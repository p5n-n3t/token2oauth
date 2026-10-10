import tempfile
import unittest
from pathlib import Path
from snooze.tasks import TaskRepository
from snooze.providers import ProviderRegistry
from snooze.credentials import CredentialStore


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = TaskRepository(self.root / 's.sqlite')
        self.registry = ProviderRegistry(self.repo)

    def test_public_configuration_never_contains_headers(self):
        with self.assertRaises(ValueError): self.registry.upsert_public_config('a', {'http_headers': {'Authorization': 'private'}})
        self.registry.upsert_public_config('a', {'label': 'Remote', 'adapter': 'ssh', 'capacity': 2, 'enabled': True})
        self.assertNotIn('Authorization', str(self.registry.list_public()))
        self.assertFalse(self.registry.list_public()[0]['capabilities']['launch']['supported'])

    def test_disabled_account_retains_record(self):
        self.registry.upsert_public_config('a', {'adapter': 'ollama', 'capacity': 1})
        self.registry.upsert_public_config('a', {'enabled': False})
        self.assertEqual(len(self.registry.list_public()), 1)
        self.assertFalse(self.registry.list_public()[0]['enabled'])

    def test_quota_override_expires_and_records_provenance(self):
        self.registry.upsert_public_config('a', {'quota_override': {'value': 8, 'unit': 'credits', 'expires_at': 150}})
        self.assertEqual(self.registry.snapshot('a', now=100).quota['source'], 'operator')
        self.assertIsNone(self.registry.snapshot('a', now=151).quota)

    def test_higher_capacity_requires_verified_limit(self):
        with self.assertRaises(ValueError): self.registry.upsert_public_config('a', {'adapter': 'lightsprint', 'capacity': 16})

    def test_revision_conflict_is_atomic_and_stored_quota_survives_label_edit(self):
        first = self.registry.upsert_public_config('a', {'quota_override':{'value':8,'unit':'credits'}})
        updated = self.registry.upsert_public_config('a', {'label':'New'}, expected_revision=first['revision'])
        self.assertEqual(updated['quota_override']['value'],8)
        with self.assertRaises(ValueError):
            self.registry.upsert_public_config('a', {'label':'Lost update'}, expected_revision=first['revision'])
        self.assertEqual(self.registry.get('a')['label'],'New')

    def test_renamed_key_preserves_id_only_via_verified_binding(self):
        self.registry.upsert_public_config('stable', {'adapter': 'lightsprint', 'mcp_key': 'lightsprint-3-old', 'workspace_id': 'w'})
        self.registry.bind('stable', 'lightsprint-9-new', ['w'])
        self.assertEqual(self.registry.get('stable')['mcp_key'], 'lightsprint-9-new')
        with self.assertRaises(ValueError): self.registry.bind('stable', 'lightsprint-8-other', ['different'])

    def test_credential_store_is_private_and_returns_reference(self):
        secrets = CredentialStore(self.root / 'credentials.json')
        ref = secrets.put('webhook', 'private-test-secret')
        self.assertEqual(secrets.get(ref), 'private-test-secret')
        self.assertEqual(secrets.path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('private-test-secret', ref)
