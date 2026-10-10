import unittest
from snooze.accounts import discover_accounts, resolve_owner


class AccountsTests(unittest.TestCase):
    def test_discovery_supports_renamed_keys_without_credentials(self):
        config = {'mcp_servers': {
            'lightsprint7': {'url': 'https://app.lightsprint.ai/mcp', 'http_headers': {'Authorization': 'secret'}},
            'lightsprint-8-demo': {'url': 'https://app.lightsprint.ai/mcp'},
            'other': {'url': 'https://example.org/mcp'}}}
        result = discover_accounts(config)
        self.assertEqual({a['server_key'] for a in result}, {'lightsprint7', 'lightsprint-8-demo'})
        self.assertNotIn('secret', str(result))
        self.assertTrue(all(a['capacity'] == 12 for a in result))

    def test_owner_uses_verified_workspace_not_number(self):
        accounts = discover_accounts({'mcp_servers': {'lightsprint-9-demo': {'url': 'https://app.lightsprint.ai/mcp'}}})
        self.assertEqual(resolve_owner(accounts, 'workspace-old-2', {'lightsprint-9-demo': ['workspace-old-2']}), 'lightsprint-9-demo')

    def test_ambiguous_or_missing_owner_is_rejected(self):
        accounts = [{'server_key': 'a'}, {'server_key': 'b'}]
        for mapping in ({}, {'a': ['w'], 'b': ['w']}):
            with self.assertRaises(ValueError):
                resolve_owner(accounts, 'w', mapping)
