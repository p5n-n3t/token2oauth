# Supervisor continuity operator check

**Assignment:** T2O-R47-20261010
**Base:** `origin/codex/unified-platform-20261010` fetched at `b283997`
**Purpose:** Verify that a submitted two-task job is monitored after its initiating MCP client process exits. This is an operator-run harness; it does not claim provider execution or gateway restart success.

## Run

Build the current checkout first, then run from the repository root with a private runtime config and an existing owner-only Token2OAuth StateStore:

```sh
npm run build
node scripts/verify-supervisor-continuity.mjs \
  --config /private/path/supervisor.json \
  --state-dir /private/path/token2oauth-state \
  --timeout-seconds 180 \
  > /private/path/continuity-evidence.json
```

The config must contain two enabled eligible account IDs and registered `gpt-6-luna` sessions, each on a distinct account. The harness copies it to a mode-0600 temporary config, binds exactly those two selected sessions and a maximum of two workers, and never edits the supplied config or StateStore. The temporary local gateway has a separate private StateStore, a random in-memory admin password, a gateway-issued PKCE token and an ephemeral loopback listener. Credentials do not appear in arguments or logs. `job_submit` is sent once by a child Node process over private stdin; the parent records its exit and thereafter only performs reads. If acceptance is ambiguous, there is no automatic resubmission.

The parent polls ordinary `job_status` while the durable runtime worker monitors and collects task operations. It queries read-only provider session status to record baseline/final prompt count, reported state and available budget/cost fields. Results include task states, selected account IDs, timestamps, and exact marker-match booleans; raw response text is never recorded. A prompt-count delta other than exactly one is a blocker.

## Gateway restart boundary

The harness intentionally does not restart the gateway. In this checkout the temporary HTTP gateway and `SupervisorRuntime` worker share one Node process; stopping that process also stops the worker. There is no supported detached supervisor endpoint through which a new gateway process can reconnect to the still-running worker. `gatewayRestart.status` remains `blocked`; when two provider sessions are actually observed running with one new prompt each, the evidence records that state and the reason restart proof was not attempted. This is not a passing restart test.

If a submission is ambiguous, times out, fails a marker, lacks prompt-count evidence, or the gateway restart remains blocked, the harness retains both private temporary directories and prints their paths in the sanitized report so an operator can inspect durable local job/OAuth state. It sends no cancel, stop, or provider-session control call. Temporary directories are removed only when all job checks pass and restart is verified; that restart is currently unsupported, so a submitted run retains private state for review. Maximum observation time is three minutes.

## Validation record

Harness source was checked with `node --check`; no harness run, paid inference, provider call, build, or test suite was executed while preparing this operator artifact. The restart path is explicitly blocked by the current process architecture and no restart success is claimed.

## Operator verification — 2026-10-10

The operator ran the harness against two registered real accounts. One OAuth-authenticated MCP submission was accepted at 17:18:25 UTC; its child client exited at 17:18:25.572 UTC. Both exact markers were collected afterward, each provider prompt count increased by exactly one, and the parent job became complete. Evidence is in `../evidence/2026-10-10-origin-client-exit.json`. This proves that monitoring/result collection survives the submitting client exiting while the gateway backend remains alive. It does not prove that the entire parent process can exit or that gateway restart during active execution succeeds.

The same durable database was reopened after the test. The administrative projection recovered both completed tasks and their receipt-derived provider USD deltas, $0.001314 and $0.000838. `../evidence/2026-10-10-durable-usage-snapshot.json` records that projection. These are provisional reported USD increases, not invoice charges or remaining credits.

The operator corrected native status parsing (`status.sessionStatus`) and observes provider running state independently from local queue states. No simultaneous provider overlap was established in this short continuity run. Gateway restart remains unverified; remote execution can survive a local restart, and a separate harness is being prepared to prove safe reconciliation without duplicate launch.
