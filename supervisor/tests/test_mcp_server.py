import tempfile
import unittest
import io
from pathlib import Path
from snooze.tasks import TaskRepository
from snooze.mcp_server import MCPFacade


class MCPTests(unittest.TestCase):
    def test_malformed_messages_do_not_kill_stdio_consumer(self):
        with tempfile.TemporaryDirectory() as d:
            facade=MCPFacade(TaskRepository(Path(d)/'s.sqlite'),None,'private',['p'])
            output=io.StringIO()
            facade.serve_stdio(io.StringIO('1\n[]\n{"id":2,"method":"tools/call","params":[]}\n{"id":3,"method":"tools/list"}\n'),output)
            self.assertIn('"id": 3',output.getvalue())

    def test_tools_describe_required_control_and_acknowledgment_arguments(self):
        with tempfile.TemporaryDirectory() as d:
            facade=MCPFacade(TaskRepository(Path(d)/'s.sqlite'),None,'private',['p'])
            tools={t['name']:t for t in facade.rpc({'id':1,'method':'tools/list'})['result']['tools']}
            self.assertIn('task_id',tools['snooze_task']['inputSchema']['required'])
            self.assertIn('expected_revision',tools['snooze_control']['inputSchema']['required'])
            self.assertIn('delivery_id',tools['snooze_acknowledge']['inputSchema']['required'])
            self.assertIn('snooze_snapshot',tools)

    def test_scope_and_auth_cannot_be_bypassed_by_tool_calls(self):
        with tempfile.TemporaryDirectory() as d:
            repo=TaskRepository(Path(d)/'s.sqlite')
            facade=MCPFacade(repo,None,'private',['p'])
            with self.assertRaises(PermissionError):facade.call('events',{'project':'p'},'wrong')
            with self.assertRaises(PermissionError):facade.call('events',{'project':'other'},'private')
            self.assertEqual(facade.call('events',{'project':'p'},'private')['events'],[])
            with self.assertRaises(ValueError):facade.call('shell',{'project':'p','command':'bad'},'private')
