import tempfile
import unittest
from pathlib import Path
from snooze.tasks import TaskRepository
from snooze.providers import ProviderRegistry
from snooze.scheduler import Scheduler
from snooze.validation import ValidatorRegistry
from snooze.control import Control
from snooze.mcp_server import MCPFacade


class ProjectAccountTests(unittest.TestCase):
    def test_scoped_coordinator_cannot_read_mutate_or_route_foreign_account(self):
        with tempfile.TemporaryDirectory() as d:
            repo=TaskRepository(Path(d)/'s.sqlite');repo.register_project('p','/p');repo.register_project('q','/q')
            registry=ProviderRegistry(repo)
            registry.upsert_public_config('q-account',{'label':'Foreign','workspace_id':'workspace-q'},project_id='q')
            control=Control(repo,registry,Scheduler(repo,registry,ValidatorRegistry()))
            facade=MCPFacade(repo,control,'test',['p'])
            self.assertEqual(facade.call('snapshot',{'project':'p'},'test')['accounts'],[])
            result=facade.call('control',{'project':'p','action':'account-config','target_id':'q-account','values':{'enabled':False},'expected_revision':1},'test')
            self.assertEqual(result['state'],'rejected');self.assertEqual(result['status_code'],403)
            self.assertTrue(registry.get('q-account')['enabled'])
            self.assertEqual(registry.list_public('p'),[])

