import tempfile
import unittest
from pathlib import Path
from snooze.cli import prime
from snooze.service import render_unit


class ServiceTests(unittest.TestCase):
    def test_quoted_paths_and_percent_specifiers_cannot_change_unit(self):
        text=render_unit(Path('/tmp/state %n with spaces'),Path('/tmp/my python'))
        self.assertIn('"/tmp/state %%n with spaces"',text)
        self.assertIn('CPUQuota=20%',text)
        self.assertIn('MemoryMax=256M',text)
        with self.assertRaises(ValueError):render_unit(Path('/tmp/state\nExecStart=bad'),Path('/usr/bin/python3'))
