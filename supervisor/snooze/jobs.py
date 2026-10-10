"""Durable, bounded assignment registry and provider-operation outbox.

This module deliberately knows stable account IDs and operation DTOs only.  The
Token2OAuth process owns credentials and performs every provider/MCP call.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

MAX_TASKS = 100
MAX_INSTRUCTIONS = 16 * 1024
MAX_JOB_BYTES = 1024 * 1024
MAX_DEPENDENCIES = 8
MAX_PAGE = 200
MUTATING_KINDS = {"create_task", "patch_task", "launch_task", "chat_session", "cancel_session"}
OPERATION_KINDS = {
    "create_task", "patch_task", "verify_task_packet", "launch_task",
    "inspect_task_agents", "observe_session", "chat_session", "cancel_session",
}
ASSIGNMENT_KEYS = {"schemaVersion", "assignmentId", "idempotencyKey", "projectId", "eligibleAccountIds", "tasks"}
TASK_KEYS = {"taskId", "dependsOn", "scopeKeys", "inputRef", "inputSha256", "instructions", "execution", "output"}
OUTPUT_KEYS = {
    "json-records": {"kind", "validator", "ids", "requiredFields"},
    "text": {"kind", "maxBytes", "format"},
    "coding-artifact": {"kind", "repository", "allowedPaths", "requirePullRequest"},
}


def _text(value, name, maximum=256):
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        raise ValueError(f"Invalid {name}")
    return value


def _closed_object(value, keys, name):
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"{name} has unsupported or missing fields")


def _validate_scope(value):
    _text(value, "scope", 512)
    if value.startswith("record:"):
        if not value[7:] or any(char.isspace() for char in value[7:]):
            raise ValueError("Invalid record scope")
        return value
    if value.startswith("path:"):
        raw = value[5:]
        path = PurePosixPath(raw)
        if not raw or path.is_absolute() or ".." in path.parts or "\\" in raw or str(path) == ".":
            raise ValueError("Scope must be repository-relative")
        return "path:" + str(path)
    raise ValueError("Use record:ID or path:repository-relative scope")


def validate_assignment(body):
    _closed_object(body, ASSIGNMENT_KEYS, "assignment")
    if body["schemaVersion"] != 1 or type(body["schemaVersion"]) is not int:
        raise ValueError("schemaVersion must be 1")
    _text(body["assignmentId"], "assignmentId")
    _text(body["idempotencyKey"], "idempotencyKey", 200)
    _text(body["projectId"], "projectId")
    accounts = body["eligibleAccountIds"]
    if not isinstance(accounts, list) or not 2 <= len(accounts) <= 50:
        raise ValueError("eligibleAccountIds must contain 2 to 50 accounts")
    if any(not isinstance(account, str) or not account or len(account) > 256 for account in accounts) or len(set(accounts)) != len(accounts):
        raise ValueError("eligibleAccountIds must be distinct stable IDs")
    tasks = body["tasks"]
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= MAX_TASKS:
        raise ValueError(f"tasks must contain 1 to {MAX_TASKS} entries")
    if len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_JOB_BYTES:
        raise ValueError("Assignment exceeds 1 MiB")
    ids = []
    normalized = []
    for task in tasks:
        _closed_object(task, TASK_KEYS, "task")
        task_id = _text(task["taskId"], "taskId")
        ids.append(task_id)
        dependencies = task["dependsOn"]
        if not isinstance(dependencies, list) or len(dependencies) > MAX_DEPENDENCIES or any(not isinstance(v, str) for v in dependencies):
            raise ValueError("dependsOn must contain at most 8 task IDs")
        if len(set(dependencies)) != len(dependencies) or task_id in dependencies:
            raise ValueError("Duplicate or self dependency")
        scopes = task["scopeKeys"]
        if not isinstance(scopes, list) or not scopes:
            raise ValueError("Each task needs scopeKeys")
        normalized_scopes = [_validate_scope(scope) for scope in scopes]
        if len(set(normalized_scopes)) != len(normalized_scopes):
            raise ValueError("Duplicate scope")
        _text(task["inputRef"], "inputRef", 512)
        if not isinstance(task["inputSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", task["inputSha256"]):
            raise ValueError("inputSha256 must be 64 lowercase hexadecimal characters")
        if not isinstance(task["instructions"], str) or len(task["instructions"].encode("utf-8")) > MAX_INSTRUCTIONS:
            raise ValueError("instructions exceeds 16 KiB")
        if re.search(r"(?i)bearer\s+\S+|lsat_[A-Za-z0-9_-]+", task["instructions"]):
            raise ValueError("Credential-like instructions are not accepted")
        if re.match(r"(?i)https?://", task["inputRef"]):
            raise ValueError("inputRef must be an opaque local reference")
        execution = task["execution"]
        if not isinstance(execution, dict) or execution.get("mode") not in {"fresh", "existing-session"}:
            raise ValueError("Unsupported execution mode")
        if execution["mode"] == "fresh":
            if set(execution) != {"mode", "provider"} or execution["provider"] not in {"claude", "codex", "auto", "pi"}:
                raise ValueError("Invalid fresh execution")
        elif set(execution) != {"mode", "sessionId", "accountId"} or not all(isinstance(execution[k], str) and execution[k] for k in ("sessionId", "accountId")):
            raise ValueError("Invalid registered-session execution")
        elif execution["accountId"] not in accounts:
            raise ValueError("Registered session account must be eligible")
        output = task["output"]
        if not isinstance(output, dict) or output.get("kind") not in OUTPUT_KEYS or set(output) != OUTPUT_KEYS[output.get("kind")]:
            raise ValueError("Unsupported output contract")
        if output["kind"] == "text" and (type(output["maxBytes"]) is not int or not 1 <= output["maxBytes"] <= 32768 or not isinstance(output["format"], str)):
            raise ValueError("Invalid bounded text output contract")
        if output["kind"] == "json-records" and (not isinstance(output["ids"], list) or not output["ids"] or not isinstance(output["requiredFields"], list) or not output["requiredFields"]):
            raise ValueError("Invalid JSON records output contract")
        if output["kind"] == "json-records" and (len(output["ids"]) > 100 or len(output["requiredFields"]) > 100 or
                any(not isinstance(item, str) or not item or len(item) > 256 for item in output["ids"] + output["requiredFields"])):
            raise ValueError("JSON record contract exceeds bounds")
        if output["kind"] == "coding-artifact" and (not isinstance(output["repository"], str) or not isinstance(output["allowedPaths"], list) or type(output["requirePullRequest"]) is not bool):
            raise ValueError("Invalid coding artifact output contract")
        if output["kind"] == "coding-artifact" and (not output["repository"] or len(output["repository"]) > 256 or
                not 1 <= len(output["allowedPaths"]) <= 100 or any(not isinstance(p, str) or not p or p.startswith("/") or ".." in PurePosixPath(p).parts or "\\" in p for p in output["allowedPaths"])):
            raise ValueError("Coding artifact paths must be bounded repository-relative paths")
        normalized.append({**task, "scopeKeys": normalized_scopes})
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate taskId")
    id_set = set(ids)
    indegree = {task["taskId"]: 0 for task in normalized}
    children = {task["taskId"]: [] for task in normalized}
    for task in normalized:
        for parent in task["dependsOn"]:
            if parent not in id_set:
                raise ValueError("Dependencies must belong to this assignment")
            indegree[task["taskId"]] += 1
            children[parent].append(task["taskId"])
    ready = [key for key, degree in indegree.items() if degree == 0]
    visited = 0
    while ready:
        current = ready.pop()
        visited += 1
        for child in children[current]:
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(child)
    if visited != len(normalized):
        raise ValueError("Task dependencies contain a cycle")
    return {**body, "tasks": normalized}


class JobRegistry:
    """Single-host durable registry; SQLite transactions fence every claim/result."""

    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        self.repository = None
        try:
            from .tasks import TaskRepository
            self.repository = TaskRepository(self.path)
        except ModuleNotFoundError as exc:
            # R11's pinned Snooze source may not yet be present on this branch.
            if exc.name not in {"snooze.tasks", f"{__package__}.tasks"}:
                raise
        if self.repository is not None:
            self.path = self.repository.path
        previous_umask = os.umask(0o077)
        try:
            with self.connection(write=True) as db:
                db.executescript("""
                CREATE TABLE IF NOT EXISTS assignments(
                  id TEXT PRIMARY KEY, project TEXT NOT NULL, idem TEXT NOT NULL,
                  fingerprint TEXT NOT NULL, eligible TEXT NOT NULL, body TEXT NOT NULL,
                  state TEXT NOT NULL, approved INTEGER NOT NULL, revision INTEGER NOT NULL,
                  created_at REAL NOT NULL, UNIQUE(project,idem));
                CREATE TABLE IF NOT EXISTS job_tasks(
                  assignment TEXT NOT NULL, task_id TEXT NOT NULL, body TEXT NOT NULL,
                  state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
                  selected_account TEXT, attempt_id TEXT, provider_task_id TEXT, session_id TEXT,
                  PRIMARY KEY(assignment,task_id));
                CREATE TABLE IF NOT EXISTS operations(
                  id TEXT PRIMARY KEY, assignment TEXT NOT NULL, task_id TEXT NOT NULL,
                  attempt_id TEXT NOT NULL, generation INTEGER NOT NULL, account TEXT NOT NULL,
                  kind TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL,
                  worker TEXT, lease_until REAL, result TEXT, error_class TEXT,
                  created_at REAL NOT NULL, UNIQUE(assignment,task_id,generation,kind));
                CREATE INDEX IF NOT EXISTS operations_ready ON operations(state,created_at);
                CREATE TABLE IF NOT EXISTS job_events(
                  id INTEGER PRIMARY KEY AUTOINCREMENT, assignment TEXT NOT NULL,
                  kind TEXT NOT NULL, at REAL NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS bridge_control(
                  id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL,
                  emergency_stop INTEGER NOT NULL, revision INTEGER NOT NULL);
                INSERT OR IGNORE INTO bridge_control(id,paused,emergency_stop,revision) VALUES(1,0,0,1);
                CREATE TABLE IF NOT EXISTS scheduler_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
                INSERT OR IGNORE INTO scheduler_meta(key,value) VALUES('round_robin',0);
                """)
            os.chmod(self.path, 0o600)
        finally:
            os.umask(previous_umask)

    @contextmanager
    def connection(self, write=False):
        if self.repository is not None:
            with self.repository.connection(write=write) as db:
                yield db
            return
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if write:
                db.commit()
        except Exception:
            if write:
                db.rollback()
            raise
        finally:
            db.close()

    def _event(self, db, assignment, kind, data=None, now=None):
        # Event payloads contain state/IDs only. Instructions and operation inputs stay private.
        safe = {key: value for key, value in (data or {}).items()
                if key in {"state", "taskId", "accountId", "generation", "operationId", "reason"}
                and isinstance(value, (str, int, float, bool, type(None)))}
        when = time.time() if now is None else now
        if self.repository is not None:
            row = db.execute("SELECT project FROM assignments WHERE id=?", (assignment,)).fetchone()
            if row:
                self.repository.event(db, row["project"], kind, {**safe, "assignmentId": assignment}, now=when)
                return
        db.execute("INSERT INTO job_events(assignment,kind,at,data) VALUES(?,?,?,?)",
                   (assignment, kind, when, json.dumps(safe)))

    def submit(self, body, *, approved=True, now=None):
        body = validate_assignment(body)
        encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fingerprint = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        created = time.time() if now is None else now
        with self.connection(write=True) as db:
            prior = db.execute("SELECT * FROM assignments WHERE project=? AND idem=?", (body["projectId"], body["idempotencyKey"])).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise ValueError("Idempotency key already belongs to a different assignment")
                return self._receipt(prior)
            state = "queued" if approved else "draft"
            db.execute("INSERT INTO assignments VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (body["assignmentId"], body["projectId"], body["idempotencyKey"], fingerprint,
                        json.dumps(body["eligibleAccountIds"]), encoded, state, int(approved), 1, created))
            for task in body["tasks"]:
                db.execute("INSERT INTO job_tasks(assignment,task_id,body,state) VALUES(?,?,?,?)",
                           (body["assignmentId"], task["taskId"], json.dumps(task, ensure_ascii=False), "queued"))
            self._event(db, body["assignmentId"], "assignment_" + state, {"state": state}, created)
            row = db.execute("SELECT * FROM assignments WHERE id=?", (body["assignmentId"],)).fetchone()
            return self._receipt(row)

    @staticmethod
    def _receipt(row):
        return {"assignmentId": row["id"], "projectId": row["project"], "state": row["state"],
                "revision": row["revision"], "taskCount": len(json.loads(row["body"])["tasks"])}

    def get_assignment(self, assignment_id):
        with self.connection() as db:
            row = db.execute("SELECT * FROM assignments WHERE id=?", (assignment_id,)).fetchone()
            if not row:
                return None
            tasks = []
            for task in db.execute("SELECT * FROM job_tasks WHERE assignment=? ORDER BY rowid", (assignment_id,)):
                spec = json.loads(task["body"])
                tasks.append({"taskId": task["task_id"], "state": task["state"], "dependsOn": spec["dependsOn"],
                              "attempt": task["attempt_id"], "generation": task["generation"],
                              "selectedAccountId": task["selected_account"], "providerTaskId": task["provider_task_id"],
                              "sessionId": task["session_id"], "modelRequested": "unknown/unsupported",
                              "modelReported": None, "providerStatus": None, "quota": "unknown", "capacity": "unknown"})
            return {"schemaVersion": 1, **self._receipt(row), "eligibleAccountIds": json.loads(row["eligible"]), "tasks": tasks}

    def list_assignments(self, project, *, offset=0, limit=50):
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= MAX_PAGE:
            raise ValueError("Invalid assignment page")
        with self.connection() as db:
            total = db.execute("SELECT COUNT(*) FROM assignments WHERE project=?", (project,)).fetchone()[0]
            rows = db.execute("SELECT * FROM assignments WHERE project=? ORDER BY created_at,id LIMIT ? OFFSET ?", (project, limit, offset)).fetchall()
        return {"assignments": [self._receipt(row) for row in rows], "total": total, "offset": offset,
                "hasMore": offset + len(rows) < total}

    def approve(self, assignment_id, expected_revision, now=None):
        when = time.time() if now is None else now
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM assignments WHERE id=?", (assignment_id,)).fetchone()
            if not row:
                raise KeyError("Assignment not found")
            if row["revision"] != expected_revision or row["state"] != "draft":
                raise RuntimeError("Stale assignment revision or state")
            db.execute("UPDATE assignments SET approved=1,state='queued',revision=revision+1 WHERE id=?", (assignment_id,))
            self._event(db, assignment_id, "assignment_queued", {"state": "queued"}, when)
            return self._receipt(db.execute("SELECT * FROM assignments WHERE id=?", (assignment_id,)).fetchone())

    def set_control(self, action, value, expected_revision):
        if action not in {"pause_dispatch", "emergency_stop"} or type(value) is not bool:
            raise ValueError("Invalid control action")
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM bridge_control WHERE id=1").fetchone()
            if row["revision"] != expected_revision:
                raise RuntimeError("Stale control revision")
            field = "paused" if action == "pause_dispatch" else "emergency_stop"
            db.execute(f"UPDATE bridge_control SET {field}=?,revision=revision+1 WHERE id=1", (int(value),))
            return {"action": action, "value": value, "revision": expected_revision + 1}

    def events(self, after=0, limit=100):
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= MAX_PAGE:
            raise ValueError("Invalid event cursor/page size")
        with self.connection() as db:
            if self.repository is not None:
                rows = db.execute("SELECT id,project,task,attempt,kind,at,data FROM events WHERE id>? ORDER BY id LIMIT ?", (after, limit)).fetchall()
                events = [{"id": row["id"], "projectId": row["project"], "task": row["task"], "attempt": row["attempt"],
                           "kind": row["kind"], "at": row["at"], "data": json.loads(row["data"])} for row in rows]
            else:
                rows = db.execute("SELECT id,assignment,kind,at,data FROM job_events WHERE id>? ORDER BY id LIMIT ?", (after, limit)).fetchall()
                events = [{"id": row["id"], "assignmentId": row["assignment"], "kind": row["kind"],
                           "at": row["at"], "data": json.loads(row["data"])} for row in rows]
        return {"events": events, "cursor": events[-1]["id"] if events else after, "hasMore": len(events) == limit}

    @staticmethod
    def _next_kind(task):
        mode = task["execution"]["mode"]
        if mode == "fresh":
            return {"queued": "create_task", "created": "patch_task", "patched": "verify_task_packet",
                    "verified": "launch_task"}.get(task.get("dispatchPhase", "queued"))
        return {"queued": "verify_task_packet", "verified": "chat_session"}.get(task.get("dispatchPhase", "queued"))

    def _queue_one_ready(self, db, now):
        control = db.execute("SELECT paused,emergency_stop FROM bridge_control WHERE id=1").fetchone()
        if control["paused"] or control["emergency_stop"]:
            return None
        rows = db.execute("SELECT a.*,t.task_id,t.body AS task_body,t.state AS task_state,t.generation,t.selected_account,t.attempt_id "
                          "FROM assignments a JOIN job_tasks t ON t.assignment=a.id "
                          "WHERE a.approved=1 AND a.state='queued' AND t.state IN ('queued','retry_due') "
                          "ORDER BY a.created_at,t.rowid").fetchall()
        for row in rows:
            spec = json.loads(row["task_body"])
            deps = spec["dependsOn"]
            if deps:
                states = {x["task_id"]: x["state"] for x in db.execute("SELECT task_id,state FROM job_tasks WHERE assignment=?", (row["id"],))}
                if any(states.get(dep) != "complete" for dep in deps):
                    continue
            accounts = json.loads(row["eligible"])
            active = {r[0] for r in db.execute("SELECT selected_account FROM job_tasks WHERE selected_account IS NOT NULL AND state IN ('reserved','starting','running','awaiting_output','ambiguous','cancel_pending')")}
            available = [account for account in accounts if account not in active]
            if spec["execution"]["mode"] == "existing-session":
                pinned = spec["execution"]["accountId"]
                available = [account for account in available if account == pinned]
            if not available:
                continue
            rr = db.execute("SELECT value FROM scheduler_meta WHERE key='round_robin'").fetchone()[0]
            account = available[rr % len(available)]
            db.execute("UPDATE scheduler_meta SET value=? WHERE key='round_robin'", (rr + 1,))
            generation = row["generation"] + 1
            attempt = uuid.uuid4().hex
            phase = "queued"
            kind = self._next_kind(spec)
            if kind not in OPERATION_KINDS:
                continue
            # Reservation, affinity, attempt generation, outbox operation, and event share one transaction.
            db.execute("UPDATE job_tasks SET state='reserved',generation=?,selected_account=?,attempt_id=? WHERE assignment=? AND task_id=? AND state IN ('queued','retry_due')",
                       (generation, account, attempt, row["id"], row["task_id"]))
            operation_id = uuid.uuid4().hex
            operation_input = {"assignmentId": row["id"], "taskId": row["task_id"], "phase": phase}
            db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,'queued',NULL,NULL,NULL,NULL,?)",
                       (operation_id, row["id"], row["task_id"], attempt, generation, account, kind,
                        json.dumps(operation_input), now))
            self._event(db, row["id"], "operation_queued", {"state": "queued", "taskId": row["task_id"],
                                                               "accountId": account, "generation": generation,
                                                               "operationId": operation_id}, now)
            return operation_id
        return None

    def claim_operation(self, worker_id, lease_seconds=30, now=None):
        _text(worker_id, "workerId", 128)
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= 300:
            raise ValueError("leaseSeconds must be between 1 and 300")
        when = time.time() if now is None else now
        with self.connection(write=True) as db:
            expired = db.execute("SELECT * FROM operations WHERE state='claimed' AND lease_until<=?", (when,)).fetchall()
            for op in expired:
                state = "ambiguous" if op["kind"] in MUTATING_KINDS else "queued"
                db.execute("UPDATE operations SET state=?,worker=NULL,lease_until=NULL,error_class='LeaseExpired' WHERE id=? AND state='claimed'",
                           (state, op["id"]))
                if state == "ambiguous":
                    db.execute("UPDATE job_tasks SET state='ambiguous' WHERE assignment=? AND task_id=? AND generation=?",
                               (op["assignment"], op["task_id"], op["generation"]))
                    db.execute("UPDATE assignments SET state='held',revision=revision+1 WHERE id=?", (op["assignment"],))
                    self._event(db, op["assignment"], "operation_ambiguous", {"state": state,
                                  "taskId": op["task_id"], "generation": op["generation"], "operationId": op["id"]}, when)
            self._queue_one_ready(db, when)
            control = db.execute("SELECT paused,emergency_stop FROM bridge_control WHERE id=1").fetchone()
            if control["paused"] or control["emergency_stop"]:
                return None
            op = db.execute("SELECT o.* FROM operations o JOIN assignments a ON a.id=o.assignment "
                            "WHERE o.state='queued' AND a.state='queued' AND a.approved=1 ORDER BY o.created_at,o.id LIMIT 1").fetchone()
            if not op:
                return None
            db.execute("UPDATE operations SET state='claimed',worker=?,lease_until=? WHERE id=? AND state='queued'",
                       (worker_id, when + lease_seconds, op["id"]))
            return {"operationId": op["id"], "attemptId": op["attempt_id"], "generation": op["generation"],
                    "selectedAccountId": op["account"], "kind": op["kind"], "providerTaskId": None,
                    "sessionId": None, "input": json.loads(op["input"])}

    def record_result(self, operation_id, body, now=None):
        if not isinstance(body, dict) or set(body) - {"workerId", "outcome", "observedAt", "result", "errorClass"}:
            raise ValueError("Invalid operation result fields")
        worker = _text(body.get("workerId"), "workerId", 128)
        outcome = body.get("outcome")
        if outcome not in {"accepted", "rejected", "ambiguous"}:
            raise ValueError("Invalid operation outcome")
        result = body.get("result", {})
        if not isinstance(result, dict) or len(json.dumps(result, separators=(",", ":")).encode()) > 32768:
            raise ValueError("Result must be a bounded object")
        allowed_result = {"providerTaskId", "sessionId", "branchName", "commitRef", "artifactRefs", "pullRequest", "reportedModel", "status"}
        if set(result) - allowed_result:
            raise ValueError("Unsupported operation result fields")
        for key, value in result.items():
            if isinstance(value, str):
                _text(value, key, 2048)
                if re.search(r"(?i)bearer\s+\S+|lsat_[A-Za-z0-9_-]+", value):
                    raise ValueError("Credential-like result values are not accepted")
            elif isinstance(value, list):
                if len(value) > 32 or any(not isinstance(v, str) or len(v) > 2048 for v in value): raise ValueError("Invalid reference list")
            elif isinstance(value, dict):
                if key != "pullRequest" or set(value) - {"url", "status"}: raise ValueError("Invalid pull request reference")
                for nested in value.values():
                    if not isinstance(nested, str) or len(nested) > 2048 or re.search(r"(?i)bearer\s+\S+|lsat_[A-Za-z0-9_-]+", nested):
                        raise ValueError("Invalid pull request reference")
            elif value is not None: raise ValueError("Invalid result value")
        error_class = body.get("errorClass")
        if error_class is not None and (not isinstance(error_class, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", error_class)):
            raise ValueError("errorClass must be a safe class name")
        encoded = json.dumps({"outcome": outcome, "result": result, "errorClass": error_class}, sort_keys=True, separators=(",", ":"))
        when = time.time() if now is None else now
        with self.connection(write=True) as db:
            op = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
            if not op: raise KeyError("Operation not found")
            if op["state"] in {"accepted", "rejected", "ambiguous"}:
                if op["result"] == encoded: return {"operationId": operation_id, "state": op["state"], "replayed": True}
                raise RuntimeError("Conflicting operation result")
            if op["state"] != "claimed" or op["worker"] != worker:
                raise RuntimeError("Operation is not owned by this worker")
            db.execute("UPDATE operations SET state=?,result=?,error_class=?,lease_until=NULL WHERE id=? AND state='claimed' AND worker=?",
                       (outcome, encoded, body.get("errorClass"), operation_id, worker))
            task = db.execute("SELECT * FROM job_tasks WHERE assignment=? AND task_id=?", (op["assignment"], op["task_id"])).fetchone()
            if task["generation"] != op["generation"] or task["attempt_id"] != op["attempt_id"] or task["selected_account"] != op["account"]:
                raise RuntimeError("Stale operation generation")
            if outcome == "ambiguous":
                state = "ambiguous"
            elif outcome == "rejected":
                state = "blocked"
            else:
                state = "running" if op["kind"] in {"launch_task", "chat_session"} else "starting"
                spec = json.loads(task["body"])
                phase_map = {"create_task": "created", "patch_task": "patched", "verify_task_packet": "verified"}
                phase = phase_map.get(op["kind"])
                if phase:
                    spec["dispatchPhase"] = phase
                    db.execute("UPDATE job_tasks SET body=? WHERE assignment=? AND task_id=? AND generation=?",
                               (json.dumps(spec), op["assignment"], op["task_id"], op["generation"]))
                    next_kind = self._next_kind(spec)
                    if next_kind:
                        next_id = uuid.uuid4().hex
                        db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,'queued',NULL,NULL,NULL,NULL,?)",
                                   (next_id, op["assignment"], op["task_id"], op["attempt_id"], op["generation"], op["account"], next_kind,
                                    json.dumps({"assignmentId": op["assignment"], "taskId": op["task_id"], "phase": phase}), when))
                if result.get("providerTaskId"):
                    db.execute("UPDATE job_tasks SET provider_task_id=? WHERE assignment=? AND task_id=? AND generation=?",
                               (result["providerTaskId"], op["assignment"], op["task_id"], op["generation"]))
                if result.get("sessionId"):
                    db.execute("UPDATE job_tasks SET session_id=? WHERE assignment=? AND task_id=? AND generation=?",
                               (result["sessionId"], op["assignment"], op["task_id"], op["generation"]))
            db.execute("UPDATE job_tasks SET state=? WHERE assignment=? AND task_id=? AND generation=?",
                       (state, op["assignment"], op["task_id"], op["generation"]))
            if state in {"ambiguous", "blocked"}:
                db.execute("UPDATE assignments SET state='held',revision=revision+1 WHERE id=?", (op["assignment"],))
            self._event(db, op["assignment"], "operation_" + state, {"state": state, "taskId": op["task_id"],
                          "generation": op["generation"], "operationId": operation_id}, when)
            return {"operationId": operation_id, "state": state, "replayed": False}
