"""Scoped read-only client for the pinned AgentsView v1 analytics API."""
import json
import math
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo

from snooze.analytics import HistoryFilter


API_VERSION = 1
VERSION_PATH = '/api/v1/version'
REPORT_PATHS = {
    'usage_summary': '/api/v1/usage/summary',
    'usage_top_sessions': '/api/v1/usage/top-sessions',
    'analytics_summary': '/api/v1/analytics/summary',
    'analytics_heatmap': '/api/v1/analytics/heatmap',
    'analytics_hour_of_week': '/api/v1/analytics/hour-of-week',
    'analytics_projects': '/api/v1/analytics/projects',
    'analytics_tools': '/api/v1/analytics/tools',
    'activity_report': '/api/v1/activity/report',
    'session_usage': None,
    'session_children': None,
    'session_tool_calls': None,
}
SAFE_KEYS = {
    # Snooze DTO fields and the subset of AgentsView's public v1 schemas which
    # can safely contribute to a report. Prompt/transcript/content fields are
    # intentionally absent, even when an endpoint returns them.
    'summary', 'series', 'heatmap', 'hour_of_week', 'breakdowns', 'top_sessions', 'coverage', 'sources',
    'concurrency', 'query_ms', 'facts', 'event_count', 'attempt_count', 'usage_count', 'tool_call_count',
    'projects', 'tools', 'sessions', 'activity', 'hour_of_week', 'total', 'value', 'unit',
    'source', 'state', 'observed', 'eligible', 'missing', 'from', 'to', 'window', 'timezone',
    'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens',
    'observed_cost', 'estimated_cost', 'observed_costs', 'estimated_costs',
    'observed_cost_source', 'estimated_cost_source', 'observed_cost_sources', 'estimated_cost_sources',
    'cost_currency', 'cost_source', 'cache_efficiency', 'input_tokens_count', 'output_tokens_count',
    'count', 'events', 'validated', 'attempts', 'failures', 'retries', 'recoveries',
    'queue_latency', 'run_duration', 'duration', 'latency', 'p50', 'p95', 'samples',
    'date', 'hour', 'day', 'weekday', 'hours', 'at', 'timestamp', 'model', 'effort', 'account',
    'project', 'project_id', 'folder', 'session', 'session_id', 'parent_session_id',
    'root_session_id', 'task_id', 'attempt_id', 'request_id', 'tool', 'tool_name',
    'name', 'id', 'label', 'currency', 'unit_name', 'percentage', 'ratio', 'version',
    'source_version', 'source_window', 'contract_version', 'children', 'parent', 'kind',
    'active_days', 'active_projects', 'agents', 'avg_messages', 'concentration', 'median_messages',
    'models', 'most_active_project', 'p90_messages', 'token_reporting_sessions', 'total_messages',
    'total_output_tokens', 'total_sessions', 'entries', 'entries_from', 'levels', 'metric',
    'cells', 'day_of_week', 'messages', 'daily', 'totals', 'projectTotals', 'modelTotals',
    'agentTotals', 'sessionCounts', 'unsupportedUsage', 'cacheStats', 'comparison', 'pricing',
    'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'cacheSavings',
    'totalCost', 'microdollars', 'copilotAICredits', 'schema_version', 'projectBreakdowns', 'modelBreakdowns',
    'agentBreakdowns', 'machineBreakdowns', 'modelsUsed', 'totalTokens', 'sessionId', 'agent',
    'startedAt', 'cost', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'has_cost',
    'has_token_data', 'breakdown', 'breakdown_count', 'cost_usd', 'cost_source', 'rollup_cost',
    'rollup_cost_source', 'rollup_subagent_count', 'subagent_count', 'server_running',
    'peak_context_tokens', 'unpriced_models', 'tool_calls', 'by_agent', 'by_category', 'by_tool',
    'trend', 'by_project', 'by_model', 'by_session', 'buckets', 'range_start', 'range_end',
    'effective_end', 'bucket_count', 'bucket_seconds', 'bucket_unit', 'partial', 'as_of',
    'elapsed_bucket_count', 'peak', 'interactive_peak', 'subagent_peak', 'automated_peak',
    'sessions_total', 'report_id', 'sessions_next_cursor',
    'duration_min', 'active_duration_min', 'message_count', 'termination_status', 'ended_at',
    'started_at', 'total_calls', 'by_category', 'by_tool', 'by_agent', 'cost_currency',
    'input_cost', 'output_cost', 'cache_creation_cost', 'error_count', 'duration_ms',
    'status', 'category', 'calls', 'successes', 'failures', 'tool_name', 'tool_call_count',
    'ordinal', 'source', 'has_rollup_cost', 'ai_credits', 'web_search_requests', 'models_used',
    'cost_source', 'table_version', 'latest_row_updated_at', 'custom_override_count',
    'effective_row_count', 'digest', 'fallback', 'used', 'models', 'source',
}
DYNAMIC_MAP_KEYS = {'projects', 'agents', 'models'}


@dataclass(frozen=True)
class EngineReport:
    state: str
    payload: dict
    source_version: str | None
    source_window: dict | None
    coverage: dict
    error_kind: str | None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


class EngineClient:
    def __init__(self, base_url=None, *, allowed_hosts=(), bearer_token=None,
                 timeout=2.0, cache_ttl=15.0, max_cache_entries=128,
                 transport=None, clock=time.monotonic):
        self.base_url = None
        self._base = None
        self._allowed_hosts = set()
        self._token = bearer_token
        self.timeout = timeout
        self.cache_ttl = cache_ttl
        self.max_cache_entries = max_cache_entries
        self.transport = transport or self._request
        self.clock = clock
        self._cache = OrderedDict()
        self._version_cache = None
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0.1 <= timeout <= 10:
            raise ValueError('timeout must be between 0.1 and 10 seconds')
        if not isinstance(cache_ttl, (int, float)) or isinstance(cache_ttl, bool) or not 0 <= cache_ttl <= 300:
            raise ValueError('cache_ttl must be between 0 and 300 seconds')
        if type(max_cache_entries) is not int or not 1 <= max_cache_entries <= 1024:
            raise ValueError('max_cache_entries must be between 1 and 1024')
        if bearer_token is not None and (not isinstance(bearer_token, str) or len(bearer_token) > 4096):
            raise ValueError('Invalid bearer token')
        if base_url is not None:
            if not isinstance(base_url, str) or len(base_url) > 2048:
                raise ValueError('Invalid engine URL')
            parsed = urlsplit(base_url)
            if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError('Engine URL must be an origin or path without credentials/query/fragment')
            self._allowed_hosts = {self._host(value) for value in allowed_hosts}
            port = parsed.port
            if port in (80, 443): port = None
            host_port = parsed.hostname.lower() + ((':' + str(port)) if port else '')
            if not self._allowed_hosts or not any(self._host_matches(host_port, approved) for approved in self._allowed_hosts):
                raise ValueError('Engine host is outside the explicitly allowed scope')
            if parsed.scheme != 'https' and not self._loopback(parsed.hostname):
                raise ValueError('HTTP is allowed only for an explicitly scoped loopback engine')
            self._base = urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip('/'), '', ''))
            self.base_url = self._base

    @staticmethod
    def _host(value):
        if not isinstance(value, str) or not value or '*' in value or '/' in value or '@' in value:
            raise ValueError('allowed_hosts must contain exact host names')
        parsed = urlsplit('//' + value)
        if not parsed.hostname or parsed.path or parsed.query or parsed.fragment:
            raise ValueError('Invalid allowed host')
        port = parsed.port
        if port in (80, 443):
            port = None
        return parsed.hostname.lower() + ((':' + str(port)) if port else '')

    @staticmethod
    def _host_matches(host_port, allowed):
        return host_port.lower() == allowed.lower()

    @staticmethod
    def _loopback(host):
        import ipaddress
        if host.lower() == 'localhost':
            return True
        try:
            return ipaddress.ip_address(host).is_loopback
        except ValueError:
            return False

    @staticmethod
    def _request(request, timeout):
        return build_opener(_NoRedirect()).open(request, timeout=timeout)

    def _unavailable(self, error_kind):
        return EngineReport('unavailable', {}, None, None, {'state': 'unavailable'}, error_kind)

    def _path(self, report_kind, filters):
        if report_kind not in REPORT_PATHS:
            raise ValueError('Unknown analytics report kind')
        path = REPORT_PATHS[report_kind]
        if path is None:
            if not filters.session_id:
                raise ValueError('Session report requires session_id')
            session_id = quote(filters.session_id, safe='')
            suffix = {'session_usage': 'usage', 'session_children': 'children', 'session_tool_calls': 'tool-calls'}[report_kind]
            path = f'/api/v1/sessions/{session_id}/{suffix}'
        return path

    @staticmethod
    def _iso_utc(timestamp):
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')

    def _query(self, report_kind, filters):
        if filters.accounts or filters.efforts:
            raise LookupError('unsupported_filter')
        if len(filters.project_ids) > 1 or len(filters.models) > 1:
            raise LookupError('unsupported_filter')
        query = {}
        path = REPORT_PATHS[report_kind]
        if report_kind.startswith('session_'):
            if filters.start is not None or filters.end is not None or filters.project_ids or filters.models:
                raise LookupError('unsupported_filter')
            return query
        query['timezone'] = filters.timezone
        if path == '/api/v1/activity/report':
            if filters.models:
                raise LookupError('unsupported_filter')
            if filters.start is not None: query['from'] = self._iso_utc(filters.start)
            if filters.end is not None: query['to'] = self._iso_utc(filters.end)
        else:
            zone = ZoneInfo(filters.timezone)
            if filters.start is not None:
                query['from'] = datetime.fromtimestamp(filters.start, timezone.utc).astimezone(zone).date().isoformat()
            if filters.end is not None:
                query['to'] = datetime.fromtimestamp(filters.end, timezone.utc).astimezone(zone).date().isoformat()
        if filters.project_ids:
            query['project'] = filters.project_ids[0]
        if filters.models:
            if path == '/api/v1/activity/report':
                raise LookupError('unsupported_filter')
            query['model'] = filters.models[0]
        return query

    @classmethod
    def _sanitize(cls, value, depth=0, *, dynamic_keys=False):
        if depth > 6:
            return None
        if value is None or isinstance(value, (bool, int, float)):
            if isinstance(value, float) and not math.isfinite(value): return None
            return value
        if isinstance(value, str):
            # An allowed field name is not permission to expose secret-like text.
            return re.sub(r'(?i)Bearer\s+\S+|lsat_[A-Za-z0-9_-]+','[redacted]',value[:1000])
        if isinstance(value, list):
            return [clean for item in value[:500] if (clean := cls._sanitize(item, depth + 1)) is not None]
        if isinstance(value, dict):
            result = {}
            for key, item in list(value.items())[:200]:
                if not isinstance(key, str):
                    continue
                if key in SAFE_KEYS:
                    clean = cls._sanitize(item, depth + 1, dynamic_keys=key in DYNAMIC_MAP_KEYS)
                elif dynamic_keys and isinstance(item, dict) and re.fullmatch(r'[\w .:/-]{1,200}', key, re.UNICODE):
                    clean = cls._sanitize(item, depth + 1)
                else:
                    continue
                if clean is not None:
                    result[key] = clean
            return result
        return None

    @staticmethod
    def _shape_valid(report_kind, body):
        if report_kind == 'usage_summary':
            return (isinstance(body, dict) and all(key in body for key in ('projects', 'from', 'to', 'totals', 'daily', 'projectTotals', 'modelTotals'))
                    and isinstance(body['projects'], dict) and isinstance(body['totals'], dict)
                    and isinstance(body['daily'], list) and isinstance(body['projectTotals'], list)
                    and isinstance(body['modelTotals'], list) and isinstance(body['from'], str) and isinstance(body['to'], str))
        if report_kind == 'usage_top_sessions':
            required = {'sessionId', 'displayName', 'agent', 'project', 'startedAt', 'inputTokens', 'outputTokens',
                        'cacheCreationTokens', 'cacheReadTokens', 'totalTokens', 'cost'}
            return isinstance(body, list) and all(isinstance(item, dict) and required <= item.keys() for item in body)
        if report_kind == 'analytics_summary':
            integers = ('total_sessions', 'total_messages', 'total_output_tokens', 'token_reporting_sessions', 'active_projects', 'active_days')
            return (isinstance(body, dict) and all(type(body.get(key)) is int for key in integers)
                    and isinstance(body.get('models'), list))
        if report_kind == 'analytics_heatmap':
            return isinstance(body, dict) and {'metric', 'entries', 'levels', 'entries_from'} <= body.keys() and isinstance(body['entries'], list)
        if report_kind == 'analytics_hour_of_week':
            return (isinstance(body, dict) and isinstance(body.get('cells'), list)
                    and all(isinstance(cell, dict) and all(type(cell.get(key)) is int for key in ('day_of_week', 'hour', 'messages'))
                            for cell in body['cells']))
        if report_kind == 'analytics_projects':
            return isinstance(body, dict) and isinstance(body.get('projects'), list)
        if report_kind == 'analytics_tools':
            return (isinstance(body, dict) and type(body.get('total_calls')) is int
                    and all(isinstance(body.get(key), list) for key in ('by_category', 'by_agent', 'by_tool', 'trend')))
        if report_kind == 'activity_report':
            required = {'projects', 'timezone', 'range_start', 'range_end', 'bucket_unit', 'bucket_seconds', 'bucket_count',
                        'partial', 'buckets', 'peak', 'totals', 'by_project', 'by_model', 'by_agent', 'by_session', 'sessions_total'}
            return (isinstance(body, dict) and required <= body.keys() and isinstance(body['buckets'], list)
                    and isinstance(body['partial'], bool) and isinstance(body['timezone'], str))
        if report_kind == 'session_usage':
            required = {'session_id', 'agent', 'project', 'total_output_tokens', 'peak_context_tokens', 'has_token_data',
                        'cost', 'has_cost', 'models', 'unpriced_models', 'breakdown_count', 'breakdown', 'server_running'}
            return isinstance(body, dict) and required <= body.keys() and isinstance(body['breakdown'], list)
        if report_kind == 'session_children':
            return isinstance(body, list) and all(isinstance(item, dict) and 'id' in item for item in body)
        if report_kind == 'session_tool_calls':
            return isinstance(body, dict) and isinstance(body.get('tool_calls'), list) and type(body.get('count')) is int
        return False

    def _request_json(self, path, query):
        url = self._base + path
        encoded = urlencode(query)
        if encoded:
            url += '?' + encoded
        headers = {'Accept': 'application/json', 'User-Agent': 'Snooze-Analytics/1'}
        if self._token:
            headers['Authorization'] = 'Bearer ' + self._token
        request = Request(url, headers=headers, method='GET')
        try:
            response = self.transport(request, self.timeout)
            with response as opened:
                status = opened.getcode() if hasattr(opened, 'getcode') else getattr(opened, 'status', 200)
                if 300 <= status < 400:
                    return None, 'redirect_blocked'
                if status < 200 or status >= 300:
                    return None, 'http_error'
                raw = opened.read(2_000_001)
                if len(raw) > 2_000_000:
                    return None, 'response_too_large'
        except HTTPError as error:
            if 300 <= error.code < 400:
                return None, 'redirect_blocked'
            return None, 'http_error'
        except TimeoutError:
            return None, 'timeout'
        except (URLError, OSError):
            return None, 'unavailable'
        except Exception:
            return None, 'transport_error'
        try:
            return json.loads(raw.decode('utf-8')), None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, 'malformed_json'

    def _source_version(self):
        now = self.clock()
        if self._version_cache and now - self._version_cache[0] <= self.cache_ttl:
            return self._version_cache[1], None
        body, error = self._request_json(VERSION_PATH, {})
        if error:
            return None, error
        if (not isinstance(body, dict) or type(body.get('api_version')) is not int
                or body.get('api_version') != API_VERSION
                or not isinstance(body.get('version'), str) or not body['version']
                or not isinstance(body.get('commit'), str) or not body['commit']):
            return None, 'contract_mismatch'
        version = f"{body['version'][:80]}+{body['commit'][:80]} (API {body['api_version']})"
        self._version_cache = (now, version)
        return version, None

    def _normalize(self, report_kind, body, source_version, filters, query):
        if not self._shape_valid(report_kind, body):
            raise LookupError('response shape mismatch')
        if report_kind == 'usage_top_sessions':
            data = {'sessions': body}
        elif report_kind == 'session_children':
            data = {'children': body}
        else:
            data = body
        clean_data = self._sanitize(data)
        if not isinstance(clean_data, dict) or not clean_data:
            raise LookupError('normalized report is empty')
        precision = 'rfc3339' if report_kind == 'activity_report' or report_kind.startswith('session_') else 'calendar_day'
        source_window = {
            'requested_from_utc': self._iso_utc(filters.start) if filters.start is not None else None,
            'requested_to_utc': self._iso_utc(filters.end) if filters.end is not None else None,
            'timezone': filters.timezone,
            'granularity': precision,
            'native_from': query.get('from'),
            'native_to': query.get('to'),
        }
        if isinstance(body, dict):
            if 'range_start' in body: source_window['native_from'] = body['range_start']
            elif 'from' in body: source_window['native_from'] = body['from']
            if 'range_end' in body: source_window['native_to'] = body['range_end']
            elif 'to' in body: source_window['native_to'] = body['to']
        coverage = {'state': 'partial' if isinstance(body, dict) and body.get('partial') is True else 'available',
                    'response_shape': report_kind, 'native_partial': bool(isinstance(body, dict) and body.get('partial') is True)}
        if report_kind == 'usage_summary':
            counts = body.get('sessionCounts')
            coverage['token_coverage'] = {
                'observed_sessions': None,
                'eligible_sessions': counts.get('total') if isinstance(counts, dict) else None,
                'state': 'unavailable',
                'reason': 'this endpoint exposes aggregate token totals but no session token-coverage count',
            }
        elif report_kind == 'analytics_summary':
            coverage['token_coverage'] = {
                'observed_sessions': body.get('token_reporting_sessions'),
                'eligible_sessions': body.get('total_sessions'),
            }
        return EngineReport('available', clean_data, source_version, source_window, coverage, None)

    def query(self, report_kind, filters):
        if not isinstance(filters, HistoryFilter):
            raise TypeError('filters must be HistoryFilter')
        path = self._path(report_kind, filters)
        if self._base is None:
            return self._unavailable('not_configured')
        try:
            query = self._query(report_kind, filters)
        except LookupError:
            return self._unavailable('unsupported_filter')
        key = (report_kind, filters)
        now = self.clock()
        cached = self._cache.get(key)
        if cached and now - cached[0] <= self.cache_ttl:
            self._cache.move_to_end(key)
            return cached[1]
        source_version, error = self._source_version()
        if error:
            return self._unavailable(error)
        body, error = self._request_json(path, query)
        if error:
            return self._unavailable(error)
        try:
            result = self._normalize(report_kind, body, source_version, filters, query)
        except (LookupError, TypeError, ValueError):
            return self._unavailable('contract_mismatch')
        self._cache[key] = (now, result)
        self._cache.move_to_end(key)
        while len(self._cache) > self.max_cache_entries:
            self._cache.popitem(last=False)
        return result

    def clear_cache(self):
        self._cache.clear()
        self._version_cache = None

    def test_connection(self, filters=None):
        """Perform a read-only analytics summary request and validate its API version."""
        return self.query('analytics_summary', filters or HistoryFilter())
