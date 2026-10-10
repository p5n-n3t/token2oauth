"""Durable incidents: acceptance, acknowledgment and resolution are separate."""
import json
import re
import uuid
from dataclasses import dataclass


FIELDS={'project','task','account','session','kind','message','observed_at','last_action','suggested_next_step'}


def safe_payload(payload):
    result={}
    for key,value in payload.items():
        if key not in FIELDS or not isinstance(value,(str,int,float,bool,type(None))):continue
        if isinstance(value,str):
            value=re.sub(r'(?i)Bearer\s+\S+','Bearer [redacted]',value[:4000])
            value=re.sub(r'lsat_[A-Za-z0-9_-]+','[redacted]',value)
        result[key]=value
    return result


@dataclass(frozen=True)
class DeliveryReceipt:
    delivery_id:str
    state:str
    accepted_at:float|None
    acknowledged_at:float|None
    error_kind:str|None


class Outbox:
    def __init__(self,repository,deliver=None):
        self.repo=repository
        self.deliver=deliver or (lambda channel,payload:{'state':'inbox'})
        with self.repo.connection(True) as c:
            c.execute('CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, incident TEXT, channel TEXT, project TEXT, payload TEXT, state TEXT, due_at REAL, attempts INTEGER DEFAULT 0, accepted_at REAL, acknowledged_at REAL, error_kind TEXT, resolved INTEGER DEFAULT 0, UNIQUE(incident,channel))')
            c.execute('CREATE TABLE IF NOT EXISTS coordinators(id TEXT PRIMARY KEY, projects TEXT NOT NULL)')
            if 'sending_at' not in {r['name'] for r in c.execute('PRAGMA table_info(outbox)')}:
                c.execute('ALTER TABLE outbox ADD COLUMN sending_at REAL')

    def enqueue(self,incident_id,channel_id,payload,due_at):
        payload=safe_payload(payload)
        if not payload.get('project'):raise ValueError('Incident project is required')
        with self.repo.connection(True) as c:
            row=c.execute('SELECT id FROM outbox WHERE incident=? AND channel=?',(incident_id,channel_id)).fetchone()
            if row:return row['id']
            id=uuid.uuid4().hex
            c.execute('INSERT INTO outbox(id,incident,channel,project,payload,state,due_at) VALUES(?,?,?,?,?,"queued",?)',(id,incident_id,channel_id,payload['project'],json.dumps(payload),due_at))
            self.repo.event(c,payload['project'],'incident_enqueued',{'state':'queued','message':payload.get('message')},payload.get('task'),now=due_at)
            return id

    def list(self,project):
        with self.repo.connection() as c:
            return [{**dict(r),'payload':json.loads(r['payload']),'resolved':bool(r['resolved'])} for r in c.execute('SELECT * FROM outbox WHERE project=? ORDER BY due_at,id',(project,))]

    def deliver_due(self,now):
        receipts=[]
        # A crashed send may have reached its receiver. Retry the SAME delivery ID,
        # with a persisted bound; receivers must deduplicate that ID (at-least-once).
        with self.repo.connection(True) as c:
            c.execute('UPDATE outbox SET state=CASE WHEN attempts>=3 THEN "failed" ELSE "queued" END,error_kind="InterruptedDelivery",due_at=? WHERE state="sending" AND COALESCE(sending_at,due_at)<=?',(now,now-30))
            ids=[r['id'] for r in c.execute('SELECT id FROM outbox WHERE state="queued" AND resolved=0 AND due_at<=? ORDER BY due_at LIMIT 20',(now,))]
        for id in ids:
            with self.repo.connection(True) as c:
                row=c.execute('SELECT * FROM outbox WHERE id=? AND state="queued" AND resolved=0 AND due_at<=?',(id,now)).fetchone()
                if not row:continue
                c.execute('UPDATE outbox SET state="sending",attempts=attempts+1,sending_at=? WHERE id=?',(now,id))
            try:
                response=self.deliver(row['channel'],{**json.loads(row['payload']),'delivery_id':id})
                state=response.get('state','inbox')
                if state not in ('accepted','inbox'):raise ValueError('Invalid channel receipt')
                accepted=now if state=='accepted' else None;error=None
            except Exception as exc:
                error=type(exc).__name__;accepted=None
                state='failed' if row['attempts']>=2 else 'queued'
            with self.repo.connection(True) as c:
                c.execute('UPDATE outbox SET state=?,accepted_at=?,error_kind=?,due_at=? WHERE id=? AND state="sending" AND acknowledged_at IS NULL',(state,accepted,error,now+60*(2**row['attempts']),id))
                self.repo.event(c,row['project'],'delivery_'+state,{'state':state,'error_kind':error},now=now)
            receipts.append(DeliveryReceipt(id,state,accepted,None,error))
        return receipts

    def register_coordinator(self,id,projects):
        if not isinstance(id,str) or not id or not isinstance(projects,list) or not projects or any(not isinstance(p,str) or not p for p in projects):raise ValueError('Invalid coordinator scope')
        with self.repo.connection(True) as c:c.execute('INSERT INTO coordinators VALUES(?,?) ON CONFLICT(id) DO UPDATE SET projects=excluded.projects',(id,json.dumps(projects)))

    def acknowledge(self,delivery_id,coordinator_id):
        with self.repo.connection(True) as c:
            coordinator=c.execute('SELECT projects FROM coordinators WHERE id=?',(coordinator_id,)).fetchone()
            row=c.execute('SELECT project FROM outbox WHERE id=?',(delivery_id,)).fetchone()
            if not row or not coordinator or row['project'] not in json.loads(coordinator['projects']):return False
            c.execute('UPDATE outbox SET state="acknowledged",acknowledged_at=COALESCE(acknowledged_at,unixepoch()) WHERE id=?',(delivery_id,))
            self.repo.event(c,row['project'],'coordinator_acknowledged',{'actor':coordinator_id})
            return True

    def resolve(self,incident_id,evidence):
        if not evidence.get('verified_state_change'):raise ValueError('Resolution needs a verified state change')
        with self.repo.connection(True) as c:c.execute('UPDATE outbox SET resolved=1 WHERE incident=?',(incident_id,))
