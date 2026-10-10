import tempfile
import unittest
from pathlib import Path
from snooze.tasks import TaskRepository
from snooze.outbox import Outbox


class OutboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.repo=TaskRepository(Path(self.tmp.name)/'s.sqlite')
    def test_accepted_delivery_is_not_acknowledged(self):
        box=Outbox(self.repo,lambda channel,payload:{'state':'accepted'})
        id=box.enqueue('incident-1','test',{'project':'p','task':'t','Authorization':'secret'},100)
        receipt=box.deliver_due(100)[0]
        self.assertEqual(receipt.state,'accepted');self.assertIsNone(receipt.acknowledged_at)
        self.assertNotIn('Authorization',str(box.list('p')))
        box.register_coordinator('coord',['p'])
        self.assertTrue(box.acknowledge(id,'coord'))
        self.assertEqual(box.list('p')[0]['state'],'acknowledged')
        self.assertFalse(box.list('p')[0]['resolved'])
    def test_restart_and_recurring_incident_deduplicate(self):
        first=Outbox(self.repo); id=first.enqueue('same','inbox',{'project':'p','message':'Failed'},100)
        restarted=Outbox(TaskRepository(self.repo.path))
        self.assertEqual(restarted.enqueue('same','inbox',{'project':'p','message':'Still failed'},101),id)
        self.assertEqual(len(restarted.list('p')),1)
        self.assertFalse(restarted.acknowledge(id,'unregistered'))
    def test_failed_delivery_has_bounded_persisted_backoff(self):
        calls=[]
        def fail(channel,payload):calls.append(1);raise TimeoutError()
        box=Outbox(self.repo,fail);box.enqueue('i','test',{'project':'p'},100)
        box.deliver_due(100);box.deliver_due(101)
        self.assertEqual(len(calls),1)
        Outbox(TaskRepository(self.repo.path),fail).deliver_due(200)
        box.deliver_due(500);box.deliver_due(1000)
        self.assertEqual(len(calls),3)
        self.assertEqual(box.list('p')[0]['state'],'failed')

    def test_inflight_crash_reuses_delivery_id_with_a_bounded_recovery(self):
        sent=[]
        box=Outbox(self.repo,lambda channel,payload: sent.append(payload['delivery_id']) or {'state':'accepted'})
        id=box.enqueue('i','test',{'project':'p'},100)
        with self.repo.connection(True) as c:
            c.execute('UPDATE outbox SET state="sending",attempts=1,sending_at=100 WHERE id=?',(id,))
        box.deliver_due(110); self.assertEqual(sent,[])
        restarted=Outbox(TaskRepository(self.repo.path),box.deliver)
        restarted.deliver_due(131)
        self.assertEqual(sent,[id])
        self.assertEqual(restarted.list('p')[0]['state'],'accepted')

    def test_concurrent_acknowledgment_is_not_overwritten_by_send_receipt(self):
        box=Outbox(self.repo);box.register_coordinator('coord',['p'])
        def receiver(channel,payload):
            box.acknowledge(payload['delivery_id'],'coord')
            return {'state':'accepted'}
        box.deliver=receiver
        box.enqueue('i','test',{'project':'p'},100);box.deliver_due(100)
        self.assertEqual(box.list('p')[0]['state'],'acknowledged')

    def test_resolved_incident_is_not_sent_late(self):
        sent=[];box=Outbox(self.repo,lambda channel,payload:sent.append(1) or {'state':'accepted'})
        box.enqueue('i','test',{'project':'p'},100)
        box.resolve('i',{'verified_state_change':True});box.deliver_due(200)
        self.assertEqual(sent,[])
