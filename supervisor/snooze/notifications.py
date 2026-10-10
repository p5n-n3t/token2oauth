"""Explicitly approved wake channels; no arbitrary GUI-chat injection."""
import ipaddress
import json
import subprocess
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('Wake redirects are not permitted')


class NotificationChannels:
    def __init__(self,channels,approved_commands=(),credentials=None):
        self.channels=channels;self.credentials=credentials
        approved={str(Path(p).resolve()) for p in approved_commands}
        for config in channels.values():
            kind=config.get('kind')
            if kind=='webhook':
                parsed=urlparse(config.get('url',''))
                if parsed.username or parsed.password or parsed.fragment or parsed.hostname not in config.get('approved_hosts',[]):raise ValueError('Wake destination is not approved')
                loopback=parsed.hostname in ('127.0.0.1','localhost','::1')
                if parsed.scheme!='https' and not (parsed.scheme=='http' and loopback and config.get('network_scope')=='loopback'):raise ValueError('HTTPS or approved loopback required')
            elif kind=='command':
                argv=config.get('argv',[])
                if not argv or not isinstance(argv,list) or not all(isinstance(x,str) for x in argv) or not Path(argv[0]).is_absolute() or str(Path(argv[0]).resolve()) not in approved:raise ValueError('Command executable is not allowlisted')
            elif kind!='inbox':raise ValueError('Unknown notification channel')

    def deliver(self,channel,payload):
        if channel=='inbox' or channel not in self.channels:return {'state':'inbox'}
        config=self.channels[channel]
        data=json.dumps(payload).encode()
        if config['kind']=='webhook':
            headers={'Content-Type':'application/json','X-Snooze-Delivery-Id':payload.get('delivery_id','')}
            if config.get('credential_ref'):
                if self.credentials is None:raise ValueError('Credential store unavailable')
                headers['Authorization']='Bearer '+self.credentials.get(config['credential_ref'])
            request=urllib.request.Request(config['url'],data=data,headers=headers)
            with urllib.request.build_opener(NoRedirect()).open(request,timeout=5) as response:
                if not 200<=response.status<300:raise ValueError('Wake endpoint refused')
            return {'state':'accepted'}
        if config['kind']=='command':
            completed=subprocess.run(config['argv'],input=data,capture_output=True,timeout=10,shell=False)
            if completed.returncode:raise ValueError('Wake command failed')
            return {'state':'accepted'}
        return {'state':'inbox'}
