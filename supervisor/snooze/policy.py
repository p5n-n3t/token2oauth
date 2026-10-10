"""Explainable eligibility first; cheap is never a substitute for suitability."""
from snooze.domain import Eligibility


DEFAULTS = {'interval':300,'pause_dispatch':True,'emergency_stop':False,'max_concurrent':12,'global_concurrent':24,'max_recoveries':2,'backoff_seconds':60,'stall_seconds':900,'observation_workers':4,'request_timeout':20,'reserve':0,'allow_unknown_quota':False,'allow_native':False,'native_ceiling':0,'native_reserve':None,'model_limits':{},'mode':'balanced'}
PRESETS={'conservative':{'max_concurrent':4,'global_concurrent':8,'max_recoveries':1,'backoff_seconds':120,'observation_workers':2},
         'balanced':{'max_concurrent':12,'global_concurrent':24,'max_recoveries':2,'backoff_seconds':60,'observation_workers':4}}


class Policy:
    def __init__(self, settings=None, occupied=None, account_configs=None, project_occupied=0, global_occupied=0):
        self.settings={**DEFAULTS,**(settings or {})}; self.occupied=occupied or {}; self.configs=account_configs or {}
        self.project_occupied=project_occupied; self.global_occupied=global_occupied

    def evaluate(self, task, account, now):
        reasons=[]; config=self.configs.get(account.id,{})
        if not task.approved: reasons.append('Task is not approved')
        if not account.enabled: reasons.append('Account disabled')
        if account.health != 'healthy': reasons.append('Connection health is not verified healthy')
        if not account.capabilities.get('launch',{}).get('supported'): reasons.append('Launch unsupported')
        if task.requirements.get('hard_write_scope') and not account.capabilities.get('hard_write_scope',{}).get('supported'):reasons.append('Required hard write-scope boundary is unsupported')
        if self.occupied.get(account.id,0) >= account.capacity: reasons.append('Account capacity occupied')
        if self.project_occupied >= self.settings['max_concurrent']: reasons.append('Project concurrency limit')
        if self.global_occupied >= self.settings['global_concurrent']: reasons.append('Global concurrency limit')
        if config.get('cooldown_until',0) > now: reasons.append('Account cooling down')
        native=config.get('adapter') in ('native','local')
        if native and (not self.settings['allow_native'] or self.settings['native_ceiling'] < 1 or self.settings['native_reserve'] is None):
            reasons.append('Native bulk routing is disabled without explicit ceiling/reserve')
        if native and self.occupied.get(account.id,0) >= self.settings['native_ceiling']: reasons.append('Native concurrency limit')
        model=task.requirements.get('model')
        if not model or model not in account.models: reasons.append('Requested model not available')
        if task.requirements.get('effort','low') not in config.get('efforts',['low']): reasons.append('Requested effort not available')
        if not set(task.requirements.get('tools',[])).issubset(set(config.get('tools',[]))): reasons.append('Required tools unavailable')
        privacy=task.requirements.get('privacy')
        if privacy and privacy not in config.get('privacy',[]): reasons.append('Privacy requirement unmet')
        levels={'basic':0,'standard':1,'advanced':2}
        quality=task.requirements.get('quality')
        if quality and levels.get(config.get('quality'),-1)<levels.get(quality,999): reasons.append('Quality class requirement unmet')
        quota=account.quota
        if quota and quota.get('expires_at') is not None and quota['expires_at'] <= now: quota=None
        if quota is None or quota.get('value') is None:
            if not (config.get('allow_unknown_quota') or self.settings['allow_unknown_quota']): reasons.append('Quota unknown; explicit budget policy needed')
        elif quota['value'] <= max(config.get('reserve',0),self.settings['reserve'],(self.settings['native_reserve'] or 0) if native else 0): reasons.append('Quota reserve reached')
        # Neutral priors. No invented success/latency score until validated samples exist.
        rank=(-config.get('priority',0), self.occupied.get(account.id,0), account.id)
        return Eligibility(not reasons,tuple(reasons),rank)
