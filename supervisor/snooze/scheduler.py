"""Durable, deterministic scheduler. Routine cycles use no reasoning-model calls."""
import json
import hashlib
import math
import threading
import time
import uuid
from collections import Counter
from dataclasses import asdict
from snooze.domain import CycleReport
from snooze.policy import Policy, DEFAULTS, PRESETS
from snooze.adapters.base import UnsupportedOperation


class Scheduler:
    def __init__(self, repository, registry, validators, clock=time.time):
        self.repo=repository; self.registry=registry; self.validators=validators; self.clock=clock
        self.lock=threading.Lock(); self.wake=threading.Event()

    def settings(self, project):
        with self.repo.connection() as c:
            row=c.execute('SELECT * FROM policy_settings WHERE project=?',(project,)).fetchone()
        return {**DEFAULTS,**(json.loads(row['data']) if row else {}),'revision':row['revision'] if row else 0}

    def configure(self, project, values, actor='operator', expected_revision=None):
        if set(values)-set(DEFAULTS): raise ValueError('Unknown policy setting')
        with self.repo.connection(True) as c:
            row=c.execute('SELECT * FROM policy_settings WHERE project=?',(project,)).fetchone()
            revision=row['revision'] if row else 0
            if expected_revision is not None and expected_revision != revision: raise ValueError('Stale revision')
            settings={**DEFAULTS,**(json.loads(row['data']) if row else {}),**PRESETS.get(values.get('mode'),{}),**values}
            for key in ('interval','max_concurrent','global_concurrent','max_recoveries','backoff_seconds','native_ceiling','stall_seconds','observation_workers','request_timeout'):
                minimum=30 if key=='interval' else (0 if key in ('max_recoveries','native_ceiling') else 1)
                if type(settings[key]) is not int or not minimum<=settings[key]<=86400: raise ValueError('Invalid '+key)
            for key in ('pause_dispatch','emergency_stop','allow_unknown_quota','allow_native'):
                if type(settings[key]) is not bool: raise ValueError('Invalid '+key)
            if settings['max_recoveries'] > 2: raise ValueError('Maximum two recoveries')
            if settings['observation_workers']>8 or settings['request_timeout']>30:raise ValueError('Observation workers/timeouts exceed safe bounds')
            for key in ('reserve','native_reserve'):
                value=settings[key]
                if key=='native_reserve' and value is None:continue
                if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0:raise ValueError('Reserve must be finite and nonnegative')
            if settings['mode'] not in ('conservative','balanced','custom'): raise ValueError('Unknown preset')
            if not isinstance(settings['model_limits'],dict) or any(type(v) is not int or v<1 for v in settings['model_limits'].values()): raise ValueError('Invalid model limits')
            revision+=1
            c.execute('INSERT INTO policy_settings VALUES(?,?,?) ON CONFLICT(project) DO UPDATE SET revision=excluded.revision,data=excluded.data',(project,revision,json.dumps(settings)))
            c.execute('INSERT INTO settings_revisions(project,revision,actor,at,data) VALUES(?,?,?,?,?)',(project,revision,actor,self.clock(),json.dumps(settings)))
            self.repo.event(c,project,'policy_configured',{'revision':revision,'actor':actor},now=self.clock())
        self.wake.set(); return {**settings,'revision':revision}

    def _record(self, project, kind, payload, task=None, attempt=None, now=None):
        with self.repo.connection(True) as c: self.repo.event(c,project,kind,payload,task,attempt,now)

    def _cooldown(self,account,settings,now,error_kind):
        config=self.registry.get(account)
        count=min(config.get('failure_count',0)+1,16)
        self.registry.upsert_public_config(account,{'failure_count':count,'error_kind':error_kind,
            'cooldown_until':now+min(settings['backoff_seconds']*(2**min(count-1,6)),3600)},trusted=True)

    def _validate(self, attempt, artifact, now):
        generation=artifact.get('generation',attempt['generation']) if isinstance(artifact,dict) else attempt['generation']
        if generation!=attempt['generation']:
            self.repo.record_artifact(attempt['id'],generation,artifact)
            return {'task':attempt['task'],'action':'late_artifact_quarantined'}
        spec=self.repo.spec(attempt['task']); result=self.validators.validate(spec,artifact)
        accepted=self.repo.record_artifact(attempt['id'],attempt['generation'],artifact)
        with self.repo.connection(True) as c:
            c.execute('INSERT INTO validations VALUES(?,?,?,?,?)',(uuid.uuid4().hex,attempt['id'],result.state,json.dumps(asdict(result)),now))
        if accepted=='accepted' and result.state=='valid':
            self.repo.update_attempt(attempt['id'],'complete',data={'validation':'valid','artifact_hash':result.artifact_hash},now=now)
            self.repo.release(attempt['id'],{'validated':True})
            return {'task':spec.id,'action':'validated_complete'}
        self.repo.update_attempt(attempt['id'],'blocked',data={'validation':'invalid','errors':list(result.errors)},now=now)
        return {'task':spec.id,'action':'validation_failed'}

    def _recover(self, attempt, adapter, status, settings, now):
        if not self.registry.authorized(attempt['account'],attempt['project']):return 'account_scope_unverified'
        if settings['pause_dispatch'] or settings['emergency_stop']: return 'recovery_paused'
        data=attempt['data']; count=data.get('recovery_count',0)
        if now < data.get('recovery_due',0): return 'recovery_backoff'
        if count>=settings['max_recoveries']:
            self.repo.update_attempt(attempt['id'],'blocked',data={'reason':'Recovery limit exhausted'},now=now)
            return 'recovery_exhausted'
        if not adapter.capabilities().get('resume',{}).get('supported'): return 'resume_unsupported'
        jitter=.9+int(hashlib.sha256((attempt['id']+str(count)).encode()).hexdigest()[:4],16)/65535*.2
        next_data={'recovery_count':count+1,'recovery_due':now+settings['backoff_seconds']*(2**count)*jitter,'resume_message_id':str(uuid.uuid4())}
        # Persist the bound before network I/O; a crash cannot reset the budget.
        self.repo.update_attempt(attempt['id'],'awaiting_output',data=next_data,now=now)
        task=self.repo.get(attempt['task'])
        try:
            adapter.resume(attempt['session'],{**self.repo.attempt(attempt['id']),'instructions':task['instructions']})
            return 'resume_requested'
        except Exception:
            self.repo.update_attempt(attempt['id'],'ambiguous',data={'reason':'Resume acceptance uncertain'},now=now)
            return 'resume_ambiguous'

    def tick(self, project_id, now=None, *, manual=False, override_pause=False, only_task=None):
        now=self.clock() if now is None else now
        if not self.lock.acquire(False): return CycleReport(now,self.clock(),[],[{'kind':'cycle_running'}])
        decisions=[]; errors=[]
        try:
            settings=self.settings(project_id); project=self.repo.project(project_id)
            owner=project['executor'] if project else 'external-managed'
            managed=owner=='snooze'
            self._record(project_id,'cycle_started',{},now=now)
            for attempt in self.repo.active(project_id):
                try:
                    adapter=self.registry.adapter(attempt['account'])
                    if attempt['state']=='ambiguous' or (not attempt['session'] and attempt['state']!='reserved'):
                        receipt=adapter.reconcile(attempt) if adapter.capabilities().get('reconcile',{}).get('supported') else None
                        if receipt and receipt.get('session_id'):
                            self.repo.update_attempt(attempt['id'],'running',session=receipt['session_id'],now=now)
                        else: decisions.append({'task':attempt['task'],'action':'needs_reconciliation'})
                        continue
                    if not attempt['session']: continue
                    observation=adapter.observe(attempt['session'])
                    self._record(project_id,'provider_observed',{'account':attempt['account'],**{k:observation.get(k) for k in ('status','model','effort','last_event_age_ms','relay_alive')}},attempt['task'],attempt['id'],now)
                    if attempt['state']=='cancel_pending':
                        if observation.get('status') in ('cancelled','canceled'):
                            self.repo.update_attempt(attempt['id'],'cancelled',now=now)
                            self.repo.release(attempt['id'],{'cancelled':True})
                            decisions.append({'task':attempt['task'],'action':'cancel_confirmed'})
                        else: decisions.append({'task':attempt['task'],'action':'awaiting_cancel_ack'})
                        continue
                    artifact=adapter.collect(attempt) if adapter.capabilities().get('collect',{}).get('supported') else None
                    if artifact is not None:
                        decisions.append(self._validate(attempt,artifact,now)); continue
                    status=observation.get('status','unknown')
                    age=observation.get('last_event_age_ms')
                    if status=='running' and type(age) is int and age>=settings['stall_seconds']*1000:
                        if attempt['data'].get('incident_kind')!='stalled':self.repo.update_attempt(attempt['id'],attempt['state'],data={'incident_kind':'stalled'},now=now)
                        decisions.append({'task':attempt['task'],'action':'stalled_needs_inspection'})
                    elif attempt['data'].get('incident_kind') and ((status=='running' and type(age) is int and age<settings['stall_seconds']*1000) or status in ('idle','failed','completed')):
                        self.repo.update_attempt(attempt['id'],attempt['state'],data={'incident_kind':None},now=now)
                    if status in ('idle','failed','completed'):
                        action=self._recover(attempt,adapter,status,settings,now) if managed and status=='failed' and attempt['state']!='blocked' else 'awaiting_saved_output'
                        decisions.append({'task':attempt['task'],'action':action})
                except Exception as e:
                    self._cooldown(attempt['account'],settings,now,type(e).__name__)
                    errors.append({'task':attempt['task'],'account':attempt['account'],'kind':type(e).__name__})
            active=self.repo.active(project_id)
            configs={a['id']:self.registry.get(a['id']) for a in self.registry.list_public(project_id)}
            with self.repo.connection() as c:
                global_count=c.execute('SELECT COUNT(*) FROM attempts WHERE released_at IS NULL').fetchone()[0]
                counts=Counter({r['account']:r['occupied'] for r in c.execute('SELECT account,COUNT(*) AS occupied FROM attempts WHERE released_at IS NULL GROUP BY account')})
            for task in self.repo.list(project_id):
                if only_task and task['id']!=only_task: continue
                if task['state'] not in ('queued','retry_due') or task['due_at']>now: continue
                spec=self.repo.spec(task['id'])
                if any(not self.repo.get(dep) or self.repo.get(dep)['state']!='complete' for dep in spec.dependencies):
                    decisions.append({'task':spec.id,'action':'dependency_blocked'}); continue
                policy=Policy(settings,counts,configs,len(active),global_count)
                eligible=[]; explanations=[]
                for id in configs:
                    result=policy.evaluate(spec,self.registry.snapshot(id,now),now)
                    if result.eligible: eligible.append((result.rank,id))
                    else: explanations.append({'account':id,'reasons':list(result.reasons)})
                if not managed or settings['emergency_stop'] or (settings['pause_dispatch'] and not (manual and override_pause)):
                    decisions.append({'task':spec.id,'action':'shadow' if not managed else 'dispatch_stopped','routes':explanations}); continue
                if not eligible:
                    decisions.append({'task':spec.id,'action':'no_eligible_route','routes':explanations}); continue
                account=min(eligible)[1]
                try: receipt=self.repo.reserve(spec.id,account,spec.scope_keys,now,policy_revision=settings['revision'],override_pause=manual and override_pause)
                except ValueError as e:
                    decisions.append({'task':spec.id,'action':'reservation_conflict'}); continue
                attempt=self.repo.attempt(receipt.attempt_id)
                self.repo.update_attempt(receipt.attempt_id,'starting',data={'requested_model':spec.requirements.get('model'),'requested_effort':spec.requirements.get('effort','low')},now=now)
                try:
                    launched=self.registry.adapter(account).launch(spec,{**attempt,'instructions':task['instructions']})
                    if not launched.get('session_id'): raise TimeoutError('Missing receipt')
                    self.repo.update_attempt(receipt.attempt_id,'running',session=launched['session_id'],data=launched,now=now)
                    decisions.append({'task':spec.id,'action':'launched','account':account,'attempt':receipt.attempt_id})
                except Exception as e:
                    self._cooldown(account,settings,now,type(e).__name__)
                    configs[account]=self.registry.get(account)
                    self.repo.update_attempt(receipt.attempt_id,'ambiguous',data={'reason':'Launch acceptance uncertain','error_kind':type(e).__name__},now=now)
                    errors.append({'task':spec.id,'account':account,'kind':'ambiguous_launch'})
                counts[account]+=1; active=self.repo.active(project_id); global_count+=1
            self._record(project_id,'cycle_finished',{'decisions':decisions,'errors':errors},now=now)
            return CycleReport(now,self.clock(),decisions,errors)
        finally: self.lock.release()
