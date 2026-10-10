"""Discover labels without mistaking them for authenticated identities."""
import re


def discover_accounts(config: dict) -> list[dict]:
    result = []
    for key, value in config.get('mcp_servers', {}).items():
        if not re.fullmatch(r'lightsprint(?:[1-9]\d*|-[1-9]\d*(?:-[\w.-]+)?)?', key, re.I):
            continue
        result.append({'server_key': key, 'label': key, 'capacity': 12,
                       'identity': None, 'quota': None,
                       'enabled': value.get('enabled', True)})
    return sorted(result, key=lambda a: a['server_key'])


def resolve_owner(accounts: list[dict], workspace_id: str, observed_workspaces: dict) -> str:
    matches = [a['server_key'] for a in accounts
               if workspace_id in observed_workspaces.get(a['server_key'], [])]
    if len(matches) != 1:
        raise ValueError('Workspace ownership unavailable or ambiguous')
    return matches[0]
