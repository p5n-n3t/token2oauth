# Durable session resumption broker

**Assignment:** T2O-R23-20261010
**Base:** `origin/codex/unified-platform-20261010`
**Date:** 2026-10-10

## Implemented

Added `supervisor/snooze/resumption.py`, a local SQLite event broker with an exclusive advisory owner lock. Its private database is stored under an owner-only directory and file. Trusted setup code explicitly registers the UUID session, principal, project, job, workspace working directory, adapter, model, and (for Claude Code) fixed MCP config and tool allowlist. A separate trusted policy record holds authorization level, allowed actions, mode, attempt/runtime ceilings, and budget ceilings. Event fields cannot select a session, executable, model, working directory, config, tool permissions, or budget.

`handle_event` validates bounded event metadata, persists a unique event/request before dispatch, and invokes at most once. It stores no prompt, provider output, credential, or raw transcript. Request summaries contain only adapter, exit code, elapsed time, bounded byte counts, truncation state, and a fixed budget-enforcement classification. Inbox acknowledgment is a separate timestamp; acknowledging a handoff never changes execution state.

The default policy is observe-only. Headless dispatch requires authorization level 4, `headless` mode, and the registered action in the policy allowlist. Codex uses the documented `codex exec resume --model MODEL --json SESSION_UUID PROMPT` shape with the registered absolute executable, no unsupported monetary-limit flag, and no approval bypass. Because the documented Codex CLI has no strict USD cap, execution is held for manual handoff unless policy explicitly acknowledges that limitation; runtime, attempt, and broker-side reservation ceilings still apply, but they are not a hard Codex spend cap. Claude Code uses `-p --resume SESSION_UUID PROMPT --model MODEL --max-budget-usd CAP --strict-mcp-config FILE --allowedTools ... --output-format json` from fixed registered configuration. No model is selected automatically.

Subprocesses receive an argv list with `shell=False`, a filtered environment, no stdin, a fresh process group, bounded output capture, and a policy runtime timeout. Timeout or uncertain runner outcome becomes `ambiguous`; it is never replayed. The broker terminates only the newly created child process group. A process restart marks durable in-flight claims ambiguous under the owner lock. `completed` means only that the CLI exited successfully; it does not verify remote task completion or output artifacts.

ChatGPT Web/Desktop requests produce durable `manual_handoff` entries with request/event IDs. There is no cloud-resume endpoint or configured cloud callback; the broker does not claim that a dormant conversation resumed. Polling/provider integration and public API wiring remain outside these owned files.

## Verification and limits

The focused suite passed: 10 tests cover injected subprocess argv and `shell=False`, Codex/Claude command shapes, policy rejection, event deduplication, budget ceilings, timeout ambiguity, restart recovery without replay, Web handoff, separate acknowledgment, and prompt/output non-persistence. `python -m compileall -q snooze/resumption.py` passed. The full vendored Python suite passed: 188 tests via `python -m unittest discover -s tests` from `supervisor/`.

No provider CLI was executed, no external inference call was made, and no public route was mounted. Codex's spend ceiling remains an explicit operator-acknowledged limitation because the documented CLI does not provide a strict per-run USD flag. CLI exit status is process evidence only; a separate reconciliation/validation layer must establish remote task outcomes.
