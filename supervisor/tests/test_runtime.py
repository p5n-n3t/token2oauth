import tempfile
import unittest
from pathlib import Path
from snooze.cli import prime
from snooze.runtime import Runtime
from snooze.domain import CycleReport, TaskSpec


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state'; self.folder = Path(self.tmp.name) / 'repo'; self.folder.mkdir()
        self.config = prime(self.folder, self.state, None)
        self.config['config_path'] = str(Path(self.tmp.name) / 'missing.toml')

    def test_runtime_is_external_by_default_and_records_actual_checks(self):
        runtime = Runtime(self.state, self.config, observe=lambda job: {'status':'running'})
        result = runtime.check(runtime.project)
        self.assertEqual(runtime.repo.project(runtime.project)['executor'], 'external-managed')
        with runtime.repo.connection() as c:
            kinds = [r['kind'] for r in c.execute('SELECT kind FROM events WHERE project=?', (runtime.project,))]
        self.assertIn('monitor_finished', kinds)
        self.assertGreaterEqual(result['finished_at'], result['started_at'])
        self.assertEqual(result['checked'], 0)

    def test_repeated_incident_is_quiet_and_state_change_can_reopen_it(self):
        status = ['failed']
        runtime = Runtime(self.state, self.config, observe=lambda job: {'status':status[0]})
        runtime.store.ingest_jobs(runtime.project, [{'id':'job','session_id':'session'}])
        runtime.check(runtime.project); runtime.check(runtime.project)
        self.assertEqual(len(runtime.outbox.list(runtime.project)), 1)
        self.assertEqual(runtime.outbox.list(runtime.project)[0]['state'], 'inbox')
        status[0] = 'running'; runtime.check(runtime.project)
        self.assertTrue(runtime.outbox.list(runtime.project)[0]['resolved'])
        status[0] = 'failed'; runtime.check(runtime.project)
        self.assertEqual(len(runtime.outbox.list(runtime.project)), 2)

    def test_polling_interval_is_policy_backed_and_wakeable(self):
        runtime = Runtime(self.state, self.config, observe=lambda job: {})
        self.assertEqual(runtime.interval(), 300)
        runtime.scheduler.configure(runtime.project, {'interval':30})
        self.assertEqual(runtime.interval(), 30)
        self.assertTrue(runtime.scheduler.wake.is_set())

    def test_invalid_optional_engine_cannot_stop_monitoring(self):
        self.config['analytics_engine']={'base_url':'https://unapproved.test','allowed_hosts':['other.test'],'project_mapping':'p'}
        runtime=Runtime(self.state,self.config,observe=lambda job:{})
        self.assertEqual(runtime.history.engine_report({})['error_kind'],'configuration_invalid')
        self.assertEqual(runtime.check(runtime.project)['checked'],0)

    def test_malformed_optional_engine_configuration_cannot_stop_monitoring(self):
        self.config['analytics_engine']='not a mapping'
        runtime=Runtime(self.state,self.config,observe=lambda job:{})
        self.assertEqual(runtime.history.engine_report({})['error_kind'],'configuration_invalid')
        self.assertEqual(runtime.check(runtime.project)['checked'],0)

    def test_collector_failure_is_deduplicated_and_verified_completion_resolves_it(self):
        runtime = Runtime(self.state, self.config, observe=lambda job: {})
        runtime.repo.add(TaskSpec('t',runtime.project,('record:1',),'ref','hash',{}, {},'json-records',True))
        attempt=runtime.repo.reserve('t','a',('record:1',),100)
        runtime.repo.update_attempt(attempt.attempt_id,'running',session='s',now=100)
        errors=[{'task':'t','kind':'TimeoutError'}]
        runtime.scheduler.tick=lambda project:CycleReport(100,101,[],errors)
        runtime.check(runtime.project);runtime.check(runtime.project)
        deliveries=runtime.outbox.list(runtime.project)
        self.assertEqual(len(deliveries),1)
        self.assertEqual(deliveries[0]['payload']['kind'],'verification_unavailable')
        errors.clear()
        # Missing a new error alone does not establish that output is correct.
        runtime.check(runtime.project)
        self.assertFalse(runtime.outbox.list(runtime.project)[0]['resolved'])
        runtime.repo.update_attempt(attempt.attempt_id,'complete',data={'validation':'valid'},now=102)
        runtime.repo.release(attempt.attempt_id,{'validated':True})
        runtime.check(runtime.project)
        self.assertTrue(runtime.outbox.list(runtime.project)[0]['resolved'])
