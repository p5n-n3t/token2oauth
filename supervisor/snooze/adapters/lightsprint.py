"""Documented LightSprint operations. Ambiguous launches are never retried here."""
import re
import json
from dataclasses import asdict
from snooze.adapters.base import BaseAdapter, OPERATIONS, UnsupportedOperation
from snooze.transport import normalize_status


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', value): raise ValueError('Invalid provider identifier')
    return value


class LightSprintAdapter(BaseAdapter):
    def __init__(self, config, transport, collector=None):
        self.config = config
        self.transport = transport
        self.collector = collector

    def capabilities(self):
        result = super().capabilities()
        result['hard_write_scope'] = {'supported':False,'reason':'LightSprint supplies a stack-wide sandbox. Instructions and isolated PR branches are not a hard per-file write boundary; require manual diff review before applying output.'}
        if self.config.get('mcp_key'):
            result['observe'] = {'supported': True, 'reason': None}
        for op in self.config.get('verified_operations', []):
            if op in ('resume', 'cancel'): result[op] = {'supported': True, 'reason': None}
        if self.config.get('stack_id') and self.config.get('launch_verified') and self.config.get('models'):
            result['launch'] = {'supported': True, 'reason': None}
        result['collect']['reason'] = 'Configure a verified artifact collector; provider idle alone is not output.'
        if self.collector and self.config.get('artifact_repo') and self.config.get('artifact_prefix'):
            result['collect'] = {'supported':True,'reason':None}
        result['reconcile']['reason'] = 'Provider launch lookup by idempotency key is unverified; manual reconciliation required.'
        return result

    def observe(self, session_id):
        self.require('observe')
        return normalize_status(self.transport.request(self.config['mcp_key'], 'GET', f'/api/agent-sessions/{identifier(session_id)}/status'))

    def launch(self, task, attempt):
        self.require('launch')
        requested_model = task.requirements.get('model')
        effort = task.requirements.get('effort', 'low')
        if requested_model not in self.config['models'] or effort not in self.config.get('efforts', ['low']):
            raise UnsupportedOperation('Requested model/effort is not verified for this account')
        key = self.config['mcp_key']
        created = self.transport.request(key, 'POST', '/api/tasks', {'title': 'Snooze ' + task.id, 'scope': 'stack', 'stackId': identifier(self.config['stack_id'])})
        provider_id = identifier(created.get('task', {}).get('id'))
        # Task creation is durable; record the remote ID for any later ambiguity.
        instructions=attempt.get('instructions','')+'\n\nApproved Snooze task packet (do not broaden this assignment):\n'+json.dumps(asdict(task),ensure_ascii=False,indent=2)
        instructions+='\nWrite only the named repository-relative paths/record IDs on your isolated task branch; never merge, deploy, change canonical data or edit another stack repository. The coordinator must review the diff before applying changes. Input must match the supplied hash and output must satisfy the supplied exact contract. If details are insufficient, save an explicit blocker instead of guessing.'
        if self.config.get('artifact_prefix'):
            instructions+='\n\nSnooze output receipt: save '+self.config['artifact_prefix']+'/'+task.id+'.json on your pushed task branch. JSON envelope must contain task_id='+task.id+', attempt_id='+attempt['id']+', generation='+str(attempt['generation'])+' and records matching the supplied exact output contract. Do not fabricate completion; push the saved file.'
        self.transport.request(key, 'PATCH', '/api/tasks/' + provider_id, {'description': instructions, 'complexity': 'low'})
        result = self.transport.request(key, 'POST', f'/api/tasks/{provider_id}/lightsprint-agents/codex',
                                        {'model': requested_model, 'reasoningEffort': effort, 'autoMerge': False})
        sid = identifier(result.get('id'))
        return {'session_id': sid, 'state': 'running', 'provider_task_id': provider_id, 'branch': result.get('branchName'), 'requested_model': requested_model, 'requested_effort': effort}

    def resume(self, session_id, attempt):
        self.require('resume')
        message_id=attempt.get('data',{}).get('resume_message_id')
        if not message_id:raise ValueError('Persist a client message ID before continuation')
        self.transport.request(self.config['mcp_key'], 'POST', f'/api/agent-sessions/{identifier(session_id)}/chat', {'message': attempt.get('instructions', ''),'clientMessageId':message_id})
        return {'state': 'pending', 'session_id': session_id}

    def cancel(self, session_id):
        self.require('cancel')
        self.transport.request(self.config['mcp_key'], 'POST', f'/api/agent-sessions/{identifier(session_id)}/cancel', {})
        return {'state': 'pending', 'session_id': session_id}

    def collect(self, attempt):
        self.require('collect')
        return self.collector.collect(self.config,attempt)
