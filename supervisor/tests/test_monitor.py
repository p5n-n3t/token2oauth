import tempfile
import unittest
from pathlib import Path
from snooze.store import Store
from snooze.monitor import Monitor


class MonitorTests(unittest.TestCase):
    def test_overlapping_check_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(Path(d) / 's.db')
            monitor = Monitor(store, lambda job: {'status': 'running'})
            monitor.lock.acquire()
            try:
                with self.assertRaises(RuntimeError):
                    monitor.check('p')
            finally:
                monitor.lock.release()

    def test_failed_poll_does_not_hide_healthy_observation(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(Path(d) / 's.db')
            store.ingest_jobs('p', [{'id': 'a', 'session_id': 'a'}, {'id': 'b', 'session_id': 'b'}])
            def observe(job):
                if job['id'] == 'a':
                    raise TimeoutError('API timeout')
                return {'status': 'running', 'model': 'small'}
            Monitor(store, observe).check('p')
            state = store.snapshot('p')
            self.assertEqual(state['workers'][1]['observation']['status'], 'running')
            self.assertEqual(state['workers'][0]['observation']['status'], 'unavailable')
            self.assertEqual(len(state['incidents']), 1)

    def test_idle_is_an_incident_not_a_success(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(Path(d) / 's.db')
            store.ingest_jobs('p', [{'id': 'a', 'session_id': 'a'}])
            Monitor(store, lambda job: {'status': 'idle'}).check('p')
            self.assertEqual(store.snapshot('p')['incidents'][0]['kind'], 'idle')
