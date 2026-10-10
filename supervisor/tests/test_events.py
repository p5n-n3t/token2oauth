import tempfile
import unittest
from pathlib import Path
from snooze.tasks import TaskRepository
from snooze.events import EventFeed


class EventTests(unittest.TestCase):
    def test_allowed_event_message_redacts_credential_like_text(self):
        from snooze.events import public_event
        value=public_event({'message':'Bearer dummy-secret lsat_dummyvalue','Authorization':'secret'})
        self.assertNotIn('dummy-secret',str(value));self.assertNotIn('lsat_dummy',str(value));self.assertNotIn('Authorization',value)

    def test_cursor_pagination_is_project_scoped_and_allowlisted(self):
        with tempfile.TemporaryDirectory() as d:
            repo=TaskRepository(Path(d)/'s.sqlite')
            with repo.connection(True) as c:
                repo.event(c,'p','incident',{'message':'A','Authorization':'must-not-export'})
                repo.event(c,'q','incident',{'message':'Other project'})
                repo.event(c,'p','incident',{'message':'B'})
            feed=EventFeed(repo)
            first=feed.read('p',after=0,limit=1)
            self.assertEqual(len(first['events']),1)
            self.assertNotIn('Authorization',str(first))
            second=feed.read('p',after=first['cursor'],limit=1)
            self.assertEqual(second['events'][0]['data']['message'],'B')
            self.assertEqual(feed.read('p',after=second['cursor'])['events'],[])
