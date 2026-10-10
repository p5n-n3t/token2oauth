"""Serve the built Svelte app through Snooze's real localhost HTTP handler."""
from __future__ import annotations

import copy
import sys
import time
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from snooze.web import _make_server


class FixtureStore:
    def __init__(self) -> None:
        now = time.time()
        self.settings = {"interval": 300}
        self.workers = []
        for index in range(100):
            self.workers.append({
                "id": f"task-{index:03d}",
                "session_id": f"session-{index:03d}",
                "server_key": f"lightsprint{index // 12 + 1}",
                "logical_slot": index % 12 + 1,
                "workspace_id": f"/home/worker/workspaces/Project {index}",
                "title": "Review release candidate" if index == 0 else f"Inspect deployment batch {index:03d}",
                "instruction": '<img src=x onerror="alert(1)"> Keep this assigned prompt literal.' if index == 0 else f"Review task {index} carefully.",
                "requested_model": "codex-5",
                "requested_reasoning": "low",
                "state": "running" if index % 4 else "waiting",
                "last_sent": now - index * 240,
                "observed_at": now - 15,
                "observation_status": "fresh",
                "observation": {"status": "working" if index % 4 else "waiting", "model": "codex-5", "effort": None if index == 0 else "medium"},
                "references": ["javascript:alert(1)", "https://name:secret@example.test/private", "https://docs.example.test/runbook"] if index == 0 else [],
            })
        for index in range(10_000):
            self.workers.append({
                "id": f"done-{index:03d}",
                "session_id": f"done-session-{index:03d}",
                "server_key": f"lightsprint{index % 9 + 1}",
                "title": f"Completed assignment {index:03d}",
                "instruction": f"Completed task instructions {index}.",
                "state": "completed",
                "last_sent": now - 500 - index,
                "observed_at": now - 490 - index,
                "observation_status": "fresh",
                "observation": {"status": "idle", "model": "codex-5", "effort": "medium"},
            })
        self.incidents = [
            {"job": f"task-{index % 100:03d}", "kind": "attention", "message": f"Recorded incident {index:05d}; usage is unavailable.", "at": now - index}
            for index in range(2)
        ]

    def snapshot(self, project_id: str) -> dict:
        return {"project": project_id, "workers": self.workers, "incidents": self.incidents, "settings": dict(self.settings)}

    def history_page(self, project_id: str, *, offset: int = 0, limit: int = 25, query: str = "") -> dict:
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100 or len(query) > 200:
            raise ValueError("Invalid history page")
        terminal = {"complete", "completed", "done", "cancelled", "canceled", "failed"}
        needle = query.casefold()
        rows = []
        for worker in self.workers:
            state = str(worker.get("state", "")).lower()
            if state not in terminal:
                continue
            task_id = str(worker.get("id", ""))
            title = str(worker.get("title") or worker.get("name") or task_id)[:160]
            detail = "Recorded task state from local Snooze history; usage and validation detail are unavailable."
            if needle and needle not in " ".join((title, state, detail, task_id)).casefold():
                continue
            rows.append({"id": f"task:{task_id}", "at": worker.get("observed_at") or worker.get("last_sent"), "kind": state,
                         "title": title, "detail": detail, "task_id": task_id})
        for index, incident in enumerate(self.incidents):
            task_id = str(incident.get("job", ""))
            kind = str(incident.get("kind", "incident"))
            title = task_id or "Worker event"
            detail = str(incident.get("message") or "No event detail was recorded.")[:500]
            if needle and needle not in " ".join((title, kind, detail, task_id)).casefold():
                continue
            rows.append({"id": f"incident:{index}", "at": incident.get("at"), "kind": kind, "title": title, "detail": detail, "task_id": task_id or None})
        rows.sort(key=lambda row: row.get("at") or 0, reverse=True)
        total = len(rows)
        entries = rows[offset:offset + limit]
        return {"entries": entries, "total": total, "offset": offset, "limit": limit, "has_more": offset + len(entries) < total}

    def set_settings(self, project_id: str, values: dict) -> None:
        self.settings = dict(values)

    def ack(self, project_id: str, job: str, kind: str) -> None:
        self.incidents = [event for event in self.incidents if not (event["job"] == job and event["kind"] == kind)]


class FixtureMonitor:
    def check(self, project_id: str) -> None:
        return None


if __name__ == "__main__":
    from snooze.tasks import TaskRepository
    from snooze.history_api import HistoryAPI
    from snooze.history_ingest import HistoryIngestor
    fixture_directory=tempfile.TemporaryDirectory(prefix="snooze-browser-fixture-")
    repo=TaskRepository(Path(fixture_directory.name)/'history.sqlite')
    repo.register_project('trump-files','/fixture/project')
    now=time.time()
    HistoryIngestor(repo).ingest_events('browser-fixture','seed',[
        {'event_id':f'fixture-{index}','at':now-index*3600,'kind':'usage','project_id':'trump-files',
         'account_id':f'lightsprint{index%9+1}','session_id':f'fixture-session-{index//3}',
         'model':'fixture-small','effort':'low','input_tokens':100+index,'output_tokens':50+index}
        for index in range(120)])
    accounts = {f"lightsprint{index}": {"enabled": True} for index in range(1, 10)}
    config = {"ownership": "external", "dispatcher": "external", "mcp_servers": accounts}
    server = _make_server(FixtureStore(), "trump-files", FixtureMonitor(), "e2e-cookie-token", port=4179, project_config=config,history=HistoryAPI(repo,'trump-files'))
    server.serve_forever()
