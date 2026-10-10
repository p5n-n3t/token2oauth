# MCP client authentication and session resumption

**Assignment:** T2O-R04 — unified Token2OAuth × Snooze
**Verified:** 2026-10-10
**Scope:** Official client/specification documentation only; 20 targeted URLs requested. This is an adapter and operating-model assessment, not a claim that every client/version was installed and tested.

## Decision

For external events that must continue work, use a durable event inbox/queue that records the event and intended client/session, then invoke a documented CLI resume adapter where one exists. If the client exposes only a desktop/web connector or has no verified resume command, send a human notification and let the person reopen the conversation. Do not assume a consumer chat has a public webhook that can awaken an arbitrary dormant conversation.

**Executed:** The assignment reports that Claude Code **2.1.286** passed a local check of the centralized HTTP gateway, OAuth, actual tool calls, and reconnect. I did not rerun that environment.
**Documented:** Claude Code and Codex CLI both document local CLI session resumption. This means a process can be started with an existing session identifier; it is not itself a durable event listener. Claude Code separately documents MCP WebSocket event delivery into a running session.
**Experimental/product-gated:** ChatGPT Developer Mode/custom MCP is a product feature with plan and workspace controls. It is distinct from the API and does not establish a general event-to-dormant-chat adapter.
**Unsupported in reviewed official docs:** a public webhook or API that resumes an arbitrary dormant ChatGPT Web/Desktop conversation. This means no such supported path was documented in the pages reviewed, not proof that no private/internal mechanism exists.
**Unknown:** Where a product URL redirected to a general index, returned an error, or documented MCP setup without session-resume semantics, I do not infer resumability.

## Protocol and adapter findings

| Client | Authentication and MCP status | Resumption / external events |
|---|---|---|
| **Claude Code CLI** | Remote HTTP MCP supports OAuth; configure a server with `claude mcp add --transport http NAME URL`, then authorize through the documented CLI flow. The interactive auth command can print a URL for SSH/headless terminals, but completing OAuth still needs a user/browser callback. `--bare` skips MCP server discovery and is unsuitable when a run depends on configured MCP tools. | Documented shapes: `claude -p --resume SESSION_ID "prompt"` and `claude -p --continue "prompt"`. A saved local session can be resumed by a newly launched CLI process. MCP docs also describe WebSocket servers pushing external messages into a **running** session; this is not durable wake-up/replay for a stopped session. Assignment-supplied 2.1.286 gateway/OAuth/tool/reconnect check passed locally. |
| **Codex CLI** | Official CLI supports noninteractive `codex exec`; authenticate with the supported Codex sign-in or a separately provisioned API key in an authorized runtime. A ChatGPT subscription is not an API key. | Documented resume shapes: `codex exec resume --last "prompt"` or `codex exec resume SESSION_ID "prompt"`; interactive users can use `codex resume`. Resume is a CLI operation over saved CLI session state, not a documented webhook listener for dormant ChatGPT Web chats. Check `codex exec resume --help` on the installed version before automating flags; CLI syntax can evolve. |
| **ChatGPT Web / Desktop** | OpenAI documents Developer Mode and remote MCP apps/connectors in ChatGPT with plan/workspace availability and administrator controls. Setup is user-authorized product configuration; connector OAuth is not a license to copy browser credentials into a service. The reviewed pages do not establish equivalent Desktop configuration or a supported programmatic resume handle. | Scheduled Tasks are documented as scheduled prompts/reminders. The reviewed docs do not describe arbitrary external-event triggers or an API to attach an event to a dormant conversation. Use a queue plus a notification or a supported API workflow instead. Treat Web/Desktop parity as **unknown** unless the current product UI/docs explicitly show it for the account. |
| **OpenCode** | The queried first-party MCP URL returned 404. Z.AI’s official integration guide includes an OpenCode MCP configuration example, which establishes that an MCP configuration path is documented by that integration vendor, not the client’s complete auth policy. | **Unknown:** no first-party resume adapter verified in this pass. Do not infer one from MCP configuration. |
| **Cursor** | The queried MCP URL redirected to the general Cursor docs index, whose navigation lists MCP. Specific OAuth/headless configuration was not established by that fetched page. | **Unknown:** no exact durable session-resume or event-invocation adapter verified. |
| **Windsurf** | The queried Windsurf MCP URL redirected to Devin documentation. Do not transfer Devin’s MCP capabilities to Windsurf. | **Unknown** from current Windsurf-specific evidence retrieved. |
| **Cline / Roo Code / Continue** | MCP configuration is documented: Cline describes remote Streamable HTTP/SSE and a CLI OAuth authorization flow; Roo documents stdio, Streamable HTTP and legacy SSE, with per-tool auto-approval disabled by default; Continue documents stdio/SSE/Streamable HTTP configuration. | These pages establish MCP setup, not durable session resumption or a provider webhook that wakes a dormant agent. **Unknown** for that adapter; use an external inbox and human notification unless a separately verified client API exists. |
| **Perplexity** | The official help URL returned 403 during this pass. | **Unknown.** No support claim made. |
| **Z.AI** | Official docs show its MCP server configuration and supported client examples (including Claude Desktop, Cline, OpenCode and Roo). The example uses a Z.AI API key for that service. This proves an integration example, not those clients’ session-resume behavior. | **Unknown** for durable client resumption or external-event invocation. |
| **Hermes Agent** | Official docs describe MCP OAuth and user-mediated browser authorization. They state expired OAuth in the background can park a server with a warning; background probes do not open a browser. Reauthorization is therefore a human action. | MCP reconnect/reload controls are documented, but the pages reviewed do not establish a general adapter that resumes an arbitrary dormant conversation from an external event. Use notification for parked auth and persist incoming work outside the agent. |

## Safe operating pattern

The MCP authorization specification applies to HTTP-based transports: OAuth authorization is optional, but HTTP implementations should follow the spec when using it. It references OAuth 2.1, authorization-server metadata and protected-resource metadata. Send access tokens in the `Authorization` header on every request, never in a URL; use least-privilege scopes and bind credentials to the intended resource. The spec says stdio implementations should not use this HTTP OAuth flow and should obtain credentials from the environment. Never extract cookies, browser storage, hidden endpoints, or private prompts to simulate a client session.

For event-driven work, persist the event ID, payload, target session ID (if supported), retry state, and audit trail in an owned inbox. Start a fresh authorized CLI process and pass only the event needed for the documented resume command. Require explicit tool permissions and human approval for consequential actions; do not treat MCP connectivity as blanket approval. If authorization has expired or the client has no documented resume interface, notify a person rather than silently retrying with consumer-account state.

Consumer Claude/ChatGPT subscriptions grant product access; they are not API keys. For unattended service calls, use the provider’s documented API credential path and account/billing controls, or a supported product sign-in inside its intended CLI. Do not convert a personal subscription into an assumed API entitlement.

## Official sources (checked 2026-10-10)

- MCP authorization, version 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code headless execution: https://code.claude.com/docs/en/headless
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude remote MCP connectors: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Codex CLI: https://learn.chatgpt.com/docs/codex/cli
- Codex CLI reference: https://developers.openai.com/codex/cli/reference/
- Codex authentication: https://developers.openai.com/codex/auth/
- ChatGPT Developer Mode and MCP apps: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta
- ChatGPT Scheduled Tasks: https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
- ChatGPT connectors: https://help.openai.com/en/articles/11487775-connectors-in-chatgpt
- OpenCode MCP URL checked (404): https://opencode.ai/docs/mcp/
- Cursor MCP URL checked (redirected to docs index): https://docs.cursor.com/context/mcp
- Windsurf MCP URL checked (redirected to Devin docs): https://docs.windsurf.com/windsurf/cascade/mcp
- Cline MCP: https://docs.cline.bot/mcp/mcp-overview
- Roo Code MCP: https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/
- Continue MCP: https://docs.continue.dev/customize/deep-dives/mcp
- Perplexity connectors URL checked (403): https://www.perplexity.ai/help-center/en/articles/10352986-connectors
- Z.AI MCP server/client examples: https://docs.z.ai/devpack/mcp/vision-mcp-server
- Hermes Agent MCP: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
