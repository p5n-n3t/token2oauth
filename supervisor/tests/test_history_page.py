import tempfile
import unittest
from pathlib import Path
from snooze.store import Store
from snooze.tasks import TaskRepository


class HistoryPageTests(unittest.TestCase):
    def test_large_history_is_bounded_on_the_server_and_project_scoped(self):
        with tempfile.TemporaryDirectory() as d:
            store=Store(Path(d)/'s.sqlite');repository=TaskRepository(store.path)
            store.ingest_jobs('p',[{'id':str(i),'state':'complete','title':'Result '+str(i),'instruction':'private '*500,'last_sent':i} for i in range(1000)])
            store.ingest_jobs('other',[{'id':'secret','state':'complete','title':'Foreign'}])
            page=store.history_page('p',offset=0,limit=25)
            self.assertEqual(len(page['entries']),25);self.assertEqual(page['total'],1000)
            self.assertNotIn('private',str(page));self.assertNotIn('Foreign',str(page))
            self.assertEqual(store.history_page('p',query='Result 999')['total'],1)
            with self.assertRaises(ValueError):store.history_page('p',limit=10000)
