import json
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
import unittest
import urllib.error
import urllib.request
from dataclasses import asdict
from pathlib import Path
from snooze.store import Store
from snooze.tasks import TaskRepository
from snooze.providers import ProviderRegistry
from snooze.scheduler import Scheduler
from snooze.validation import ValidatorRegistry
from snooze.control import Control
from snooze.domain import TaskSpec
from snooze.web import _make_server


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=Store(Path(self.tmp.name)/'s.sqlite');self.repo=TaskRepository(self.store.path)
        self.repo.register_project('p','/p')
        self.registry=ProviderRegistry(self.repo)
        self.scheduler=Scheduler(self.repo,self.registry,ValidatorRegistry())
        self.control=Control(self.repo,self.registry,self.scheduler)
        self.server=_make_server(self.store,'p',None,'test-token',0,control=self.control)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        self.url='http://127.0.0.1:'+str(self.server.server_port)

    def post(self,action,values,revision=0,origin=None,target='p'):
        request=urllib.request.Request(self.url+'/api/v2/control',data=json.dumps({'action':action,'target_id':target,'values':values,'expected_revision':revision}).encode(),headers={'Origin':origin or self.url,'X-Snooze-Token':'test-token','Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request) as r:return r.status,json.loads(r.read())
        except urllib.error.HTTPError as e:return e.code,json.loads(e.read())

    def test_interval_below_minimum_rejected(self):
        self.assertEqual(self.post('policy-config',{'interval':29})[0],400)

    def test_stale_revision_conflicts(self):
        self.assertEqual(self.post('policy-config',{'interval':60})[0],200)
        self.assertEqual(self.post('policy-config',{'interval':90},revision=0)[0],409)
        self.assertEqual(self.scheduler.settings('p')['interval'],60)

    def test_cross_origin_and_secrets_are_rejected(self):
        self.assertEqual(self.post('policy-config',{'interval':60},origin='https://evil.test')[0],403)
        self.assertEqual(self.post('account-config',{'http_headers':{'Authorization':'secret'}},target='a')[0],400)

    def test_provider_connection_failure_is_a_receipt_not_an_http_disconnect(self):
        self.registry.upsert_public_config('a',{},project_id='p')
        def fail(id):raise RuntimeError('Private provider error')
        self.registry.test_connection=fail
        code,body=self.post('account-test',{},revision=1,target='a')
        self.assertEqual(code,503);self.assertEqual(body['state'],'rejected')
        self.assertNotIn('Private provider error',str(body))

    def test_unimplemented_connection_test_is_not_confirmed(self):
        self.registry.upsert_public_config('a',{'adapter':'ollama'},project_id='p')
        code,body=self.post('account-test',{},revision=1,target='a')
        self.assertEqual(code,409)
        self.assertEqual(body['state'],'rejected')
        self.assertIn('unsupported',body['reason'].lower())

    def test_concurrent_cancel_with_one_revision_sends_one_provider_mutation(self):
        self.registry.upsert_public_config('a',{},project_id='p')
        self.repo.set_executor('p','snooze',quiesced=True,reconciled=True)
        self.repo.add(TaskSpec('t','p',('record:1',),'ref','h',{}, {},'json-records',True))
        receipt=self.repo.reserve('t','a',('record:1',),100)
        self.repo.update_attempt(receipt.attempt_id,'running',session='s',now=100)
        calls=[]
        class Adapter:
            def capabilities(self):return {'cancel':{'supported':True}}
            def cancel(self,session):calls.append(session)
        self.registry.overrides['a']=Adapter()
        revision=self.repo.get('t')['revision']
        barrier=threading.Barrier(2);original=self.repo.get
        def get(id):
            row=original(id)
            if id=='t' and row['revision']==revision:barrier.wait(timeout=3)
            return row
        self.repo.get=get
        with ThreadPoolExecutor(2) as pool:
            results=list(pool.map(lambda _:self.control.apply('p','operator','cancel','t',{},revision),range(2)))
        self.assertEqual(calls,['s'])
        self.assertEqual(sorted(r.status_code for r in results),[202,409])

    def test_external_owner_cannot_pretend_to_pause_dispatcher(self):
        code,body=self.post('dispatch-pause',{'paused':True})
        self.assertEqual(code,409)
        self.assertEqual(body['state'],'rejected')

    def test_approve_is_versioned_and_persists_after_restart(self):
        self.repo.add(TaskSpec('t','p',('record:1',),'ref','h',{}, {},'json-records',False))
        receipt=self.control.apply('p','operator','approve','t',{},0)
        self.assertEqual(receipt.state,'confirmed')
        self.assertTrue(TaskRepository(self.repo.path).spec('t').approved)

    def test_emergency_stop_cannot_be_bypassed_by_retry(self):
        self.repo.set_executor('p','snooze',quiesced=True,reconciled=True)
        self.repo.add(TaskSpec('t','p',('record:1',),'ref','h',{}, {},'json-records',True))
        self.scheduler.configure('p',{'emergency_stop':True})
        receipt=self.control.apply('p','operator','retry','t',{'override_pause':True},0)
        self.assertEqual(receipt.state,'rejected')
        self.assertEqual(self.repo.get('t')['state'],'queued')
