"""Owner-scoped durable inbox over the registry's existing SQLite events."""
from __future__ import annotations

import json
import re
import secrets
import time


MAX_PAGE_SIZE = 100
CURSOR_TTL = 24 * 60 * 60
EVENT_ID = re.compile(r"(?:repo|job):[1-9][0-9]{0,18}\Z")
SAFE_VALUE = re.compile(r"[A-Za-z0-9_.:@/-]{1,256}\Z")
SAFE_STATES = {"queued", "draft", "reserved", "starting", "running", "awaiting_output", "validating",
               "retry_due", "ambiguous", "cancel_pending", "cancelled", "complete", "blocked", "failed",
               "held", "claimed", "accepted", "rejected", "valid", "invalid", "unknown"}


class InboxUnavailable(RuntimeError):
    """No supported durable event table is available in this registry."""


class JobInbox:
    def __init__(self, registry):
        self.registry = registry

    @staticmethod
    def _tables(db):
        return {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    @classmethod
    def _schema(cls, db):
        tables = cls._tables(db)
        sources = []
        if "events" in tables:
            columns = {row["name"] for row in db.execute("PRAGMA table_info(events)")}
            if {"id", "project", "task", "attempt", "kind", "at", "data"} <= columns:
                sources.append("repo")
        if "job_events" in tables:
            columns = {row["name"] for row in db.execute("PRAGMA table_info(job_events)")}
            if {"id", "assignment", "kind", "at", "data"} <= columns:
                sources.append("job")
        if not sources:
            raise InboxUnavailable("event_feed_unavailable")
        db.execute("""CREATE TABLE IF NOT EXISTS job_inbox_acknowledgements(
            event_id TEXT NOT NULL, owner_principal TEXT NOT NULL, client_id TEXT NOT NULL,
            project TEXT NOT NULL, acknowledged_at REAL NOT NULL,
            PRIMARY KEY(event_id,owner_principal,client_id,project))""")
        db.execute("""CREATE TABLE IF NOT EXISTS job_inbox_cursors(
            token TEXT PRIMARY KEY, owner_principal TEXT NOT NULL, client_id TEXT NOT NULL,
            project TEXT NOT NULL, last_at REAL NOT NULL, last_source TEXT NOT NULL,
            last_id INTEGER NOT NULL, created_at REAL NOT NULL)""")
        db.execute("CREATE INDEX IF NOT EXISTS job_inbox_cursor_age ON job_inbox_cursors(created_at)")
        return sources

    @staticmethod
    def _validate_scope(project, owner, client):
        def valid(value):
            return (isinstance(value, str) and 0 < len(value) <= 256 and value.strip() and
                    not any(ord(char) < 32 or ord(char) == 127 for char in value))
        if not valid(project):
            raise ValueError("projectId is required")
        if not valid(owner):
            raise PermissionError("owner_context_required")
        if not valid(client):
            raise PermissionError("owner_context_required")

    @staticmethod
    def _cursor_position(db, after, owner, client, project):
        if after in (None, "", "0"):
            return None
        row = db.execute("""SELECT last_at,last_source,last_id FROM job_inbox_cursors
            WHERE token=? AND owner_principal=? AND client_id=? AND project=?""",
                         (after, owner, client, project)).fetchone()
        if row is None:
            raise ValueError("Invalid inbox cursor")
        return row["last_at"], row["last_source"], row["last_id"]

    @staticmethod
    def _repository_select(position):
        cursor = ""
        args = []
        if position is not None:
            cursor = " AND (e.at,'repo',e.id)>(?,?,?)"
            args.extend(position)
        task_table = """(SELECT jt.task_id FROM job_tasks jt WHERE jt.assignment=a.id AND
            (jt.attempt_id=e.attempt OR jt.task_id=json_extract(e.data,'$.taskId') OR
             jt.task_id=(SELECT json_extract(at.data,'$.r21TaskId') FROM attempts at WHERE at.id=e.attempt LIMIT 1))
            ORDER BY jt.task_id LIMIT 1)"""
        owner_join = """COALESCE(json_extract(e.data,'$.assignmentId'),json_extract(e.data,'$.r21Assignment'),
            (SELECT json_extract(at.data,'$.r21Assignment') FROM attempts at WHERE at.id=e.attempt LIMIT 1))"""
        return f"""SELECT e.id source_id,'repo:'||e.id event_id,'repo' source,e.at,e.kind type,
            a.id assignment_id,{task_table} task_id,e.data
            FROM events e JOIN assignments a ON a.id={owner_join} AND a.project=e.project
            WHERE a.project=? AND e.project=? AND a.owner_principal=? AND a.client_id=?{cursor}""", args

    @staticmethod
    def _legacy_select(position):
        cursor = ""
        args = []
        if position is not None:
            cursor = " AND (j.at,'job',j.id)>(?,?,?)"
            args.extend(position)
        return f"""SELECT j.id source_id,'job:'||j.id event_id,'job' source,j.at,j.kind type,
            a.id assignment_id,(SELECT jt.task_id FROM job_tasks jt WHERE jt.assignment=a.id AND
              jt.task_id=json_extract(j.data,'$.taskId') LIMIT 1) task_id,j.data
            FROM job_events j JOIN assignments a ON a.id=j.assignment AND a.project=?
            WHERE a.project=? AND a.owner_principal=? AND a.client_id=?{cursor}""", args

    def read(self, *, project, owner, client, after="0", limit=50):
        self._validate_scope(project, owner, client)
        if type(limit) is not int or not 1 <= limit <= MAX_PAGE_SIZE:
            raise ValueError("limit must be between 1 and 100")
        if not isinstance(after, str) or len(after) > 128:
            raise ValueError("Invalid inbox cursor")
        now = time.time()
        with self.registry.connection(write=True) as db:
            sources = self._schema(db)
            position = self._cursor_position(db, after, owner, client, project)
            db.execute("DELETE FROM job_inbox_cursors WHERE created_at<?", (now - CURSOR_TTL,))
            selects, args = [], []
            for source in sources:
                select, cursor_args = (self._repository_select(position) if source == "repo"
                                       else self._legacy_select(position))
                selects.append(select)
                args.extend((project, project, owner, client, *cursor_args))
            union = " UNION ALL ".join(selects)
            rows = db.execute(f"""SELECT feed.*,
                EXISTS(SELECT 1 FROM job_inbox_acknowledgements ack WHERE ack.event_id=feed.event_id
                  AND ack.owner_principal=? AND ack.client_id=? AND ack.project=?) acknowledged
                FROM ({union}) feed ORDER BY feed.at,feed.source,feed.source_id LIMIT ?""",
                              [owner, client, project, *args, limit + 1]).fetchall()
            has_more = len(rows) > limit
            page = rows[:limit]
            events = []
            for row in page:
                try:
                    metadata = json.loads(row["data"])
                except (TypeError, json.JSONDecodeError):
                    metadata = {}
                event_type = row["type"] if isinstance(row["type"], str) and SAFE_VALUE.fullmatch(row["type"]) else None
                if event_type is None:
                    continue
                state = metadata.get("state")
                if not isinstance(state, str) or state not in SAFE_STATES:
                    state = None
                task_id = row["task_id"] if isinstance(row["task_id"], str) and SAFE_VALUE.fullmatch(row["task_id"]) else None
                events.append({"id": row["source_id"], "eventId": row["event_id"], "at": row["at"],
                               "type": event_type, "assignmentId": row["assignment_id"],
                               "taskId": task_id, "state": state,
                               "acknowledged": bool(row["acknowledged"])})
            next_cursor = None
            if has_more and page:
                last = page[-1]
                next_cursor = secrets.token_urlsafe(24)
                db.execute("""INSERT INTO job_inbox_cursors(token,owner_principal,client_id,project,last_at,last_source,last_id,created_at)
                    VALUES(?,?,?,?,?,?,?,?)""", (next_cursor, owner, client, project, last["at"], last["source"], last["source_id"], now))
                db.execute("""DELETE FROM job_inbox_cursors WHERE token IN
                    (SELECT token FROM job_inbox_cursors ORDER BY created_at DESC LIMIT -1 OFFSET 10000)""")
            return {"projectId": project, "events": events, "cursor": next_cursor, "hasMore": has_more}

    def _event_assignment(self, db, event_id, project, owner, client, sources):
        if not isinstance(event_id, str) or not EVENT_ID.fullmatch(event_id):
            return None
        source, raw_id = event_id.split(":", 1)
        if source not in sources:
            return None
        if source == "job":
            return db.execute("""SELECT a.id FROM job_events e JOIN assignments a ON a.id=e.assignment
                WHERE e.id=? AND a.project=? AND a.owner_principal=? AND a.client_id=?""",
                              (int(raw_id), project, owner, client)).fetchone()
        return db.execute("""SELECT a.id FROM events e JOIN assignments a ON a.id=COALESCE(
                json_extract(e.data,'$.assignmentId'),json_extract(e.data,'$.r21Assignment'),
                (SELECT json_extract(at.data,'$.r21Assignment') FROM attempts at WHERE at.id=e.attempt LIMIT 1))
            AND a.project=e.project WHERE e.id=? AND e.project=? AND a.project=?
                AND a.owner_principal=? AND a.client_id=?""",
                          (int(raw_id), project, project, owner, client)).fetchone()

    def acknowledge(self, *, event_id, project, owner, client):
        self._validate_scope(project, owner, client)
        now = time.time()
        with self.registry.connection(write=True) as db:
            sources = self._schema(db)
            assignment = self._event_assignment(db, event_id, project, owner, client, sources)
            if assignment is None:
                raise KeyError("not_found")
            db.execute("""INSERT OR IGNORE INTO job_inbox_acknowledgements
                (event_id,owner_principal,client_id,project,acknowledged_at) VALUES(?,?,?,?,?)""",
                       (event_id, owner, client, project, now))
            return {"eventId": event_id, "acknowledged": True}
