import unittest
from snooze.adapters.base import UnsupportedOperation
from snooze.adapters.registered import RegisteredAdapter
from snooze.adapters.lightsprint import LightSprintAdapter
from snooze.domain import TaskSpec, AttemptReceipt


class RecordingTransport:
    def __init__(self): self.calls = []
    def request(self, key, method, path, body=None):
        self.calls.append((key, method, path, body))
        if method == 'GET': return {'status': {'sessionStatus': 'idle', 'model': 'gpt-6-luna', 'privateMessages': ['secret']}}
        return {'id': 'session-1', 'status': 'running', 'branchName': 'ls/test'}


class AdapterTests(unittest.TestCase):
    def test_full_approved_packet_is_sent_and_hard_write_scope_is_unsupported(self):
        class Transport(RecordingTransport):
            def request(self,key,method,path,body=None):
                self.calls.append((key,method,path,body))
                if path=='/api/tasks':return {'task':{'id':'remote-task'}}
                return {'id':'session-1','branchName':'ls/test'}
        transport=Transport()
        adapter=LightSprintAdapter({'mcp_key':'key','stack_id':'stack','launch_verified':True,'models':['small'],'efforts':['low']},transport)
        task=TaskSpec('t','p',('record:17','path:src/assigned.py'),'inputs.json','a'*64,{'model':'small'},{'ids':['17'],'fields':['id']},'json-records',True)
        adapter.launch(task,{'id':'a','generation':1,'instructions':'Edit only assigned data.'})
        description=next(c[3]['description'] for c in transport.calls if c[1]=='PATCH')
        for text in ('path:src/assigned.py','inputs.json','"output_contract"','"scope_keys"'):
            self.assertIn(text,description)
        self.assertFalse(adapter.capabilities()['hard_write_scope']['supported'])
    def test_unsupported_launch_rejected_before_network(self):
        transport = RecordingTransport()
        adapter = LightSprintAdapter({'id': 'a', 'mcp_key': 'key'}, transport)
        with self.assertRaises(UnsupportedOperation): adapter.launch(None, None)
        self.assertEqual(transport.calls, [])

    def test_live_observation_fields_are_allowlisted(self):
        transport = RecordingTransport()
        adapter = LightSprintAdapter({'id': 'a', 'mcp_key': 'key'}, transport)
        result = adapter.observe('session-1')
        self.assertEqual(result['status'], 'idle')
        self.assertNotIn('privateMessages', result)
        with self.assertRaises(ValueError): adapter.observe('../../etc')

    def test_resume_is_pending_not_completed(self):
        transport = RecordingTransport()
        adapter = LightSprintAdapter({'id': 'a', 'mcp_key': 'key', 'verified_operations': ['resume', 'cancel']}, transport)
        result = adapter.resume('session-1', {'instructions': 'Continue the exact assignment','data':{'resume_message_id':'client-1'}})
        self.assertEqual(result['state'], 'pending')
        self.assertEqual(transport.calls[0][2], '/api/agent-sessions/session-1/chat')
        self.assertEqual(transport.calls[0][3],{'message':'Continue the exact assignment','clientMessageId':'client-1'})
        self.assertEqual(adapter.cancel('session-1')['state'], 'pending')

    def test_future_registration_does_not_advertise_execution(self):
        adapter = RegisteredAdapter({'adapter': 'ssh'})
        self.assertFalse(adapter.capabilities()['launch']['supported'])
        with self.assertRaises(UnsupportedOperation): adapter.cancel('s')
