import tempfile
import unittest
from pathlib import Path
from snooze.cli import prime


class CliTests(unittest.TestCase):
    def test_prime_repo_path_with_spaces_and_no_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d) / 'demo repo'
            repo.mkdir()
            state = Path(d) / 'state'
            config = prime(repo, state, None)
            self.assertEqual(config['repo'], str(repo.resolve()))
            self.assertTrue((state / 'project.json').exists())
