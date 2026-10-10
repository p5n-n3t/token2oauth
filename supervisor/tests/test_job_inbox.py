import http.client
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from snooze.bridge import PrivateHTTPServer
from snooze.jobs import JobRegistry


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("local")
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.path)


class JobInboxBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "private"
        self.db_path = self.root / "jobs.sqlite3"
        self.registry = JobRegistry(self.db_path)
        self.registry.register_account({"accountId": "account-a", "enabled": True, "authorized": True,
            "health": "healthy", "quota": "available", "allowUnknownQuota": False,
            "registeredSessions": [{"id": "session-a", "model": "unknown", "workspace": "workspace-a"}]})
        self.bearer = "x" * 43
        self.socket_path = self.root / "bridge.sock"
        self.server = PrivateHTTPServer(self.socket_path, self.registry, self.bearer)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)

    def _stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def call(self, route, *, method="GET", body=None, owner="owner-a", client="client-a"):
        connection = UnixHTTPConnection(str(self.socket_path))
        headers = {"Authorization": "Bearer " + self.bearer}
        payload = None
        if body is not None:
            payload = json.dumps(body)
            headers["Content-Type"] = "application/json"
        if owner is not None:
            headers["X-Owner-Principal"] = owner
        if client is not None:
            headers["X-Client-Id"] = client
        connection.request(method, route, body=payload, headers=headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, json.loads(data) if data else None

    def submit(self, assignment_id, project="project-a", owner="owner-a", client="client-a"):
        body = {"schemaVersion": 1, "assignmentId": assignment_id, "idempotencyKey": "key-" + assignment_id,
            "projectId": project, "eligibleAccountIds": ["account-a"],
            "tasks": [{"taskId": "task-1", "dependsOn": [], "scopeKeys": ["path:src/input.json"],
                "instructions": "never expose this prompt", "execution": {"mode": "existing-session",
                    "accountId": "account-a", "sessionId": "session-a"},
                "output": {"kind": "text", "maxBytes": 1024, "format": "plain", "expectedMarker": "DONE"}}]}
        return self.call("/v1/assignments", method="POST", body=body, owner=owner, client=client)

    def test_both_trusted_owner_and_client_headers_are_required(self):
        self.submit("owned")
        for owner, client in ((None, "client-a"), ("owner-a", None), (None, None)):
            with self.subTest(owner=owner, client=client):
                status, result = self.call("/v1/inbox?projectId=project-a", owner=owner, client=client)
                self.assertEqual(status, 403)
                self.assertEqual(result["error"], "owner_context_required")

    def test_repository_events_are_scoped_to_exact_owner_client_and_project(self):
        self.submit("owned")
        self.submit("other-owner", owner="owner-b")
        self.submit("other-client", client="client-b")
        self.submit("other-project", project="project-b")
        self.submit("legacy-null", owner=None, client=None)
        with self.registry.connection(write=True) as db:
            db.execute("INSERT INTO events(project,task,attempt,kind,at,data) VALUES(?,?,?,?,?,?)",
                       ("project-a", None, None, "safe_state_probe", 123,
                        json.dumps({"assignmentId": "owned", "state": "private prompt", "message": "secret body"})))

        status, result = self.call("/v1/inbox?projectId=project-a")

        self.assertEqual(status, 200)
        self.assertEqual(result["projectId"], "project-a")
        self.assertTrue(result["events"])
        self.assertEqual({event["assignmentId"] for event in result["events"]}, {"owned"})
        probe = next(event for event in result["events"] if event["type"] == "safe_state_probe")
        self.assertIsNone(probe["state"])
        self.assertIsNone(probe["taskId"])
        self.assertNotIn("never expose this prompt", repr(result))
        self.assertNotIn("private prompt", repr(result))
        self.assertNotIn("secret body", repr(result))
        self.assertNotIn("owner-b", repr(result))

    def test_legacy_job_events_are_included_without_null_scope_wildcards(self):
        self.submit("legacy-events")
        original_repository = self.registry.repository
        self.registry.repository = None
        try:
            with self.registry.connection(write=True) as db:
                self.registry._event(db, "legacy-events", "operation_queued", {"state": "queued", "message": "private"}, now=123)
        finally:
            self.registry.repository = original_repository

        status, result = self.call("/v1/inbox?projectId=project-a")

        self.assertEqual(status, 200)
        legacy = [event for event in result["events"] if event["eventId"].startswith("job:")]
        self.assertEqual(len(legacy), 1)
        self.assertEqual(legacy[0]["type"], "operation_queued")
        self.assertEqual(legacy[0]["state"], "queued")
        self.assertFalse(legacy[0]["acknowledged"])
        self.assertNotIn("private", repr(result))

    def test_pagination_acknowledgment_and_restart_are_durable_and_deduplicated(self):
        self.submit("paged")
        original_repository = self.registry.repository
        self.registry.repository = None
        try:
            with self.registry.connection(write=True) as db:
                self.registry._event(db, "paged", "legacy_progress", {"state": "running"}, now=123)
                self.registry._event(db, "paged", "legacy_done", {"state": "complete"}, now=124)
        finally:
            self.registry.repository = original_repository

        status, first = self.call("/v1/inbox?projectId=project-a&limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(len(first["events"]), 1)
        self.assertTrue(first["hasMore"])
        cursor = first["cursor"]
        self.assertIsInstance(cursor, str)
        self.assertNotEqual(cursor, first["events"][0]["eventId"])
        status, second = self.call(f"/v1/inbox?projectId=project-a&after={cursor}&limit=1")
        self.assertEqual(status, 200)
        self.assertTrue(second["hasMore"])
        self.assertNotEqual(first["events"][0]["eventId"], second["events"][0]["eventId"])

        event = first["events"][0]
        path = f"/v1/inbox/{event['eventId']}/ack"
        receipt = {"projectId": "project-a"}
        self.assertEqual(self.call(path, method="POST", body=receipt)[0], 200)
        self.assertEqual(self.call(path, method="POST", body=receipt)[1],
                         {"eventId": event["eventId"], "acknowledged": True})

        self.registry = JobRegistry(self.db_path)
        self.server.registry = self.registry
        status, after_restart = self.call("/v1/inbox?projectId=project-a&limit=1")
        self.assertEqual(status, 200)
        self.assertTrue(after_restart["events"][0]["acknowledged"])
        status, final = self.call(f"/v1/inbox?projectId=project-a&after={second['cursor']}&limit=10")
        self.assertEqual(status, 200)
        self.assertFalse(final["hasMore"])
        self.assertIsNone(final["cursor"])

    def test_cursor_and_ack_are_bound_to_exact_scope_and_body_cannot_override(self):
        self.submit("scoped")
        with self.registry.connection(write=True) as db:
            self.registry._event(db, "scoped", "scoped_followup", {"state": "queued"}, now=456)
        _, result = self.call("/v1/inbox?projectId=project-a&limit=1")
        self.assertTrue(result["hasMore"])
        cursor = result["cursor"]
        status, denied = self.call(f"/v1/inbox?projectId=project-a&after={cursor}", owner="owner-b")
        self.assertEqual(status, 400)
        self.assertEqual(denied["error"], "Invalid inbox cursor")

        event_id = result["events"][0]["eventId"]
        status, _ = self.call(f"/v1/inbox/{event_id}/ack", method="POST",
                              body={"projectId": "project-a", "ownerPrincipalId": "owner-a", "clientId": "client-a"})
        self.assertEqual(status, 400)
        status, _ = self.call(f"/v1/inbox/{event_id}/ack", method="POST", body={"projectId": "project-b"})
        self.assertEqual(status, 404)
        status, _ = self.call(f"/v1/inbox/{event_id}/ack", method="POST", body={"projectId": "project-a"}, client="client-b")
        self.assertEqual(status, 404)

    def test_pagination_bounds_and_unsupported_event_store_are_explicit(self):
        self.submit("bounds")
        for suffix in ("limit=0", "limit=101", "extra=1"):
            status, _ = self.call("/v1/inbox?projectId=project-a&" + suffix)
            self.assertEqual(status, 400)
        with self.registry.connection(write=True) as db:
            db.execute("DROP TABLE events")
            db.execute("DROP TABLE job_events")
        status, result = self.call("/v1/inbox?projectId=project-a")
        self.assertEqual(status, 501)
        self.assertEqual(result, {"error": "event_feed_unavailable"})


if __name__ == "__main__":
    unittest.main()
