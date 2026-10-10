# Controlled distributed-job verification

**Assignment:** T2O-R34-20261010
**Purpose:** An operator-run, bounded check of the local gateway, durable job path, existing-session supervisor, and completion-marker retrieval. This report describes the harness only; it does not claim any provider execution.

## Current integration gate

At `origin/codex/unified-platform-20261010` (`d951ea2`), the harness deliberately stops before submission. The runtime's `job_workers` response sets `dispatchEnabled: false` with `blockerCode: "worker_contract_mismatch"`; the `job_submit` input schema and validator reject `output.expectedMarker`, while Snooze's text-output validator requires it; and `job_results` reports `resultsAvailable: false`. These are observed source contracts, not a prediction that jobs completed. Reconcile the adapter/runtime contracts first; then run the harness against the updated build. It will not create a queued-only job or claim a marker was validated under this checkout.

## Preconditions and command

Use a disposable or explicitly authorized local Token2OAuth `StateStore` containing at least two enabled `lightsprint` accounts, plus a supervisor JSON configuration with the same account IDs and at least two registered existing sessions. The supervisor config must satisfy `readSupervisorRuntimeConfig`'s owner-only regular-file and permission checks. Run from the repository root with Node 22+:

```sh
npm run build
node scripts/verify-distributed-job.mjs \
  --config /private/path/supervisor.json \
  --state-dir /private/path/token2oauth-state \
  --tasks 2 --timeout-seconds 300 \
  > /private/path/distributed-job-evidence.json
```

`--tasks` accepts 2 or 3; the wait is capped at five minutes. The state directory must already contain a StateStore. The harness reads account metadata through `StateStore`, uses the real `buildApp`, `StateStore`, and `SupervisorRuntime`, and starts an ephemeral HTTP listener bound only to `127.0.0.1`. It starts the local Snooze bridge in a fresh temporary directory, so it does not attach to, stop, or alter an existing interactive orchestrator. It never calls an upstream provider directly.

The harness registers a temporary public OAuth client against its local gateway and obtains a gateway-issued `mcp jobs:read jobs:write` token through the normal PKCE authorization flow. It prompts for the gateway admin password without echoing it. The token and password are never printed; the temporary OAuth client and refresh-token record are removed in `finally`. A forced process kill can skip that cleanup, so use a disposable state copy where possible and remove any abandoned `t2o-r34-*` OAuth client through normal gateway administration.

Before the one and only `job_submit`, it inspects the published tool schema for `expectedMarker` and asks `job_workers` whether dispatch is enabled. A failed preflight stops before submission. The job contains two or three independent marker-only tasks, each with a unique marker, existing-session execution, bounded plain-text output, and instructions prohibiting tools, file access, external services, and continuation of prior work. On an accepted submission it polls only `job_status`, then reads `job_results` after a terminal complete state. A submit timeout is recorded as ambiguous; the submit is never repeated, and only read-only status lookup follows.

## Evidence and cleanup

The stdout JSON contains assignment/project/task IDs, observed states and timestamps, marker-match booleans (never response text), blocker codes, and samples where multiple tasks were simultaneously reported `running`. `runningIntervals.taskIntervals` includes only timestamps supplied by the job status payload; simultaneous overlap is true only when one status sample reports at least two running tasks. Queued or starting tasks are not counted as concurrent. Missing timestamps or inaccessible results remain unknown/false; the harness does not infer concurrency from task count or success from an idle session.

After the bounded wait, it closes only its local HTTP server and temporary bridge process, removes the temporary OAuth client/refresh record, and deletes the isolated bridge directory. It sends no `job_control`, cancel, stop, or remote orchestrator command. A timeout leaves any remote work for the operator to inspect through the normal job interface; it is never silently cancelled or resubmitted.

## Authoring checks

The harness passed `node --check` and `git diff --check`. `npm test` built TypeScript and ran 177 tests: 176 passed and one supervisor-runtime test failed with `unsafe_socket_permissions` while starting the Python Unix bridge (`test/supervisor-runtime.test.mjs`). The harness was not invoked. No live provider calls were made. Any evidence JSON from an operator run should be reviewed for blockers, distinct selected-account count, result-marker booleans, and simultaneous-running samples before describing it as distributed execution.
