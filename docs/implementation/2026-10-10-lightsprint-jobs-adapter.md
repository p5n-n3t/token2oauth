# Account-pinned LightSprint jobs adapter

**Assignment:** T2O-R12-20261010
**Verified:** 2026-10-10
**Scope:** Standalone TypeScript adapter and mocked unit tests. No server route, pool, database, or production wiring was changed.

## Result and evidence

The new `LightSprintJobsAdapter` binds each instance to one stored `lightsprint` account, obtains its encrypted token through `StateStore.revealToken`, and uses LightSprint's fixed `https://app.lightsprint.ai/mcp` endpoint. It neither selects credentials from `CredentialPool` nor accepts caller-supplied URLs. Native MCP uses JSON-RPC initialize, `notifications/initialized`, `tools/call`, `Mcp-Session-Id`, and this repository's JSON/SSE response parser. The API tool call remains `lightsprint_api({ method, path, body })`.

Implemented calls cover task create/read/instruction patch, task-scoped agent launch/list, session status/transcript, chat, cancel, and stop. Mutations are never automatically retried. A missing response is classified `ambiguous`; the response envelope retains the owning `accountId`. Status 401, 402, and 429 become safe auth, quota, and rate-limit categories, including when a 402 is wrapped in an HTTP 200 tool result. Raw upstream error text is not returned for rejected calls. Transcripts are capped at 250,000 serialized characters, and adapter calls do not emit transcript or prompt telemetry.

Instruction patching always performs a task readback. Launch is blocked unless the returned task ID and description exactly match the requested ID and instructions, and launch rechecks before the POST. Launch accepts only `autoMerge:false`; the provider enum is closed. A returned model or branch name is labelled as reported metadata only: callers cannot request an exact model or assume a branch name was honored. The chat body carries the newly supplied `content` and `clientMessageId`, never a stale transcript fragment.

**Executed:** mocked tests verify credential pinning, MCP initialize/session/call framing and IDs, exact chat fields, ambiguous lost launch response without replay, inner-402 quota classification, instruction mismatch blocking, documented operation routes, and transcript bounds. The project `npm test` command builds TypeScript and runs the Node test suite; no live LightSprint call, paid operation, or real account credential was used.

**Documented:** the current runtime's official LightSprint MCP tool description identifies `lightsprint_api({method,path,body})`, task and agent routes, and session status/transcript/chat/cancel/stop endpoints; the LightSprint server is `https://app.lightsprint.ai/mcp`. The current tool description specifies chat `{content}`; this adapter additionally sends `clientMessageId` as required by the assignment and covered by a mock only. See [LightSprint MCP docs](https://app.lightsprint.ai/docs/mcp/) and the existing [provider capability profile](../PROVIDER-CAPABILITIES.md).

**Unsupported:** this adapter does not export or reuse consumer web-session credentials outside a documented client, does not choose an exact model or branch, and refuses disabled or non-LightSprint accounts.
**Experimental:** none. The fetch and MCP-client factory seams are test injection points; tests do not establish live service behavior.
**Unknown / limitation:** no remote call was made, so API acceptance of `clientMessageId`, error-envelope details, permission behavior, and any future server changes remain unverified. The adapter is not registered in `server.ts` by design. Remote authorization remains LightSprint's account boundary; this module preserves the selected account on every result and does not claim to discover ownership of pre-existing remote IDs.
