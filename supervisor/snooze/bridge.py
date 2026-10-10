"""Authenticated private Unix-socket HTTP bridge for the Node supervisor."""
from __future__ import annotations

import argparse
import hmac
import http.server
import json
import os
import re
import socket
import stat
import urllib.parse
from pathlib import Path

from .jobs import JobRegistry

MAX_BODY = 1024 * 1024


def read_auth_fd(fd=3):
    """Read one already-written bearer from the inherited pipe; never echo it."""
    chunk = os.read(fd, 4096)
    token = chunk.rstrip(b"\r\n")
    if len(token) < 32 or len(token) > 512 or b"\n" in token or b"\r" in token:
        raise RuntimeError("Invalid bridge authentication pipe")
    try:
        return token.decode("ascii")
    except UnicodeDecodeError as exc:
        raise RuntimeError("Invalid bridge authentication pipe") from exc


class PrivateHTTPServer(http.server.ThreadingHTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, socket_path, registry, bearer):
        self.socket_path = Path(socket_path)
        self.registry = registry
        self.bearer = bearer
        self.socket_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.socket_path.parent, 0o700)
        if self.socket_path.exists() or self.socket_path.is_symlink():
            if self.socket_path.is_symlink() or not stat.S_ISSOCK(self.socket_path.lstat().st_mode):
                raise RuntimeError("Refusing to replace non-socket bridge path")
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                if probe.connect_ex(str(self.socket_path)) == 0:
                    raise RuntimeError("Bridge socket is already active")
            finally:
                probe.close()
            self.socket_path.unlink()
        super().__init__(str(self.socket_path), BridgeHandler, bind_and_activate=True)
        os.chmod(self.socket_path, 0o600)
        socket_stat = self.socket_path.lstat()
        self.socket_identity = (socket_stat.st_dev, socket_stat.st_ino)

    def server_close(self):
        try:
            super().server_close()
        finally:
            try:
                if self.socket_path.exists() and stat.S_ISSOCK(self.socket_path.lstat().st_mode):
                    current = self.socket_path.lstat()
                    if (current.st_dev, current.st_ino) == self.socket_identity:
                        self.socket_path.unlink()
            except FileNotFoundError:
                pass


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    server: PrivateHTTPServer
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *args):
        # Request paths, headers and bodies can contain sensitive operator input.
        return

    def _reply(self, status, payload=None):
        raw = b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Connection", "close")
        self.end_headers()
        if raw:
            self.wfile.write(raw)
        self.close_connection = True

    def _body(self):
        length = self.headers.get("Content-Length")
        if length is None or not length.isdecimal() or int(length) > MAX_BODY:
            raise ValueError("Invalid or oversized request body")
        raw = self.rfile.read(int(length))
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Malformed JSON body") from exc
        if not isinstance(value, dict):
            raise ValueError("Request body must be a JSON object")
        return value

    def _authorized(self):
        header = self.headers.get("Authorization", "")
        expected = "Bearer " + self.server.bearer
        return hmac.compare_digest(header.encode("utf-8"), expected.encode("utf-8"))

    def _assignment_body(self):
        body = self._body()
        # Ownership comes only from the trusted Node supervisor headers.
        body.pop("ownerPrincipalId", None)
        body.pop("clientId", None)
        principal = self.headers.get("X-Owner-Principal")
        client = self.headers.get("X-Client-Id")
        if principal:
            body["ownerPrincipalId"] = principal
        if client:
            body["clientId"] = client
        return body

    def _dispatch(self):
        if not self._authorized():
            self._reply(401, {"error": "unauthorized"})
            return
        parsed = urllib.parse.urlsplit(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query, strict_parsing=False)
        registry = self.server.registry
        try:
            if self.command == "POST" and route == "/v1/assignments":
                self._reply(202, registry.submit(self._assignment_body(), approved=True))
                return
            if self.command == "POST" and route == "/admin/api/v1/assignments":
                self._reply(202, registry.submit(self._assignment_body(), approved=False))
                return
            if self.command == "POST" and route == "/v1/accounts":
                self._reply(200, registry.register_account(self._body()))
                return
            if self.command == "GET" and route == "/admin/api/v1/assignments":
                project = query.get("projectId", [None])[0]
                if not project:
                    raise ValueError("projectId is required")
                offset = int(query.get("offset", ["0"])[0])
                limit = int(query.get("limit", ["50"])[0])
                self._reply(200, registry.list_assignments(project, offset=offset, limit=limit,
                                                           owner_principal_id=self.headers.get("X-Owner-Principal"),
                                                           client_id=self.headers.get("X-Client-Id")))
                return
            match = re.fullmatch(r"/admin/api/v1/assignments/([^/]+)(?:/approve)?", route)
            if self.command == "POST" and match and route.endswith("/approve"):
                body = self._body()
                if set(body) != {"expectedRevision"} or type(body["expectedRevision"]) is not int:
                    raise ValueError("expectedRevision is required")
                self._reply(202, registry.approve(urllib.parse.unquote(match.group(1)), body["expectedRevision"]))
                return
            if self.command == "GET" and match and not route.endswith("/approve"):
                value = registry.get_assignment(urllib.parse.unquote(match.group(1)), self.headers.get("X-Owner-Principal"),
                                                self.headers.get("X-Client-Id"))
                self._reply(200, value) if value else self._reply(404, {"error": "not_found"})
                return
            match = re.fullmatch(r"/v1/assignments/([^/]+)/(results|cancel)", route)
            if match and match.group(2) == "results" and self.command == "GET":
                self._reply(200, registry.assignment_results(urllib.parse.unquote(match.group(1)), self.headers.get("X-Owner-Principal"),
                                                             self.headers.get("X-Client-Id")))
                return
            if match and match.group(2) == "cancel" and self.command == "POST":
                body = self._body()
                if set(body) != {"expectedRevision"} or type(body["expectedRevision"]) is not int:
                    raise ValueError("expectedRevision is required")
                self._reply(202, registry.cancel_assignment(urllib.parse.unquote(match.group(1)), body["expectedRevision"],
                                                              self.headers.get("X-Owner-Principal"), self.headers.get("X-Client-Id")))
                return
            if self.command == "GET" and route == "/admin/api/v1/events":
                after = int(query.get("after", ["0"])[0])
                limit = int(query.get("limit", ["100"])[0])
                self._reply(200, registry.events(after=after, limit=limit))
                return
            if self.command == "POST" and route == "/admin/api/v1/control":
                body = self._body()
                if set(body) != {"action", "value", "expectedRevision"}:
                    raise ValueError("Invalid control request")
                self._reply(202, registry.set_control(body["action"], body["value"], body["expectedRevision"]))
                return
            if self.command == "POST" and route == "/v1/operations/claim":
                body = self._body()
                if set(body) - {"workerId", "leaseSeconds"}:
                    raise ValueError("Invalid claim fields")
                operation = registry.claim_operation(body.get("workerId"), body.get("leaseSeconds", 30))
                if operation is None:
                    self._reply(204)
                else:
                    self._reply(200, operation)
                return
            match = re.fullmatch(r"/v1/operations/([^/]+)/result", route)
            if self.command == "POST" and match:
                self._reply(200, registry.record_result(urllib.parse.unquote(match.group(1)), self._body()))
                return
            self._reply(404, {"error": "not_found"})
        except KeyError:
            self._reply(404, {"error": "not_found"})
        except RuntimeError as exc:
            self._reply(409, {"error": str(exc)[:160]})
        except (ValueError, TypeError, OverflowError) as exc:
            self._reply(400, {"error": str(exc)[:160]})
        except Exception:
            # Deliberately suppress exception strings/tracebacks (provider data may be involved).
            self._reply(500, {"error": "internal_error"})

    do_GET = _dispatch
    do_POST = _dispatch


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--auth-fd", type=int, default=3)
    args = parser.parse_args(argv)
    state_dir = Path(args.state_dir)
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)
    bearer = read_auth_fd(args.auth_fd)
    registry = JobRegistry(state_dir / "snooze.sqlite3")
    server = PrivateHTTPServer(args.socket, registry, bearer)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
