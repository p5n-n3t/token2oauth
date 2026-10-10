import json
import tempfile
import time
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from snooze.analytics import Analytics, HistoryFilter
from snooze.history_ingest import HistoryIngestor
from snooze.tasks import TaskRepository


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = TaskRepository(Path(self.tmp.name) / 'history.sqlite')
        self.repo.register_project('p1', '/work/alpha')
        self.repo.register_project('p2', '/other/alpha')
        self.repo.add_alias('p1', 'repo:one')
        self.analytics = Analytics(self.repo)

    def filters(self, **overrides):
        values = dict(project_ids=(), from_utc=None, to_utc=None, timezone='UTC',
                      accounts=(), models=(), efforts=(), session_id=None)
        values.update(overrides)
        return HistoryFilter(**values)

    def event(self, project, kind, at, data=None, task=None, attempt=None):
        with self.repo.connection(True) as conn:
            self.repo.event(conn, project, kind, data or {}, task, attempt, at)

    def test_missing_usage_is_null_not_zero(self):
        report = self.analytics.history_report(self.filters())
        self.assertIsNone(report['summary']['input_tokens']['value'])
        self.assertEqual(report['summary']['input_tokens']['coverage']['observed'], 0)
        self.assertIsNone(report['summary']['input_tokens']['coverage']['eligible'])
        self.assertIsNone(report['summary']['input_tokens']['coverage']['missing'])
        self.assertEqual(report['coverage']['usage']['state'], 'unavailable')

    def test_only_validated_attempt_completion_counts_as_throughput(self):
        self.event('p1', 'attempt_complete', 200, {'validation': 'valid'}, 't1', 'a1')
        self.event('p1', 'attempt_complete', 210, {'validation': 'invalid'}, 't2', 'a2')
        self.event('p1', 'provider_observed', 220, {'status': 'idle'}, 't3', 'a3')
        report = self.analytics.history_report(self.filters())
        self.assertEqual(report['summary']['validated_throughput']['value'], 1)
        self.assertEqual(report['summary']['task_outcomes']['value'], 1)

    def test_retry_and_validation_failure_rates_use_attempt_samples(self):
        with self.repo.connection(True) as conn:
            conn.executemany(
                'INSERT INTO attempts(id,task,project,account,generation,idempotency_key,session,state,scopes,started_at,lease_until,released_at,recovery_count,due_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [('a1', 't1', 'p1', 'acct', 1, 'key-1', None, 'complete', '[]', 100, 200, 200, 0, 0, '{}'),
                 ('a2', 't2', 'p1', 'acct', 2, 'key-2', None, 'complete', '[]', 110, 200, 200, 0, 0, '{}')])
        self.event('p1', 'attempt_complete', 150, {'validation': 'valid'}, 't1', 'a1')
        self.event('p1', 'attempt_blocked', 160, {'validation': 'invalid'}, 't2', 'a2')
        report = self.analytics.history_report(self.filters())
        self.assertEqual(report['summary']['retry_attempts']['value'], 1)
        self.assertEqual(report['summary']['retry_rate']['value'], 0.5)
        self.assertEqual(report['summary']['retry_rate']['coverage']['eligible'], 2)
        self.assertEqual(report['summary']['validation_failure_rate']['value'], 0.5)
        self.assertEqual(report['summary']['validation_failure_rate']['coverage']['eligible'], 2)

    def test_recovery_duration_spans_failed_attempt_to_later_validated_attempt(self):
        self.event('p1', 'provider_observed', 100, {'status': 'failed'}, 't1', 'a1')
        self.event('p1', 'attempt_awaiting_output', 105, {'recovery_count': 1}, 't1', 'a1')
        self.event('p1', 'attempt_complete', 125, {'validation': 'valid'}, 't1', 'a2')
        report = self.analytics.history_report(self.filters())
        self.assertEqual(report['summary']['recoveries']['value'], 1)
        self.assertEqual(report['summary']['time_to_recovery_p50']['value'], 25)

    def test_queue_latency_and_run_duration_are_separate_with_samples(self):
        with self.repo.connection(True) as conn:
            conn.execute('INSERT INTO tasks(id,project,spec,instructions,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                         ('t1', 'p1', '{}', '', 'complete', 100, 220))
        self.event('p1', 'attempt_reserved', 130, {}, 't1', 'a1')
        self.event('p1', 'attempt_starting', 150, {}, 't1', 'a1')
        self.event('p1', 'attempt_complete', 220, {'validation': 'valid'}, 't1', 'a1')
        report = self.analytics.history_report(self.filters())
        self.assertEqual(report['summary']['queue_latency_p50']['value'], 30)
        self.assertEqual(report['summary']['queue_latency_p50']['coverage']['observed'], 1)
        self.assertEqual(report['summary']['run_duration_p50']['value'], 70)

    def test_timezone_heatmap_handles_spring_dst_without_inventing_missing_hour(self):
        first = datetime(2026, 3, 8, 6, 30, tzinfo=timezone.utc).timestamp()
        second = datetime(2026, 3, 8, 7, 30, tzinfo=timezone.utc).timestamp()
        self.event('p1', 'attempt_reserved', first, {}, 't1', 'a1')
        self.event('p1', 'attempt_reserved', second, {}, 't2', 'a2')
        report = self.analytics.history_report(self.filters(timezone='America/New_York'))
        day = next(row for row in report['heatmap'] if row['date'] == '2026-03-08')
        self.assertEqual(day['hours'][1], 1)
        self.assertEqual(day['hours'][2], 0)
        self.assertEqual(day['hours'][3], 1)
        self.assertFalse(day['hours_present'][2])
        self.assertTrue(day['hours_present'][1])
        self.assertTrue(day['hours_present'][3])

    def test_timezone_heatmap_combines_both_fall_back_hours_and_marks_the_hour_present(self):
        first = datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc).timestamp()
        second = datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc).timestamp()
        self.event('p1', 'attempt_reserved', first, {}, 't1', 'a1')
        self.event('p1', 'attempt_reserved', second, {}, 't2', 'a2')
        report = self.analytics.history_report(self.filters(timezone='America/New_York'))
        day = next(row for row in report['heatmap'] if row['date'] == '2026-11-01')
        self.assertEqual(day['hours'][1], 2)
        self.assertTrue(day['hours_present'][1])

    def test_timezone_calendar_series_respects_local_midnight(self):
        before = datetime(2026, 1, 2, 4, 30, tzinfo=timezone.utc).timestamp()
        after = datetime(2026, 1, 2, 5, 30, tzinfo=timezone.utc).timestamp()
        self.event('p1', 'attempt_reserved', before, {}, 't1', 'a1')
        self.event('p1', 'attempt_reserved', after, {}, 't2', 'a2')
        report = self.analytics.history_report(self.filters(timezone='America/New_York'))
        self.assertEqual([row['date'] for row in report['series']], ['2026-01-01', '2026-01-02'])

    def test_requested_and_confirmed_models_have_separate_attribution(self):
        self.event('p1', 'attempt_starting', 100, {'model': 'requested-model'}, 't1', 'a1')
        self.event('p1', 'provider_observed', 110, {'model': 'confirmed-model'}, 't1', 'a1')
        report = self.analytics.history_report(self.filters())
        self.assertEqual(report['breakdowns']['requested_models'][0]['id'], 'requested-model')
        self.assertEqual(report['breakdowns']['requested_models'][0]['event_count'], 1)
        self.assertEqual(report['breakdowns']['confirmed_models'], [{'id': 'confirmed-model', 'event_count': 1}])

    def test_observed_and_estimated_costs_keep_distinct_provenance(self):
        HistoryIngestor(self.repo).ingest_events('agentsview', 'cost-page', [
            {'event_id': 'cost-1', 'at': 100, 'kind': 'usage', 'project_id': 'p1', 'request_id': 'r1',
             'input_tokens': 10, 'observed_cost': 1.25, 'estimated_cost': 2.5, 'cost_currency': 'USD',
             'observed_cost_source': 'provider_reported', 'estimated_cost_source': 'catalog_estimate',
             'source_version': '2.4'}])
        report = self.analytics.history_report(self.filters())
        self.assertEqual(report['summary']['observed_cost']['value'], 1.25)
        self.assertEqual(report['summary']['estimated_cost']['value'], 2.5)
        self.assertEqual(report['sources'][0]['version'], '2.4')
        self.assertEqual(report['sources'][0]['observed_cost_sources'], ['provider_reported'])
        self.assertEqual(report['sources'][0]['estimated_cost_sources'], ['catalog_estimate'])

    def test_capacity_utilization_uses_timestamped_capacity_and_account_events(self):
        self.event('p1', 'attempt_reserved', 100, {'account': 'acct'}, 't1', 'a1')
        HistoryIngestor(self.repo).ingest_events('engine', 'capacity', [
            {'event_id': 'capacity-1', 'at': 120, 'kind': 'capacity_snapshot', 'project_id': 'p1',
             'account': 'acct', 'capacity': 2, 'source_version': 'engine-v1'}])
        report = self.analytics.history_report(self.filters())
        self.assertEqual(report['summary']['historical_utilization']['value'], 0.5)
        self.assertEqual(report['summary']['historical_utilization']['state'], 'partial')
        self.assertIsNone(report['summary']['historical_utilization']['coverage']['eligible'])
        capacity_source = next(source for source in report['sources'] if source['id'] == 'engine')
        self.assertEqual(capacity_source['version'], 'engine-v1')
        self.assertEqual(capacity_source['window'], {'from': 120.0, 'to': 120.0})

    def test_mixed_cost_currencies_remain_separate(self):
        HistoryIngestor(self.repo).ingest_events('agentsview', 'currency-page', [
            {'event_id': 'usd', 'at': 100, 'kind': 'usage', 'project_id': 'p1', 'request_id': 'usd',
             'input_tokens': 1, 'observed_cost': 1.0, 'cost_currency': 'USD'},
            {'event_id': 'eur', 'at': 101, 'kind': 'usage', 'project_id': 'p1', 'request_id': 'eur',
             'input_tokens': 1, 'observed_cost': 2.0, 'cost_currency': 'EUR'},
        ])
        report = self.analytics.history_report(self.filters())
        self.assertIsNone(report['summary']['observed_cost']['value'])
        self.assertEqual(report['summary']['observed_cost']['state'], 'unavailable')
        project = next(row for row in report['breakdowns']['projects'] if row['project_id'] == 'p1')
        self.assertEqual({row['currency'] for row in project['observed_costs']}, {'USD', 'EUR'})

    def test_tool_call_import_has_its_own_attribution(self):
        HistoryIngestor(self.repo).ingest_events('agentsview', 'tool-page', [
            {'event_id': 'tool-1', 'at': 100, 'kind': 'tool_call', 'project_id': 'p1',
             'session_id': 's1', 'tool': 'search'},
        ])
        report = self.analytics.history_report(self.filters())
        self.assertEqual(report['breakdowns']['tools'][0]['tool_call_count'], 1)

    def test_explicit_alias_selects_one_project_without_merging_same_basename(self):
        self.event('p1', 'attempt_reserved', 100, {}, 't1', 'a1')
        self.event('p2', 'attempt_reserved', 110, {}, 't2', 'a2')
        report = self.analytics.history_report(self.filters(project_ids=('repo:one',)))
        self.assertEqual(report['summary']['events']['value'], 1)
        self.assertEqual([row['project_id'] for row in report['breakdowns']['projects']], ['p1'])

    def test_unknown_historical_capacity_keeps_utilization_unavailable(self):
        self.event('p1', 'attempt_starting', 100, {}, 't1', 'a1')
        report = self.analytics.history_report(self.filters())
        self.assertIsNone(report['summary']['historical_utilization']['value'])
        self.assertEqual(report['summary']['historical_utilization']['state'], 'unavailable')

    def test_truncated_ownership_history_does_not_publish_a_false_concurrency_baseline(self):
        self.event('p1', 'attempt_reserved', 100, {}, 't1', 'a1')
        self.event('p1', 'owner_released', 110, {}, 't1', 'a1')
        report = Analytics(self.repo, max_rows=1).history_report(self.filters(from_utc=105))
        self.assertEqual(report['concurrency'], [])
        self.assertIsNone(report['summary']['concurrency_peak']['value'])
        self.assertEqual(report['summary']['concurrency_peak']['state'], 'unavailable')

    def test_imported_usage_deduplicates_requests_cumulative_snapshots_and_forks(self):
        ingestor = HistoryIngestor(self.repo, batch_size=2)
        rows = [
            {'event_id': 'req-1', 'at': 100, 'kind': 'usage', 'project_id': 'p1',
             'session_id': 'root', 'request_id': 'request-1', 'input_tokens': 100,
             'output_tokens': 10, 'model': 'm1', 'account': 'acct'},
            {'event_id': 'cum-1', 'at': 110, 'kind': 'usage', 'project_id': 'p1',
             'session_id': 'root', 'root_session_id': 'root', 'usage_group_id': 'group-1',
             'cumulative': True, 'input_tokens': 200, 'output_tokens': 20, 'model': 'm1'},
            {'event_id': 'cum-2', 'at': 120, 'kind': 'usage', 'project_id': 'p1',
             'session_id': 'child', 'parent_session_id': 'root', 'root_session_id': 'root',
             'usage_group_id': 'group-1', 'cumulative': True,
             'input_tokens': 250, 'output_tokens': 25, 'model': 'm1'},
            {'event_id': 'req-1-replay', 'at': 130, 'kind': 'usage', 'project_id': 'p1',
             'session_id': 'root', 'request_id': 'request-1', 'input_tokens': 100,
             'output_tokens': 10, 'model': 'm1', 'account': 'acct'},
        ]
        receipt = ingestor.ingest_events('agentsview', 'cursor-4', rows)
        self.assertEqual((receipt.accepted, receipt.duplicates, receipt.rejected), (3, 1, 0))
        report = self.analytics.history_report(self.filters())
        self.assertEqual(report['summary']['input_tokens']['value'], 350)
        self.assertEqual(report['summary']['output_tokens']['value'], 35)
        self.assertEqual(report['summary']['input_tokens']['coverage']['observed'], 2)
        self.assertIsNone(report['summary']['input_tokens']['coverage']['eligible'])
        self.assertEqual(report['summary']['input_tokens']['state'], 'partial')
        self.assertEqual(report['coverage']['usage']['state'], 'partial')

    def test_anonymous_cumulative_usage_keeps_distinct_source_events_separate(self):
        HistoryIngestor(self.repo).ingest_events('agentsview', 'anonymous-page', [
            {'event_id': 'anonymous-1', 'at': 100, 'kind': 'usage', 'project_id': 'p1',
             'cumulative': True, 'input_tokens': 5},
            {'event_id': 'anonymous-2', 'at': 101, 'kind': 'usage', 'project_id': 'p1',
             'cumulative': True, 'input_tokens': 10},
        ])

        report = self.analytics.history_report(self.filters())

        self.assertEqual(report['summary']['input_tokens']['value'], 15)
        self.assertEqual(report['summary']['input_tokens']['coverage']['observed'], 2)

    def test_source_metadata_uses_only_bounded_history_facts(self):
        rows = [
            {'event_id': f'bounded-{index}', 'at': 100 + index, 'kind': 'usage', 'project_id': 'p1',
             'source_version': 'v1', 'request_id': f'request-{index}', 'input_tokens': 1,
             'observed_cost': 0.1, 'estimated_cost': 0.2, 'cost_currency': 'USD',
             'observed_cost_source': 'provider_reported', 'estimated_cost_source': 'catalog_estimate'}
            for index in range(100)
        ]
        HistoryIngestor(self.repo).ingest_events('large-source', 'page-100', rows)
        statements = []
        original_connection = self.repo.connection

        @contextmanager
        def tracing_connection(write=False):
            with original_connection(write) as connection:
                connection.set_trace_callback(statements.append)
                yield connection

        self.repo.connection = tracing_connection
        report = Analytics(self.repo, max_rows=2).history_report(self.filters())

        fact_selects = [statement.casefold() for statement in statements if 'from history_facts' in statement.casefold()]
        self.assertTrue(fact_selects)
        self.assertTrue(all('limit' in statement for statement in fact_selects), fact_selects)
        self.assertTrue(report['coverage']['truncated'])
        self.assertEqual(report['sources'], [{
            'id': 'large-source', 'version': 'v1',
            'window': {'from': 100.0, 'to': 101.0}, 'facts': 2,
            'observed_cost_sources': ['provider_reported'],
            'estimated_cost_sources': ['catalog_estimate'],
        }])

    def test_scale_fixture_reports_measured_query_time(self):
        now = time.time()
        with self.repo.connection(True) as conn:
            conn.executemany('INSERT INTO events(project,task,attempt,kind,at,data) VALUES(?,?,?,?,?,?)',
                             [('p1', f't{i}', f'a{i}', 'attempt_reserved', now - i, '{}') for i in range(10000)])
            conn.executemany('INSERT INTO attempts(id,task,project,account,generation,idempotency_key,session,state,scopes,started_at,lease_until,released_at,recovery_count,due_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                             [(f'a{i}', f't{i}', 'p1', f'acct-{i % 100}', 1, f'key-{i}', None, 'complete', '[]', now-i, now, now, 0, 0, '{}') for i in range(10000)])
        report = self.analytics.history_report(self.filters(from_utc=now - 20000, to_utc=now + 1))
        self.assertEqual(report['summary']['events']['value'], 10000)
        self.assertGreaterEqual(report['query_ms'], 0)
        self.assertEqual(len(report['breakdowns']['accounts']), 100)


if __name__ == '__main__':
    unittest.main()
