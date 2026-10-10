"""Project-scoped, bounded history reports; no private transcript proxy."""
import csv
import io
import json
import threading
import time
from dataclasses import asdict
from datetime import datetime, timezone

FILTER_KEYS={'from_utc','to_utc','timezone','accounts','models','efforts'}
ENGINE_KINDS={'usage_summary','usage_top_sessions','analytics_summary','analytics_heatmap',
              'analytics_hour_of_week','analytics_projects','analytics_tools','activity_report'}


def parse_filters(project,query,*,now=None):
    from snooze.analytics import HistoryFilter
    if not isinstance(query,dict) or set(query)-FILTER_KEYS:raise ValueError('Unknown history filter')
    def single(key,default):
        values=query.get(key,[default])
        if not isinstance(values,list) or len(values)!=1 or not isinstance(values[0],str) or len(values[0])>128:raise ValueError('Invalid '+key)
        return values[0]
    now=time.time() if now is None else now
    end=single('to_utc',datetime.fromtimestamp(now,timezone.utc).isoformat())
    from snooze.analytics import _timestamp
    end_epoch=_timestamp(end)
    start=single('from_utc',datetime.fromtimestamp(end_epoch-30*86400,timezone.utc).isoformat())
    choices={}
    for key in ('accounts','models','efforts'):
        values=query.get(key,[])
        if not isinstance(values,list) or len(values)>20 or any(not isinstance(v,str) or not v or len(v)>160 for v in values):raise ValueError('Invalid '+key)
        choices[key]=tuple(dict.fromkeys(values))
    filters=HistoryFilter((project,),start,end,single('timezone','UTC'),**choices)
    if filters.end-filters.start>366*86400:raise ValueError('History range exceeds 366 days')
    return filters


def csv_cell(value):
    if value is None:return ''
    if isinstance(value,str) and (value.startswith(('\t','\r','\n')) or value.lstrip().startswith(('=','+','-','@'))):return "'"+value
    return value


class HistoryAPI:
    def __init__(self,repo,project,*,engine=None,engine_project=None,engine_error=None,clock=time.time):
        self.repo=repo;self.project=project;self.engine=engine;self.engine_project=engine_project;self.clock=clock
        self.lock=threading.Lock();self._cache={}
        self.engine_error=engine_error

    def filters(self,query):return parse_filters(self.project,query,now=self.clock())

    def report(self,query):
        from snooze.analytics import Analytics
        filters=self.filters(query)
        # Range defaults tick with wall time. Cache only explicit ranges, never
        # block scheduling on an engine request or hold this lock during I/O.
        key=filters
        with self.lock:
            cached=self._cache.get(key)
            if cached and self.clock()-cached[0]<5:return cached[1]
        native=Analytics(self.repo,max_rows=10000).history_report(filters)
        public={'filters':{'project_id':self.project,'from_utc':datetime.fromtimestamp(filters.start,timezone.utc).isoformat(),
                          'to_utc':datetime.fromtimestamp(filters.end,timezone.utc).isoformat(),'timezone':filters.timezone,
                          'accounts':list(filters.accounts),'models':list(filters.models),'efforts':list(filters.efforts)},
                'native':native,'bounded_rows':10000}
        with self.lock:
            if len(self._cache)>=16:self._cache.pop(next(iter(self._cache)))
            self._cache[key]=(self.clock(),public)
        return public

    def engine_report(self,query):
        from snooze.analytics_engine import EngineClient
        from snooze.analytics import HistoryFilter
        query=dict(query);kinds=query.pop('kind',['usage_summary'])
        if not isinstance(kinds,list) or len(kinds)!=1 or kinds[0] not in ENGINE_KINDS:raise ValueError('Unsupported engine report')
        filters=self.filters(query)
        if self.engine_error:
            return {'state':'unavailable','payload':{},'source_version':None,'source_window':None,'coverage':{},'error_kind':self.engine_error}
        if self.engine is not None and not self.engine_project:
            return {'state':'unavailable','payload':{},'source_version':None,'source_window':None,'coverage':{},'error_kind':'project_mapping_required'}
        # IDs belong to each source. A local UUID is not an AgentsView folder ID;
        # mapping requires explicit operator configuration, never basename guesses.
        if self.engine_project:
            filters=HistoryFilter((self.engine_project,),filters.from_utc,filters.to_utc,filters.timezone,filters.accounts,filters.models,filters.efforts)
        return asdict((self.engine or EngineClient()).query(kinds[0],filters))

    def export(self,query):
        query=dict(query);formats=query.pop('format',['json'])
        if not isinstance(formats,list) or len(formats)!=1 or formats[0] not in ('json','csv'):raise ValueError('Unsupported export format')
        report=self.report(query)
        if formats[0]=='json':return 'application/json',json.dumps(report,allow_nan=False).encode()
        fields=['project_id','from_utc','to_utc','timezone','metric','value','unit','source','state','observed','eligible','missing']
        output=io.StringIO();writer=csv.DictWriter(output,fieldnames=fields);writer.writeheader()
        for name,metric in report['native']['summary'].items():
            row={**{k:report['filters'][k] for k in fields[:4]},'metric':name,
                 **{k:metric.get(k) for k in ('value','unit','source','state')},**metric.get('coverage',{})}
            writer.writerow({k:csv_cell(row.get(k)) for k in fields})
        return 'text/csv; charset=utf-8',output.getvalue().encode()

    def ingest(self,source,cursor,rows,*,cancelled=False):
        from snooze.history_ingest import HistoryIngestor
        if not isinstance(rows,list) or len(rows)>1000:raise ValueError('Import page must contain at most 1000 rows')
        for row in rows:
            if not isinstance(row,dict) or row.get('project_id',row.get('project'))!=self.project:raise ValueError('Import row outside current project scope')
        receipt=HistoryIngestor(self.repo).ingest_events(source,cursor,rows,cancelled=cancelled)
        with self.lock:self._cache.clear()
        return receipt
