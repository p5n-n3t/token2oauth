"""Bounded project-scoped event feed for browser and coordinator consumers."""
import json
import re

FIELDS={'state','status','model','effort','account','generation','revision','actor','reason','message','validation','artifact_hash','error_kind','recovery_count','recovery_due','executor','action'}


def public_event(data):
    return {k:(re.sub(r'(?i)Bearer\s+\S+|lsat_[A-Za-z0-9_-]+','[redacted]',v[:4000]) if isinstance(v,str) else v)
            for k,v in data.items() if k in FIELDS and isinstance(v,(str,int,float,bool,type(None)))}


class EventFeed:
    def __init__(self,repository): self.repo=repository
    def read(self,project,after=0,limit=100):
        if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=200: raise ValueError('Invalid cursor/page limit')
        with self.repo.connection() as c:
            rows=c.execute('SELECT id,task,attempt,kind,at,data FROM events WHERE project=? AND id>? ORDER BY id LIMIT ?',(project,after,limit)).fetchall()
        events=[{**{k:r[k] for k in ('id','task','attempt','kind','at')},'data':public_event(json.loads(r['data']))} for r in rows]
        return {'events':events,'cursor':events[-1]['id'] if events else after,'has_more':len(events)==limit}
