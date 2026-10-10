import http.client
import json
import os
import socket
import stat
import tempfile
import threading
import unittest
from pathlib import Path

from snooze.bridge import PrivateHTTPServer, read_auth_fd
from snooze.jobs import JobRegistry
def assignment():
    return {
        "schemaVersion": 1, "assignmentId": "job-1", "idempotencyKey": "key-1",
        "projectId": "project-a", "eligibleAccountIds": ["account-a"],
        "tasks": [{"taskId": "task-1", "dependsOn": [], "scopeKeys": ["path:src/input.json"],
                   "instructions": "Extract records",
                   "execution": {"mode": "existing-session", "accountId": "account-a", "sessionId": "session-a"},
                   "output": {"kind": "text", "maxBytes": 1024, "format": "plain", "expectedMarker": "DONE"}}],
    }


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("local")
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.path)


def call(path, method="GET", body=None, bearer=None, route="/admin/api/v1/assignments"):
    connection = UnixHTTPConnection(path)
    headers = {}
    payload = None
    if body is not None:
        payload = json.dumps(body)
        headers["Content-Type"] = "application/json"
    if bearer is not None:
        headers["Authorization"] = "Bearer " + bearer
    connection.request(method, route, body=payload, headers=headers)
    response = connection.getresponse()
    data = response.read()
    connection.close()
    return response.status, (json.loads(data) if data else None)


class PrivateBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "private"
        self.registry = JobRegistry(self.root / "jobs.sqlite3")
        self.registry.register_account({"accountId": "account-a", "enabled": True, "authorized": True,
            "health": "healthy", "quota": "available", "allowUnknownQuota": False,
            "registeredSessions": [{"id": "session-a", "model": "unknown", "workspace": "workspace-a"}]})
        self.bearer = "x" * 43
        self.socket_path = self.root / "bridge.sock"
        self.server = PrivateHTTPServer(self.socket_path, self.registry, self.bearer)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def test_every_request_requires_bearer_and_socket_is_private(self):
        status, payload = call(str(self.socket_path))
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "unauthorized")
        self.assertEqual(stat.S_IMODE(self.socket_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)

    def test_authenticated_direct_submission_is_accepted(self):
        conn = UnixHTTPConnection(str(self.socket_path))
        conn.request("POST", "/v1/assignments", body=json.dumps(assignment()), headers={
            "Authorization": "Bearer " + self.bearer, "Content-Type": "application/json"})
        response = conn.getresponse()
        result = json.loads(response.read())
        self.assertEqual(response.status, 202)
        self.assertEqual(result["state"], "queued")
        conn.close()
        status, operation = call(str(self.socket_path), method="POST", body={"workerId": "node-1"},
                                 bearer=self.bearer, route="/v1/operations/claim")
        self.assertEqual(status, 200)
        self.assertEqual(operation["kind"], "chat_session")
        self.assertEqual(operation["input"]["sessionId"], "session-a")
        self.assertEqual(operation["input"]["instructions"], "Extract records")

    def test_registered_account_route_is_authenticated(self):
        status, payload = call(str(self.socket_path), method="POST", route="/v1/accounts", bearer=self.bearer,
            body={"accountId": "account-b", "enabled": True, "authorized": True,
                  "health": "healthy", "quota": "unknown", "allowUnknownQuota": True,
                  "registeredSessions": [{"id": "session-b", "model": "unknown", "workspace": "workspace-a"}]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["accountId"], "account-b")

    def test_auth_pipe_reads_only_a_bounded_bearer(self):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"z" * 43 + b"\n")
        os.close(write_fd)
        try:
            self.assertEqual(read_auth_fd(read_fd), "z" * 43)
        finally:
            os.close(read_fd)


if __name__ == "__main__":
    unittest.main()
