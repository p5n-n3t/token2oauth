class UnsupportedOperation(ValueError):
    pass


OPERATIONS = ('observe', 'launch', 'resume', 'cancel', 'collect', 'reconcile')


class BaseAdapter:
    def capabilities(self):
        return {op: {'supported': False, 'reason': 'Adapter is registration-only; no verified execution transport.'} for op in OPERATIONS}

    def require(self, operation):
        capability = self.capabilities().get(operation, {})
        if not capability.get('supported'): raise UnsupportedOperation(capability.get('reason', 'Unsupported operation'))

    def launch(self, task, attempt): self.require('launch')
    def resume(self, session_id, attempt): self.require('resume')
    def cancel(self, session_id): self.require('cancel')
    def collect(self, attempt): self.require('collect')
    def reconcile(self, attempt): self.require('reconcile')
    def observe(self, session_id): self.require('observe')
