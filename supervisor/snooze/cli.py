"""Small local CLI; no external model calls needed to monitor."""
import argparse
import fcntl
import json
import os
import secrets
import threading
import time
import webbrowser
import uuid
from pathlib import Path
from snooze.legacy import read_queue
from snooze.store import Store
from snooze.monitor import Monitor
from snooze.transport import LightSprint


def prime(repo, state, queue):
    repo = Path(repo).resolve(strict=True)
    state = Path(state)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (state / 'project.json').exists():
        raise ValueError('Project is already initialised; use open, not init, to preserve ownership/history')
    config = {'repo': str(repo), 'queue': str(Path(queue).resolve()) if queue else None,
              'project': repo.name, 'project_id':uuid.uuid4().hex, 'ownership': {}, 'config_path': str(Path.home() / '.codex/config.toml')}
    (state / 'project.json').write_text(json.dumps(config, indent=2))
    token_path = state / 'control-token'
    if not token_path.exists():
        fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(secrets.token_urlsafe(32))
    return config


def main():
    from snooze.launch import default_state, open_dashboard
    parser = argparse.ArgumentParser(description='Snooze — honest worker visibility')
    parser.add_argument('--state', type=Path, default=default_state())
    subs = parser.add_subparsers(dest='command')
    init = subs.add_parser('init'); init.add_argument('--repo', type=Path, required=True); init.add_argument('--queue', type=Path)
    server = subs.add_parser('serve'); server.add_argument('--open', action='store_true'); server.add_argument('--port', type=int, default=8765)
    opener = subs.add_parser('open'); opener.add_argument('--port',type=int); opener.add_argument('--no-browser',action='store_true')
    mcp = subs.add_parser('mcp')
    enqueue = subs.add_parser('enqueue');enqueue.add_argument('--file',type=Path,required=True);enqueue.add_argument('--approve',action='store_true')
    history=subs.add_parser('history');history.add_argument('--format',choices=['json','csv'],default='json');history.add_argument('--from-utc');history.add_argument('--to-utc');history.add_argument('--timezone',default='UTC')
    importer=subs.add_parser('import-history');importer.add_argument('--file',type=Path,required=True);importer.add_argument('--source',required=True);importer.add_argument('--cursor',required=True)
    provider=subs.add_parser('configure-provider');provider.add_argument('--id',required=True);provider.add_argument('--file',type=Path,required=True)
    engine=subs.add_parser('configure-engine');engine.add_argument('--url',required=True);engine.add_argument('--allow-host',action='append',required=True);engine.add_argument('--project-mapping',required=True);engine.add_argument('--credential-ref')
    engine_test=subs.add_parser('test-engine')
    takeover=subs.add_parser('take-control',help='Explicit single-owner handover, never an automatic takeover');takeover.add_argument('--external-stopped',action='store_true');takeover.add_argument('--ownership-checked',action='store_true')
    service = subs.add_parser('install-service');service.add_argument('--name',default='snooze.service');service.add_argument('--port',type=int,default=8765)
    for command in ('status', 'incidents', 'check', 'config'):
        subs.add_parser(command)
    args = parser.parse_args()
    state = args.state
    if args.command in (None,'open'):
        print(open_dashboard(state,getattr(args,'port',None),webbrowser.open if not getattr(args,'no_browser',False) else lambda url:False)); return
    if args.command == 'init':
        print(json.dumps(prime(args.repo, state, args.queue), indent=2)); return
    config = json.loads((state / 'project.json').read_text())
    if args.command=='configure-engine':
        from snooze.engine_setup import configure_engine
        print(json.dumps(configure_engine(state,args.url,args.allow_host,args.project_mapping,args.credential_ref)));return
    from snooze.runtime import Runtime
    runtime = Runtime(state,config)
    store = runtime.store; project = runtime.project
    if args.command=='take-control':
        runtime.repo.set_executor(project,'snooze',quiesced=args.external_stopped,reconciled=args.ownership_checked)
        print(json.dumps({'executor':'snooze','pause_dispatch':runtime.scheduler.settings(project)['pause_dispatch'],'notice':'Operator-attested handover; this command did not stop external workers. Approve tasks and explicitly unpause in Settings.'}));return
    if args.command=='test-engine':
        print(json.dumps(runtime.history.engine_report({'kind':['analytics_summary']})));return
    if args.command=='history':
        import sys
        query={'format':[args.format],'timezone':[args.timezone]}
        for key in ('from_utc','to_utc'):
            if getattr(args,key):query[key]=[getattr(args,key)]
        sys.stdout.buffer.write(runtime.history.export(query)[1]);return
    if args.command=='import-history':
        from dataclasses import asdict
        if args.file.stat().st_size>1024*1024:parser.error('History page exceeds 1 MiB')
        print(json.dumps(asdict(runtime.history.ingest(args.source,args.cursor,json.loads(args.file.read_text())))));return
    if args.command=='configure-provider':
        if args.file.stat().st_size>8192:parser.error('Provider config exceeds 8 KiB')
        current=runtime.registry.get(args.id)
        result=runtime.registry.upsert_public_config(args.id,json.loads(args.file.read_text()),trusted=True,expected_revision=current['revision'] if current else 0,project_id=project)
        runtime.registry.authorize(args.id,project,manage=True)
        print(json.dumps(result));return
    if args.command == 'install-service':
        from snooze.service import install_service
        print(install_service(state,args.name,args.port));return
    if args.command == 'enqueue':
        from snooze.queueing import add_packet
        if args.file.stat().st_size>1024*1024:parser.error('Task packet exceeds 1 MiB')
        row=add_packet(runtime.repo,project,json.loads(args.file.read_text()),approved=args.approve)
        print(json.dumps({'id':row['id'],'state':row['state'],'approved':row['spec']['approved']}));return
    if args.command == 'mcp':
        import sys
        from snooze.mcp_server import MCPFacade
        MCPFacade(runtime.repo,runtime.control,(state / 'control-token').read_text(),[project]).serve_stdio(sys.stdin,sys.stdout); return
    if args.command in ('status', 'incidents', 'config'):
        result = store.snapshot(project)
        if args.command == 'incidents': result = result['incidents']
        if args.command == 'config': result = config
        print(json.dumps(result, indent=2)); return
    with (state / 'daemon.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error('A Snooze process already owns this state; use dashboard Check now')
        if args.command == 'check':
            print(json.dumps(runtime.check(project))); return
        threading.Thread(target=runtime.run, daemon=True).start()
        if args.open:
            webbrowser.open(f'http://127.0.0.1:{args.port}')
        from snooze.web import serve
        try:
            serve(store, project, runtime, (state / 'control-token').read_text(), args.port,project_config=config,control=runtime.control,history=runtime.history)
        finally: runtime.stop()
