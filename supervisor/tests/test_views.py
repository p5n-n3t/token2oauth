import unittest

from snooze.views import dashboard_state, task_detail


class ViewTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {
            'project': 'trumpfiles.fun',
            'workers': [{
                'id': 'task-1', 'session_id': 'session-1', 'workspace_id': '/a/shared',
                'title': 'Inspect queue', 'instruction': 'Keep it scoped',
                'state': 'running', 'requested_model': 'model-wanted',
                'requested_reasoning': 'high', 'observation': {
                    'status': 'idle', 'model': None, 'effort': None,
                    'Authorization': 'secret', 'http_headers': {'x': 'secret'},
                    'provider_extra': 'private',
                }, 'observed_at': 1000, 'observation_status': 'stale',
                'last_sent': 900,
            }, {
                'id': 'task-2', 'session_id': 'session-2', 'workspace_id': '/b/shared',
                'title': 'Other project', 'state': 'queued', 'observation': None,
                'observed_at': None, 'observation_status': 'unobserved',
            }],
            'incidents': [{'job': 'task-1', 'kind': 'idle', 'message': 'Inspect', 'at': 1200}],
            'settings': {'interval': 300},
        }

    def store(self):
        class Store:
            def snapshot(_self, project_id):
                return self.snapshot
        return Store()

    def test_idle_is_not_completion(self):
        state = dashboard_state(self.store(), 'trumpfiles.fun', {}, 1300)
        slot = state['slots'][0]
        self.assertEqual(slot['provider_state'], 'idle')
        self.assertNotEqual(slot['task_state'], 'complete')
        self.assertIsNone(slot['confirmed_effort'])

    def test_external_owner_disables_dispatch(self):
        state = dashboard_state(self.store(), 'trumpfiles.fun', {'ownership': {'w': 'external'}}, 1300)
        self.assertFalse(state['capabilities']['dispatch']['supported'])

    def test_projection_preserves_provenance_and_allowlists_fields(self):
        state = dashboard_state(self.store(), 'trumpfiles.fun', {}, 1300)
        first, second = state['slots']
        self.assertEqual(first['requested_model'], 'model-wanted')
        self.assertIsNone(first['confirmed_model'])
        self.assertEqual(first['observation_freshness'], 'stale')
        self.assertEqual(second['observation_freshness'], 'unobserved')
        self.assertEqual([s['workspace_id'] for s in state['slots']], ['/a/shared', '/b/shared'])
        rendered = repr(state)
        for private in ('Authorization', 'http_headers', 'provider_extra', 'secret', 'raw_config'):
            self.assertNotIn(private, rendered)

    def test_task_detail_is_allowlisted(self):
        detail = task_detail(self.store(), 'trumpfiles.fun', 'task-1')
        self.assertEqual(detail['instruction'], 'Keep it scoped')
        self.assertNotIn('Authorization', repr(detail))
        self.assertIsNone(task_detail(self.store(), 'trumpfiles.fun', '../task-1'))


if __name__ == '__main__':
    unittest.main()
