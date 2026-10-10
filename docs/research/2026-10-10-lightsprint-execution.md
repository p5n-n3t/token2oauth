# LightSprint execution and capacity interface audit

**Assignment:** T2O-PREFLIGHT-20261010-A10
**Verified:** 2026-10-10
**Token2OAuth baseline:** `origin/main` at `7d084c64cccab9634848125724ed1a3193c410ae`

## Findings

| Capability | Classification | Evidence and boundary |
|---|---|---|
| Harmless prompt preflight | **Executed (handoff evidence; not repeated)** | Assignment reports nine accounts ran harmless `gpt-6-luna` prompts; Joey account 1 returned HTTP 402 depleted. Existing-session resume also worked. This report did not issue prompts or repeat account tests. |
| Native LightSprint MCP | **Documented** | `https://app.lightsprint.ai/docs/mcp/` documents `https://app.lightsprint.ai/mcp`, one `lightsprint_api` tool, OAuth sign-in or a user-created named access token, and calls authorized as that user. Workspace/repository role checks still apply. The public docs say the tool can create tasks and launch agent sessions. |
| Fresh task agent | **Documented, task-scoped** | The exposed `lightsprint_api` schema documents `POST /api/tasks` with `{title, workspaceId}` (or stack scope), then `POST /api/tasks/{taskId}/lightsprint-agents/{claude|codex|auto|pi}` with `{branchName?: string, autoMerge?: boolean}`. This starts a task agent; there is no separate standalone session-create or `cloud-agents` method in the published schema. No launch was performed. |
| Exact model selection | **Unknown / absent from launch schema** | Launch selects a provider enum, not a model ID. Official FAQ says LightSprint routes workflow steps to suitable models; it does not publish a model catalog or an exact model-selection request schema. `propose_automation_task` exposes a `model` field for automation configuration, not a one-shot session launch. |
| Usage, quota, model catalog, live capacity | **Unknown in API surface** | The public pricing page describes shared plan credits and usage analytics, but the exposed tool schema has no model-list, usage/quota query, or capacity endpoint. This establishes no documented query surface here; it does not prove that private product UI or an unexposed service has none. Do not infer remaining credits or worker slots. |
| Existing-session chat | **Schema discrepancy; unresolved** | Handoff says chat needs `{message, clientMessageId}`. The current `lightsprint_api` reference lists `POST /api/agent-sessions/{sessionId}/chat` with `{content}`. No mutation was attempted. Confirm the live MCP tool-call schema before implementing chat; do not guess at a REST payload. |
| n8n cloud-agent routes | **Unknown; 404 reported by handoff** | The supplied investigation reports first-party `cloud-agents/settings` and task `cloud-agents` reads returned 404. They were not retried: those paths are not in this session's published `lightsprint_api` allowlist, and a 404 alone does not establish global product support. |
| Browser WebMCP | **Experimental** | The official MCP page marks WebMCP experimental and off by default, with browser-only `lightsprint_current_page` and `lightsprint_navigate` tools. It is not a server-side worker API. |
| Subordinate execution in this runtime | **Documented runtime tool; not a LightSprint cloud API** | `collaboration.spawn_agent({task_name: string, message: string, fork_turns?: string, model?: string, reasoning_effort?: string})` is exposed to this runtime. `fork_turns` accepts `none`, `all`, or a positive count string; `model` can select `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, or `gpt-5.6-sol`; reasoning effort is model-dependent. It starts a subordinate agent, not a LightSprint task/session, and does not query LightSprint capacity. No subordinate was started. |

## Supported gateway route and minimal Token2OAuth boundary

A gateway can use the documented native MCP route: connect as an MCP client to `https://app.lightsprint.ai/mcp` through the documented OAuth flow, then call `lightsprint_api` to create a task and launch a task-scoped agent. A user-provisioned named access token is the documented non-browser alternative. Calls run with that user's identity and role. The gateway must receive authorization through that supported flow; this audit did not access, copy, or expose credentials. Omit `autoMerge` unless separately authorized.

At `origin/main` `7d084c6`, Token2OAuth already has a suitable small provider boundary in `src/provider-capabilities.ts`: `PROVIDER_PROFILES.lightsprint` records the MCP URL, `lightsprint_api`, auth modes, credential scope, and `quotaEndpointDocumented: false`; `Observed<T>` represents provenance-bearing known values or explicit unknowns. Keep a LightSprint adapter on that MCP transport and this observed/unknown convention. Its minimal operations are task creation, task-agent launch by provider, and documented session reads. Do not add guessed model, credit, quota, capacity, or chat methods; add them only after the first-party schema is published and validated.

Token2OAuth's provider profile is static documentation, not a live model or quota catalog. Its current quota signals are reactive HTTP 402/429 only. The existing snapshot already supports `Observed<QuotaInfo>` with remaining, limit, unit, and reset time, so unavailable values should remain unknown rather than be fabricated.

## Official sources checked (2026-10-10)

- [MCP and native API client](https://app.lightsprint.ai/docs/mcp/) — endpoint, OAuth/named-token flow, user authorization, available tools, task/session capability, and experimental WebMCP.
- [Security and isolated execution](https://lightsprint.ai/security) — one isolated cloud sandbox per task and task-scoped review/access controls.
- [FAQ](https://lightsprint.ai/faq) — model-agnostic workflow routing; no exact-model API schema found.
- [Pricing](https://lightsprint.ai/pricing) — shared credits and product-level usage analytics; no query endpoint schema found.
- [Token2OAuth provider boundary at baseline](https://github.com/p5n-n3t/token2oauth/blob/7d084c64cccab9634848125724ed1a3193c410ae/src/provider-capabilities.ts) — repository context, not a LightSprint API specification.
