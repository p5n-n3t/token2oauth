# Durable owner-scoped job inbox

## Behavior

Added private bridge routes `GET /v1/inbox?projectId=…&after=…&limit=…` and `POST /v1/inbox/{eventId}/ack`. Both require the bridge bearer plus trusted `X-Owner-Principal` and `X-Client-Id` headers. GET and acknowledgment scope is resolved from the stored assignment row and must match the exact project, owner, and client; NULL legacy ownership never acts as a wildcard, and request bodies cannot select identity.

The inbox reads repository-backed `events` and legacy `job_events` SQLite schemas. Repository events resolve through their stored assignment metadata or the linked R21 attempt; legacy events resolve through their assignment foreign key. Event IDs are namespaced (`repo:<id>` / `job:<id>`) so the independent SQLite sequences cannot collide. Unsupported/missing event storage returns HTTP 501 rather than a fabricated feed.

Pages are capped at 100. Continuation cursors are random, persisted, and bound to the exact owner/client/project; expired cursors are pruned after 24 hours, with a 10,000-row cap. Responses project only event ID/time/type, stored assignment/task identifiers, a bounded state, and acknowledgment status; arbitrary event payloads and prompts are never returned. Acknowledgments use a dedicated SQLite table with `(event_id, owner, client, project)` as the primary key and `INSERT OR IGNORE`, making retries idempotent across restarts.

## Verification

- `python -m unittest tests.test_job_inbox tests.test_bridge` — 12 passed.
- `python -m unittest discover -s tests` from `supervisor/` — 222 passed.
- Coverage includes both actual SQLite event models, Unix-socket HTTP routing, required headers, exact owner/client/project isolation, NULL legacy rows, bounded pagination and scope-bound cursors, prompt exclusion, idempotent acknowledgments after registry restart, and explicit unsupported-storage status.
- `git diff --check` — passed.

Only `supervisor/snooze/job_inbox.py`, `supervisor/snooze/bridge.py`, `supervisor/tests/test_job_inbox.py`, and this report are in scope. `jobs.py` and Node sources were not changed.
