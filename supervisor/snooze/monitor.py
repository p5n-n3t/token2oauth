"""Observation only until scheduler ownership and recovery are verified."""
import concurrent.futures
import time
import threading


class Monitor:
    def __init__(self, store, observe):
        self.store, self.observe = store, observe
        self.lock = threading.Lock()
        self.max_workers=4

    def check(self, project_id):
        if not self.lock.acquire(blocking=False):
            raise RuntimeError('Check already running')
        try:
            return self._check(project_id)
        finally:
            self.lock.release()

    def _check(self, project_id):
        started = time.time()
        snapshot=getattr(self.store,'active_snapshot',self.store.snapshot)(project_id)
        jobs = [j for j in snapshot['workers'] if j.get('session_id') and str(j.get('state','')).lower() not in ('complete','completed','done','cancelled','canceled','failed','draft','held','queued')]

        def check_one(job):
            try:
                observation = self.observe(job)
            except Exception as exc:
                observation = {'status': 'unavailable', 'error_class': type(exc).__name__}
            self.store.observe(job['session_id'], observation)
            status = observation.get('status', 'unknown')
            self.store.retire_other_incidents(project_id, job['id'], status)
            if status in ('idle', 'failed', 'unavailable', 'ownership_unknown', 'unknown'):
                self.store.incident(project_id, job['id'], status,
                                    f'{status}: inspect task and artifacts before any reassignment')
            return status

        with concurrent.futures.ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            statuses = list(pool.map(check_one, jobs))
        return {'started_at': started, 'finished_at': time.time(), 'checked': len(statuses)}
