import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from snooze.notifications import NotificationChannels


class NotificationTests(unittest.TestCase):
    def test_endpoint_must_be_explicitly_approved(self):
        with self.assertRaises(ValueError): NotificationChannels({'w':{'kind':'webhook','url':'https://arbitrary.test/hook','approved_hosts':[]}})
        with self.assertRaises(ValueError): NotificationChannels({'c':{'kind':'command','argv':['/bin/sh','-c','echo bad']}},approved_commands=[])
    def test_real_receiver_acceptance_does_not_claim_acknowledgment(self):
        received=[]
        class Receiver(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200);self.end_headers();self.wfile.write(b'accepted')
        server=ThreadingHTTPServer(('127.0.0.1',0),Receiver)
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        channels=NotificationChannels({'w':{'kind':'webhook','url':f'http://127.0.0.1:{server.server_port}/hook','approved_hosts':['127.0.0.1'],'network_scope':'loopback'}})
        result=channels.deliver('w',{'project':'p','message':'Test incident'})
        self.assertEqual(result['state'],'accepted');self.assertNotIn('acknowledged_at',result)
        self.assertEqual(received[0]['project'],'p')
    def test_missing_channel_is_inbox_only(self):
        self.assertEqual(NotificationChannels({}).deliver('inbox',{'project':'p'})['state'],'inbox')
