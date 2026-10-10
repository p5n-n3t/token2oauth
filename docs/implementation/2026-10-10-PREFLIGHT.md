# Token2OAuth × Snooze: connectivity checkpoint

Verified 2026-10-10. This records execution evidence, not completion of the product roadmap.

## Runtime and source

- Running gateway: PID 1336, `127.0.0.1:2030`, `/home/jq/.local/share/token2oauth`, installed Git main `7d084c6` (0.2.0 integration release).
- Public MCP: `https://jq-xubuntu1.bigeye-escalator.ts.net/token2oauth/mcp`.
- Desktop checkout: `codex/t2o-dashboard-help-20261007`, older source; preserve it. No product source changes made during preflight.
- Separate Loopback: port 2025. Existing Tailscale root and OAuth alias mounts were inspected, not modified.
- Ten encrypted credentials in `~/.config/token2oauth/state.json`; secrets were decrypted only in process memory for authorized per-account probes. None copied into evidence.

## Verified workforce

All ten accounts passed independent MCP initialization, tools/list, authenticated repository/board/automation reads, and owned-session status reads. All expose `lightsprint_api`.

| Account | Real inference | Token2OAuth repo | Snooze repo | Notes |
|---|---|---|---|---|
| 10 ecummi16 | Passed | Yes | Yes | Returned exact assistant marker |
| 9 zhaddadz | Passed | Yes | No | First stale session returned 409; alternate succeeded |
| 8 p0y50n | Passed | Yes | Yes | Returned exact assistant marker |
| 7 l2thepete | Passed **through gateway** | Yes | No | Gateway submitted prompt and retrieved assistant transcript |
| 6 niandran | Passed | Yes | Yes | Returned exact assistant marker |
| 5 elleparker | Passed | Yes | Yes | Returned exact assistant marker |
| 4 chupalopez | Passed | Yes | No | Two stale sessions returned 409; third succeeded |
| 3 jqleq | Passed | No | No | Authentication/inference work; project access absent |
| 2 ngilfordz | Passed | Yes | No | Returned exact assistant marker |
| 1 joeyqleq | **HTTP 402 insufficient credits** | No | No | No top-up/billing/subscription change performed |

These are execution eligibility observations at test time, not quantified balances or future capacity guarantees. Nine can execute a harmless prompt, but only eight currently connect the Token2OAuth repository and four connect Snooze.

Account 7 gateway session `ck7907TEyc4_2qljQnwlQ` returned assistant text `T2O_PREFLIGHT_ACCOUNT07_OK` at `2026-10-10T14:30:30.269Z`, with no tool calls. Account 10's initial marker was separately retrieved through direct per-account MCP. Harmless probes reused idle owned sessions; they forbade repository access, changes, commits, PRs, secrets, and continuation of old work.

A separate two-account test observed both accounts 10 and 8 in `running` phase in one parallel sampling round at 14:37:01–14:37:02 UTC; both subsequently returned their exact markers with no tool calls. Evidence is in `../evidence/2026-10-10-lightsprint-overlap.json`. This verifies small multi-account execution, not a 24/35-worker benchmark or single-request durable fan-out.

Gateway API task creation/update/read also passed: verification-only task `6ahCA4Qe0GY1L0w5fWwr_` was created, annotated, marked done, and read back. Creating a board task is not creating an executing agent.

## Known limitations and defects

- Exact balances, renewal dates, maximum concurrency, free slots, and full eligible model catalog are **unknown**. `gpt-6-luna` executed successfully. Session cost/budget fields are not account balance.
- The current pricing page does not establish twelve slots per account. No 108-slot assumption or load test was used.
- Live MCP description says chat accepts `content`; runtime rejects it and requires `message` plus `clientMessageId`. Validation failures caused no execution. Corrected requests used stable message IDs.
- Some ended sessions report `idle` and `canSendMessage:true`, then reject chat with HTTP 409. Do not classify the entire account as broken from that result.
- Published first-party n8n source describes `/api/tasks/{id}/cloud-agents/{provider}` and `/api/cloud-agents/settings`, but tested read endpoints return 404 and current MCP allowlist rejects settings. No invented launch endpoint was used. Fresh agent creation/model selection remain unverified; existing-session resumption is verified.
- An account-10 session read through the gateway client currently affinitized to account 7 returned HTTP 403. Existing pooling does not automatically discover remote agent ownership from an API path.
- Installed source provides request pooling, in-memory request concurrency and session/task ownership helpers. No durable single-request job dispatcher/scheduler was found. Remote agent lifetime differs from HTTP request lifetime. Ownership state is process-local.
- Upstream MCP tool failures can occur inside HTTP 200 responses. Gateway health reports all ten selectable even though account 1's inference returned HTTP 402 inside a tool result. Quota eligibility needs protocol-level handling.

## Claude Code

Claude Code version 2.1.286. Added a single user-scope HTTP MCP entry with the official `claude mcp add` command. Previous configuration backed up at `~/.config/token2oauth/backups/20261010-claude/claude.json` (private).

User completed official OAuth login; `claude mcp get token2oauth` now reports Connected. Two separate Claude processes successfully discovered/called the MCP tool and retrieved real repository and session-status data; actual tool messages were checked independently. Reconnect passed. No existing MCP servers removed. Gateway tools and OAuth work in Claude Code. Its model summaries contained two inaccurate claims; sanitized actual tool evidence is recorded in `../evidence/2026-10-10-claude-mcp.json`.

## Recovery and next action

Diagnostic scripts and sanitized snapshots persist under `~/.local/state/token2oauth/preflight/20261010`; private transient raw responses are under `/tmp/t2o-preflight-20261010`. Do not commit raw provider transcripts or credentials.

Next: finish source recovery and collect bounded cloud leads R01/R02, then assign official provider research and architecture. Preflight, Claude execution/reconnect and the visible-session sweep are saved. Inspect prior Snooze checkpoint `docs/implementation/2026-10-07-PAUSED-HANDOFF.md` in its command-centre worktree before reusing former assignments. Do not repeat completed modules or deploy unreviewed changes.

## Official evidence

- https://lightsprint.ai/pricing (checked 2026-10-10; no per-account concurrency claim)
- https://github.com/SprintsAI/n8n-nodes-lightsprint/blob/main/nodes/Lightsprint/Lightsprint.node.ts (published operations; live mismatch noted above)
- https://github.com/SprintsAI/n8n-nodes-lightsprint/blob/main/nodes/Lightsprint/transport.ts (published transport)
- Live upstream MCP tool description and schemas, captured privately 2026-10-10.
- Installed Claude Code help for `mcp add`, `mcp login`, `mcp get`, and non-interactive execution.

Full visible-session sweep: 163 existing sessions, 159 idle and four failed, at observation time before research dispatch. Idle is not task completion or a free-slot count. One historical account-10 session records claude-opus-5-5; only gpt-6-luna was execution-tested. Two current research workers are separately tracked in the durable ledger.

## Follow-up verification

Claude Code completed another real GET /api/repos after this chat's MCP connection began returning HTTP 401. The live gateway doctor still passes; the downstream connection failure is client-specific and requires separate reconnect investigation. No authentication was weakened.

A fresh task-agent launch through Claude Code and the centralized gateway is now verified; the assistant marker was retrieved and session stop confirmed. See `../evidence/2026-10-10-fresh-agent.json`. The launch selected gpt-6.1-sol by default and generated its own branch name. Exact model choice is not supported by the documented launch fields. The initiating Claude executor truncated the task description, so future dispatch must write and read back the complete instruction packet in ordinary code before launch. No automatic launch retry was performed.

The protocol quota/auth failure fix is integrated on the development branch at 00e3e77 and passes all 123 tests. The running installed gateway remains unchanged.

The temporary workforce watchdog incorrectly applied completed assignment deadlines to reused sessions and interrupted two new assignments. Those workers were explicitly resumed; the diagnostic watchdog now skips terminal assignments and checks for newer assignments sharing the session before cancellation. This is a batch safeguard, not completed product supervision.
