import tempfile
import unittest
from pathlib import Path
from snooze.store import Store


class StoreTests(unittest.TestCase):
    def test_active_snapshot_skips_terminal_and_unassigned_rows_without_deleting_history(self):
        with tempfile.TemporaryDirectory() as d:
            s=Store(Path(d)/'s.db')
            s.ingest_jobs('p',[{'id':'active','session_id':'s','state':'running'},
                              {'id':'waiting','session_id':'w','state':'waiting'},
                              {'id':'draft','state':'draft'},{'id':'queued','session_id':'q','state':'queued'},
                              {'id':'finished','session_id':'f','state':'completed'}])
            self.assertEqual({j['id'] for j in s.active_snapshot('p')['workers']},{'active','waiting'})
            self.assertEqual(len(s.snapshot('p')['workers']),5)
    def test_superseded_incident_is_retired_when_status_changes(self):
        with tempfile.TemporaryDirectory() as d:
            s = Store(Path(d) / 's.db')
            s.incident('p', 'a', 'ownership_unknown', 'Unmapped')
            s.retire_other_incidents('p', 'a', 'idle')
            self.assertEqual(s.snapshot('p')['incidents'], [])

    def test_nested_legacy_observation_never_exposes_private_provider_fields(self):
        with tempfile.TemporaryDirectory() as d:
            s = Store(Path(d) / 's.db')
            s.ingest_jobs('p', [{'id': 'a', 'session_id': 's'}])
            s.observe('s', {'status': {'sessionStatus': 'idle', 'credentialRef': 'sensitive-marker'}})
            result = s.snapshot('p')
            self.assertNotIn('sensitive-marker', str(result))
            self.assertEqual(result['workers'][0]['observation']['status'], 'idle')

    def test_import_is_idempotent_and_stale_until_observed(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'state.db'
            s = Store(path)
            jobs = [{'id': 'one', 'session_id': 's1', 'state': 'running', 'requested_model': 'small'}]
            s.ingest_jobs('p', jobs)
            s.ingest_jobs('p', jobs)
            state = s.snapshot('p')
            self.assertEqual(len(state['workers']), 1)
            self.assertEqual(state['workers'][0]['observation_status'], 'unobserved')
            s.observe('s1', {'status': 'idle', 'model': 'confirmed'})
            restored = Store(path).snapshot('p')['workers'][0]
            self.assertEqual(restored['requested_model'], 'small')
            self.assertEqual(restored['observation']['model'], 'confirmed')

    def test_incidents_deduplicate_and_acknowledge(self):
        with tempfile.TemporaryDirectory() as d:
            s = Store(Path(d) / 'state.db')
            s.incident('p', 'one', 'failed', 'Worker failed')
            s.incident('p', 'one', 'failed', 'Worker failed again')
            self.assertEqual(len(s.snapshot('p')['incidents']), 1)
            s.ack('p', 'one', 'failed')
            self.assertEqual(s.snapshot('p')['incidents'], [])
