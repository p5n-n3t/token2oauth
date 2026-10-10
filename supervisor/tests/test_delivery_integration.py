import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from snooze.outbox import Outbox
from snooze.tasks import TaskRepository
from snooze.mcp_server import MCPFacade


class DeliveryIntegrationTests(unittest.TestCase):
    def test_process_death_after_enqueue_is_recovered_and_scoped_consumer_acknowledges(self):
        received=[]
        class Receiver(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append((self.headers['X-Snooze-Delivery-Id'],payload))
                self.send_response(204);self.end_headers()
        server=ThreadingHTTPServer(('127.0.0.1',0),Receiver)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as d:
            path=str(Path(d)/'s.sqlite')
            # os._exit simulates abrupt process death AFTER the enqueue transaction commits.
            first='from snooze.tasks import TaskRepository;from snooze.outbox import Outbox;import sys,os;Outbox(TaskRepository(sys.argv[1])).enqueue("incident","receiver",{"project":"p","kind":"failed"},100);os._exit(17)'
            process=subprocess.run([sys.executable,'-c',first,path],capture_output=True,timeout=10)
            self.assertEqual(process.returncode,17)
            second='from snooze.tasks import TaskRepository;from snooze.outbox import Outbox;from snooze.notifications import NotificationChannels;import sys;channels=NotificationChannels({"receiver":{"kind":"webhook","url":sys.argv[2],"approved_hosts":["127.0.0.1"],"network_scope":"loopback"}});Outbox(TaskRepository(sys.argv[1]),channels.deliver).deliver_due(101)'
            subprocess.run([sys.executable,'-c',second,path,f'http://127.0.0.1:{server.server_port}/wake'],check=True,capture_output=True,timeout=10)
            repo=TaskRepository(path);box=Outbox(repo)
            delivery=box.list('p')[0]
            self.assertEqual(delivery['state'],'accepted');self.assertIsNone(delivery['acknowledged_at'])
            self.assertEqual(received[0][0],delivery['id'])
            consumer=MCPFacade(repo,None,'test-secret',['p'])
            consumer.call('register',{'project':'p','coordinator_id':'test-consumer'},'test-secret')
            receipt=consumer.call('acknowledge',{'project':'p','delivery_id':delivery['id'],'coordinator_id':'test-consumer'},'test-secret')
            self.assertTrue(receipt['acknowledged']);self.assertFalse(box.list('p')[0]['resolved'])
