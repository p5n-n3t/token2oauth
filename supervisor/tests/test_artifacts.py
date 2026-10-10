import base64
import json
import unittest
from snooze.artifacts import GitHubArtifacts


class ArtifactTests(unittest.TestCase):
    def test_saved_output_has_exact_repository_branch_and_generation(self):
        calls=[]
        packet={'task_id':'t','attempt_id':'a','generation':2,'records':[{'id':'1'}]}
        def fetch(url,headers):
            calls.append(url)
            return {'type':'file','encoding':'base64','path':'results/t.json','size':99,'sha':'b'*40,'content':base64.b64encode(json.dumps(packet).encode()).decode()}
        collector=GitHubArtifacts(fetch=fetch)
        result=collector.collect({'artifact_repo':'p5n-n3t/snooze','artifact_prefix':'results'}, {'id':'a','task':'t','generation':2,'data':{'branch':'codex/test'}})
        self.assertEqual(result['records'],[{'id':'1'}]);self.assertEqual(result['generation'],2)
        self.assertIn('ref=codex%2Ftest',calls[0]);self.assertEqual(result['source'],'github-saved-file')
    def test_arbitrary_hosts_paths_and_unattested_files_are_rejected(self):
        collector=GitHubArtifacts(fetch=lambda u,h:{'type':'file','encoding':'base64','path':'results/t.json','size':2,'content':'e30='})
        for config in ({'artifact_repo':'https://evil.test/x','artifact_prefix':'results'}, {'artifact_repo':'p5n-n3t/snooze','artifact_prefix':'../../secret'}, {'artifact_repo':'p5n-n3t/snooze','artifact_prefix':'results'}):
            with self.assertRaises(ValueError):collector.collect(config,{'id':'a','task':'t','generation':2,'data':{'branch':'b'}})

