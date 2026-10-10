"""Opt-in, user-scoped service installation with strict argument quoting."""
import json
import re
import subprocess
import sys
from pathlib import Path


def quoted(value):
    text=str(value)
    if any(c in text for c in ('\n','\r','\x00')): raise ValueError('Invalid path')
    return '"'+text.replace('%','%%').replace('\\','\\\\').replace('"','\\"')+'"'


def render_unit(state, executable, port=8765):
    if type(port) is not int or not 1<=port<=65535: raise ValueError('Invalid port')
    return '[Unit]\nDescription=Snooze worker command centre\nAfter=network.target\n\n[Service]\n'+\
        f'ExecStart={quoted(executable)} -m snooze --state {quoted(Path(state).resolve())} serve --port {port}\n'+\
        'Restart=on-failure\nRestartSec=15\nNice=10\nMemoryMax=256M\nCPUQuota=20%\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n'


def install_service(state, name='snooze.service', port=8765):
    if not re.fullmatch(r'snooze(?:-[A-Za-z0-9_-]+)?\.service',name): raise ValueError('Invalid Snooze service name')
    state=Path(state).resolve(strict=True)
    config=json.loads((state/'project.json').read_text())
    target=Path.home()/'.config/systemd/user'/name
    if target.exists(): raise ValueError('Service already exists; it was not replaced')
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(render_unit(state,sys.executable,port))
    config['user_service']=name
    config['service_port']=port
    (state/'project.json').write_text(json.dumps(config,indent=2))
    subprocess.run(['systemctl','--user','daemon-reload'],check=True,timeout=10)
    subprocess.run(['systemctl','--user','enable','--now',name],check=True,timeout=15)
    return str(target)
