# Controlled distributed-job verification

**Assignment:** T2O-R40-20261010 (follow-up to T2O-R34-20261010)
**Purpose:** An operator-run, bounded check of the local gateway, durable job path, existing-session supervisor, and completion-marker retrieval, with an isolated OAuth option. This report describes the harness only; it does not claim any provider execution.

## Current integration gate

The harness inspects the current build's `job_submit` schema before submission and stops when `output.expectedMarker` is unavailable. It also checks `job_workers` and stops when dispatch is disabled. These are runtime/source contract checks, not a prediction that jobs completed. A results DTO without the documented bounded result rows does not validate a marker.

## Preconditions and command

Use a private local Token2OAuth `StateStore` containing at least two enabled LightSprint-eligible accounts, plus a supervisor JSON configuration with the same account IDs and at least two registered existing sessions. A legacy `generic-bearer-mcp` account is eligible only when the stored global upstream URL is the exact canonical LightSprint MCP URL; accounts are never rewritten. The supervisor config must satisfy `readSupervisorRuntimeConfig`'s owner-only regular-file and permission checks. Run from the repository root with Node 22+:

```sh
npm run build
node scripts/verify-distributed-job.mjs \
  --config /private/path/supervisor.json \
  --state-dir /private/path/token2oauth-state \
  --tasks 2 --timeout-seconds 300 \
  > /private/path/distributed-job-evidence.json
```

For a fully isolated local OAuth registry, add `--isolated-auth`:

```sh
node scripts/verify-distributed-job.mjs \
  --config /private/path/supervisor.json \
  --state-dir /private/path/token2oauth-state \
  --tasks 2 --timeout-seconds 300 --isolated-auth \
  > /private/path/distributed-job-evidence.json
```

This mode treats the configured upstream StateStore as read-only and constructs it once for runtime credentials. A separate private temporary StateStore receives a random temporary admin password; its ephemeral loopback gateway performs ordinary client registration and PKCE authorization without prompting. After obtaining the real generated client ID, the harness writes a mode-0600 private copy of the supervisor config with only the selected project's client binding replaced, then starts the runtime against the original credential store and an isolated bridge directory. The temporary OAuth registry and files are removed on normal exit. The issuer URL uses the actual ephemeral listener port. This mode does not add scopes to or alter any existing OAuth client.

`--tasks` accepts 2 or 3; the wait is capped at five minutes. The state directory must already contain a StateStore. The harness reads account metadata through `StateStore`, uses the real `buildApp`, `StateStore`, and `SupervisorRuntime`, and starts an ephemeral HTTP listener bound only to `127.0.0.1`. It starts the local Snooze bridge in a fresh temporary directory, so it does not attach to, stop, or alter an existing interactive orchestrator. It never calls an upstream provider directly.

Interactive mode registers a temporary public OAuth client against the local gateway and obtains a gateway-issued `mcp jobs:read jobs:write` token through normal PKCE authorization, prompting for the gateway admin password without echoing it. Isolated-auth mode uses its generated temporary password and separate OAuth store. Tokens and passwords are never printed; temporary OAuth state is removed in `finally`. A forced process kill can skip cleanup, so isolated-auth mode is preferred when the configured StateStore must remain untouched.

Before the one and only `job_submit`, it inspects the published tool schema for `expectedMarker` and asks `job_workers` whether dispatch is enabled. A failed preflight stops before submission. The job contains two or three independent marker-only tasks, each with a unique marker, existing-session execution, bounded plain-text output, and instructions prohibiting tools, file access, external services, and continuation of prior work. On an accepted submission it polls only `job_status`, then reads `job_results` after a terminal complete state. A submit timeout is recorded as ambiguous; the submit is never repeated, and only read-only status lookup follows.

## Evidence and cleanup

The stdout JSON contains assignment/project/task IDs, observed states and timestamps, marker-match booleans (never response text), blocker codes, and samples where multiple tasks were simultaneously reported `running`. `runningIntervals.taskIntervals` includes only timestamps supplied by the job status payload; simultaneous overlap is true only when one status sample reports at least two running tasks. Queued or starting tasks are not counted as concurrent. Missing timestamps or inaccessible results remain unknown/false; the harness does not infer concurrency from task count or success from an idle session.

After the bounded wait, it closes only its local HTTP server and temporary bridge process, removes temporary OAuth state, and deletes isolated directories. It sends no `job_control`, cancel, stop, or remote orchestrator command. A timeout leaves any remote work for the operator to inspect through the normal job interface; it is never silently cancelled or resubmitted. Status is considered terminal when all reported task states are terminal, even if the parent remains queued; a fully completed task aggregate can trigger result retrieval. Numeric epoch-second timestamps are converted to ISO. The R30 results DTO (`results` rows with `task_id` and `text`) is read when present; otherwise marker verification remains explicitly blocked.

Current runtime limitation: `SupervisorRuntime.start()` still accepts only accounts stored with provider `lightsprint`, even though the LightSprint jobs adapter recognizes a legacy generic account only for the canonical LightSprint upstream URL. This harness does not mutate or disguise stored account records to bypass that runtime gate; such accounts can pass the harness eligibility check but runtime startup will report its current account-availability blocker until the runtime contract is reconciled.

## Authoring checks

R40 validation is limited to `node --check` and `git diff --check`; the operator harness was not invoked. No live provider calls were made. The earlier R34 full-suite run had one unrelated supervisor-runtime fixture failure (`unsafe_socket_permissions`) while starting the Python Unix bridge. Any evidence JSON from an operator run should be reviewed for blockers, distinct selected-account count, result-marker booleans, and simultaneous-running samples before describing it as distributed execution.
