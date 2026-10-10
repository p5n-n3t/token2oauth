"""Credential-local MCP transport; never return request headers."""
import json
import re
import tomllib
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        return None


def normalize_status(payload):
    value = payload.get('status', payload)
    if not isinstance(value, dict):
        value = payload
    status = value.get('sessionStatus', value.get('status', 'unknown'))
    relay=value.get('relayHealth',{}) if isinstance(value.get('relayHealth'),dict) else {}
    age=relay.get('lastEventAgoMs',value.get('last_event_age_ms'))
    alive=relay.get('alive',value.get('relay_alive'))
    model=value.get('model'); effort=value.get('reasoningEffort',value.get('effort'))
    return {'status': status if isinstance(status, str) else 'unknown',
            'model': model[:200] if isinstance(model,str) else None,
            'effort': effort[:100] if isinstance(effort,str) else None,
            'last_event_age_ms':age if type(age) is int and 0<=age<=365*86400*1000 else None,
            'relay_alive':alive if type(alive) is bool else None}


class LightSprint:
    def __init__(self, config_path: Path, timeout=20):
        self.config_path = config_path
        self.timeout=timeout
        self.opener=urllib.request.build_opener(NoRedirect())

    def request(self, server_key, method, path, body=None):
        servers = tomllib.loads(self.config_path.read_text()).get('mcp_servers', {})
        if server_key not in servers:
            raise ValueError('Configured account unavailable')
        cfg = servers[server_key]
        if cfg.get('url') != 'https://app.lightsprint.ai/mcp':
            raise ValueError('Unsupported LightSprint endpoint')
        headers = {**cfg.get('http_headers', {}), 'Content-Type': 'application/json',
                   'Accept': 'application/json, text/event-stream', 'User-Agent': 'Codex MCP'}
        auth = headers.get('Authorization', '')
        if auth.startswith('lsat_'):
            headers['Authorization'] = 'Bearer ' + auth

        def rpc(name, params, ident):
            payload = {'jsonrpc': '2.0', 'method': name, 'params': params}
            if ident is not None:
                payload['id'] = ident
            req = urllib.request.Request(cfg['url'], data=json.dumps(payload).encode(), headers=headers)
            with self.opener.open(req, timeout=self.timeout) as response:
                session = response.headers.get('Mcp-Session-Id')
                if session:
                    headers['Mcp-Session-Id'] = session
                if ident is None and response.status in (202, 204):
                    return {}
                if 'text/event-stream' in response.headers.get('Content-Type', ''):
                    for line in response:
                        if line.startswith(b'data:'):
                            result = json.loads(line[5:])
                            if result.get('id') == ident:
                                return result
                    raise ValueError('No matching MCP response')
                return json.loads(response.read())

        init = rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                                  'clientInfo': {'name': 'snooze', 'version': '0.1.0'}}, 1)
        headers['MCP-Protocol-Version'] = init.get('result', {}).get('protocolVersion', '2025-03-26')
        rpc('notifications/initialized', {}, None)
        arguments = {'method': method, 'path': path}
        if body is not None:
            arguments['body'] = body
        envelope = rpc('tools/call', {'name': 'lightsprint_api', 'arguments': arguments}, 2)
        result = envelope.get('result', {})
        if envelope.get('error') or result.get('isError'):
            details = envelope.get('error',{}).get('message','') if isinstance(envelope.get('error'),dict) else ''
            if not details:
                details = ' '.join(item.get('text','') for item in result.get('content',[]) if item.get('type')=='text')
            # Retain actionable provider rejection evidence, never auth headers or
            # unbounded responses. This exception stays backend-only.
            details=re.sub(r'(?i)Bearer\s+\S+|lsat_[A-Za-z0-9_-]+','[redacted]',details)
            raise RuntimeError('Provider rejected request: '+details[:500])
        for item in result.get('content', []):
            if item.get('type') == 'text':
                return json.loads(item['text'])
        return result

    def observe(self, job):
        key = job.get('server_key')
        if not key:
            return {'status': 'ownership_unknown'}
        result = self.request(key, 'GET', f"/api/agent-sessions/{job['session_id']}/status")
        # Allowlist: raw provider output can contain private messages or secrets.
        return normalize_status(result)
