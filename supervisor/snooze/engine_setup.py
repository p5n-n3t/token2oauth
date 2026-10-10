"""Explicit operator consent for a read-only engine origin and project mapping."""
import json
import os
import tempfile
from pathlib import Path


def configure_engine(state,base_url,allowed_hosts,project_mapping,credential_ref=None):
    from snooze.analytics_engine import EngineClient
    state=Path(state);path=state/'project.json';config=json.loads(path.read_text())
    if not isinstance(project_mapping,str) or not project_mapping or len(project_mapping)>512:raise ValueError('Explicit source project mapping required')
    if credential_ref is not None and (not isinstance(credential_ref,str) or not credential_ref.startswith('credential:')):raise ValueError('Use a private credential reference, not a token')
    # Validate policy before persisting anything; this constructor makes no calls.
    EngineClient(base_url,allowed_hosts=allowed_hosts)
    config['analytics_engine']={'base_url':base_url,'allowed_hosts':list(allowed_hosts),'project_mapping':project_mapping,'credential_ref':credential_ref}
    fd,name=tempfile.mkstemp(prefix='.engine-config-',dir=state)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as output:json.dump(config,output,indent=2);output.flush();os.fsync(output.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)
    return {'configured':True,'restart_required':True,'project_mapping':project_mapping}
