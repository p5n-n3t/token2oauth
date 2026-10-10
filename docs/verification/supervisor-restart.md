# Supervisor gateway restart continuity check

**Assignment:** T2O-R54-20261010
**Integration base:** `origin/codex/unified-platform-20261010` at `c3f77b5`
**Purpose:** Operator-run evidence that one accepted two-session job survives a restart of only its temporary gateway and supervisor runtime. Preparing this harness does not submit jobs or call providers.

## Run

After building the checkout, use a private runtime JSON config and an existing owner-only Token2OAuth StateStore:

```sh
npm run build
node scripts/verify-supervisor-restart.mjs \
  --config /private/path/supervisor.json \
  --state-dir /private/path/token2oauth-state \
  --timeout-seconds 180 \
  > /private/path/restart-evidence.json
```

The harness selects two enabled eligible accounts with registered `gpt-6-luna` sessions, sets a two-worker private runtime config, creates an isolated temporary OAuth StateStore, and binds an ephemeral loopback port. PKCE uses that exact port for its issuer/resource audience; restart reuses the same config, bridge database, auth store, listener port and in-memory OAuth access token. The supplied config and credential StateStore are read-only. Secrets are not placed in command arguments or evidence output.

The initiating `job_submit` runs in one child Node process and is sent once. The child exits after the response; the parent does only backend-status, provider-session-status, SQLite-read-only and results reads after that. Ambiguous submission is never retried. Work consists of exactly two bounded marker-only prompts assigned to distinct accounts.

## Restart safety gate and evidence

Before stopping anything, the harness must observe both selected native provider sessions as running and use SQLite URI `mode=ro` against the temporary `snooze.sqlite3` registry to confirm exactly one `accepted` `chat_session` receipt for each selected account/session, no queued/claimed chat mutation, and no claimed operation. It records only operation/task/account/session IDs, receipt state and client message IDs, not prompt bodies. Prompt count is not required to have incremented while sessions are running.

Only after that gate does it close the temporary HTTP listener and gracefully close `SupervisorRuntime` (which drains its local worker), then start a new runtime and gateway over the same durable paths and port. It reconnects the existing scoped OAuth token, reads job status/results without sending chat again, and compares accepted receipts before stop, after restart and at completion. Evidence includes stop/start times, provider states before and after local shutdown, final prompt-count deltas, reported budget/cost fields, task states, and exact marker-match results. Continuity is verified only if both final prompt counts are baseline +1, both markers match, the task/job is complete, and both accepted receipts remain unchanged and unique.

If the pre-stop safety gate is absent, restart is not attempted and is not reported as successful. If the run is ambiguous, fails, or times out, private runtime/auth directories and durable job state are retained with their paths in the sanitized evidence. No cancel, stop-session, provider-session mutation, installed service restart, or resubmission is performed. Observation is capped at three minutes; remote work may outlive the local harness and must be inspected through normal operator tools.

## Preparation checks

`node --check scripts/verify-supervisor-restart.mjs` and `git diff --check` passed. The harness was not run, and no paid inference or live provider call was made during preparation. Runtime outcomes remain unknown until an operator executes the command with authorized test accounts.
