import tempfile
import unittest
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from snooze.transport import LightSprint
from snooze.transport import normalize_status


class TransportTests(unittest.TestCase):
    def test_progress_age_and_liveness_are_safe_observed_fields(self):
        value=normalize_status({'status':{'sessionStatus':'running','relayHealth':{'alive':True,'lastEventAgoMs':900000,'relayPid':42},'userId':'private'}})
        self.assertEqual(value['last_event_age_ms'],900000)
        self.assertIs(value['relay_alive'],True)
        self.assertNotIn('relayPid',str(value))

    def test_nested_provider_status_is_flattened_without_sensitive_fields(self):
        value = normalize_status({'status': {'sessionStatus': 'idle', 'model': 'small', 'userId': 'private', 'credentialRef': 'private'}})
        self.assertEqual(value['status'], 'idle')
        self.assertEqual(value['model'], 'small')
        self.assertNotIn('private', str(value))

    def test_model_and_effort_cannot_smuggle_nested_private_objects(self):
        result=normalize_status({'status':{'sessionStatus':'running','model':{'Authorization':'secret'},'reasoningEffort':['secret']}})
        self.assertIsNone(result['model']);self.assertIsNone(result['effort']);self.assertNotIn('secret',str(result))

    def test_provider_compatible_user_agent_is_sent(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'config.toml'
            path.write_text('[mcp_servers.demo]\nurl="https://app.lightsprint.ai/mcp"\n')
            class Response:
                headers = {}; status = 200
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self): return b'{"result":{"content":[{"type":"text","text":"{}"}]}}'
            def open_request(request, timeout):
                self.assertEqual(request.get_header('User-agent'), 'Codex MCP')
                return Response()
            with patch('urllib.request.OpenerDirector.open', side_effect=open_request):
                LightSprint(path).request('demo', 'GET', '/api/repos')

    def test_provider_opener_does_not_forward_authentication_on_redirect(self):
        received=[]
        class Target(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                received.append(self.headers.get('Authorization'))
                self.send_response(200);self.end_headers()
        target=ThreadingHTTPServer(('127.0.0.1',0),Target)
        class Redirect(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                self.send_response(302);self.send_header('Location',f'http://127.0.0.1:{target.server_port}/');self.end_headers()
        source=ThreadingHTTPServer(('127.0.0.1',0),Redirect)
        for server in (target,source):
            threading.Thread(target=server.serve_forever,daemon=True).start()
            self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        provider=LightSprint(Path('/unused'))
        request=urllib.request.Request(f'http://127.0.0.1:{source.server_port}/',headers={'Authorization':'Bearer dummy-not-a-secret'})
        with self.assertRaises(urllib.error.HTTPError):provider.opener.open(request,timeout=2)
        self.assertEqual(received,[])
