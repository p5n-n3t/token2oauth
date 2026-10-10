"""Revisioned operator actions with the same ownership and dispatch constraints."""
import json
import time
import uuid
from snooze.adapters.base import UnsupportedOperation
from dataclasses import dataclass


@dataclass(frozen=True)
class ActionReceipt:
    action_id:str
    state:str
    reason:str|None
    revision:int
    status_code:int=200


class Control:
    def __init__(self,repository,registry,scheduler):
        self.repo=repository; self.registry=registry; self.scheduler=scheduler

    def apply(self,project_id,actor_id,action,target_id,values,expected_revision):
        action_id=uuid.uuid4().hex
        revision=0
        def receipt(state,reason=None,code=200): return ActionReceipt(action_id,state,reason,revision,code)
        if not isinstance(values,dict) or type(expected_revision) is not int: return receipt('rejected','Invalid action values/revision',400)
        settings=self.scheduler.settings(project_id); project=self.repo.project(project_id)
        owner=project['executor'] if project else 'external-managed'
        revision=settings['revision']
        try:
            if action in ('coordinator-register','incident-ack'):
                from snooze.outbox import Outbox
                box=Outbox(self.repo)
                if action=='coordinator-register':
                    box.register_coordinator(values['coordinator_id'],[project_id]);return receipt('confirmed')
                if not any(d['id']==target_id for d in box.list(project_id)):return receipt('rejected','Unknown delivery in this project',404)
                acknowledged=box.acknowledge(target_id,values['coordinator_id'])
                return receipt('confirmed' if acknowledged else 'rejected',None if acknowledged else 'Register a coordinator for this project first.',200 if acknowledged else 409)
            if action=='task-add':
                from snooze.queueing import add_packet
                row=add_packet(self.repo,project_id,values,approved=False)
                revision=row['revision']; self.scheduler.wake.set(); return receipt('confirmed')
            if action=='account-test':
                if not self.registry.authorized(target_id,project_id):return receipt('rejected','Account is outside this project scope',403)
                self.registry.test_connection(target_id)
                revision=self.registry.get(target_id)['revision'];return receipt('confirmed')
            if action in ('policy-config','dispatch-pause','emergency-stop'):
                if action!='policy-config' and owner!='snooze': return receipt('rejected','External dispatcher owns this project; Snooze cannot pause or stop it.',409)
                changes=values
                if action=='dispatch-pause': changes={'pause_dispatch':values.get('paused')}
                if action=='emergency-stop': changes={'emergency_stop':values.get('stopped')}
                updated=self.scheduler.configure(project_id,changes,actor_id,expected_revision)
                revision=updated['revision']; return receipt('confirmed')
            if action=='account-config':
                account=self.registry.get(target_id); revision=account['revision'] if account else 0
                if account and not self.registry.authorized(target_id,project_id,manage=True):return receipt('rejected','Account is not manageable in this project',403)
                if expected_revision!=revision: raise ValueError('Stale revision')
                updated=self.registry.upsert_public_config(target_id,values,expected_revision=expected_revision,project_id=project_id)
                revision=updated['revision']; return receipt('confirmed')
            task=self.repo.get(target_id)
            if not task or task['project']!=project_id: return receipt('rejected','Unknown task in this project',404)
            revision=task['revision']
            if expected_revision!=revision: raise ValueError('Stale revision')
            active=next((a for a in self.repo.active(project_id) if a['task']==target_id),None)
            if action in ('retry','resume','reassign'):
                if action=='reassign': return receipt('rejected','Reassignment needs confirmed inactive ownership and a new approved routing requirement; direct account reassignment is not supported.',409)
                if owner!='snooze': return receipt('rejected','Project is externally managed; no provider mutation permitted.',409)
                if settings['emergency_stop']: return receipt('rejected','Emergency stop is active.',409)
                if settings['pause_dispatch'] and values.get('override_pause') is not True: return receipt('rejected','Dispatch paused; explicit one-off override required.',409)
                if active: return receipt('rejected','Current attempt owns its scope. Reconcile inactivity/cancellation first.',409)
                if not task['spec']['approved']: return receipt('rejected','Task is not approved.',409)
                self.repo.transition(target_id,'queued',expected_revision=expected_revision,require_inactive=True)
                report=self.scheduler.tick(project_id,manual=True,override_pause=values.get('override_pause') is True,only_task=target_id)
                launched=any(d.get('action')=='launched' for d in report.decisions)
                revision=self.repo.get(target_id)['revision']
                return receipt('pending' if launched else 'rejected',None if launched else 'No eligible route; inspect scheduling decisions.',202 if launched else 409)
            if action=='cancel':
                if owner!='snooze' or not active: return receipt('rejected','No Snooze-owned active session to cancel.',409)
                if active['state']=='cancel_pending':return receipt('rejected','Cancellation is already pending; scope remains owned.',409)
                if not self.registry.authorized(active['account'],project_id):return receipt('rejected','Attempt account is outside this project scope',403)
                adapter=self.registry.adapter(active['account'])
                if not adapter.capabilities().get('cancel',{}).get('supported'): return receipt('rejected','Cancellation unsupported by this adapter.',409)
                self.repo.update_attempt(active['id'],'cancel_pending',data={'actor':actor_id,'action_id':action_id},expected_revision=expected_revision)
                adapter.cancel(active['session']); revision=self.repo.get(target_id)['revision']
                return receipt('pending','Awaiting provider acknowledgment; scope remains owned.',202)
            if action not in ('hold','approve','prioritize'): raise ValueError('Unknown action')
            if active: return receipt('rejected','Reconcile active execution before editing its assignment.',409)
            with self.repo.connection(True) as c:
                row=c.execute('SELECT revision FROM tasks WHERE id=?',(target_id,)).fetchone()
                if row['revision']!=expected_revision: raise ValueError('Stale revision')
                if action=='approve':
                    spec=task['spec']; spec['approved']=True
                    c.execute('UPDATE tasks SET spec=?,state="queued",revision=revision+1 WHERE id=?',(json.dumps(spec),target_id))
                elif action=='hold': c.execute('UPDATE tasks SET state="held",revision=revision+1 WHERE id=?',(target_id,))
                else:
                    priority=values.get('priority')
                    if type(priority) is not int or not -10000<=priority<=10000: raise ValueError('Invalid priority')
                    c.execute('UPDATE tasks SET priority=?,revision=revision+1 WHERE id=?',(priority,target_id))
                self.repo.event(c,project_id,'control_'+action,{'actor':actor_id,'action':action},target_id,now=time.time())
            self.scheduler.wake.set(); revision+=1
            return receipt('confirmed')
        except UnsupportedOperation as e:
            return receipt('rejected',str(e),409)
        except (ValueError,TypeError,KeyError) as e:
            return receipt('rejected',str(e) if isinstance(e,ValueError) else 'Invalid value type',409 if str(e)=='Stale revision' else 400)
        except (TimeoutError,ConnectionError):
            return receipt('pending','Provider acceptance uncertain; reconcile before repeating.',202)
        except (RuntimeError,OSError):
            return receipt('rejected','Provider unavailable; inspect the task and reconcile ownership before repeating a mutation.',503)
