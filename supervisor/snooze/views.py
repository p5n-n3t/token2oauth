"""Allowlisted schema-v2 dashboard projections over the legacy Store snapshot."""
from __future__ import annotations

import re
from urllib.parse import urlparse


_TERMINAL = {'complete', 'completed', 'done', 'cancelled', 'canceled', 'failed'}
_TASK_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,128}$')


def _text(value, limit=4000):
    return value[:limit] if isinstance(value, str) else None


def _safe_reference(value):
    if not isinstance(value, str):
        return None
    parsed = urlparse(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        return None
    return value


def _worker(snapshot, task_id):
    for worker in snapshot.get('workers', []):
        if isinstance(worker, dict) and worker.get('id') == task_id:
            return worker
    return None


def dashboard_state(store, project_id: str, config: dict, now: float) -> dict:
    """Return a stable, private dashboard DTO without passing through raw jobs."""
    snapshot = getattr(store,'active_snapshot',store.snapshot)(project_id)
    config = config if isinstance(config, dict) else {}
    workers = [w for w in snapshot.get('workers', []) if isinstance(w, dict)]
    slots = []
    for worker in workers:
        legacy_state = worker.get('state')
        task_state = legacy_state.lower() if isinstance(legacy_state, str) else 'queued'
        if task_state in _TERMINAL:
            continue
        observation = worker.get('observation')
        observation = observation if isinstance(observation, dict) else {}
        freshness = worker.get('observation_status')
        if freshness not in ('fresh', 'stale', 'unobserved'):
            freshness = 'unavailable' if observation.get('status') == 'unavailable' else 'unknown'
        provider_state = observation.get('status')
        if not isinstance(provider_state, str):
            provider_state = 'unobserved' if not observation else 'unknown'
        references = worker.get('references', worker.get('artifacts', []))
        if not isinstance(references, list):
            references = []
        slots.append({
            'task_id': _text(worker.get('id'), 128),
            'session_id': _text(worker.get('session_id'), 256),
            'account_id': _text(worker.get('server_key'), 128),
            'logical_slot': worker.get('logical_slot') if isinstance(worker.get('logical_slot'), int) else None,
            'workspace_id': _text(worker.get('workspace_id'), 2048),
            'task_summary': _text(worker.get('title') or worker.get('name'), 500),
            'requested_model': _text(worker.get('requested_model'), 256),
            'confirmed_model': _text(observation.get('model'), 256),
            'requested_effort': _text(worker.get('requested_effort') or worker.get('requested_reasoning'), 128),
            'confirmed_effort': _text(observation.get('effort'), 128),
            'started_at': worker.get('last_sent') if isinstance(worker.get('last_sent'), (int, float)) else None,
            'observed_at': worker.get('observed_at') if isinstance(worker.get('observed_at'), (int, float)) else None,
            'provider_state': provider_state,
            'task_state': task_state,
            'observation_freshness': freshness,
            'references': [ref for value in references if (ref := _safe_reference(value))],
        })

    external_owner = bool(config.get('ownership')) or config.get('dispatcher') == 'external'
    accounts = []
    try:
        from snooze.accounts import discover_accounts
        accounts = [{k: account.get(k) for k in ('server_key', 'label', 'capacity', 'enabled')}
                    for account in discover_accounts(config)]
    except (AttributeError, TypeError):
        pass
    incidents = []
    for incident in snapshot.get('incidents', []):
        if isinstance(incident, dict):
            incidents.append({
                'task_id': _text(incident.get('job'), 128),
                'kind': _text(incident.get('kind'), 128),
                'message': _text(incident.get('message'), 2000),
                'at': incident.get('at') if isinstance(incident.get('at'), (int, float)) else None,
            })
    settings = snapshot.get('settings')
    settings = settings if isinstance(settings, dict) else {}
    return {
        'schema_version': 2,
        'project': {'id': project_id, 'name': _text(config.get('project'),160) or project_id},
        'summary': {'active_tasks': len(slots), 'incidents': len(incidents)},
        'accounts': accounts,
        'slots': slots,
        'incidents': incidents,
        'settings': {'interval': settings.get('interval') if isinstance(settings.get('interval'), int) else None},
        'capabilities': {
            'dispatch': {'supported': False, 'reason': 'Dispatch is owned outside Snooze.' if external_owner else 'Dispatch is not enabled.'},
        },
        'cycle': {'started_at': None, 'finished_at': None, 'checked': None},
    }


def task_detail(store, project_id: str, task_id: str) -> dict | None:
    """Return allowlisted task text and validated references, or None."""
    if not isinstance(task_id, str) or not _TASK_ID.fullmatch(task_id):
        return None
    worker = _worker(store.snapshot(project_id), task_id)
    if worker is None:
        return None
    raw_refs = worker.get('references', worker.get('artifacts', []))
    if not isinstance(raw_refs, list):
        raw_refs = []
    return {
        'task_id': task_id,
        'summary': _text(worker.get('title') or worker.get('name'), 500),
        'instruction': _text(worker.get('instruction') or worker.get('prompt')),
        'state': _text(worker.get('state'), 128),
        'attempts': [],
        'events': [],
        'references': [ref for value in raw_refs if (ref := _safe_reference(value))],
    }
