"""Public connection settings and private transport references, not raw MCP config."""
import json
import math
import time
from snooze.domain import AccountSnapshot
from snooze.adapters.registered import RegisteredAdapter
from snooze.adapters.lightsprint import LightSprintAdapter


PUBLIC_FIELDS = {'label','adapter','enabled','capacity','models','efforts','priority','tools','privacy','quality','reserve','allow_unknown_quota','quota_override','cooldown_until'}
BACKEND_FIELDS = {'mcp_key','workspace_id','stack_id','repo_id','verified_capacity','verified_operations','launch_verified','health','artifact_repo','artifact_prefix','artifact_credential_ref','failure_count','error_kind'}
ADAPTERS = {'lightsprint','local','native','ssh','tailscale','ollama','v0','figma','external'}


class ProviderRegistry:
    def __init__(self, repository, transport=None, collector=None, project_id=None):
        self.repo = repository
        self.transport = transport
        self.collector = collector
        self.project_id = project_id
        self.overrides = {}
        with self.repo.connection(True) as c:
            c.execute('CREATE TABLE IF NOT EXISTS provider_projects(account TEXT,project TEXT,can_manage INTEGER DEFAULT 0,PRIMARY KEY(account,project))')

    def authorize(self,account,project,*,manage=False):
        if not self.get(account) or not self.repo.project(project):raise ValueError('Unknown account/project')
        with self.repo.connection(True) as c:
            c.execute('INSERT INTO provider_projects VALUES(?,?,?) ON CONFLICT(account,project) DO UPDATE SET can_manage=MAX(can_manage,excluded.can_manage)',(account,project,int(manage)))
            self.repo.event(c,project,'account_authorized',{'account':account,'can_manage':manage})

    def authorized(self,account,project,*,manage=False):
        with self.repo.connection() as c:
            row=c.execute('SELECT can_manage FROM provider_projects WHERE account=? AND project=?',(account,project)).fetchone()
        return bool(row and (not manage or row['can_manage']))

    def get(self, id):
        with self.repo.connection() as c:
            row = c.execute('SELECT * FROM provider_configs WHERE id=?', (id,)).fetchone()
            return {**json.loads(row['data']), 'revision': row['revision']} if row else None

    def upsert_public_config(self, account_id, values, *, trusted=False, expected_revision=None, project_id=None):
        if not isinstance(values, dict) or set(values) - (PUBLIC_FIELDS | (BACKEND_FIELDS if trusted else {'mcp_key','workspace_id'})):
            raise ValueError('Unknown/private configuration fields')
        existing=self.get(account_id)
        project_id=project_id or self.project_id
        if existing and project_id and not trusted and not self.authorized(account_id,project_id,manage=True):raise PermissionError('Account is not manageable in this project')
        current = existing or {'id': account_id, 'label': account_id, 'adapter': 'lightsprint', 'enabled': True, 'capacity': 12, 'models': [], 'efforts': ['low'], 'reserve': 0, 'health': 'unknown'}
        original_revision = current.get('revision',0)
        if expected_revision is not None and expected_revision != original_revision: raise ValueError('Stale revision')
        current.update(values)
        if current['adapter'] not in ADAPTERS: raise ValueError('Unknown adapter')
        capacity = current['capacity']
        if type(capacity) is not int or not 1 <= capacity <= 100: raise ValueError('Capacity must be 1–100')
        if current['adapter'] == 'lightsprint' and capacity > current.get('verified_capacity', 12): raise ValueError('Higher limit needs verified adapter evidence')
        if type(current['enabled']) is not bool: raise ValueError('Enabled must be boolean')
        if len(str(current['label'])) > 160: raise ValueError('Label too long')
        for field in ('models','efforts','tools','privacy'):
            value = current.get(field, [])
            if not isinstance(value, list) or len(value) > 100 or any(not isinstance(v, str) or len(v) > 160 for v in value): raise ValueError('Invalid ' + field)
        for field in ('reserve','priority','cooldown_until'):
            value = current.get(field, 0)
            if not isinstance(value, (int,float)) or isinstance(value,bool) or not math.isfinite(value) or (field != 'priority' and value < 0): raise ValueError('Invalid ' + field)
        override = current.get('quota_override')
        if override is not None and 'quota_override' in values:
            if not isinstance(override, dict) or set(override) - {'value','unit','expires_at'}: raise ValueError('Invalid quota override')
            value = override.get('value')
            if not isinstance(value, (int,float)) or isinstance(value,bool) or not math.isfinite(value) or value < 0: raise ValueError('Invalid quota value')
            expiry = override.get('expires_at')
            if expiry is not None and (not isinstance(expiry,(int,float)) or not math.isfinite(expiry)): raise ValueError('Invalid quota expiration')
            current['quota_override'] = {**override, 'source':'operator', 'observed_at':time.time()}
        current.pop('revision', None)
        with self.repo.connection(True) as c:
            row=c.execute('SELECT revision FROM provider_configs WHERE id=?',(account_id,)).fetchone()
            if (row['revision'] if row else 0) != original_revision: raise ValueError('Stale revision')
            c.execute('INSERT INTO provider_configs(id,data,revision) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=revision+1', (account_id,json.dumps(current)))
            if project_id and not existing:
                c.execute('INSERT OR IGNORE INTO provider_projects VALUES(?,?,1)',(account_id,project_id))
            self.repo.event(c, 'system', 'account_configured', {'account':account_id})
        return self.public(self.get(account_id))

    def adapter(self, id):
        if id in self.overrides: return self.overrides[id]
        config = self.get(id)
        if not config: raise ValueError('Unknown account')
        if config['adapter'] == 'lightsprint' and self.transport is not None: return LightSprintAdapter(config, self.transport, self.collector)
        return RegisteredAdapter(config)

    def public(self, config):
        return {**{k:config.get(k) for k in PUBLIC_FIELDS}, 'id':config['id'], 'server_key':config['id'], 'revision':config.get('revision',0), 'identity':None, 'quota':self.snapshot(config['id']).quota, 'health':config.get('health','unknown'), 'capabilities':self.adapter(config['id']).capabilities()}

    def list_public(self,project=None):
        project=project or self.project_id
        with self.repo.connection() as c:
            ids = [r['id'] for r in (c.execute('SELECT id FROM provider_configs WHERE id IN (SELECT account FROM provider_projects WHERE project=?) ORDER BY id',(project,)) if project else c.execute('SELECT id FROM provider_configs ORDER BY id'))]
        return [self.public(self.get(id)) for id in ids]

    def snapshot(self, id, now=None):
        config = self.get(id)
        if config is None: raise ValueError('Unknown account')
        now = time.time() if now is None else now
        quota = config.get('quota_override')
        if quota and quota.get('expires_at') is not None and quota['expires_at'] <= now: quota = None
        return AccountSnapshot(id, config['enabled'], config['capacity'], None, self.adapter(id).capabilities(), tuple(config.get('models',[])), quota, config.get('health','unknown'))

    def bind(self, id, mcp_key, observed_workspaces):
        config = self.get(id)
        if not config or not config.get('workspace_id') or config['workspace_id'] not in observed_workspaces: raise ValueError('Workspace ownership unverified')
        return self.upsert_public_config(id, {'mcp_key':mcp_key}, trusted=True)

    def test_connection(self, id):
        config = self.get(id)
        if config['adapter'] != 'lightsprint' or self.transport is None:
            from snooze.adapters.base import UnsupportedOperation
            raise UnsupportedOperation('Connection test unsupported by this adapter')
        result = self.transport.request(config['mcp_key'], 'GET', '/api/repos')
        workspaces = {r.get('workspaceId') for r in result.get('repos',[]) if isinstance(r,dict)}
        if config.get('workspace_id') and config['workspace_id'] not in workspaces: raise ValueError('Configured workspace not accessible')
        self.upsert_public_config(id, {'health':'healthy','failure_count':0,'cooldown_until':0,'error_kind':None}, trusted=True)
        return self.snapshot(id)
