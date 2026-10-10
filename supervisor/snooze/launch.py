"""Bounded local launch; never overwrite a project or commandeer another listener."""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def default_state():
    if os.environ.get('SNOOZE_STATE'):
        return Path(os.environ['SNOOZE_STATE']).expanduser()
    binding = Path.home() / '.config/snooze/launcher.json'
    if binding.exists():
        return Path(json.loads(binding.read_text())['state']).expanduser()
    # Compatibility with the already installed preview; retain its history in place.
    legacy = Path.home() / '.local/state/snooze-trump'
    return legacy if (legacy / 'project.json').exists() else Path.home() / '.local/state/snooze'


def probe(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=1) as response:
            return json.loads(response.read(4096))
    except urllib.error.HTTPError as exc:
        raise RuntimeError('Another or incompatible service is listening on this port') from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ConnectionRefusedError): return None
        raise RuntimeError('Listener did not return a compatible health response') from exc
    except (ValueError, TimeoutError, OSError) as exc:
        raise RuntimeError('Listener did not return a compatible health response') from exc


def start_daemon(state, port, config):
    service = config.get('user_service')
    if service:
        if not isinstance(service, str) or not re.fullmatch(r'snooze(?:-[A-Za-z0-9_-]+)?\.service', service):
            raise ValueError('Invalid registered Snooze service')
        unit = Path.home() / '.config/systemd/user' / service
        if not unit.is_file(): raise RuntimeError('Registered user service is not installed')
        subprocess.run(['systemctl','--user','start',service], check=True, timeout=10)
        return
    state = Path(state)
    with (state / 'daemon.log').open('ab') as log:
        subprocess.Popen([sys.executable,'-m','snooze','--state',str(state),'serve','--port',str(port)],
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)


def open_dashboard(state, port, open_browser):
    state = Path(state)
    config_file = state / 'project.json'
    if not config_file.is_file():
        raise RuntimeError('First initialise a project: snooze init --repo /path/to/repo')
    config = json.loads(config_file.read_text())
    if port is None:port=config.get('service_port',8765)
    if type(port) is not int or not 1 <= port <= 65535: raise ValueError('Invalid port')
    expected = config.get('project_id', config['project'])
    health = probe(port)
    if health is None:
        start_daemon(state, port, config)
        deadline = time.monotonic() + 12
        while health is None and time.monotonic() < deadline:
            time.sleep(.15); health = probe(port)
        if health is None: raise RuntimeError('Snooze did not become ready; inspect daemon.log or the registered service')
    if not isinstance(health, dict) or health.get('name') != 'snooze' or health.get('api_version') != 2 or health.get('project') != expected:
        raise RuntimeError('Port belongs to another project or incompatible service; no process was replaced')
    url = f'http://127.0.0.1:{port}/'
    try: open_browser(url)
    except Exception: pass  # Browser failure must not hide the working URL.
    return url
