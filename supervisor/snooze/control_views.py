"""Safe derived control-plane views, separate from legacy import projections."""
import json
import time
from snooze.events import EventFeed, public_event
from snooze.views import _safe_reference


def task_row(task):
    return {k: task[k] for k in ('id','project','state','priority','created_at','updated_at','revision')} | {'summary':task['instructions'][:160], 'approved':task['spec']['approved']}


def extend_dashboard(state, control, project):
    settings = control.scheduler.settings(project)
    ownership = control.repo.project(project)
    managed = ownership is not None and ownership['executor'] == 'snooze'
    state['project']['executor'] = ownership['executor'] if ownership else 'external-managed'
    state['settings'] = settings
    accounts = control.registry.list_public(project)
    state['accounts'] = accounts or state['accounts']
    state['capabilities'].update({
        name: {'supported': managed, 'reason': None if managed else 'This project is externally managed. Snooze cannot control its dispatcher.'}
        for name in ('dispatch','pause','emergency_stop')
    })
    state['capabilities']['account_config'] = {'supported':True,'reason':None}
    state['capabilities']['policy_config'] = {'supported':True,'reason':None}
    managed_slots=[]
    for attempt in control.repo.active(project):
        task=control.repo.get(attempt['task'])
        with control.repo.connection() as c:
            row=c.execute('SELECT at,data FROM events WHERE attempt=? AND kind="provider_observed" ORDER BY id DESC LIMIT 1',(attempt['id'],)).fetchone()
        observed=json.loads(row['data']) if row else {}
        managed_slots.append({'task_id':attempt['task'],'session_id':attempt['session'],'account_id':attempt['account'], 'logical_slot':None,
                              'task_summary':task['instructions'][:160], 'requested_model':task['spec']['requirements'].get('model'),
                              'confirmed_model':observed.get('model'),'requested_effort':task['spec']['requirements'].get('effort'),
                              'confirmed_effort':observed.get('effort'),'started_at':attempt['started_at'],'observed_at':row['at'] if row else None,
                              'provider_state':observed.get('status','unobserved'),'task_state':task['state'],
                              'observation_freshness':'fresh' if row and time.time()-row['at'] < settings['interval']*2 else 'unobserved' if not row else 'stale',
                              'references':[], 'attempt_id':attempt['id']})
    state['slots'].extend(managed_slots)
    state['summary']['active_tasks']=len(state['slots'])
    state['summary']['queue_tasks']=control.repo.queue_page(project,limit=1)['total']
    with control.repo.connection() as c:
        row=c.execute('SELECT at,data FROM events WHERE project=? AND kind="monitor_finished" ORDER BY id DESC LIMIT 1',(project,)).fetchone()
        start=c.execute('SELECT at FROM events WHERE project=? AND kind="monitor_started" ORDER BY id DESC LIMIT 1',(project,)).fetchone()
    data=json.loads(row['data']) if row else {}
    state['cycle']={'started_at':start['at'] if start else None,'finished_at':row['at'] if row else None,'checked':data.get('checked'),'next_due_at':row['at']+settings['interval'] if row else None}
    return state


def managed_task_detail(control, project, task_id):
    task=control.repo.get(task_id)
    if not task or task['project']!=project:return None
    with control.repo.connection() as c:
        attempts=[dict(r) for r in c.execute('SELECT id,generation,account,session,state,started_at,released_at FROM attempts WHERE task=? ORDER BY generation',(task_id,))]
    references=[]
    for attempt in attempts:
        for artifact in control.repo.artifacts(attempt['id']):
            url=artifact['reference'].get('url')
            if _safe_reference(url):references.append(url)
    with control.repo.connection() as c:
        rows=c.execute('SELECT id,task,attempt,kind,at,data FROM events WHERE project=? AND task=? ORDER BY id DESC LIMIT 200',(project,task_id)).fetchall()
    events=[{**{k:r[k] for k in ('id','task','attempt','kind','at')},'data':public_event(json.loads(r['data']))} for r in reversed(rows)]
    return {'task_id':task_id,'summary':task['instructions'][:160],'instruction':task['instructions'],'state':task['state'],
            'revision':task['revision'],'scope_keys':task['spec']['scope_keys'],'approved':task['spec']['approved'],
            'attempts':attempts,'events':events,
            'references':references}
