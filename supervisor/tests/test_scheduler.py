import tempfile
import threading
import unittest
from pathlib import Path
from snooze.domain import TaskSpec
from snooze.tasks import TaskRepository
from snooze.providers import ProviderRegistry
from snooze.scheduler import Scheduler
from snooze.validation import ValidatorRegistry


class FakeAdapter:
    def __init__(self): self.launches=[]; self.resumes=[]; self.artifact=None; self.state='running'; self.timeout=False
    def capabilities(self): return {op:{'supported':True,'reason':None} for op in ('launch','observe','collect','resume','cancel','reconcile')}
    def launch(self, task, attempt):
        self.launches.append(attempt['idempotency_key'])
        if self.timeout: raise TimeoutError('Acceptance uncertain')
        return {'session_id':'session-'+task.id,'state':'running'}
    def observe(self, session): return {'status':self.state,'model':'small','effort':'low'}
    def collect(self, attempt): return self.artifact
    def reconcile(self, attempt): return None
    def resume(self, session, attempt): self.resumes.append(session); return {'state':'pending'}
    def cancel(self, session): return {'state':'pending'}


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.repo=TaskRepository(Path(self.tmp.name)/'s.sqlite'); self.repo.register_project('p','/p')
        self.registry=ProviderRegistry(self.repo)
        self.registry.upsert_public_config('a',{'adapter':'ssh','models':['small'],'efforts':['low'],'capacity':1,'health':'healthy','allow_unknown_quota':True},trusted=True,project_id='p')
        self.adapter=FakeAdapter(); self.registry.overrides['a']=self.adapter
        self.scheduler=Scheduler(self.repo,self.registry,ValidatorRegistry(),clock=lambda:100)
        self.scheduler.configure('p',{'pause_dispatch':False,'allow_unknown_quota':True})
        self.repo.set_executor('p','snooze',quiesced=True,reconciled=True)
    def add(self,id='t',scope='1'):
        self.repo.add(TaskSpec(id,'p',('record:'+scope,),'fixture','h',{'model':'small','effort':'low'},{'ids':[scope],'fields':['id']},'json-records',True),now=90)
    def test_idle_without_artifact_is_not_complete(self):
        self.add(); self.scheduler.tick('p',100); self.adapter.state='idle'; self.scheduler.tick('p',101)
        self.assertNotEqual(self.repo.get('t')['state'],'complete')
        self.assertEqual(len(self.adapter.launches),1)
    def test_busy_without_fresh_progress_alerts_without_duplicate_execution(self):
        self.add();self.scheduler.tick('p',100)
        self.adapter.observe=lambda session:{'status':'running','last_event_age_ms':1000000,'relay_alive':True}
        report=self.scheduler.tick('p',1100)
        self.assertIn({'task':'t','action':'stalled_needs_inspection'},report.decisions)
        self.assertEqual(len(self.adapter.launches),1);self.assertEqual(self.adapter.resumes,[])
        self.assertEqual(self.repo.active('p')[0]['data']['incident_kind'],'stalled')
        self.adapter.observe=lambda session:{'status':'running','last_event_age_ms':0,'relay_alive':True}
        self.scheduler.tick('p',1101)
        self.assertIsNone(self.repo.active('p')[0]['data']['incident_kind'])

    def test_presets_and_monitor_bounds_are_explainable_and_finite(self):
        settings=self.scheduler.configure('p',{'mode':'conservative'})
        self.assertEqual(settings['max_concurrent'],4)
        self.assertEqual(settings['max_recoveries'],1)
        for values in ({'reserve':float('nan')},{'native_reserve':-1},{'observation_workers':9},{'request_timeout':31}):
            with self.subTest(values=values),self.assertRaises(ValueError):self.scheduler.configure('p',values)
    def test_valid_output_finishes_before_replacement(self):
        self.add(); self.add('u','2'); self.scheduler.tick('p',100)
        self.adapter.artifact={'records':[{'id':'1'}]}; self.adapter.state='idle'
        self.scheduler.tick('p',101)
        self.assertEqual(self.repo.get('t')['state'],'complete')
        self.assertEqual(len(self.adapter.launches),2)

    def test_late_saved_generation_is_quarantined_without_blocking_current_owner(self):
        self.add();self.scheduler.tick('p',100)
        self.adapter.artifact={'generation':0,'records':[{'id':'1'}]}
        self.scheduler.tick('p',101)
        self.assertEqual(self.repo.get('t')['state'],'running')
        self.assertEqual(self.repo.artifacts(self.repo.active('p')[0]['id'])[0]['state'],'quarantined')
    def test_timeout_stays_reserved_across_restart_no_duplicate_launch(self):
        self.add(); self.adapter.timeout=True; self.scheduler.tick('p',100)
        new=Scheduler(self.repo,self.registry,ValidatorRegistry())
        new.tick('p',10000)
        self.assertEqual(len(self.adapter.launches),1)
        self.assertEqual(self.repo.active('p')[0]['state'],'ambiguous')
    def test_pause_emergency_external_and_shadow_never_launch(self):
        self.add(); self.scheduler.configure('p',{'pause_dispatch':True}); self.scheduler.tick('p',100)
        self.assertEqual(self.adapter.launches,[])
        self.scheduler.configure('p',{'pause_dispatch':False,'emergency_stop':True}); self.scheduler.tick('p',101)
        self.assertEqual(self.adapter.launches,[])
        self.scheduler.configure('p',{'emergency_stop':False})
        for owner in ('external-managed','shadow'):
            self.repo.set_executor('p',owner); self.scheduler.tick('p',102)
            self.assertEqual(self.adapter.launches,[])
    def test_two_ticks_share_exclusive_reservation(self):
        self.add(); other=Scheduler(self.repo,self.registry,ValidatorRegistry())
        threads=[threading.Thread(target=s.tick,args=('p',100)) for s in (self.scheduler,other)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(len(self.adapter.launches),1)

    def test_cancel_receipt_releases_only_after_provider_acknowledgment(self):
        self.add(); self.scheduler.tick('p',100)
        attempt=self.repo.active('p')[0]
        self.repo.update_attempt(attempt['id'],'cancel_pending',now=101)
        self.scheduler.tick('p',102); self.assertEqual(len(self.repo.active('p')),1)
        self.adapter.state='cancelled'; self.scheduler.tick('p',103)
        self.assertEqual(self.repo.active('p'),[])
        self.assertEqual(self.repo.get('t')['state'],'cancelled')

    def test_policy_changed_between_routing_and_reservation_cannot_launch(self):
        self.add()
        reserve=self.repo.reserve
        def racing(*args,**kwargs):
            self.scheduler.configure('p',{'emergency_stop':True})
            return reserve(*args,**kwargs)
        self.repo.reserve=racing
        self.scheduler.tick('p',100)
        self.assertEqual(self.adapter.launches,[])

    def test_broken_account_cools_down_without_blocking_healthy_work(self):
        self.registry.upsert_public_config('a',{'capacity':4})
        self.registry.upsert_public_config('b',{'adapter':'ssh','models':['small'],'efforts':['low'],'capacity':2,'health':'healthy','allow_unknown_quota':True},trusted=True,project_id='p')
        healthy=FakeAdapter();self.registry.overrides['b']=healthy
        self.adapter.timeout=True;self.add('first','1');self.add('second','2');self.add('third','3')
        self.scheduler.tick('p',100)
        self.assertEqual(len(self.adapter.launches),1)
        self.assertEqual(len(healthy.launches),2)
        self.assertGreater(self.registry.get('a')['cooldown_until'],100)

    def test_other_project_occupancy_does_not_hide_a_free_healthy_route(self):
        self.registry.upsert_public_config('b',{'adapter':'ssh','models':['small'],'efforts':['low'],'capacity':1,'health':'healthy','allow_unknown_quota':True},trusted=True,project_id='p')
        healthy=FakeAdapter();self.registry.overrides['b']=healthy
        self.repo.register_project('q','/q')
        self.repo.add(TaskSpec('other','q',('record:9',),'ref','h',{'model':'small'},{'ids':['9'],'fields':['id']},'json-records',True))
        self.repo.reserve('other','a',('record:9',),100)
        self.add();self.scheduler.tick('p',100)
        self.assertEqual(self.adapter.launches,[])
        self.assertEqual(len(healthy.launches),1)
    def test_recoveries_have_persisted_backoff_and_stop_after_two(self):
        self.add(); self.scheduler.tick('p',100); self.adapter.state='failed'
        self.scheduler.tick('p',101); self.scheduler.tick('p',102)
        self.assertEqual(len(self.adapter.resumes),1)
        self.scheduler.tick('p',500); self.scheduler.tick('p',1000)
        self.assertEqual(len(self.adapter.resumes),2)
        self.assertEqual(self.repo.active('p')[0]['state'],'blocked')
