import csv
import io
import json
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from pathlib import Path
from snooze.tasks import TaskRepository
from snooze.history_api import HistoryAPI, parse_filters


class HistoryAPITests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.repo=TaskRepository(Path(self.tmp.name)/'state.sqlite')
        self.repo.register_project('p','/folder/p');self.repo.register_project('q','/other/p')
        self.api=HistoryAPI(self.repo,'p',clock=lambda:1800000000)

    def test_default_filters_are_scoped_and_bounded_and_unknown_queries_reject(self):
        filters=parse_filters('p',{},now=1800000000)
        self.assertEqual(filters.project_ids,('p',))
        self.assertEqual(filters.end-filters.start,30*86400)
        for query in ({'project_ids':['q']},{'timezone':['not/a/zone']},{'from_utc':['1970-01-01']},{'models':['x']*21},{'from_utc':['NaN']}):
            with self.subTest(query=query),self.assertRaises(ValueError):parse_filters('p',query,now=1800000000)

    def test_report_never_mixes_same_named_folder_or_leaks_raw_event_data(self):
        with self.repo.connection(True) as c:
            self.repo.event(c,'p','monitor_finished',{'prompt':'private text','Authorization':'Bearer private'},now=1799999999)
            self.repo.event(c,'q','monitor_finished',{},now=1799999999)
        report=self.api.report({})
        self.assertEqual(report['filters']['project_id'],'p')
        self.assertEqual(report['native']['summary']['events']['value'],1)
        self.assertEqual(report['bounded_rows'],10000)
        self.assertNotIn('private',json.dumps(report))

    def test_engine_absence_is_typed_without_blocking_native_report(self):
        result=self.api.engine_report({'kind':['usage_summary']})
        self.assertEqual(result['state'],'unavailable')
        self.assertEqual(result['error_kind'],'not_configured')
        self.assertIn('native',self.api.report({}))
        with self.assertRaises(ValueError):self.api.engine_report({'kind':['delete_session']})

    def test_exports_are_scoped_and_nulls_and_provenance_survive(self):
        mime,data=self.api.export({'format':['json']})
        self.assertIn('json',mime)
        result=json.loads(data)
        self.assertIsNone(result['native']['summary']['input_tokens']['value'])
        mime,data=self.api.export({'format':['csv']})
        rows=list(csv.DictReader(io.StringIO(data.decode())))
        tokens=next(row for row in rows if row['metric']=='input_tokens')
        self.assertEqual(tokens['value'],'')
        self.assertEqual(tokens['state'],'unavailable')
        self.assertEqual(tokens['project_id'],'p')
        self.assertIn('source',tokens)

    def test_import_is_project_scoped_bounded_and_replay_safe(self):
        rows=[{'source_event_id':'e1','project_id':'p','at':1799999999,'kind':'usage','input_tokens':10,'prompt':'must not be kept'}]
        first=self.api.ingest('test-source','c1',rows)
        second=self.api.ingest('test-source','c1',rows)
        self.assertEqual(first.accepted,1);self.assertEqual(second.duplicates,1)
        self.assertEqual(self.api.report({})['native']['summary']['input_tokens']['value'],10)
        for bad in ([{**rows[0],'project_id':'q'}],rows*1001):
            with self.assertRaises(ValueError):self.api.ingest('test-source','c2',bad)

    def test_csv_formula_prefixes_are_escaped_not_executed(self):
        from snooze.history_api import csv_cell
        for value in ('=HYPERLINK("evil")','+SUM(1)','@payload','\t=1','-formula'):
            self.assertTrue(csv_cell(value).startswith("'"))
        self.assertEqual(csv_cell(-1.5),-1.5)

    def test_private_report_and_export_http_routes_validate_scope(self):
        from snooze.store import Store
        from snooze.web import _make_server
        server=_make_server(Store(self.repo.path),'p',None,'test-token',0,history=self.api)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        base=f'http://127.0.0.1:{server.server_port}'
        with self.assertRaises(HTTPError) as error:urlopen(base+'/api/v2/history/report')
        self.assertEqual(error.exception.code,403)
        headers={'Origin':base,'X-Snooze-Token':'test-token'}
        with urlopen(Request(base+'/api/v2/history/export?format=csv',headers=headers)) as response:
            self.assertIn('attachment',response.headers['Content-Disposition'])
            self.assertIn('project_id',response.read().decode())
        with self.assertRaises(HTTPError) as error:urlopen(Request(base+'/api/v2/history/report?project_ids=q',headers=headers))
        self.assertEqual(error.exception.code,400)
