import json
import tempfile
import unittest
from pathlib import Path
from snooze.cli import prime
from snooze.engine_setup import configure_engine


class EngineSetupTests(unittest.TestCase):
    def test_configuration_requires_network_consent_mapping_and_no_plain_token(self):
        with tempfile.TemporaryDirectory() as root:
            state=Path(root)/'state';prime(Path(root),state,None)
            previous=(state/'project.json').read_bytes()
            for args in [('https://engine.test',['other.test'],'source',None),('http://remote.test',['remote.test'],'source',None),('https://engine.test',['engine.test'],'',None),('https://engine.test',['engine.test'],'source','plaintext-token')]:
                with self.assertRaises(ValueError):configure_engine(state,*args)
                self.assertEqual((state/'project.json').read_bytes(),previous)
            result=configure_engine(state,'http://127.0.0.1:8080',['127.0.0.1:8080'],'explicit-folder')
            self.assertTrue(result['restart_required'])
            config=json.loads((state/'project.json').read_text())
            self.assertEqual(config['analytics_engine']['project_mapping'],'explicit-folder')
            self.assertEqual((state/'project.json').stat().st_mode&0o777,0o600)
