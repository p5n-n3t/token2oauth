import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from snooze.cli import prime
from snooze.launch import open_dashboard


class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state with spaces'
        self.repo = Path(self.tmp.name) / 'repo with spaces'; self.repo.mkdir()
        self.config = prime(self.repo, self.state, None)

    def server(self, payload):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                self.send_response(200); self.end_headers()
                self.wfile.write(json.dumps(payload).encode())
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        return server.server_address[1]

    def test_existing_daemon_is_reused_without_reinitializing(self):
        config = (self.state / 'project.json').read_bytes()
        port = self.server({'name':'snooze','api_version':2,'project':self.config['project_id']})
        with patch('snooze.launch.start_daemon') as start:
            url = open_dashboard(self.state, port, lambda url: False)
        start.assert_not_called()
        self.assertEqual(url, f'http://127.0.0.1:{port}/')
        self.assertEqual(config, (self.state / 'project.json').read_bytes())

    def test_unrelated_service_or_wrong_project_is_rejected(self):
        for payload in ({'name':'other'}, {'name':'snooze','api_version':2,'project':'wrong'}):
            port = self.server(payload)
            with patch('snooze.launch.start_daemon') as start:
                with self.assertRaises(RuntimeError): open_dashboard(self.state, port, lambda url: False)
                start.assert_not_called()

    def test_prime_cannot_overwrite_existing_binding(self):
        config = (self.state / 'project.json').read_bytes()
        with self.assertRaises(ValueError): prime(self.repo, self.state, None)
        self.assertEqual(config, (self.state / 'project.json').read_bytes())

    def test_stopped_daemon_start_is_checked_until_ready(self):
        with patch('snooze.launch.probe', side_effect=[None, None, {'name':'snooze','api_version':2,'project':self.config['project_id']}]), patch('snooze.launch.start_daemon') as start, patch('snooze.launch.time.sleep'):
            open_dashboard(self.state, 8999, lambda url: False)
        start.assert_called_once()

    def test_default_open_reuses_registered_custom_service_port(self):
        config={**self.config,'user_service':'snooze-test.service','service_port':9000}
        (self.state/'project.json').write_text(json.dumps(config))
        with patch('snooze.launch.probe',return_value={'name':'snooze','api_version':2,'project':self.config['project_id']}) as probe:
            url=open_dashboard(self.state,None,lambda url:False)
        probe.assert_called_once_with(9000)
        self.assertEqual(url,'http://127.0.0.1:9000/')
