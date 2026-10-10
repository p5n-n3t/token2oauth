import tempfile
import unittest
from pathlib import Path
from snooze.queueing import add_packet
from snooze.tasks import TaskRepository


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.repo=TaskRepository(Path(self.tmp.name)/'s.sqlite');self.repo.register_project('p','/p')
        self.packet={'id':'one','scope_keys':['record:1'],'input_ref':'inputs.json','input_hash':'a'*64,
                     'requirements':{'model':'small','effort':'low'},'output_contract':{'ids':['1'],'fields':['id','result']},
                     'validator_id':'json-records','instructions':'Process record 1 only.'}
    def test_supplied_approval_does_not_silently_authorize_execution(self):
        self.packet['approved']=True
        add_packet(self.repo,'p',self.packet)
        self.assertFalse(self.repo.spec('one').approved)
        self.assertEqual(self.repo.get('one')['state'],'draft')
    def test_explicit_approval_and_exact_contract_are_saved(self):
        add_packet(self.repo,'p',self.packet,approved=True)
        self.assertTrue(self.repo.spec('one').approved)
        self.assertEqual(self.repo.spec('one').scope_keys,('record:1',))
    def test_unscoped_foreign_project_and_arbitrary_validator_are_rejected(self):
        for field,value in [('project_id','other'),('validator_id','run-shell'),('output_contract',{'ids':['1','1'],'fields':['id']})]:
            with self.subTest(field=field):
                with self.assertRaises(ValueError):add_packet(self.repo,'p',{**self.packet,field:value})

