import json
import unittest
from urllib.error import URLError

from snooze.analytics import HistoryFilter
from snooze.analytics_engine import EngineClient


class Response:
    def __init__(self, payload, status=200, headers=None):
        self.payload = payload
        self.status = status
        self.headers = headers or {}
    def read(self, size=-1): return json.dumps(self.payload).encode()[:size]
    def getcode(self): return self.status
    def __enter__(self): return self
    def __exit__(self, *args): pass


class RawResponse(Response):
    def read(self, size=-1): return self.payload[:size]


class AnalyticsEngineTests(unittest.TestCase):
    def test_safe_field_names_do_not_make_credential_like_text_public(self):
        result=EngineClient._sanitize({'name':'Bearer private-value','model':'lsat_privatevalue123'})
        self.assertNotIn('private-value',str(result));self.assertNotIn('lsat_private',str(result))

    def setUp(self):
        self.filters = HistoryFilter((), None, None, 'UTC', (), (), (), None)

    def test_absent_engine_is_unavailable(self):
        report = EngineClient().query('usage_summary', self.filters)
        self.assertEqual(report.state, 'unavailable')
        self.assertEqual(report.error_kind, 'not_configured')

    def test_session_children_are_normalized_as_safe_report_rows(self):
        report=EngineClient()._normalize('session_children',[{'id':'child-1','model':'small','content':'private prompt'}],'fixture-v1',self.filters,{})
        self.assertEqual(report.payload['children'][0]['id'],'child-1')
        self.assertNotIn('private prompt',str(report))

    def test_unknown_report_rejected_before_transport(self):
        called = []
        client = EngineClient('https://engine.example', allowed_hosts=('engine.example',), transport=lambda *a: called.append(a))
        with self.assertRaises(ValueError): client.query('../sessions/delete', self.filters)
        self.assertEqual(called, [])

    def test_configured_host_must_be_explicitly_in_scope(self):
        with self.assertRaises(ValueError): EngineClient('https://engine.example', allowed_hosts=('other.example',))

    def test_external_plain_http_and_unbounded_timeout_are_rejected(self):
        with self.assertRaises(ValueError):
            EngineClient('http://engine.example', allowed_hosts=('engine.example',))
        with self.assertRaises(ValueError):
            EngineClient('https://engine.example', allowed_hosts=('engine.example',), timeout=30)

    def test_redirect_is_not_followed_and_report_is_unavailable(self):
        client = EngineClient('https://engine.example', allowed_hosts=('engine.example',),
                              transport=lambda request, timeout: Response({}, 302, {'Location': 'https://evil.example/'}))
        report = client.query('usage_summary', self.filters)
        self.assertEqual(report.error_kind, 'redirect_blocked')
        self.assertEqual(report.state, 'unavailable')

    def test_timeouts_malformed_json_and_contract_mismatch_are_typed(self):
        timeout = EngineClient('https://engine.example', allowed_hosts=('engine.example',),
                               transport=lambda *a: (_ for _ in ()).throw(TimeoutError()))
        def malformed_transport(request, timeout):
            return Response(self.version()) if request.full_url.endswith('/api/v1/version') else RawResponse(b'not json')
        malformed = EngineClient('https://engine.example', allowed_hosts=('engine.example',), transport=malformed_transport)
        def mismatch_transport(request, timeout):
            return Response({'version': '4.2', 'commit': 'abc123', 'api_version': 999})
        mismatch = EngineClient('https://engine.example', allowed_hosts=('engine.example',), transport=mismatch_transport)
        self.assertEqual(timeout.query('usage_summary', self.filters).error_kind, 'timeout')
        self.assertEqual(malformed.query('usage_summary', self.filters).error_kind, 'malformed_json')
        self.assertEqual(mismatch.query('usage_summary', self.filters).error_kind, 'contract_mismatch')

    def test_normalized_report_is_cached_by_every_filter_and_hides_private_fields(self):
        calls = []
        def transport(request, timeout):
            calls.append(request.full_url)
            if request.full_url.endswith('/api/v1/version'):
                return Response(self.version())
            return Response({'projects': {}, 'from': '2026-01-01', 'to': '2026-01-01',
                             'totals': {'inputTokens': 5, 'outputTokens': 0, 'authorization': 'secret'},
                             'daily': [], 'projectTotals': [], 'modelTotals': [],
                             'transcript': 'private'})
        client = EngineClient('https://engine.example', allowed_hosts=('engine.example',), transport=transport)
        first = client.query('usage_summary', self.filters)
        second = client.query('usage_summary', self.filters)
        self.assertEqual(len(calls), 2)
        self.assertEqual(first, second)
        self.assertNotIn('authorization', str(first.payload))
        self.assertNotIn('private', str(first.payload))
        self.assertNotIn('secret', repr(first))
        different = HistoryFilter(('p',), None, None, 'UTC', (), (), (), None)
        client.query('usage_summary', different)
        self.assertEqual(len(calls), 3)

    def test_connection_test_uses_a_read_only_allowlisted_report(self):
        calls = []
        def transport(request, timeout):
            calls.append((request.get_method(), request.full_url))
            if request.full_url.endswith('/api/v1/version'):
                return Response(self.version())
            return Response({'active_days': 1, 'active_projects': 1, 'agents': {}, 'avg_messages': 2,
                             'concentration': 1, 'median_messages': 2, 'models': [],
                             'most_active_project': 'p', 'p90_messages': 2, 'token_reporting_sessions': 0,
                             'total_messages': 2, 'total_output_tokens': 0, 'total_sessions': 1})
        client = EngineClient('https://engine.example', allowed_hosts=('engine.example',), transport=transport)
        report = client.test_connection()
        self.assertEqual(report.state, 'available')
        self.assertEqual([call[0] for call in calls], ['GET', 'GET'])
        self.assertIn('/api/v1/version', calls[0][1])
        self.assertIn('/api/v1/analytics/summary?', calls[1][1])

    def test_auth_header_is_used_for_transport_but_never_returned(self):
        seen = []
        def transport(request, timeout):
            seen.append(request.get_header('Authorization'))
            if request.full_url.endswith('/api/v1/version'):
                return Response(self.version())
            return Response({'active_days': 1, 'active_projects': 1, 'agents': {}, 'avg_messages': 2,
                             'concentration': 1, 'median_messages': 2, 'models': [],
                             'most_active_project': 'p', 'p90_messages': 2, 'token_reporting_sessions': 0,
                             'total_messages': 2, 'total_output_tokens': 0, 'total_sessions': 1,
                             'authorization': 'do not copy'})
        client = EngineClient('https://engine.example', allowed_hosts=('engine.example',),
                              bearer_token='secret-engine-token', transport=transport)
        report = client.query('analytics_summary', self.filters)
        self.assertEqual(seen, ['Bearer secret-engine-token', 'Bearer secret-engine-token'])
        self.assertNotIn('secret-engine-token', repr(report))
        self.assertNotIn('authorization', str(report.payload))

    def test_cache_expires_and_query_carries_all_filter_dimensions(self):
        calls = []
        now = [0.0]
        def transport(request, timeout):
            calls.append(request.full_url)
            if request.full_url.endswith('/api/v1/version'):
                return Response(self.version())
            return Response({'active_days': 1, 'active_projects': 1, 'agents': {}, 'avg_messages': 2,
                             'concentration': 1, 'median_messages': 2, 'models': [],
                             'most_active_project': 'p', 'p90_messages': 2, 'token_reporting_sessions': 0,
                             'total_messages': 2, 'total_output_tokens': 0, 'total_sessions': 1})
        filters = HistoryFilter(('repo:one',), 1, 2, 'Asia/Tokyo', (), ('model',), (), None)
        client = EngineClient('https://engine.example', allowed_hosts=('engine.example',),
                              transport=transport, cache_ttl=3, clock=lambda: now[0])
        client.query('analytics_summary', filters)
        client.query('analytics_summary', filters)
        self.assertEqual(len(calls), 2)
        for value in ('from=1970-01-01', 'to=1970-01-01', 'project=repo%3Aone',
                      'model=model', 'timezone=Asia%2FTokyo'):
            self.assertIn(value, calls[1])
        now[0] = 4
        client.query('analytics_summary', filters)
        self.assertEqual(len(calls), 4)

    def test_session_routes_require_an_id_and_encode_it_as_one_path_segment(self):
        seen = []
        def transport(request, timeout):
            seen.append(request.full_url)
            if request.full_url.endswith('/api/v1/version'):
                return Response(self.version())
            return Response({'session_id': 's/../x', 'agent': 'codex', 'project': 'p',
                             'total_output_tokens': 0, 'peak_context_tokens': 0, 'has_token_data': False,
                             'cost': {}, 'has_cost': False, 'models': [], 'unpriced_models': [],
                             'breakdown_count': 0, 'breakdown': [], 'server_running': False})
        client = EngineClient('https://engine.example', allowed_hosts=('engine.example',), transport=transport)
        with self.assertRaises(ValueError): client.query('session_usage', self.filters)
        filters = HistoryFilter((), None, None, 'UTC', (), (), (), 's/../x')
        report = client.query('session_usage', filters)
        self.assertEqual(report.state, 'available')
        self.assertIn('/sessions/s%2F..%2Fx/usage', seen[-1])

    @staticmethod
    def version():
        return {'version': '1.2.3', 'commit': 'abc123', 'build_date': '2026-10-07',
                'api_version': 1, 'insight_generation_available': False,
                'session_stats_available': True}

    def test_real_native_schema_is_normalized_with_provenance_and_no_envelope_assumptions(self):
        def transport(request, timeout):
            if request.full_url.endswith('/api/v1/version'):
                return Response(self.version())
            return Response({'from': '2026-10-01', 'to': '2026-10-07', 'projects': {},
                             'totals': {'inputTokens': 15, 'outputTokens': 9,
                                        'totalCost': {'amount': 2.5, 'currency': 'USD'}},
                             'daily': [], 'projectTotals': [], 'modelTotals': [],
                             'sessionCounts': {'total': 3}})
        client = EngineClient('https://engine.example', allowed_hosts=('engine.example',), transport=transport)
        report = client.query('usage_summary', HistoryFilter((), 1790812800, 1791331200, 'UTC', (), (), (), None))
        self.assertEqual(report.state, 'available')
        self.assertEqual(report.source_version, '1.2.3+abc123 (API 1)')
        self.assertEqual(report.payload['totals']['inputTokens'], 15)
        self.assertEqual(report.source_window['granularity'], 'calendar_day')
        self.assertIn('response_shape', report.coverage)
        self.assertEqual(report.coverage['token_coverage']['state'], 'unavailable')

    def test_filters_the_adapter_cannot_represent_fail_closed_as_typed_unavailable(self):
        calls = []
        client = EngineClient('https://engine.example', allowed_hosts=('engine.example',),
                              transport=lambda request, timeout: calls.append(request))
        filters = HistoryFilter((), None, None, 'UTC', ('account-1',), (), (), None)
        report = client.query('analytics_summary', filters)
        self.assertEqual(report.error_kind, 'unsupported_filter')
        self.assertEqual(calls, [])

    def test_response_shape_must_match_the_selected_endpoint(self):
        def transport(request, timeout):
            if request.full_url.endswith('/api/v1/version'):
                return Response(self.version())
            return Response({'sessions': []})
        client = EngineClient('https://engine.example', allowed_hosts=('engine.example',), transport=transport)
        report = client.query('usage_summary', self.filters)
        self.assertEqual(report.state, 'unavailable')
        self.assertEqual(report.error_kind, 'contract_mismatch')


if __name__ == '__main__':
    unittest.main()
