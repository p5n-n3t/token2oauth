# Supervisor bridge client implementation

**Assignment:** T2O-R13-20261010
**Date:** 2026-10-10
**Branch:** `feat/t2o-supervisor-bridge-20261010`

## Result

Added an explicitly managed Node client for the private Snooze supervisor process in `src/supervisor-bridge.ts`. Constructing or importing the module has no process-start side effect; callers must create it with `enabled: true` and call `start()`. The client launches `python3 -m snooze.bridge --socket <private socket> --state-dir <isolated state> --auth-fd 3` from the configured supervisor working directory. Its state directory is `<configDir>/supervisor-state`, separate from standalone Snooze state.

The bridge creates a fresh 32-byte bearer in memory and writes it to the child's inherited fd 3. It is not placed in arguments, environment variables, or diagnostic output. Requests use an HTTP Authorization header over the Unix socket. The client only permits the contract's assignment, event, control, and operation routes and bounds method/query forms, JSON request size (256 KiB by default), response size (1 MiB by default), and request duration (15 seconds by default, with a 120-second maximum). Callers can supply an abort signal. A 401 is terminal: credentials are discarded, the child is stopped, and the bridge enters failed state, including when the peer's 401 body is oversized.

Startup requires an existing canonical config directory owned by the current user and inaccessible to group/other users. The isolated state directory must be a real directory owned by the current user with mode `0700`; the bridge refuses symlinks and pre-existing socket paths. Once started, it requires a same-user Unix socket with mode `0600`. Cleanup checks the socket's recorded device/inode/owner/mode before unlinking, so it will not blindly remove a replacement or foreign path. `status()` exposes lifecycle and bounded diagnostic metadata only; child stderr content is never retained or returned. `close()` terminates the child and removes only the socket identity observed at startup.

The client exports `SupervisorBridge`, `SupervisorBridgeError`, route validation, status/request types, and injectable spawn/HTTP-client seams. Tests cover explicit startup, fd-3 bearer handoff, permissions, route rejection, bad authentication, oversized responses and unserializable request values, request timeout/size bounds, pre-existing symlink refusal, startup failure, orderly shutdown, and child crash cleanup.

## Verification and limits

`npm test` passed on 2026-10-10: TypeScript build succeeded and all 129 repository tests passed. Dependencies were installed with `npm ci --ignore-scripts --no-audit --no-fund`; tracked lockfile/package files were unchanged.

The private client is not mounted from `server.ts`, and no public API, worker, or service lifecycle integration is added. The real Python `snooze.bridge` implementation is being vendored separately and was not present in this worktree during verification, so interoperability with that process remains unverified. The tests use injected child and HTTP seams plus a local Unix-socket fixture; they do not start provider work or pass provider credentials. No deployment, PR, merge, or live service change was performed.
