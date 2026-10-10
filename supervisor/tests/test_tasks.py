import tempfile
import threading
import unittest
from pathlib import Path
from snooze.domain import TaskSpec
from snooze.tasks import TaskRepository


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = TaskRepository(Path(self.tmp.name) / 'state.sqlite')
        self.repo.register_project('p', '/a/shared')

    def task(self, id, scopes=('record:1',), approved=True):
        spec = TaskSpec(id, 'p', scopes, 'fixture', 'hash', {}, {'kind': 'json'}, 'json-records', approved, ())
        self.repo.add(spec, instructions='Process the assigned record only.')
        return spec

    def test_two_concurrent_claims_cannot_overlap(self):
        self.task('a'); self.task('b')
        barrier = threading.Barrier(2)
        outcomes = []
        def claim(id):
            barrier.wait()
            try:
                self.repo.reserve(id, 'account', ('record:1',), 100)
                outcomes.append('reserved')
            except ValueError:
                outcomes.append('conflict')
        threads = [threading.Thread(target=claim, args=(id,)) for id in ('a', 'b')]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertCountEqual(outcomes, ['reserved', 'conflict'])

    def test_public_queue_page_selects_only_summary_and_exact_total(self):
        for index in range(30):
            self.task(str(index),('record:'+str(index),))
        self.repo.register_project('q','/q')
        self.repo.add(TaskSpec('foreign','q',('record:x',),'ref','hash',{}, {},'json-records'))
        page=self.repo.queue_page('p',offset=10,limit=5)
        self.assertEqual(page['total'],30);self.assertEqual(len(page['tasks']),5)
        self.assertNotIn('spec',repr(page))
        self.assertNotIn('instructions',repr(page))
        self.assertTrue(page['has_more'])

    def test_directory_scope_conflicts_with_child(self):
        self.task('a', ('path:src/',)); self.task('b', ('path:src/app.py',))
        self.repo.reserve('a', 'account', ('path:src/',), 100)
        with self.assertRaises(ValueError):
            self.repo.reserve('b', 'other', ('path:src/app.py',), 100)

    def test_late_generation_is_quarantined(self):
        self.task('a')
        receipt = self.repo.reserve('a', 'account', ('record:1',), 100)
        artifact = {'url': 'https://example.org/result', 'sha256': 'a' * 64}
        self.assertEqual(self.repo.record_artifact(receipt.attempt_id, receipt.generation - 1, artifact), 'quarantined')
        self.assertEqual(self.repo.artifacts(receipt.attempt_id)[0]['state'], 'quarantined')

    def test_expired_lease_is_not_evidence_for_release(self):
        self.task('a')
        receipt = self.repo.reserve('a', 'account', ('record:1',), 100)
        self.assertFalse(self.repo.release(receipt.attempt_id, {'lease_expired': True}))
        with self.assertRaises(ValueError):
            self.repo.reserve('a', 'other', ('record:1',), 10000)
        self.assertTrue(self.repo.release(receipt.attempt_id, {'confirmed_inactive': True}))

    def test_pre_io_fence_rejection_releases_only_unlaunched_reservation(self):
        self.task('a')
        receipt=self.repo.reserve('a','account',('record:1',),100)
        self.repo.update_attempt(receipt.attempt_id,'starting',now=101)
        self.assertTrue(self.repo.abandon_pre_io(receipt.attempt_id,'dispatch paused',now=102))
        self.assertEqual(self.repo.active('p'),[])
        self.assertEqual(self.repo.get('a')['state'],'blocked')

    def test_pre_io_release_refuses_ambiguous_remote_ownership(self):
        self.task('a')
        receipt=self.repo.reserve('a','account',('record:1',),100)
        self.repo.update_attempt(receipt.attempt_id,'ambiguous',now=101)
        self.assertFalse(self.repo.abandon_pre_io(receipt.attempt_id,'unknown result',now=102))
        self.assertEqual(len(self.repo.active('p')),1)

    def test_handover_requires_attestation_and_no_unreconciled_scope(self):
        with self.assertRaises(ValueError):self.repo.set_executor('p','snooze')
        self.task('owned')
        attempt=self.repo.reserve('owned','account',('record:1',),100)
        with self.assertRaises(ValueError):self.repo.set_executor('p','snooze',quiesced=True,reconciled=True)
        self.assertEqual(self.repo.project('p')['executor'],'external-managed')
        self.repo.release(attempt.attempt_id,{'confirmed_inactive':True})
        self.repo.set_executor('p','snooze',quiesced=True,reconciled=True)
        self.assertEqual(self.repo.project('p')['executor'],'snooze')

    def test_unapproved_task_and_changed_scope_rejected(self):
        self.task('a', approved=False)
        with self.assertRaises(ValueError): self.repo.reserve('a', 'account', ('record:1',), 100)
        self.task('b')
        with self.assertRaises(ValueError): self.repo.reserve('b', 'account', ('record:2',), 100)

    def test_same_basename_projects_remain_distinct(self):
        self.repo.register_project('q', '/b/shared')
        self.repo.add_alias('p', '/new/shared')
        self.assertEqual(self.repo.resolve_project('/new/shared'), 'p')
        self.assertEqual(self.repo.resolve_project('/b/shared'), 'q')

    def test_reservation_survives_restart_with_idempotency_key(self):
        self.task('a')
        receipt = self.repo.reserve('a', 'account', ('record:1',), 100)
        reloaded = TaskRepository(self.repo.path)
        self.assertEqual(reloaded.attempt(receipt.attempt_id)['idempotency_key'], receipt.idempotency_key)
        self.assertEqual(reloaded.get('a')['state'], 'reserved')

    def test_unsafe_scope_rejected(self):
        with self.assertRaises(ValueError): self.task('a', ('path:../../etc',))

    def test_account_capacity_is_enforced_inside_reservation_transaction(self):
        from snooze.providers import ProviderRegistry
        ProviderRegistry(self.repo).upsert_public_config('a', {'capacity':1})
        self.task('first', ('record:1',)); self.task('second', ('record:2',))
        self.repo.reserve('first','a',('record:1',),100)
        with self.assertRaises(ValueError): self.repo.reserve('second','a',('record:2',),100)
