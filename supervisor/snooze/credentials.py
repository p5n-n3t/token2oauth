"""Backend-only credentials; operators configure references, never UI echoes."""
import json
import os
import re
import tempfile
from pathlib import Path


class CredentialStore:
    def __init__(self, path): self.path = Path(path)

    def put(self, name, value):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', name) or not isinstance(value, str) or not value:
            raise ValueError('Invalid credential name/value')
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        data = json.loads(self.path.read_text()) if self.path.exists() else {}
        data[name] = value
        fd, filename = tempfile.mkstemp(prefix='.credentials-', dir=self.path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump(data, f); f.flush(); os.fsync(f.fileno())
            os.replace(filename, self.path)
        finally:
            if os.path.exists(filename): os.unlink(filename)
        return 'credential:' + name

    def get(self, reference):
        if not reference.startswith('credential:'): raise ValueError('Invalid credential reference')
        if self.path.stat().st_mode & 0o077: raise ValueError('Credential file permissions must be private')
        return json.loads(self.path.read_text())[reference.split(':', 1)[1]]
