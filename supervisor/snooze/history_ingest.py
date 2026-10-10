"""Bounded, idempotent ingestion of normalized history facts."""
import math
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class ImportReceipt:
    source_id: str
    cursor: str | None
    accepted: int
    duplicates: int
    rejected: int
    cancelled: bool


_TEXT_FIELDS = (
    'task', 'attempt', 'session', 'parent_session', 'root_session', 'request_id',
    'usage_group_id', 'account', 'model', 'effort', 'status', 'tool',
    'cost_currency', 'observed_cost_source', 'estimated_cost_source', 'source_version',
)
_TOKEN_FIELDS = ('input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens')
_KINDS = {'activity', 'usage', 'tool_call', 'capacity_snapshot', 'task', 'attempt', 'session'}


def _text(value, name, *, maximum=512, optional=True):
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or '\x00' in value:
        raise ValueError('invalid ' + name)
    return value.strip()


def _number(value, name, *, integer=False, optional=True, minimum=0):
    if value is None and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('invalid ' + name)
    if value < minimum or (integer and type(value) is not int):
        raise ValueError('invalid ' + name)
    return value


def _epoch(value):
    if isinstance(value, bool):
        raise ValueError('invalid timestamp')
    if isinstance(value, (int, float)) and math.isfinite(value):
        value = float(value)
        try:
            datetime.fromtimestamp(value, timezone.utc)
        except (OverflowError, OSError, ValueError):
            raise ValueError('invalid timestamp') from None
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp()
        except (ValueError, OverflowError):
            pass
    raise ValueError('invalid timestamp')


def _cancelled(cancelled):
    if callable(cancelled):
        return bool(cancelled())
    if hasattr(cancelled, 'is_set'):
        return bool(cancelled.is_set())
    return bool(cancelled)


class HistoryIngestor:
    """Persist safe scalar facts only; full prompts and transcripts are discarded."""

    def __init__(self, repository, *, batch_size=100, clock=time.time):
        if type(batch_size) is not int or not 1 <= batch_size <= 1000:
            raise ValueError('batch_size must be between 1 and 1000')
        self.repository = repository
        self.batch_size = batch_size
        self.clock = clock

    def _project_id(self, connection, value):
        project = _text(value, 'project_id', optional=False, maximum=512)
        row = connection.execute('SELECT id FROM projects WHERE id=?', (project,)).fetchone()
        if row:
            return row['id']
        row = connection.execute('SELECT project FROM project_aliases WHERE alias=?', (project,)).fetchone()
        if row:
            return row['project']
        raise ValueError('unknown project')

    def _normalize(self, connection, source_id, row):
        if not isinstance(row, dict):
            raise ValueError('row must be an object')
        event_id = _text(row.get('event_id', row.get('source_event_id')), 'event_id', optional=False, maximum=512)
        project = self._project_id(connection, row.get('project_id', row.get('project')))
        kind = _text(row.get('kind'), 'kind', optional=False, maximum=40)
        if kind not in _KINDS:
            raise ValueError('unsupported kind')
        at = _epoch(row.get('at'))
        values = {
            'source_id': source_id,
            'source_event_id': event_id,
            'project': project,
            'at': at,
            'kind': kind,
        }
        aliases = {'task': ('task_id', 'task'), 'attempt': ('attempt_id', 'attempt'),
                   'session': ('session_id', 'session'),
                   'parent_session': ('parent_session_id', 'parent_session'),
                   'root_session': ('root_session_id', 'root_session'),
                   'observed_cost_source': ('observed_cost_source', 'cost_source'),
                   'estimated_cost_source': ('estimated_cost_source', 'cost_source')}
        for field in _TEXT_FIELDS:
            names = aliases.get(field, (field,))
            value = next((row[name] for name in names if name in row), None)
            values[field] = _text(value, field)
        for field in _TOKEN_FIELDS:
            values[field] = _number(row.get(field), field, integer=True)
        values['observed_cost'] = _number(row.get('observed_cost'), 'observed_cost')
        values['estimated_cost'] = _number(row.get('estimated_cost'), 'estimated_cost')
        values['queue_latency'] = _number(row.get('queue_latency'), 'queue_latency')
        values['run_duration'] = _number(row.get('run_duration'), 'run_duration')
        values['validated'] = None if row.get('validated') is None else int(row['validated'] is True)
        if row.get('validated') is not None and type(row['validated']) is not bool:
            raise ValueError('invalid validated')
        values['capacity'] = _number(row.get('capacity'), 'capacity', integer=True)
        cumulative = row.get('cumulative', False)
        if type(cumulative) is not bool:
            raise ValueError('invalid cumulative')
        values['cumulative'] = int(cumulative)
        if kind == 'usage' and not any(values[field] is not None for field in _TOKEN_FIELDS + ('observed_cost', 'estimated_cost')):
            raise ValueError('usage row has no observed usage or cost')
        allowed_cost_sources = {'provider_reported', 'engine_reported', 'catalog_estimate', 'unknown'}
        if values['observed_cost_source'] not in (None, *allowed_cost_sources):
            raise ValueError('invalid observed cost provenance')
        if values['estimated_cost_source'] not in (None, *allowed_cost_sources):
            raise ValueError('invalid estimated cost provenance')
        if values['observed_cost'] is not None and values['observed_cost_source'] is None:
            values['observed_cost_source'] = 'unknown'
        if values['estimated_cost'] is not None and values['estimated_cost_source'] is None:
            values['estimated_cost_source'] = 'unknown'
        if values['source_version'] is not None and not re.fullmatch(r'[A-Za-z0-9._+-]{1,128}', values['source_version']):
            raise ValueError('invalid source version')
        if kind == 'capacity_snapshot' and (values['account'] is None or values['capacity'] is None or values['capacity'] < 1):
            raise ValueError('capacity snapshot needs account and positive capacity')
        return values

    def _cursor(self, source_id):
        with self.repository.connection() as connection:
            row = connection.execute('SELECT cursor FROM history_imports WHERE source_id=?', (source_id,)).fetchone()
            return row['cursor'] if row else None

    def ingest_events(self, source_id, cursor, rows, *, cancelled=None):
        source_id = _text(source_id, 'source_id', optional=False, maximum=200)
        if cursor is not None:
            cursor = _text(cursor, 'cursor', maximum=2048)
        if not isinstance(rows, (list, tuple)):
            raise ValueError('rows must be a list')
        accepted = duplicates = rejected = 0
        was_cancelled = False
        insert = '''INSERT OR IGNORE INTO history_facts(
            source_id,source_event_id,project,at,kind,task,attempt,session,parent_session,
            root_session,request_id,usage_group_id,cumulative,account,model,effort,status,tool,
            input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,
            observed_cost,estimated_cost,cost_currency,observed_cost_source,estimated_cost_source,queue_latency,run_duration,
            validated,capacity,source_version
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'''
        fields = ('source_id','source_event_id','project','at','kind','task','attempt','session',
                  'parent_session','root_session','request_id','usage_group_id','cumulative','account',
                  'model','effort','status','tool','input_tokens','output_tokens','reasoning_tokens',
                  'cache_read_tokens','cache_write_tokens','observed_cost','estimated_cost','cost_currency',
                  'observed_cost_source','estimated_cost_source','queue_latency','run_duration','validated','capacity','source_version')
        for offset in range(0, len(rows), self.batch_size):
            if _cancelled(cancelled):
                was_cancelled = True
                break
            batch = rows[offset:offset + self.batch_size]
            with self.repository.connection(True) as connection:
                for row in batch:
                    try:
                        values = self._normalize(connection, source_id, row)
                    except (TypeError, ValueError, OverflowError):
                        rejected += 1
                        continue
                    cursor_result = connection.execute(insert, tuple(values[name] for name in fields))
                    if cursor_result.rowcount:
                        accepted += 1
                    else:
                        duplicates += 1
        # Do not advance past a row that could not be normalized. Accepted
        # rows are idempotent, so callers can repair the mapping and safely
        # replay the page without losing already stored facts.
        if not was_cancelled and not rejected:
            with self.repository.connection(True) as connection:
                connection.execute('''INSERT INTO history_imports(source_id,cursor,updated_at) VALUES(?,?,?)
                    ON CONFLICT(source_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at''',
                                   (source_id, cursor, self.clock()))
        return ImportReceipt(source_id, self._cursor(source_id), accepted, duplicates, rejected, was_cancelled)


def ingest_events(repository, source_id, cursor, rows, *, batch_size=100, cancelled=None, clock=time.time):
    return HistoryIngestor(repository, batch_size=batch_size, clock=clock).ingest_events(
        source_id, cursor, rows, cancelled=cancelled)
