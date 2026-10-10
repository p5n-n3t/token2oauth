"""Bounded reports over Snooze evidence and safely imported history facts."""
import json
import math
import statistics
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


MAX_ROWS = 100_000
_UNSET = object()


def _timestamp(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).timestamp()
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        value = float(value)
        try:
            datetime.fromtimestamp(value, timezone.utc)
        except (OverflowError, OSError, ValueError):
            raise ValueError('Time filters must be UTC timestamps or ISO datetimes') from None
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).timestamp()
        except (ValueError, OverflowError):
            pass
    raise ValueError('Time filters must be UTC timestamps or ISO datetimes')


@dataclass(frozen=True)
class HistoryFilter:
    project_ids: tuple[str, ...] = ()
    from_utc: object = None
    to_utc: object = None
    timezone: str = 'UTC'
    accounts: tuple[str, ...] = ()
    models: tuple[str, ...] = ()
    efforts: tuple[str, ...] = ()
    session_id: str | None = None

    def __post_init__(self):
        for name in ('project_ids', 'accounts', 'models', 'efforts'):
            value = getattr(self, name)
            if not isinstance(value, (list, tuple)) or any(not isinstance(item, str) for item in value):
                raise ValueError(name + ' must contain strings')
            object.__setattr__(self, name, tuple(value))
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, TypeError):
            raise ValueError('Unknown report timezone') from None
        start = _timestamp(self.from_utc)
        end = _timestamp(self.to_utc)
        if start is not None and end is not None and start >= end:
            raise ValueError('from_utc must be before to_utc')
        if self.session_id is not None and (not isinstance(self.session_id, str) or not self.session_id or len(self.session_id) > 512):
            raise ValueError('Invalid session id')

    @property
    def start(self):
        return _timestamp(self.from_utc)

    @property
    def end(self):
        return _timestamp(self.to_utc)


def _metric(value, unit, source, observed=0, eligible=_UNSET, *, missing=_UNSET, state=None):
    if eligible is _UNSET:
        eligible = observed
    if missing is _UNSET:
        missing = max(0, eligible - observed) if eligible is not None else None
    coverage = {'observed': observed, 'eligible': eligible, 'missing': missing}
    if state is None:
        state = 'unavailable' if value is None else ('partial' if missing is None or missing else 'available')
    return {'value': value, 'unit': unit, 'source': source, 'coverage': coverage, 'state': state}


def _percentile(values, percentile):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return round(ordered[lower] * (1 - fraction) + ordered[upper] * fraction, 3)


class Analytics:
    def __init__(self, repository, *, max_rows=MAX_ROWS, clock=time.perf_counter):
        if type(max_rows) is not int or not 1 <= max_rows <= MAX_ROWS:
            raise ValueError('max_rows must be between 1 and 100000')
        self.repository = repository
        self.max_rows = max_rows
        self.clock = clock

    @staticmethod
    def _event_data(event):
        try:
            data = json.loads(event['data'])
            return data if isinstance(data, dict) else {}
        except (TypeError, json.JSONDecodeError):
            return {}

    @staticmethod
    def _local_hour_exists(day, hour, timezone_info):
        wall_time = datetime(day.year, day.month, day.day, hour, tzinfo=timezone_info)
        round_trip = wall_time.astimezone(timezone.utc).astimezone(timezone_info)
        return round_trip.date() == day and round_trip.hour == hour

    @staticmethod
    def _merge_breakdowns(events, usage, id_field, extra_counts=None, extra_name='attempt_count'):
        extra_counts = extra_counts or {}
        keys = set(events) | set(usage) | set(extra_counts)
        rows = []
        for key in sorted(keys):
            usage_row = usage.get(key, {})
            row = {id_field: key, 'event_count': events.get(key, 0),
                   extra_name: extra_counts.get(key, 0), 'usage_count': usage_row.get('count', 0)}
            for field in ('input_tokens', 'output_tokens', 'observed_cost', 'estimated_cost'):
                if field.endswith('_cost'):
                    currency_values = usage_row.get(field + '_by_currency', {})
                    row[field + 's'] = [{'currency': currency, 'value': value}
                                        for currency, value in sorted(currency_values.items())]
                    row[field] = (next(iter(currency_values.values()))
                                  if len(currency_values) == 1 and not usage_row.get(field + '_unlabeled') else None)
                else:
                    row[field] = usage_row.get(field) if usage_row.get(field + '_count', 0) else None
            rows.append(row)
        return rows

    def _project_ids(self, connection, requested):
        if not requested:
            return None
        result = set()
        for value in requested:
            row = connection.execute('SELECT id FROM projects WHERE id=?', (value,)).fetchone()
            if row:
                result.add(row['id'])
                continue
            row = connection.execute('SELECT project FROM project_aliases WHERE alias=?', (value,)).fetchone()
            if row:
                result.add(row['project'])
        return tuple(sorted(result))

    def _read(self, filters):
        clauses = []
        parameters = []
        project_clause = None
        with self.repository.connection() as connection:
            project_ids = self._project_ids(connection, filters.project_ids)
            if project_ids is not None:
                if not project_ids:
                    return [], [], [], [], [], [], [], {
                        'events': False, 'tasks': False, 'facts': False,
                        'capacities': False, 'attempts': False,
                    }, False
                project_clause = 'project IN (' + ','.join('?' for _ in project_ids) + ')'
                clauses.append(project_clause)
                parameters.extend(project_ids)
            if filters.start is not None:
                clauses.append('at>=?'); parameters.append(filters.start)
            if filters.end is not None:
                clauses.append('at<?'); parameters.append(filters.end)
            if filters.session_id:
                clauses.append('attempt IN (SELECT id FROM attempts WHERE session=?)'); parameters.append(filters.session_id)
            event_where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
            events = connection.execute(
                f'SELECT id,project,task,attempt,kind,at,data FROM events{event_where} ORDER BY at,id LIMIT ?',
                (*parameters, self.max_rows + 1)).fetchall()
            event_truncated = len(events) > self.max_rows
            events = events[:self.max_rows]
            ownership_clauses = ["kind IN ('attempt_reserved','owner_released')"]
            ownership_parameters = []
            if project_ids is not None:
                ownership_clauses.append(project_clause); ownership_parameters.extend(project_ids)
            if filters.end is not None:
                ownership_clauses.append('at<?'); ownership_parameters.append(filters.end)
            if filters.session_id:
                ownership_clauses.append('attempt IN (SELECT id FROM attempts WHERE session=?)')
                ownership_parameters.append(filters.session_id)
            ownership = connection.execute(
                'SELECT id,project,task,attempt,kind,at,data FROM events WHERE ' +
                ' AND '.join(ownership_clauses) + ' ORDER BY at,id LIMIT ?',
                (*ownership_parameters, self.max_rows + 1)).fetchall()
            ownership_truncated = len(ownership) > self.max_rows
            ownership = ownership[:self.max_rows]

            task_clauses = []
            task_parameters = []
            if project_ids is not None:
                task_clauses.append(project_clause); task_parameters.extend(project_ids)
            if filters.end is not None:
                task_clauses.append('created_at<?'); task_parameters.append(filters.end)
            if filters.session_id:
                task_clauses.append('id IN (SELECT task FROM attempts WHERE session=?)'); task_parameters.append(filters.session_id)
            task_where = ' WHERE ' + ' AND '.join(task_clauses) if task_clauses else ''
            tasks = connection.execute(f'SELECT id,project,created_at FROM tasks{task_where} ORDER BY created_at,id LIMIT ?',
                                       (*task_parameters, self.max_rows + 1)).fetchall()
            tasks_truncated = len(tasks) > self.max_rows
            tasks = tasks[:self.max_rows]

            facts_clauses = ["kind IN ('usage','tool_call')"]
            fact_parameters = []
            if project_ids is not None:
                facts_clauses.append(project_clause); fact_parameters.extend(project_ids)
            if filters.start is not None:
                facts_clauses.append('at>=?'); fact_parameters.append(filters.start)
            if filters.end is not None:
                facts_clauses.append('at<?'); fact_parameters.append(filters.end)
            if filters.session_id:
                facts_clauses.append('session=?'); fact_parameters.append(filters.session_id)
            facts = connection.execute(
                'SELECT * FROM history_facts WHERE ' + ' AND '.join(facts_clauses) + ' ORDER BY at,id LIMIT ?',
                (*fact_parameters, self.max_rows + 1)).fetchall()
            facts_truncated = len(facts) > self.max_rows
            facts = facts[:self.max_rows]
            capacities_clauses = ["kind='capacity_snapshot'"]
            capacity_parameters = []
            if project_ids is not None:
                capacities_clauses.append(project_clause); capacity_parameters.extend(project_ids)
            if filters.start is not None:
                capacities_clauses.append('at>=?'); capacity_parameters.append(filters.start)
            if filters.end is not None:
                capacities_clauses.append('at<?'); capacity_parameters.append(filters.end)
            if filters.accounts:
                capacities_clauses.append('account IN (' + ','.join('?' for _ in filters.accounts) + ')')
                capacity_parameters.extend(filters.accounts)
            if filters.session_id:
                capacities_clauses.append('session=?'); capacity_parameters.append(filters.session_id)
            capacities = connection.execute('SELECT account,at,capacity,source_id,source_version,'
                                             'observed_cost_source,estimated_cost_source FROM history_facts WHERE ' +
                                             ' AND '.join(capacities_clauses) + ' ORDER BY at,id LIMIT ?',
                                             (*capacity_parameters, self.max_rows + 1)).fetchall()
            capacities_truncated = len(capacities) > self.max_rows
            capacities = capacities[:self.max_rows]
            attempt_clauses = ['project IN (' +
                               (','.join('?' for _ in project_ids) if project_ids else 'SELECT id FROM projects') + ')']
            attempt_parameters = list(project_ids or ())
            if filters.start is not None:
                attempt_clauses.append('started_at>=?'); attempt_parameters.append(filters.start)
            if filters.end is not None:
                attempt_clauses.append('started_at<?'); attempt_parameters.append(filters.end)
            if filters.session_id:
                attempt_clauses.append('session=?'); attempt_parameters.append(filters.session_id)
            if filters.accounts:
                attempt_clauses.append('account IN (' + ','.join('?' for _ in filters.accounts) + ')')
                attempt_parameters.extend(filters.accounts)
            attempts = connection.execute('SELECT id,account,data,generation FROM attempts WHERE ' + ' AND '.join(attempt_clauses) +
                                          ' ORDER BY started_at,id LIMIT ?',
                                          (*attempt_parameters, self.max_rows + 1)).fetchall()
            attempts_truncated = len(attempts) > self.max_rows
            attempt_rows = []
            for attempt in attempts[:self.max_rows]:
                try:
                    data = json.loads(attempt['data'])
                except (TypeError, json.JSONDecodeError):
                    data = {}
                if filters.models and data.get('requested_model') not in filters.models: continue
                if filters.efforts and data.get('requested_effort') not in filters.efforts: continue
                attempt_rows.append({'id': attempt['id'], 'account': attempt['account'],
                                     'generation': attempt['generation'],
                                     'requested_model': data.get('requested_model'),
                                     'requested_effort': data.get('requested_effort')})
        if filters.accounts or filters.models or filters.efforts:
            wanted_account = set(filters.accounts)
            wanted_model = set(filters.models)
            wanted_effort = set(filters.efforts)
            context_ids = sorted({row['attempt'] for row in (*events, *ownership) if row['attempt']})
            attempt_context = {}
            with self.repository.connection() as connection:
                for offset in range(0, len(context_ids), 900):
                    chunk = context_ids[offset:offset + 900]
                    rows = connection.execute('SELECT id,account,data FROM attempts WHERE id IN (' +
                                              ','.join('?' for _ in chunk) + ')', chunk).fetchall()
                    for row in rows:
                        try: context_data = json.loads(row['data'])
                        except (TypeError, json.JSONDecodeError): context_data = {}
                        attempt_context[row['id']] = {'account': row['account'],
                                                      'requested_model': context_data.get('requested_model'),
                                                      'requested_effort': context_data.get('requested_effort')}

            def matches_filters(event):
                try: data = json.loads(event['data'])
                except (TypeError, json.JSONDecodeError): data = {}
                if not isinstance(data, dict): data = {}
                context = attempt_context.get(event['attempt'], {})
                account = data.get('account') or context.get('account')
                models = {data.get('model'), data.get('confirmed_model'), data.get('requested_model'), context.get('requested_model')}
                effort = data.get('effort') or data.get('requested_effort') or context.get('requested_effort')
                if wanted_account and account not in wanted_account: return False
                if wanted_model and not (wanted_model & models): return False
                if wanted_effort and effort not in wanted_effort: return False
                return True

            events = [event for event in events if matches_filters(event)]
            ownership = [event for event in ownership if matches_filters(event)]
            facts = [fact for fact in facts
                     if (not wanted_account or fact['account'] in wanted_account)
                     and (not wanted_model or fact['model'] in wanted_model)
                     and (not wanted_effort or fact['effort'] in wanted_effort)]
        return events, tasks, facts, capacities, attempt_rows, project_ids, ownership, {
            'events': event_truncated, 'tasks': tasks_truncated, 'facts': facts_truncated,
            'capacities': capacities_truncated, 'attempts': attempts_truncated,
        }, ownership_truncated

    def _usage_groups(self, facts):
        grouped = {}
        for fact in facts:
            if fact['cumulative']:
                stable = fact['usage_group_id'] or fact['root_session'] or fact['parent_session'] or fact['session']
                # If the source gives no relationship identity, a cumulative
                # row is its own observation; grouping anonymous rows would
                # silently replace unrelated usage with their maximum.
                stable = stable or fact['source_event_id']
                key = (fact['source_id'], 'cumulative', stable)
            else:
                key = (fact['source_id'], 'request', fact['request_id'] or fact['source_event_id'])
            row = grouped.setdefault(key, {'at': fact['at'], 'values': {}, 'model': fact['model'],
                                           'account': fact['account'], 'effort': fact['effort'],
                                           'session': fact['root_session'] or fact['session'],
                                           'project': fact['project'],
                                           'tool': fact['tool'], 'currency': fact['cost_currency'],
                                           'observed_cost_by_currency': {}, 'estimated_cost_by_currency': {},
                                           'observed_cost_unlabeled': 0.0, 'estimated_cost_unlabeled': 0.0,
                                           'observed_cost_source': fact['observed_cost_source'],
                                           'estimated_cost_source': fact['estimated_cost_source']})
            if fact['at'] >= row['at']:
                row.update(at=fact['at'], model=fact['model'] or row['model'],
                           account=fact['account'] or row['account'], effort=fact['effort'] or row['effort'],
                           session=fact['root_session'] or fact['session'] or row['session'],
                           project=fact['project'] or row['project'],
                           tool=fact['tool'] or row['tool'], currency=fact['cost_currency'] or row['currency'],
                           observed_cost_source=fact['observed_cost_source'] or row['observed_cost_source'],
                           estimated_cost_source=fact['estimated_cost_source'] or row['estimated_cost_source'])
            for field in ('input_tokens','output_tokens','reasoning_tokens','cache_read_tokens','cache_write_tokens'):
                value = fact[field]
                if value is not None:
                    if fact['cumulative']:
                        row['values'][field] = max(value, row['values'].get(field, 0))
                    else:
                        row['values'][field] = row['values'].get(field, 0) + value
            for field in ('observed_cost','estimated_cost'):
                value = fact[field]
                if value is not None:
                    currency = fact['cost_currency']
                    if currency:
                        totals = row[field + '_by_currency']
                        totals[currency] = max(value, totals.get(currency, 0)) if fact['cumulative'] else totals.get(currency, 0) + value
                    else:
                        key_name = field + '_unlabeled'
                        row[key_name] = max(value, row[key_name]) if fact['cumulative'] else row[key_name] + value
        return list(grouped.values())

    def history_report(self, filters):
        if not isinstance(filters, HistoryFilter):
            raise TypeError('filters must be HistoryFilter')
        started = self.clock()
        events, tasks, facts, capacities, attempt_rows, selected_projects, ownership_events, truncation, ownership_truncated = self._read(filters)
        truncated = any(truncation.values())
        timezone_info = ZoneInfo(filters.timezone)
        usage_facts = [fact for fact in facts if fact['kind'] == 'usage']
        tool_facts = [fact for fact in facts if fact['kind'] == 'tool_call']
        usage = self._usage_groups(usage_facts)
        events_by_attempt = defaultdict(list)
        events_by_task = defaultdict(list)
        task_created = {row['id']: row['created_at'] for row in tasks if row['created_at'] is not None}
        hours = defaultdict(Counter)
        hour_of_week = Counter()
        dates = defaultdict(lambda: {'events': 0, 'validated': 0, 'input_tokens': None,
                                     'output_tokens': None, 'observed_cost': None, 'estimated_cost': None})
        daily_costs = defaultdict(lambda: {'observed_cost': Counter(), 'estimated_cost': Counter()})
        projects = Counter()
        account_events = Counter()
        model_events = Counter()
        requested_models = Counter()
        confirmed_models = Counter()
        effort_events = Counter()
        tools = Counter()
        sources = set()
        validated_events = []
        for event in events:
            try: data = json.loads(event['data'])
            except (TypeError, json.JSONDecodeError): data = {}
            if not isinstance(data, dict): data = {}
            projects[event['project']] += 1
            if data.get('account'): account_events[data['account']] += 1
            if data.get('model'): model_events[data['model']] += 1
            if event['kind'] == 'attempt_starting':
                value = data.get('requested_model') or data.get('model')
                if value: requested_models[value] += 1
                if data.get('requested_effort'): effort_events[data['requested_effort']] += 1
            if event['kind'] == 'provider_observed':
                value = data.get('confirmed_model') or data.get('model')
                if value: confirmed_models[value] += 1
                if data.get('effort'): effort_events[data['effort']] += 1
            if data.get('tool'): tools[data['tool']] += 1
            local = datetime.fromtimestamp(event['at'], timezone.utc).astimezone(timezone_info)
            date_key = local.date().isoformat()
            dates[date_key]['events'] += 1
            hours[date_key][local.hour] += 1
            hour_of_week[(local.weekday(), local.hour)] += 1
            if event['attempt']:
                events_by_attempt[event['attempt']].append(event)
            if event['task']:
                events_by_task[event['task']].append(event)
            if event['kind'] == 'attempt_complete' and data.get('validation') in (True, 'valid'):
                validated_events.append(event)
                dates[date_key]['validated'] += 1
            if event['kind'].startswith(('attempt_', 'task_', 'validation_', 'provider_')):
                sources.add('Snooze event log')

        queue_samples = []
        run_samples = []
        recovery_samples = []
        retries = sum(1 for attempt in attempt_rows if attempt['generation'] > 1)
        recovery_count = 0
        for attempt_events in events_by_attempt.values():
            attempt_events.sort(key=lambda item: (item['at'], item['id']))
            reserved = next((row for row in attempt_events if row['kind'] == 'attempt_reserved'), None)
            starting = next((row for row in attempt_events if row['kind'] == 'attempt_starting'), None)
            completed = next((row for row in attempt_events if row['kind'] == 'attempt_complete' and
                              self._event_data(row).get('validation') in (True, 'valid')), None)
            if reserved and reserved['task'] in task_created:
                queue_samples.append(max(0, reserved['at'] - task_created[reserved['task']]))
            if starting and completed and completed['at'] >= starting['at']:
                run_samples.append(completed['at'] - starting['at'])
            recovery_rows = [row for row in attempt_events if row['kind'] in ('attempt_awaiting_output', 'attempt_ambiguous')]
            recovery_count += len(recovery_rows)
        validation_outcomes = set()
        invalid_validation_attempts = set()
        for event in events:
            data = self._event_data(event)
            attempt_key = event['attempt'] or f"event:{event['id']}"
            if event['kind'] == 'attempt_complete' and data.get('validation') in (True, 'valid'):
                validation_outcomes.add(attempt_key)
            elif event['kind'] in ('attempt_blocked', 'attempt_complete') and data.get('validation') == 'invalid':
                validation_outcomes.add(attempt_key)
                invalid_validation_attempts.add(attempt_key)
        validation_failures = len(invalid_validation_attempts)
        for task_events in events_by_task.values():
            task_events.sort(key=lambda item: (item['at'], item['id']))
            completions = [row for row in task_events if row['kind'] == 'attempt_complete' and
                           self._event_data(row).get('validation') in (True, 'valid')]
            failures = [row for row in task_events if row['kind'] in ('attempt_failed', 'attempt_blocked') or
                        (row['kind'] == 'provider_observed' and self._event_data(row).get('status') == 'failed')]
            for failure in failures:
                recovered = next((row for row in completions if row['at'] >= failure['at']), None)
                if recovered:
                    recovery_samples.append(recovered['at'] - failure['at'])

        validated_count = len(validated_events)
        native_coverage = {'observed': len(events),
                           'eligible': None if truncation['events'] else len(events),
                           'missing': None if truncation['events'] else 0,
                           'truncated': truncation['events']}
        outcome_truncated = truncation['events']
        queue_truncated = outcome_truncated or truncation['tasks']
        summary = {
            'events': _metric(len(events), 'events', 'Snooze event log', len(events),
                              None if truncation['events'] else len(events),
                              missing=None if truncation['events'] else 0,
                              state='partial' if truncation['events'] else 'available'),
            'task_outcomes': _metric(validated_count, 'validated tasks', 'Snooze validation events',
                                     validated_count, None if outcome_truncated else len(validated_events),
                                     missing=None if outcome_truncated else 0,
                                     state='partial' if outcome_truncated else 'available'),
            'validated_throughput': _metric(validated_count, 'validated tasks', 'Snooze validation events',
                                            validated_count, None if outcome_truncated else len(validated_events),
                                            missing=None if outcome_truncated else 0,
                                            state='partial' if outcome_truncated else 'available'),
            'queue_latency_p50': _metric(_percentile(queue_samples, .5), 'seconds', 'task created → attempt reserved',
                                         len(queue_samples), None if queue_truncated else len(queue_samples),
                                         missing=None if queue_truncated else 0,
                                         state='partial' if queue_truncated else None),
            'queue_latency_p95': _metric(_percentile(queue_samples, .95), 'seconds', 'task created → attempt reserved',
                                         len(queue_samples), None if queue_truncated else len(queue_samples),
                                         missing=None if queue_truncated else 0,
                                         state='partial' if queue_truncated else None),
            'run_duration_p50': _metric(_percentile(run_samples, .5), 'seconds', 'attempt starting → validated completion',
                                        len(run_samples), None if outcome_truncated else len(run_samples),
                                        missing=None if outcome_truncated else 0,
                                        state='partial' if outcome_truncated else None),
            'run_duration_p95': _metric(_percentile(run_samples, .95), 'seconds', 'attempt starting → validated completion',
                                        len(run_samples), None if outcome_truncated else len(run_samples),
                                        missing=None if outcome_truncated else 0,
                                        state='partial' if outcome_truncated else None),
            'retry_attempts': _metric(retries, 'attempts', 'Snooze attempt generation', retries,
                                      None if truncation['attempts'] else retries,
                                      missing=None if truncation['attempts'] else 0,
                                      state='partial' if truncation['attempts'] else None),
            'retry_rate': _metric(
                retries / len(attempt_rows) if attempt_rows else None, 'ratio',
                'attempts with generation > 1 / sampled attempts', len(attempt_rows),
                None if truncation['attempts'] else len(attempt_rows),
                missing=None if truncation['attempts'] else 0,
                state='unavailable' if not attempt_rows else ('partial' if truncation['attempts'] else 'available')),
            'validation_failures': _metric(validation_failures, 'attempts', 'Snooze validation events',
                                           validation_failures,
                                           None if outcome_truncated else validation_failures,
                                           missing=None if outcome_truncated else 0,
                                           state='partial' if outcome_truncated else None),
            'validation_failure_rate': _metric(
                validation_failures / len(validation_outcomes) if validation_outcomes else None, 'ratio',
                'invalid validation outcomes / attempts with a validation outcome',
                len(validation_outcomes), None if outcome_truncated else len(validation_outcomes),
                missing=None if outcome_truncated else 0,
                state='unavailable' if not validation_outcomes else ('partial' if outcome_truncated else 'available')),
            'recoveries': _metric(recovery_count, 'recovery events', 'Snooze attempt events', recovery_count,
                                  None if outcome_truncated else recovery_count,
                                  missing=None if outcome_truncated else 0,
                                  state='partial' if outcome_truncated else None),
            'time_to_recovery_p50': _metric(_percentile(recovery_samples, .5), 'seconds', 'failed → validated completion',
                                            len(recovery_samples), None if outcome_truncated else len(recovery_samples),
                                            missing=None if outcome_truncated else 0,
                                            state='partial' if outcome_truncated else None),
        }
        logical_usage = usage
        token_fields = {
            'input_tokens': 'input_tokens', 'output_tokens': 'output_tokens',
            'reasoning_tokens': 'reasoning_tokens', 'cache_read_tokens': 'cache_read_tokens',
            'cache_write_tokens': 'cache_write_tokens',
        }
        for metric_name, field in token_fields.items():
            observed = [row['values'][field] for row in logical_usage if field in row['values']]
            summary[metric_name] = _metric(sum(observed) if observed else None, 'tokens', 'imported usage facts',
                                           len(observed), None, missing=None,
                                           state='unavailable' if not observed else 'partial')
        for name in ('observed_cost', 'estimated_cost'):
            currencies = {currency for row in logical_usage for currency in row[name + '_by_currency']}
            observations = [amount for row in logical_usage for amount in row[name + '_by_currency'].values()]
            unlabeled = sum(row[name + '_unlabeled'] for row in logical_usage)
            observed = sum(1 for row in logical_usage if row[name + '_by_currency'] or row[name + '_unlabeled'])
            unit = next(iter(currencies)) if len(currencies) == 1 and not unlabeled else ('mixed currency' if len(currencies) > 1 else 'currency unavailable')
            amount = sum(observations) if observations and len(currencies) == 1 and not unlabeled else None
            cost_source = ('provider-reported cost facts' if name == 'observed_cost'
                           else 'catalog/API-equivalent estimate facts')
            summary[name] = _metric(amount, unit, cost_source, observed, None, missing=None,
                                     state='unavailable' if not observations or len(currencies) != 1 or unlabeled else
                                     'partial')
        input_metric = summary['input_tokens']['value']
        cache_metric = summary['cache_read_tokens']['value']
        summary['cache_efficiency'] = _metric(
            round(cache_metric / (input_metric + cache_metric), 4) if input_metric is not None and cache_metric is not None and input_metric + cache_metric else None,
            'ratio', 'imported cache/input token facts',
            min(summary['input_tokens']['coverage']['observed'], summary['cache_read_tokens']['coverage']['observed']),
            None, missing=None,
            state='partial' if input_metric is not None and cache_metric is not None else 'unavailable')

        concurrency = []
        account_for_attempt = {}
        active_attempts = set()
        interval_starts = {}
        all_intervals = []
        if filters.start is not None:
            for event in ownership_events:
                if event['at'] >= filters.start: break
                if event['kind'] == 'attempt_reserved':
                    active_attempts.add(event['attempt'])
                    account_for_attempt[event['attempt']] = self._event_data(event).get('account')
                    interval_starts[event['attempt']] = event['at']
                elif event['kind'] == 'owner_released':
                    active_attempts.discard(event['attempt'])
                    start_at = interval_starts.pop(event['attempt'], None)
                    if start_at is not None: all_intervals.append((start_at, event['at']))
        current = len(active_attempts)
        if filters.start is not None:
            concurrency.append({'at': filters.start, 'active': current, 'attempt_id': None})
        for event in events:
            if event['kind'] == 'attempt_reserved':
                if event['attempt'] not in active_attempts:
                    active_attempts.add(event['attempt']); current += 1
                account_for_attempt[event['attempt']] = self._event_data(event).get('account')
                interval_starts[event['attempt']] = event['at']
            elif event['kind'] == 'owner_released':
                if event['attempt'] in active_attempts:
                    active_attempts.remove(event['attempt']); current = max(0, current - 1)
                start_at = interval_starts.pop(event['attempt'], None)
                if start_at is not None and event['at'] >= start_at:
                    all_intervals.append((start_at, event['at']))
            if event['kind'] in ('attempt_reserved', 'owner_released'):
                concurrency.append({'at': event['at'], 'active': current, 'attempt_id': event['attempt']})
        peak = max((point['active'] for point in concurrency), default=None)
        concurrency_observed = len(concurrency)
        if ownership_truncated:
            # The pre-window ownership baseline may be incomplete, so neither
            # its active counts nor a peak can be represented as trustworthy.
            concurrency = []
        summary['concurrency_peak'] = _metric(None if ownership_truncated else peak,
                                              'attempts', 'reservation/release events', concurrency_observed,
                                              None if ownership_truncated else concurrency_observed,
                                              missing=None if ownership_truncated else 0,
                                              state='unavailable' if ownership_truncated else None)
        clipped_intervals = []
        for start_at, end_at in all_intervals:
            clipped_start = max(start_at, filters.start) if filters.start is not None else start_at
            clipped_end = min(end_at, filters.end) if filters.end is not None else end_at
            if clipped_end > clipped_start: clipped_intervals.append((clipped_start, clipped_end))
        summary['owned_time_seconds'] = _metric(
            sum(end_at - start_at for start_at, end_at in clipped_intervals)
            if clipped_intervals and not ownership_truncated else None,
            'seconds', 'complete Snooze reservation → release intervals', len(clipped_intervals), len(clipped_intervals),
            state='unavailable' if not clipped_intervals or ownership_truncated else 'partial')
        summary['idle_time_seconds'] = _metric(None, 'seconds',
                                               'unavailable without complete ownership-window coverage',
                                               0, 0, state='unavailable')
        utilization_values = []
        capacity_events = []
        for event in ownership_events:
            if event['kind'] == 'attempt_reserved':
                account_for_attempt[event['attempt']] = self._event_data(event).get('account')
                capacity_events.append((event['at'], 1, account_for_attempt.get(event['attempt'])))
            elif event['kind'] == 'owner_released':
                capacity_events.append((event['at'], -1, account_for_attempt.get(event['attempt'])))
        capacity_events.sort(key=lambda item: item[0])
        active_by_account = Counter()
        event_index = 0
        for capacity in capacities:
            while event_index < len(capacity_events) and capacity_events[event_index][0] <= capacity['at']:
                _, delta, account = capacity_events[event_index]
                if account:
                    active_by_account[account] = max(0, active_by_account[account] + delta)
                event_index += 1
            if capacity['capacity'] and capacity['account']:
                utilization_values.append(min(1.0, active_by_account[capacity['account']] / capacity['capacity']))
        utilization = statistics.fmean(utilization_values) if utilization_values and not ownership_truncated else None
        summary['historical_utilization'] = _metric(utilization, 'ratio', 'historical capacity snapshots',
                                                    len(utilization_values), None, missing=None,
                                                    state='unavailable' if not utilization_values or ownership_truncated else 'partial')

        for row in usage:
            local_date = datetime.fromtimestamp(row['at'], timezone.utc).astimezone(timezone_info).date().isoformat()
            daily = dates[local_date]
            for field in ('input_tokens', 'output_tokens'):
                if field in row['values']:
                    daily[field] = (daily[field] or 0) + row['values'][field]
            for field in ('observed_cost', 'estimated_cost'):
                for currency, amount in row[field + '_by_currency'].items():
                    daily_costs[local_date][field][currency] += amount
        series = []
        for date_key in sorted(dates):
            daily = dict(dates[date_key])
            for field in ('observed_cost', 'estimated_cost'):
                currency_values = daily_costs[date_key][field]
                daily[field + 's'] = [{'currency': currency, 'value': amount}
                                      for currency, amount in sorted(currency_values.items())]
                daily[field] = next(iter(currency_values.values())) if len(currency_values) == 1 else None
            series.append({'date': date_key, **daily})
        heatmap = [{'date': date_key, 'hours': [hours[date_key].get(hour, 0) for hour in range(24)],
                    'hours_present': [self._local_hour_exists(date.fromisoformat(date_key), hour, timezone_info)
                                      for hour in range(24)]}
                   for date_key in sorted(hours)]
        account_attempts = Counter()
        for attempt in attempt_rows:
            if attempt['account']: account_attempts[attempt['account']] += 1
        model_counts = Counter(model_events)
        tool_counts = Counter(tools)
        effort_counts = Counter(effort_events)
        account_usage = defaultdict(lambda: {'count': 0, 'input_tokens': 0, 'output_tokens': 0,
                                             'input_tokens_count': 0, 'output_tokens_count': 0,
                                             'observed_cost_by_currency': Counter(), 'estimated_cost_by_currency': Counter(),
                                             'observed_cost_unlabeled': 0, 'estimated_cost_unlabeled': 0})
        model_usage = defaultdict(lambda: {'count': 0, 'input_tokens': 0, 'output_tokens': 0,
                                           'input_tokens_count': 0, 'output_tokens_count': 0,
                                           'observed_cost_by_currency': Counter(), 'estimated_cost_by_currency': Counter(),
                                           'observed_cost_unlabeled': 0, 'estimated_cost_unlabeled': 0})
        project_usage = defaultdict(lambda: {'count': 0, 'input_tokens': 0, 'output_tokens': 0,
                                             'input_tokens_count': 0, 'output_tokens_count': 0,
                                             'observed_cost_by_currency': Counter(), 'estimated_cost_by_currency': Counter(),
                                             'observed_cost_unlabeled': 0, 'estimated_cost_unlabeled': 0})
        tool_usage = defaultdict(lambda: {'count': 0, 'input_tokens': 0, 'output_tokens': 0,
                                          'input_tokens_count': 0, 'output_tokens_count': 0,
                                          'observed_cost_by_currency': Counter(), 'estimated_cost_by_currency': Counter(),
                                          'observed_cost_unlabeled': 0, 'estimated_cost_unlabeled': 0})
        tool_call_counts = Counter(fact['tool'] for fact in tool_facts if fact['tool'])
        for row in usage:
            for key, target in ((row['account'], account_usage), (row['model'], model_usage),
                                (row['project'], project_usage), (row['tool'], tool_usage)):
                if not key: continue
                aggregate = target[key]
                aggregate['count'] += 1
                for field in ('input_tokens', 'output_tokens'):
                    if field in row['values']:
                        aggregate[field] += row['values'][field]
                        aggregate[field + '_count'] += 1
                for field in ('observed_cost', 'estimated_cost'):
                    aggregate[field + '_by_currency'].update(row[field + '_by_currency'])
                    if row[field + '_unlabeled']:
                        aggregate[field + '_unlabeled'] += 1
        with self.repository.connection() as connection:
            project_names = {row['id']: row['folder'] for row in connection.execute('SELECT id,folder FROM projects')}
        project_breakdown = self._merge_breakdowns(projects, project_usage, 'project_id')
        for row in project_breakdown:
            row['folder'] = project_names.get(row['project_id'])
        top_sessions = []
        session_totals = defaultdict(lambda: {'input_tokens': 0, 'output_tokens': 0,
                                              'observed_cost_by_currency': Counter(), 'model': None})
        for row in usage:
            if not row['session']: continue
            aggregate = session_totals[row['session']]
            aggregate['input_tokens'] += row['values'].get('input_tokens', 0)
            aggregate['output_tokens'] += row['values'].get('output_tokens', 0)
            aggregate['observed_cost_by_currency'].update(row['observed_cost_by_currency'])
            aggregate['model'] = row['model'] or aggregate['model']
        for session, aggregate in session_totals.items():
            top_sessions.append({'session_id': session, 'input_tokens': aggregate['input_tokens'],
                                 'output_tokens': aggregate['output_tokens'], 'model': aggregate['model'],
                                 'observed_costs': [{'currency': currency, 'value': amount}
                                                    for currency, amount in sorted(aggregate['observed_cost_by_currency'].items())]})
        top_sessions.sort(key=lambda row: row['input_tokens'] + row['output_tokens'], reverse=True)
        top_sessions = top_sessions[:50]
        coverage = {
            'native_events': {**native_coverage, 'state': 'partial' if truncated else 'available'},
            'usage': {'observed': len(logical_usage), 'eligible': None, 'missing': None,
                      'state': 'partial' if logical_usage else 'unavailable',
                      'completeness': 'eligible source sessions are not independently enumerated',
                      'sources': sorted({fact['source_id'] for fact in usage_facts})},
            'historical_capacity': {'observed': len(capacities), 'eligible': None,
                                    'missing': None, 'state': 'partial' if capacities else 'unavailable',
                                    'completeness': 'eligible historical snapshots are not independently enumerated'},
            'concurrency': {'observed': concurrency_observed, 'eligible': None if ownership_truncated else concurrency_observed,
                            'missing': None if ownership_truncated else 0,
                            'state': 'unavailable' if ownership_truncated else 'available'},
            'truncated': truncated,
            'truncation': dict(truncation),
        }
        source_metadata = self._source_metadata([*facts, *capacities])
        if 'Snooze event log' in sources:
            source_metadata.insert(0, {'id': 'snooze-events', 'version': None,
                                       'window': {'from': min((event['at'] for event in events), default=None),
                                                  'to': max((event['at'] for event in events), default=None)},
                                       'facts': len(events), 'observed_cost_sources': [],
                                       'estimated_cost_sources': []})
        return {
            'summary': summary,
            'series': series,
            'heatmap': heatmap,
            'hour_of_week': [{'weekday': day, 'hour': hour, 'events': hour_of_week[(day, hour)]}
                             for day in range(7) for hour in range(24)],
            'breakdowns': {
                'projects': project_breakdown,
                'accounts': self._merge_breakdowns(account_events, account_usage, 'id', account_attempts),
                'models': self._merge_breakdowns(model_events, model_usage, 'id'),
                'requested_models': self._merge_breakdowns(requested_models, {}, 'id'),
                'confirmed_models': [{'id': key, 'event_count': value} for key, value in sorted(confirmed_models.items())],
                'efforts': [{'id': key, 'event_count': value} for key, value in sorted(effort_counts.items())],
                'tools': self._merge_breakdowns(tools, tool_usage, 'id', tool_call_counts, 'tool_call_count'),
            },
            'concurrency': concurrency,
            'top_sessions': top_sessions,
            'coverage': coverage,
            'sources': source_metadata,
            'query_ms': round(max(0.0, (self.clock() - started) * 1000), 3),
        }

    @staticmethod
    def _source_metadata(facts):
        """Summarize provenance from the already bounded and filtered fact rows."""
        grouped = {}
        for fact in facts:
            key = (fact['source_id'], fact['source_version'])
            row = grouped.setdefault(key, {
                'id': fact['source_id'], 'version': fact['source_version'],
                'window': {'from': fact['at'], 'to': fact['at']}, 'facts': 0,
                'observed_cost_sources': set(), 'estimated_cost_sources': set(),
            })
            row['facts'] += 1
            row['window']['from'] = min(row['window']['from'], fact['at'])
            row['window']['to'] = max(row['window']['to'], fact['at'])
            if fact['observed_cost_source']:
                row['observed_cost_sources'].add(fact['observed_cost_source'])
            if fact['estimated_cost_source']:
                row['estimated_cost_sources'].add(fact['estimated_cost_source'])
        result = []
        for key in sorted(grouped, key=lambda item: (item[0], item[1] or '')):
            row = grouped[key]
            row['observed_cost_sources'] = sorted(row['observed_cost_sources'])
            row['estimated_cost_sources'] = sorted(row['estimated_cost_sources'])
            result.append(row)
        return result


def history_report(repository, filters):
    """Module-level entry point; state location always comes from the caller."""
    return Analytics(repository).history_report(filters)
