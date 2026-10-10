"""Small durable store. Queue history is imported, never rewritten."""
import json
import sqlite3
import time
from pathlib import Path
from snooze.transport import normalize_status


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.executescript('''
              CREATE TABLE IF NOT EXISTS jobs(project TEXT,id TEXT,session TEXT,data TEXT,PRIMARY KEY(project,id));
              CREATE TABLE IF NOT EXISTS observations(session TEXT,at REAL,data TEXT);
              CREATE TABLE IF NOT EXISTS incidents(project TEXT,job TEXT,kind TEXT,message TEXT,at REAL,acked INTEGER DEFAULT 0,PRIMARY KEY(project,job,kind));
              CREATE TABLE IF NOT EXISTS settings(project TEXT PRIMARY KEY,data TEXT);
            ''')

    def connect(self):
        return sqlite3.connect(self.path, timeout=10, factory=ClosingConnection)

    def ingest_jobs(self, project_id: str, jobs: list[dict]) -> None:
        with self.connect() as c:
            for job in jobs:
                c.execute('INSERT INTO jobs VALUES(?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET session=excluded.session,data=excluded.data',
                          (project_id, job['id'], job.get('session_id', ''), json.dumps(job)))

    def observe(self, session_id: str, observation: dict) -> None:
        observation = normalize_status(observation)
        with self.connect() as c:
            c.execute('INSERT INTO observations VALUES(?,?,?)', (session_id, time.time(), json.dumps(observation)))

    def incident(self, project, job, kind, message):
        with self.connect() as c:
            c.execute('INSERT INTO incidents VALUES(?,?,?,?,?,0) ON CONFLICT(project,job,kind) DO UPDATE SET message=excluded.message,at=excluded.at',
                      (project, job, kind, message, time.time()))

    def ack(self, project, job, kind):
        with self.connect() as c:
            c.execute('UPDATE incidents SET acked=1 WHERE project=? AND job=? AND kind=?', (project, job, kind))

    def retire_other_incidents(self, project, job, current_kind):
        with self.connect() as c:
            c.execute('UPDATE incidents SET acked=1 WHERE project=? AND job=? AND kind != ?', (project, job, current_kind))

    def settings(self, project):
        with self.connect() as c:
            row = c.execute('SELECT data FROM settings WHERE project=?', (project,)).fetchone()
        return json.loads(row[0]) if row else {'interval': 300, 'pause_dispatch': True}

    def set_settings(self, project, values):
        if not isinstance(values.get('interval', 300), int) or values.get('interval', 300) < 30:
            raise ValueError('Interval must be at least 30 seconds')
        with self.connect() as c:
            c.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(project) DO UPDATE SET data=excluded.data', (project, json.dumps(values)))

    def snapshot(self, project_id: str, *, active_only=False) -> dict:
        workers = []
        with self.connect() as c:
            where=" AND COALESCE(lower(json_extract(data,'$.state')),'') NOT IN ('complete','completed','done','cancelled','canceled','failed','draft','held','queued') AND session IS NOT NULL AND session!=''" if active_only else ''
            for session, data in c.execute('SELECT session,data FROM jobs WHERE project=?'+where+' ORDER BY id', (project_id,)):
                job = json.loads(data)
                row = c.execute('SELECT at,data FROM observations WHERE session=? ORDER BY rowid DESC LIMIT 1', (session,)).fetchone()
                job['observation'] = normalize_status(json.loads(row[1])) if row else None
                job['observed_at'] = row[0] if row else None
                job['observation_status'] = ('fresh' if time.time() - row[0] < 600 else 'stale') if row else 'unobserved'
                workers.append(job)
            incidents = [dict(zip(('job', 'kind', 'message', 'at'), r)) for r in c.execute('SELECT job,kind,message,at FROM incidents WHERE project=? AND acked=0', (project_id,))]
        return {'project': project_id, 'workers': workers, 'incidents': incidents, 'settings': self.settings(project_id)}

    def active_snapshot(self, project_id):
        return self.snapshot(project_id,active_only=True)

    def history_page(self, project, *, offset=0, limit=25, query=''):
        if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=100 or not isinstance(query,str) or len(query)>200:
            raise ValueError('Invalid history page')
        # SQL selects just the requested page; do not materialize raw job payloads.
        sources=['''SELECT 'legacy-task:'||id AS id,COALESCE(json_extract(data,'$.observed_at'),json_extract(data,'$.last_sent')) AS at,
            lower(json_extract(data,'$.state')) AS kind,COALESCE(json_extract(data,'$.title'),json_extract(data,'$.name'),id) AS title,
            'Recorded legacy task state; this is not independent artifact validation.' AS detail,id AS task_id,'legacy-import' AS source
            FROM jobs WHERE project=? AND lower(json_extract(data,'$.state')) IN ('complete','completed','done','cancelled','canceled','failed')''']
        params=[project]
        with self.connect() as c:
            if c.execute("SELECT 1 FROM sqlite_master WHERE name='events'").fetchone():
                sources.append('''SELECT 'event:'||id,at,kind,COALESCE(task,kind),COALESCE(json_extract(data,'$.message'),kind),task,'snooze-event' FROM events WHERE project=?''')
                params.append(project)
            source=' UNION ALL '.join(sources)
            where=' WHERE instr(lower(title),lower(?))>0 OR instr(lower(kind),lower(?))>0'
            params += [query,query]
            total=c.execute('SELECT COUNT(*) FROM ('+source+')'+where,params).fetchone()[0]
            rows=c.execute('SELECT * FROM ('+source+')'+where+' ORDER BY at DESC,id DESC LIMIT ? OFFSET ?',params+[limit,offset]).fetchall()
        from snooze.outbox import safe_payload
        entries=[{'id':r[0],'at':r[1] if isinstance(r[1],(int,float)) else None,'kind':r[2],'title':str(r[3])[:160],
                  'detail':safe_payload({'message':str(r[4])[:500]})['message'],'task_id':r[5],'source':r[6]} for r in rows]
        return {'entries':entries,'total':total,'offset':offset,'limit':limit,'has_more':offset+len(entries)<total}
