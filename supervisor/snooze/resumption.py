"""Durable, policy-gated resumption requests for registered local CLI sessions.

Prompts are transient inputs: they are never written to SQLite or diagnostics.
A claimed invocation that might have started is never replayed automatically.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import selectors
import signal
import sqlite3
import stat
import subprocess
import time
import uuid
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Callable, Mapping


ADAPTERS = {"codex", "claude", "chatgpt_web"}
ACTIONS = {"resume"}
STATES = {"queued", "claimed", "completed", "ambiguous", "manual_handoff", "failed"}
MAX_PROMPT_BYTES = 16 * 1024
MAX_CAPTURE_BYTES = 64 * 1024
SAFE_ENV = ("PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "CODEX_HOME")


class ResumptionError(ValueError):
    """A bounded, safe-to-report broker validation error."""


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class ProcessTimedOut(TimeoutError):
    def __init__(self, stdout_bytes: int, stderr_bytes: int, truncated: bool):
        super().__init__("resumption process timed out")
        self.stdout_bytes = stdout_bytes
        self.stderr_bytes = stderr_bytes
        self.truncated = truncated


class ProcessNotStarted(RuntimeError):
    """The configured executable could not be started; no remote work ran."""


def _now() -> float:
    return time.time()


def _bounded_id(value: str, name: str, limit: int = 160) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1," + str(limit) + r"}", value):
        raise ResumptionError(f"invalid_{name}")
    return value


def _session_uuid(value: str) -> str:
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise ResumptionError("invalid_session_uuid") from None
    if str(parsed) != value.lower():
        raise ResumptionError("invalid_session_uuid")
    return str(parsed)


def _cents(value: int | float | str | Decimal) -> int:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ResumptionError("invalid_budget") from None
    if not amount.is_finite() or amount <= 0 or amount > Decimal("10000"):
        raise ResumptionError("invalid_budget")
    cents = amount * 100
    if cents != cents.to_integral_value():
        raise ResumptionError("budget_precision_exceeded")
    return int(cents)


def _safe_summary(adapter: str, result: Mapping, elapsed_ms: int, budget_enforcement: str) -> dict:
    """Allow only bounded numeric/process metadata through the durable boundary."""
    def nonnegative_int(value):
        return value if type(value) is int and 0 <= value <= 2**53 else 0

    return {
        "adapter": adapter,
        "exit_code": result.get("exit_code") if type(result.get("exit_code")) is int and -255 <= result.get("exit_code") <= 255 else None,
        "elapsed_ms": min(max(0, int(elapsed_ms)), 600_000),
        "stdout_bytes": nonnegative_int(result.get("stdout_bytes")),
        "stderr_bytes": nonnegative_int(result.get("stderr_bytes")),
        "output_truncated": bool(result.get("output_truncated", False)),
        "budget_enforcement": budget_enforcement,
    }


def _terminate_owned_group(proc: subprocess.Popen) -> None:
    """Terminate only the new session/process group owned by this Popen child."""
    group_owned = False
    try:
        group_owned = os.getpgid(proc.pid) == proc.pid
    except (ProcessLookupError, PermissionError, OSError):
        # The leader may have exited while descendants keep inherited pipes open.
        # The group id was created from this child's PID via start_new_session.
        try:
            os.killpg(proc.pid, 0)
            group_owned = True
        except (ProcessLookupError, PermissionError, OSError):
            pass
    if proc.poll() is not None and not group_owned:
        return
    if group_owned:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            try:
                os.killpg(proc.pid, 0)
            except ProcessLookupError:
                group_owned = False
                break
            except PermissionError:
                break
            time.sleep(0.025)
        if group_owned:
            try:
                # Recheck the group identity before escalation; never signal a reused PID group.
                os.killpg(proc.pid, 0)
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
    else:
        proc.terminate()
        try:
            proc.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            if proc.poll() is None:
                proc.kill()
    try:
        proc.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        pass


def _bounded_popen(argv, *, cwd, timeout, output_limit, env, shell=False, start_new_session=True):
    if shell is not False or start_new_session is not True:
        raise ResumptionError("unsafe_process_options")
    try:
        proc = subprocess.Popen(
            argv, cwd=cwd, env=env, shell=False, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
            start_new_session=True,
        )
    except OSError:
        raise ProcessNotStarted("registered executable could not start") from None
    captured = {"stdout": bytearray(), "stderr": bytearray()}
    totals = {"stdout": 0, "stderr": 0}
    selector = selectors.DefaultSelector()
    for name, stream in (("stdout", proc.stdout), ("stderr", proc.stderr)):
        selector.register(stream, selectors.EVENT_READ, name)
    deadline = time.monotonic() + timeout
    timed_out = False
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            for key, _ in selector.select(min(remaining, 0.1)):
                chunk = os.read(key.fileobj.fileno(), 8192)
                name = key.data
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                totals[name] += len(chunk)
                room = max(0, output_limit - len(captured[name]))
                if room:
                    captured[name].extend(chunk[:room])
    except Exception:
        _terminate_owned_group(proc)
        raise
    finally:
        selector.close()
    if timed_out:
        _terminate_owned_group(proc)
    else:
        proc.wait()
    for stream in (proc.stdout, proc.stderr):
        if stream and not stream.closed:
            stream.close()
    if timed_out:
        raise ProcessTimedOut(totals["stdout"], totals["stderr"],
                              totals["stdout"] > output_limit or totals["stderr"] > output_limit)
    return {
        "exit_code": proc.returncode,
        "stdout_bytes": totals["stdout"],
        "stderr_bytes": totals["stderr"],
        "output_truncated": totals["stdout"] > output_limit or totals["stderr"] > output_limit,
    }


class ResumptionBroker:
    """Single-owner SQLite event broker. Register sessions/policies via trusted code."""

    def __init__(self, database: str | Path, *, executables: Mapping[str, str] | None = None,
                 process_runner: Callable | None = None, clock: Callable[[], float] = _now):
        requested = Path(database).absolute()
        requested.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        parent = requested.parent.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid()
            or parent.st_mode & 0o077):
            raise ResumptionError("unsafe_database_directory")
        self.database = requested.parent.resolve() / requested.name
        if requested.parent.resolve() != requested.parent:
            raise ResumptionError("unsafe_database_directory")
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.database, flags, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            os.close(fd)
            raise ResumptionError("unsafe_database_path")
        os.fchmod(fd, 0o600)
        os.close(fd)
        self._lock_path = self.database.with_name(self.database.name + ".lock")
        lock_fd = os.open(self._lock_path, flags, 0o600)
        lock_info = os.fstat(lock_fd)
        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.geteuid() or lock_info.st_nlink != 1:
            os.close(lock_fd)
            raise ResumptionError("unsafe_lock_path")
        os.fchmod(lock_fd, 0o600)
        self._lock_file = os.fdopen(lock_fd, "a+b")
        try:
            fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._lock_file.close()
            raise ResumptionError("broker_already_owned") from None
        self._clock = clock
        configured = dict(executables or {})
        if set(configured) - {"codex", "claude"}:
            self.close()
            raise ResumptionError("unknown_executable_adapter")
        if any(not isinstance(path, str) or not os.path.isabs(path) for path in configured.values()):
            self.close()
            raise ResumptionError("executable_must_be_absolute")
        self._executables = {key: os.path.realpath(path) for key, path in configured.items()}
        self._runner = process_runner or _bounded_popen
        try:
            self._initialize()
            self._recover_claimed()
        except Exception:
            self.close()
            raise

    def _connect(self):
        connection = sqlite3.connect(self.database, timeout=10, isolation_level=None, factory=_ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    def _initialize(self):
        with self._connect() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript("""
            CREATE TABLE IF NOT EXISTS resumption_sessions (
              session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
              job_id TEXT NOT NULL, adapter TEXT NOT NULL, workspace_cwd TEXT NOT NULL,
              model TEXT, strict_mcp_config TEXT, allowed_tools TEXT NOT NULL,
              UNIQUE(principal_id, project_id, job_id)
            );
            CREATE TABLE IF NOT EXISTS resumption_policies (
              principal_id TEXT NOT NULL, project_id TEXT NOT NULL, authorization_level INTEGER NOT NULL,
              mode TEXT NOT NULL, allowed_actions TEXT NOT NULL, max_attempts INTEGER NOT NULL,
              max_runtime_seconds INTEGER NOT NULL, attempt_budget_cents INTEGER NOT NULL,
              budget_ceiling_cents INTEGER NOT NULL, codex_runtime_budget_ack INTEGER NOT NULL,
              reserved_cents INTEGER NOT NULL DEFAULT 0, spent_cents INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY(principal_id, project_id)
            );
            CREATE TABLE IF NOT EXISTS resumption_requests (
              request_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL,
              project_id TEXT NOT NULL, job_id TEXT NOT NULL, action TEXT NOT NULL,
              session_id TEXT, adapter TEXT, state TEXT NOT NULL CHECK(state IN
              ('queued','claimed','completed','ambiguous','manual_handoff','failed')),
              policy_allowed_actions TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
              max_attempts INTEGER NOT NULL DEFAULT 0, budget_reserved_cents INTEGER NOT NULL DEFAULT 0,
              acked_at REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
              completed_at REAL, error_code TEXT, summary_json TEXT
            );
            CREATE TABLE IF NOT EXISTS resumption_attempts (
              request_id TEXT NOT NULL REFERENCES resumption_requests(request_id),
              attempt_no INTEGER NOT NULL, owner_pid INTEGER NOT NULL, state TEXT NOT NULL,
              started_at REAL NOT NULL, ended_at REAL, summary_json TEXT,
              PRIMARY KEY(request_id, attempt_no)
            );
            CREATE INDEX IF NOT EXISTS resumption_handoffs ON resumption_requests(state,created_at);
            """)

    def _recover_claimed(self):
        # The advisory lock proves no other broker process currently owns these claims.
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            rows = c.execute("SELECT request_id,principal_id,project_id,budget_reserved_cents,attempts FROM resumption_requests WHERE state='claimed'").fetchall()
            for row in rows:
                c.execute("UPDATE resumption_requests SET state='ambiguous',error_code='owner_restart_ambiguous',updated_at=? WHERE request_id=?",
                          (self._clock(), row['request_id']))
                c.execute("UPDATE resumption_attempts SET state='ambiguous',ended_at=? WHERE request_id=? AND attempt_no=?",
                          (self._clock(), row['request_id'], row['attempts']))
                if row['budget_reserved_cents']:
                    c.execute("UPDATE resumption_policies SET reserved_cents=MAX(0,reserved_cents-?),spent_cents=spent_cents+? WHERE principal_id=? AND project_id=?",
                              (row['budget_reserved_cents'], row['budget_reserved_cents'], row['principal_id'], row['project_id']))
            c.commit()

    def register_session(self, *, session_id: str, principal_id: str, project_id: str, job_id: str,
                         adapter: str, workspace_cwd: str, model: str | None = None,
                         strict_mcp_config: str | None = None, allowed_tools=()) -> None:
        session_id = _session_uuid(session_id)
        principal_id = _bounded_id(principal_id, "principal")
        project_id = _bounded_id(project_id, "project")
        job_id = _bounded_id(job_id, "job")
        if not isinstance(adapter, str) or adapter not in ADAPTERS:
            raise ResumptionError("adapter_not_allowed")
        if not isinstance(workspace_cwd, str) or not os.path.isabs(workspace_cwd):
            raise ResumptionError("workspace_must_be_absolute")
        cwd = os.path.realpath(workspace_cwd)
        if not os.path.isdir(cwd):
            raise ResumptionError("workspace_not_registered")
        if adapter in {"codex", "claude"}:
            if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,100}", model):
                raise ResumptionError("model_not_registered")
        config_path = None
        if not isinstance(allowed_tools, (list, tuple)):
            raise ResumptionError("explicit_tool_allowlist_required")
        tools = list(allowed_tools)
        if adapter == "claude":
            if not isinstance(strict_mcp_config, str) or not os.path.isabs(strict_mcp_config):
                raise ResumptionError("strict_mcp_config_required")
            config_path = os.path.realpath(strict_mcp_config)
            if not os.path.isfile(config_path):
                raise ResumptionError("strict_mcp_config_missing")
            if not tools or len(tools) > 64 or any(not isinstance(t, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}", t) for t in tools):
                raise ResumptionError("explicit_tool_allowlist_required")
        elif tools or strict_mcp_config:
            raise ResumptionError("claude_options_not_applicable")
        with self._connect() as c:
            c.execute("INSERT INTO resumption_sessions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(principal_id,project_id,job_id) DO UPDATE SET session_id=excluded.session_id,adapter=excluded.adapter,workspace_cwd=excluded.workspace_cwd,model=excluded.model,strict_mcp_config=excluded.strict_mcp_config,allowed_tools=excluded.allowed_tools",
                      (session_id, principal_id, project_id, job_id, adapter, cwd, model, config_path, json.dumps(tools)))

    def configure_policy(self, *, principal_id: str, project_id: str, authorization_level: int,
                         mode: str = "observe", allowed_actions=(), max_attempts: int = 1,
                         max_runtime_seconds: int = 120, attempt_budget_usd=1,
                         budget_ceiling_usd=1, codex_runtime_budget_ack: bool = False) -> None:
        principal_id = _bounded_id(principal_id, "principal")
        project_id = _bounded_id(project_id, "project")
        if not isinstance(allowed_actions, (list, tuple, set, frozenset)) or any(not isinstance(action, str) for action in allowed_actions):
            raise ResumptionError("invalid_allowed_actions")
        actions = sorted(set(allowed_actions))
        if type(authorization_level) is not int or authorization_level not in range(0, 6):
            raise ResumptionError("invalid_authorization_level")
        if mode not in {"observe", "headless"}:
            raise ResumptionError("invalid_mode")
        if not actions or not set(actions).issubset(ACTIONS):
            raise ResumptionError("invalid_allowed_actions")
        if type(max_attempts) is not int or not 1 <= max_attempts <= 5:
            raise ResumptionError("invalid_attempt_limit")
        if type(max_runtime_seconds) is not int or not 1 <= max_runtime_seconds <= 600:
            raise ResumptionError("invalid_runtime_limit")
        per_attempt = _cents(attempt_budget_usd)
        ceiling = _cents(budget_ceiling_usd)
        if per_attempt > ceiling or type(codex_runtime_budget_ack) is not bool:
            raise ResumptionError("invalid_budget_policy")
        with self._connect() as c:
            current = c.execute("SELECT reserved_cents,spent_cents FROM resumption_policies WHERE principal_id=? AND project_id=?",
                                 (principal_id,project_id)).fetchone()
            if current and ceiling < current['reserved_cents'] + current['spent_cents']:
                raise ResumptionError("budget_below_reserved_or_spent")
            c.execute("INSERT INTO resumption_policies(principal_id,project_id,authorization_level,mode,allowed_actions,max_attempts,max_runtime_seconds,attempt_budget_cents,budget_ceiling_cents,codex_runtime_budget_ack) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(principal_id,project_id) DO UPDATE SET authorization_level=excluded.authorization_level,mode=excluded.mode,allowed_actions=excluded.allowed_actions,max_attempts=excluded.max_attempts,max_runtime_seconds=excluded.max_runtime_seconds,attempt_budget_cents=excluded.attempt_budget_cents,budget_ceiling_cents=excluded.budget_ceiling_cents,codex_runtime_budget_ack=excluded.codex_runtime_budget_ack",
                      (principal_id, project_id, authorization_level, mode, json.dumps(actions), max_attempts,
                       max_runtime_seconds, per_attempt, ceiling, int(codex_runtime_budget_ack)))

    def handle_event(self, *, event_id: str, principal_id: str, project_id: str, job_id: str,
                     action: str, prompt: str) -> dict:
        """Durably deduplicate one event, then invoke at most one approved resume."""
        event_id = _bounded_id(event_id, "event_id")
        principal_id = _bounded_id(principal_id, "principal")
        project_id = _bounded_id(project_id, "project")
        job_id = _bounded_id(job_id, "job")
        action = _bounded_id(action, "action", 32)
        try:
            prompt_size = len(prompt.encode("utf-8")) if isinstance(prompt, str) else MAX_PROMPT_BYTES + 1
        except UnicodeEncodeError:
            prompt_size = MAX_PROMPT_BYTES + 1
        if not isinstance(prompt, str) or not prompt.strip() or prompt.lstrip().startswith("-") or prompt_size > MAX_PROMPT_BYTES:
            raise ResumptionError("invalid_prompt")
        now = self._clock()
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            existing = c.execute("SELECT * FROM resumption_requests WHERE event_id=?", (event_id,)).fetchone()
            if existing:
                if (existing['principal_id'],existing['project_id'],existing['job_id'],existing['action']) != (principal_id,project_id,job_id,action):
                    c.rollback()
                    raise ResumptionError("event_id_conflict")
                c.commit()
                row = existing
                created = False
            else:
                session = c.execute("SELECT * FROM resumption_sessions WHERE principal_id=? AND project_id=? AND job_id=?",
                                    (principal_id, project_id, job_id)).fetchone()
                policy = c.execute("SELECT * FROM resumption_policies WHERE principal_id=? AND project_id=?",
                                   (principal_id, project_id)).fetchone()
                allowed = json.loads(policy['allowed_actions']) if policy else []
                state, error = "queued", None
                if action not in ACTIONS:
                    state, error = "failed", "action_not_supported"
                elif not session:
                    state, error = "manual_handoff", "session_unregistered"
                elif not policy:
                    state, error = "manual_handoff", "policy_unconfigured"
                elif policy['authorization_level'] != 4:
                    state, error = "failed", "policy_level_not_authorized"
                elif action not in allowed:
                    state, error = "failed", "action_not_allowed"
                elif policy['mode'] != "headless":
                    state, error = "manual_handoff", "observe_mode"
                elif session['adapter'] == "chatgpt_web":
                    state, error = "manual_handoff", "web_session_requires_human"
                elif session['adapter'] not in self._executables:
                    state, error = "manual_handoff", "cli_adapter_unconfigured"
                elif session['adapter'] == "codex" and not policy['codex_runtime_budget_ack']:
                    state, error = "manual_handoff", "codex_budget_not_enforceable"
                request_id = str(uuid.uuid4())
                c.execute("INSERT INTO resumption_requests(request_id,event_id,principal_id,project_id,job_id,action,session_id,adapter,state,policy_allowed_actions,max_attempts,created_at,updated_at,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (request_id,event_id,principal_id,project_id,job_id,action,
                           session['session_id'] if session else None, session['adapter'] if session else None,
                           state,json.dumps(allowed),policy['max_attempts'] if policy else 0,now,now,error))
                row = c.execute("SELECT * FROM resumption_requests WHERE request_id=?", (request_id,)).fetchone()
                c.commit()
                created = True
        if row['state'] == "queued":
            self._execute(request_id, prompt)
        result = self.get_request(row['request_id'])
        result['deduplicated'] = not created
        return result

    def _execute(self, request_id: str, prompt: str) -> None:
        now = self._clock()
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            request = c.execute("SELECT * FROM resumption_requests WHERE request_id=?", (request_id,)).fetchone()
            if not request or request['state'] != "queued":
                c.rollback()
                return
            policy = c.execute("SELECT * FROM resumption_policies WHERE principal_id=? AND project_id=?",
                               (request['principal_id'], request['project_id'])).fetchone()
            session = c.execute("SELECT * FROM resumption_sessions WHERE session_id=?", (request['session_id'],)).fetchone()
            if not policy or not session or request['attempts'] >= policy['max_attempts']:
                c.execute("UPDATE resumption_requests SET state='manual_handoff',error_code='attempt_limit_or_registration_changed',updated_at=? WHERE request_id=?", (now,request_id)); c.commit(); return
            if (policy['authorization_level'] != 4 or policy['mode'] != 'headless'
                or request['action'] not in json.loads(policy['allowed_actions'])
                or session['adapter'] == 'chatgpt_web'
                or (session['adapter'] == 'codex' and not policy['codex_runtime_budget_ack'])):
                c.execute("UPDATE resumption_requests SET state='failed',error_code='policy_no_longer_authorized',updated_at=? WHERE request_id=?", (now,request_id)); c.commit(); return
            if policy['reserved_cents'] + policy['spent_cents'] + policy['attempt_budget_cents'] > policy['budget_ceiling_cents']:
                c.execute("UPDATE resumption_requests SET state='manual_handoff',error_code='budget_ceiling_reached',updated_at=? WHERE request_id=?",(now,request_id)); c.commit(); return
            if session['adapter'] == "codex" and not policy['codex_runtime_budget_ack']:
                c.execute("UPDATE resumption_requests SET state='manual_handoff',error_code='codex_budget_not_enforceable',updated_at=? WHERE request_id=?",(now,request_id)); c.commit(); return
            attempt_no = request['attempts'] + 1
            reserve = policy['attempt_budget_cents']
            c.execute("UPDATE resumption_policies SET reserved_cents=reserved_cents+? WHERE principal_id=? AND project_id=?",(reserve,request['principal_id'],request['project_id']))
            c.execute("UPDATE resumption_requests SET state='claimed',attempts=?,budget_reserved_cents=?,updated_at=?,error_code=NULL WHERE request_id=?",
                      (attempt_no,reserve,now,request_id))
            c.execute("INSERT INTO resumption_attempts(request_id,attempt_no,owner_pid,state,started_at) VALUES(?,?,?,'claimed',?)",
                      (request_id,attempt_no,os.getpid(),now))
            c.commit()
        started = time.monotonic()
        try:
            argv, cwd = self._command(session, policy, prompt)
        except ResumptionError as exc:
            self._finish(request_id,attempt_no,'failed',str(exc),{"adapter":session['adapter'],"outcome":"not_started"},reserve,consume_budget=False)
            return
        try:
            result = self._runner(argv, cwd=cwd, timeout=policy['max_runtime_seconds'],
                                  output_limit=MAX_CAPTURE_BYTES, env=self._child_environment(),
                                  shell=False, start_new_session=True)
            elapsed = int((time.monotonic() - started) * 1000)
            budget_mode = "cli_enforced" if session['adapter'] == 'claude' else "runtime_acknowledged_not_cli_enforced"
            summary = _safe_summary(session['adapter'], result, elapsed, budget_mode)
            state = "completed" if result.get("exit_code") == 0 else "failed"
            error = None if state == "completed" else "process_exit_nonzero"
        except ProcessNotStarted:
            elapsed = int((time.monotonic() - started) * 1000)
            summary = {"adapter":session['adapter'],"outcome":"not_started","elapsed_ms":min(elapsed,600_000)}
            state, error = "failed", "process_not_started"
            self._finish(request_id,attempt_no,state,error,summary,reserve,consume_budget=False)
            return
        except ProcessTimedOut as exc:
            elapsed = int((time.monotonic() - started) * 1000)
            summary = {"adapter": session['adapter'],"outcome":"timeout","elapsed_ms":min(elapsed,600_000),
                       "stdout_bytes":exc.stdout_bytes,"stderr_bytes":exc.stderr_bytes,"output_truncated":exc.truncated,
                       "budget_enforcement":"runtime_acknowledged_not_cli_enforced" if session['adapter']=="codex" else "cli_enforced"}
            state, error = "ambiguous", "process_timeout_after_start"
        except Exception as exc:
            # Once control entered the runner, the command may have started; never retry it blindly.
            elapsed = int((time.monotonic() - started) * 1000)
            summary = {"adapter":session['adapter'],"outcome":"runner_error","elapsed_ms":min(elapsed,600_000),
                       "error_class":type(exc).__name__[:80],"budget_enforcement":"runtime_acknowledged_not_cli_enforced" if session['adapter']=="codex" else "cli_enforced"}
            state, error = "ambiguous", "runner_outcome_unknown"
        self._finish(request_id, attempt_no, state, error, summary, reserve)

    def _command(self, session, policy, prompt: str):
        cwd = session['workspace_cwd']
        if not os.path.isdir(cwd) or os.path.realpath(cwd) != cwd:
            raise ResumptionError("registered_workspace_changed")
        session_id = _session_uuid(session['session_id'])
        if session['adapter'] == "codex":
            exe = self._executables['codex']
            if not os.path.isfile(exe) or not os.access(exe, os.X_OK):
                raise ResumptionError("registered_codex_missing")
            # No unsupported max-USD option and no approval/sandbox bypass flags.
            return [exe,"exec","resume","--model",session['model'],"--json",session_id,prompt],cwd
        if session['adapter'] == "claude":
            exe = self._executables['claude']
            config = session['strict_mcp_config']
            tools = json.loads(session['allowed_tools'])
            if not os.path.isfile(exe) or not os.access(exe, os.X_OK):
                raise ResumptionError("registered_claude_missing")
            if not config or not os.path.isfile(config) or os.path.realpath(config) != config:
                raise ResumptionError("registered_claude_config_changed")
            cap = f"{policy['attempt_budget_cents'] / 100:.2f}"
            return [exe,"-p","--resume",session_id,prompt,"--model",session['model'],
                    "--max-budget-usd",cap,"--strict-mcp-config",config,
                    "--allowedTools",*tools,"--output-format","json"],cwd
        raise ResumptionError("adapter_manual_handoff")

    @staticmethod
    def _child_environment():
        return {key: os.environ[key] for key in SAFE_ENV if key in os.environ}

    def _finish(self, request_id, attempt_no, state, error, summary, reserve, *, consume_budget=True):
        now = self._clock()
        encoded = json.dumps(summary, separators=(",",":"), sort_keys=True)
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT principal_id,project_id FROM resumption_requests WHERE request_id=?",(request_id,)).fetchone()
            c.execute("UPDATE resumption_policies SET reserved_cents=MAX(0,reserved_cents-?),spent_cents=spent_cents+? WHERE principal_id=? AND project_id=?",
                      (reserve,reserve if consume_budget else 0,row['principal_id'],row['project_id']))
            c.execute("UPDATE resumption_requests SET state=?,budget_reserved_cents=0,updated_at=?,completed_at=?,error_code=?,summary_json=? WHERE request_id=?",
                      (state,now,now,error,encoded,request_id))
            c.execute("UPDATE resumption_attempts SET state=?,ended_at=?,summary_json=? WHERE request_id=? AND attempt_no=?",
                      (state,now,encoded,request_id,attempt_no))
            c.commit()

    def get_request(self, request_id: str) -> dict:
        with self._connect() as c:
            row = c.execute("SELECT * FROM resumption_requests WHERE request_id=?",(request_id,)).fetchone()
        if not row:
            raise ResumptionError("request_not_found")
        return self._public_request(row)

    def get_event(self, event_id: str) -> dict:
        with self._connect() as c:
            row = c.execute("SELECT * FROM resumption_requests WHERE event_id=?",(event_id,)).fetchone()
        if not row:
            raise ResumptionError("event_not_found")
        return self._public_request(row)

    @staticmethod
    def _public_request(row):
        return {"request_id":row['request_id'],"event_id":row['event_id'],"principal_id":row['principal_id'],
                "project_id":row['project_id'],"job_id":row['job_id'],"action":row['action'],
                "session_id":row['session_id'],"adapter":row['adapter'],"state":row['state'],
                "policy_allowed_actions":json.loads(row['policy_allowed_actions']),"attempts":row['attempts'],
                "max_attempts":row['max_attempts'],"acked":row['acked_at'] is not None,"acked_at":row['acked_at'],
                "created_at":row['created_at'],"updated_at":row['updated_at'],"completed_at":row['completed_at'],
                "error_code":row['error_code'],"summary":json.loads(row['summary_json']) if row['summary_json'] else None}

    def pending_handoffs(self, *, limit: int = 50) -> list[dict]:
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ResumptionError("invalid_page_limit")
        with self._connect() as c:
            rows = c.execute("SELECT * FROM resumption_requests WHERE state='manual_handoff' AND acked_at IS NULL ORDER BY created_at,request_id LIMIT ?",(limit,)).fetchall()
        return [self._public_request(row) for row in rows]

    def acknowledge(self, event_id: str) -> bool:
        """Acknowledge inbox delivery without changing execution/completion state."""
        now = self._clock()
        with self._connect() as c:
            cursor = c.execute("UPDATE resumption_requests SET acked_at=COALESCE(acked_at,?),updated_at=? WHERE event_id=?",(now,now,event_id))
            return cursor.rowcount == 1

    def close(self):
        lock = getattr(self, "_lock_file", None)
        if lock and not lock.closed:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
            finally:
                lock.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
