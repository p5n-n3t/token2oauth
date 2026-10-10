"""Transactional task ownership, fencing and append-only execution evidence."""
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path, PurePosixPath
from snooze.domain import TaskSpec, AttemptReceipt
from snooze.migrations import migrate_state


class DispatchFenceError(ValueError):
    """A reserved provider mutation no longer passes its final local fence."""


def normalized_scope(value):
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ValueError('Invalid scope')
    if value.startswith('record:'):
        if not value[7:] or any(c.isspace() for c in value[7:]): raise ValueError('Invalid record scope')
        return value
    if value.startswith('path:'):
        raw = value[5:]
        path = PurePosixPath(raw)
        if not raw or path.is_absolute() or '..' in path.parts or '\\' in raw or str(path) == '.':
            raise ValueError('Scope must be repository-relative')
        return 'path:' + str(path)
    raise ValueError('Use record:ID or path:repository-relative scope')


def scopes_overlap(left, right):
    for a in left:
        for b in right:
            if a == b: return True
            if a.startswith('path:') and b.startswith('path:') and (a.startswith(b + '/') or b.startswith(a + '/')):
                return True
    return False


class TaskRepository:
    def __init__(self, path):
        self.path = Path(path)
        migrate_state(self.path)

    @contextmanager
    def connection(self, write=False):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        try:
            if write: c.execute('BEGIN IMMEDIATE')
            yield c
            if write: c.commit()
        except Exception:
            if write: c.rollback()
            raise
        finally: c.close()

    def event(self, c, project, kind, data=None, task=None, attempt=None, now=None):
        c.execute('INSERT INTO events(project,task,attempt,kind,at,data) VALUES(?,?,?,?,?,?)',
                  (project, task, attempt, kind, time.time() if now is None else now, json.dumps(data or {})))

    def register_project(self, id, folder, remote=None):
        with self.connection(True) as c:
            c.execute('INSERT OR IGNORE INTO projects(id,folder,remote) VALUES(?,?,?)', (id, folder, remote))
            c.execute('INSERT OR IGNORE INTO project_aliases VALUES(?,?)', (folder, id))

    def add_alias(self, project, alias):
        with self.connection(True) as c:
            if not c.execute('SELECT 1 FROM projects WHERE id=?', (project,)).fetchone(): raise ValueError('Unknown project')
            c.execute('INSERT INTO project_aliases VALUES(?,?)', (alias, project))

    def resolve_project(self, alias):
        with self.connection() as c:
            row = c.execute('SELECT project FROM project_aliases WHERE alias=?', (alias,)).fetchone()
            return row['project'] if row else None

    def project(self, id):
        with self.connection() as c:
            row = c.execute('SELECT * FROM projects WHERE id=?', (id,)).fetchone()
            return dict(row) if row else None

    def set_executor(self, project, executor, *, quiesced=False, reconciled=False):
        if executor not in ('external-managed', 'shadow', 'snooze'): raise ValueError('Invalid executor')
        if executor == 'snooze' and not (quiesced and reconciled): raise ValueError('Handover requires quiescence and reconciled sessions')
        with self.connection(True) as c:
            current=c.execute('SELECT executor FROM projects WHERE id=?',(project,)).fetchone()
            if current is None:raise ValueError('Unknown project')
            if executor=='snooze' and current['executor']!='snooze' and c.execute('SELECT 1 FROM attempts WHERE project=? AND released_at IS NULL',(project,)).fetchone():
                raise ValueError('Unreconciled attempts still own scopes; handover rejected')
            c.execute('UPDATE projects SET executor=? WHERE id=?', (executor, project))
            self.event(c, project, 'executor_changed', {'executor': executor})

    def add(self, spec: TaskSpec, instructions='', now=None):
        if not spec.id or not spec.project_id or not spec.scope_keys: raise ValueError('Task identity and scope required')
        scopes = tuple(sorted(set(normalized_scope(s) for s in spec.scope_keys)))
        data = asdict(spec); data['scope_keys'] = scopes
        when = time.time() if now is None else now
        with self.connection(True) as c:
            c.execute('INSERT INTO tasks(id,project,spec,instructions,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                      (spec.id, spec.project_id, json.dumps(data), instructions, 'queued' if spec.approved else 'draft', when, when))
            self.event(c, spec.project_id, 'task_added', {'state': 'queued' if spec.approved else 'draft'}, task=spec.id, now=when)

    @staticmethod
    def decode(row):
        if row is None: return None
        data = dict(row); data['spec'] = json.loads(data['spec'])
        return data

    def get(self, id):
        with self.connection() as c: return self.decode(c.execute('SELECT * FROM tasks WHERE id=?', (id,)).fetchone())

    def list(self, project):
        with self.connection() as c:
            return [self.decode(r) for r in c.execute('SELECT * FROM tasks WHERE project=? ORDER BY priority DESC,created_at,id', (project,))]

    def queue_page(self,project,*,offset=0,limit=50):
        if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=200:raise ValueError('Invalid queue page')
        with self.connection() as c:
            total=c.execute('SELECT COUNT(*) FROM tasks WHERE project=?',(project,)).fetchone()[0]
            rows=c.execute('SELECT id,project,state,priority,created_at,updated_at,revision,substr(instructions,1,160) AS summary,json_extract(spec,"$.approved") AS approved FROM tasks WHERE project=? ORDER BY priority DESC,created_at,id LIMIT ? OFFSET ?',(project,limit,offset)).fetchall()
        return {'tasks':[{**dict(r),'approved':bool(r['approved'])} for r in rows],'total':total,'offset':offset,'has_more':offset+len(rows)<total}

    def spec(self, id):
        task = self.get(id)
        if not task: raise ValueError('Unknown task')
        data = task['spec']; data['scope_keys'] = tuple(data['scope_keys']); data['dependencies'] = tuple(data['dependencies'])
        return TaskSpec(**data)

    def reserve(self, task_id, account_id, scope_keys, now, *, policy_revision=None, override_pause=False):
        scopes = tuple(sorted(set(normalized_scope(s) for s in scope_keys)))
        with self.connection(True) as c:
            task = self.decode(c.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone())
            if not task or task['state'] not in ('queued', 'retry_due') or not task['spec']['approved']: raise ValueError('Task not ready/approved')
            if list(scopes) != sorted(task['spec']['scope_keys']): raise ValueError('Scope differs from approved assignment')
            for row in c.execute('SELECT scopes FROM attempts WHERE project=? AND released_at IS NULL', (task['project'],)):
                if scopes_overlap(scopes, json.loads(row['scopes'])): raise ValueError('Active assignment scope conflict')
            account = c.execute('SELECT data FROM provider_configs WHERE id=?', (account_id,)).fetchone()
            if account:
                capacity = json.loads(account['data']).get('capacity', 1)
                occupied = c.execute('SELECT COUNT(*) FROM attempts WHERE account=? AND released_at IS NULL', (account_id,)).fetchone()[0]
                if occupied >= capacity: raise ValueError('Account capacity occupied')
            policy_row = c.execute('SELECT data,revision FROM policy_settings WHERE project=?', (task['project'],)).fetchone()
            policy = json.loads(policy_row['data']) if policy_row else {}
            if policy_revision is not None:
                owner=c.execute('SELECT executor FROM projects WHERE id=?',(task['project'],)).fetchone()
                if not owner or owner['executor']!='snooze' or not policy_row or policy_row['revision']!=policy_revision or policy.get('emergency_stop') or (policy.get('pause_dispatch',True) and not override_pause):
                    raise ValueError('Dispatch ownership or policy changed')
            project_count = c.execute('SELECT COUNT(*) FROM attempts WHERE project=? AND released_at IS NULL', (task['project'],)).fetchone()[0]
            total_count = c.execute('SELECT COUNT(*) FROM attempts WHERE released_at IS NULL').fetchone()[0]
            if project_count >= policy.get('max_concurrent', 12) or total_count >= policy.get('global_concurrent', 24):
                raise ValueError('Concurrency limit reached')
            model = task['spec']['requirements'].get('model')
            model_limit = policy.get('model_limits', {}).get(model)
            if model_limit is not None:
                model_count = sum(json.loads(r['data']).get('requested_model') == model for r in c.execute('SELECT data FROM attempts WHERE project=? AND released_at IS NULL', (task['project'],)))
                if model_count >= model_limit: raise ValueError('Model concurrency limit reached')
            generation = c.execute('SELECT COALESCE(MAX(generation),0)+1 FROM attempts WHERE task=?', (task_id,)).fetchone()[0]
            attempt_id = uuid.uuid4().hex; key = uuid.uuid4().hex
            c.execute('INSERT INTO attempts(id,task,project,account,generation,idempotency_key,state,scopes,started_at,lease_until,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                      (attempt_id, task_id, task['project'], account_id, generation, key, 'reserved', json.dumps(scopes), now, now + 600, json.dumps({'requested_model': model})))
            c.execute('UPDATE tasks SET state="reserved",updated_at=?,revision=revision+1 WHERE id=?', (now, task_id))
            self.event(c, task['project'], 'attempt_reserved', {'account': account_id, 'generation': generation}, task_id, attempt_id, now)
            return AttemptReceipt(attempt_id, generation, key, None, 'reserved')

    def attempt(self, id):
        with self.connection() as c:
            row = c.execute('SELECT * FROM attempts WHERE id=?', (id,)).fetchone()
            if row is None: return None
            data = dict(row); data['data'] = json.loads(data['data']); data['scopes'] = json.loads(data['scopes'])
            return data

    def active(self, project):
        with self.connection() as c: ids = [r['id'] for r in c.execute('SELECT id FROM attempts WHERE project=? AND released_at IS NULL', (project,))]
        return [self.attempt(id) for id in ids]

    @contextmanager
    def dispatch_fence(self, attempt_id, policy_revision, *, override_pause=False):
        """Serialize the last local ownership/policy check with provider I/O.

        The write transaction remains held while the caller performs exactly one
        provider mutation. A persisted pause/stop therefore cannot be acknowledged
        between this check and that mutation.
        """
        with self.connection(True) as c:
            row = c.execute('SELECT * FROM attempts WHERE id=? AND released_at IS NULL', (attempt_id,)).fetchone()
            if not row:
                raise DispatchFenceError('Attempt ownership is no longer active')
            project = c.execute('SELECT executor FROM projects WHERE id=?', (row['project'],)).fetchone()
            if not project or project['executor'] != 'snooze':
                raise DispatchFenceError('Snooze no longer owns dispatch for this project')
            policy = c.execute('SELECT revision,data FROM policy_settings WHERE project=?', (row['project'],)).fetchone()
            revision = policy['revision'] if policy else 0
            settings = json.loads(policy['data']) if policy else {}
            if revision != policy_revision:
                raise DispatchFenceError('Dispatch policy revision changed')
            if settings.get('emergency_stop', False) or (settings.get('pause_dispatch', True) and not override_pause):
                raise DispatchFenceError('Dispatch is paused or stopped')
            if not c.execute('SELECT 1 FROM provider_projects WHERE account=? AND project=?', (row['account'], row['project'])).fetchone():
                raise DispatchFenceError('Provider account is no longer authorized for this project')
            account = c.execute('SELECT data FROM provider_configs WHERE id=?', (row['account'],)).fetchone()
            if not account:
                raise DispatchFenceError('Provider account configuration is unavailable')

            account_occupied = {}
            for occupied in c.execute('SELECT account,COUNT(*) AS n FROM attempts WHERE released_at IS NULL AND id!=? GROUP BY account', (attempt_id,)):
                account_occupied[occupied['account']] = occupied['n']
            project_occupied = c.execute('SELECT COUNT(*) FROM attempts WHERE project=? AND released_at IS NULL AND id!=?', (row['project'], attempt_id)).fetchone()[0]
            global_occupied = c.execute('SELECT COUNT(*) FROM attempts WHERE released_at IS NULL AND id!=?', (attempt_id,)).fetchone()[0]
            model_occupied = {}
            for occupied in c.execute('SELECT data FROM attempts WHERE project=? AND released_at IS NULL AND id!=?', (row['project'], attempt_id)):
                model = json.loads(occupied['data']).get('requested_model')
                if model:
                    model_occupied[model] = model_occupied.get(model, 0) + 1
            attempt = dict(row)
            attempt['data'] = json.loads(row['data'])
            attempt['scopes'] = json.loads(row['scopes'])
            yield {
                'attempt': attempt,
                'settings': settings,
                'revision': revision,
                'account_config': json.loads(account['data']),
                'account_occupied': account_occupied,
                'project_occupied': project_occupied,
                'global_occupied': global_occupied,
                'model_occupied': model_occupied,
            }

    def abandon_pre_io(self, attempt_id, reason, now=None):
        """Release only a local reservation proven not to have reached a provider."""
        when = time.time() if now is None else now
        with self.connection(True) as c:
            row = c.execute('SELECT * FROM attempts WHERE id=? AND released_at IS NULL', (attempt_id,)).fetchone()
            if not row or row['state'] not in ('reserved', 'starting') or row['session'] is not None:
                return False
            data = json.loads(row['data'])
            data['dispatch_fence_rejected'] = str(reason)[:300]
            c.execute('UPDATE attempts SET state="blocked",released_at=?,data=? WHERE id=?', (when, json.dumps(data), attempt_id))
            c.execute('UPDATE tasks SET state="blocked",updated_at=?,revision=revision+1 WHERE id=?', (when, row['task']))
            self.event(c, row['project'], 'owner_released', {'dispatch_not_started': True, 'reason': str(reason)[:300]}, row['task'], attempt_id, when)
            return True

    def update_attempt(self, id, state, *, session=None, data=None, now=None, expected_revision=None):
        allowed = {'reserved','starting','running','awaiting_output','validating','complete','failed','cancel_pending','cancelled','ambiguous','blocked'}
        if state not in allowed: raise ValueError('Invalid attempt state')
        when = time.time() if now is None else now
        with self.connection(True) as c:
            row = c.execute('SELECT * FROM attempts WHERE id=? AND released_at IS NULL', (id,)).fetchone()
            if not row: raise ValueError('No active attempt')
            task=c.execute('SELECT revision FROM tasks WHERE id=?',(row['task'],)).fetchone()
            if expected_revision is not None and task['revision']!=expected_revision:raise ValueError('Stale revision')
            merged = json.loads(row['data']); merged.update(data or {})
            c.execute('UPDATE attempts SET state=?,session=COALESCE(?,session),data=? WHERE id=?', (state, session, json.dumps(merged), id))
            c.execute('UPDATE tasks SET state=?,updated_at=?,revision=revision+1 WHERE id=?', (state, when, row['task']))
            self.event(c, row['project'], 'attempt_' + state, merged, row['task'], id, when)

    def release(self, attempt_id, evidence):
        if not any(evidence.get(k) is True for k in ('confirmed_inactive', 'cancelled', 'validated', 'manual_ownership_resolution')): return False
        with self.connection(True) as c:
            row = c.execute('SELECT * FROM attempts WHERE id=? AND released_at IS NULL', (attempt_id,)).fetchone()
            if not row: return False
            c.execute('UPDATE attempts SET released_at=? WHERE id=?', (time.time(), attempt_id))
            self.event(c, row['project'], 'owner_released', evidence, row['task'], attempt_id)
            return True

    def record_artifact(self, attempt_id, generation, reference):
        with self.connection(True) as c:
            row = c.execute('SELECT * FROM attempts WHERE id=?', (attempt_id,)).fetchone()
            if not row: raise ValueError('Unknown attempt')
            state = 'accepted' if row['generation'] == generation and row['released_at'] is None else 'quarantined'
            c.execute('INSERT INTO artifacts VALUES(?,?,?,?,?,?)', (uuid.uuid4().hex, attempt_id, generation, state, json.dumps(reference), time.time()))
            self.event(c, row['project'], 'artifact_' + state, {'generation': generation}, row['task'], attempt_id)
            return state

    def artifacts(self, attempt_id):
        with self.connection() as c:
            return [{**dict(r), 'reference': json.loads(r['reference'])} for r in c.execute('SELECT * FROM artifacts WHERE attempt=? ORDER BY at', (attempt_id,))]

    def transition(self, id, state, now=None, *, expected_revision=None, require_inactive=False):
        if state not in {'draft','queued','held','retry_due','blocked','cancelled','complete','unresolved'}: raise ValueError('Invalid task state')
        with self.connection(True) as c:
            row = c.execute('SELECT * FROM tasks WHERE id=?', (id,)).fetchone()
            if not row: raise ValueError('Unknown task')
            if expected_revision is not None and row['revision']!=expected_revision:raise ValueError('Stale revision')
            if require_inactive and c.execute('SELECT 1 FROM attempts WHERE task=? AND released_at IS NULL',(id,)).fetchone():raise ValueError('Active ownership must be reconciled')
            c.execute('UPDATE tasks SET state=?,updated_at=?,revision=revision+1 WHERE id=?', (state, now or time.time(), id))
            self.event(c, row['project'], 'task_' + state, {}, id, now=now)
