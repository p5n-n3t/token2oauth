# Experimental GitHub Copilot agent-task adapter

**Verified:** 2026-10-10. **Implementation status:** adapter authored and fake-fetch tested; Token2OAuth runtime integration is **unverified**. No GitHub task was submitted and no live provider call was made.

## What is implemented

`src/providers/github-agent-tasks.ts` adds an isolated TypeScript adapter for the documented repository-scoped lifecycle:

- `POST /agents/repos/{owner}/{repo}/tasks` to submit a prompt.
- `GET /agents/repos/{owner}/{repo}/tasks` to list one bounded page (at most 100).
- `GET /agents/repos/{owner}/{repo}/tasks/{task_id}` to retrieve a task.

The adapter fixes the host to `https://api.github.com`, validates owner, repository, task ID, request options, and output size, uses `redirect: "error"`, and applies a bounded timeout and 1 MiB response cap. It resolves a credential through a callback for each request and does not retain it or include it in errors. Requests use `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10`.

Start requests accept only documented fields (`prompt`, `model`, `custom_agent`, `create_pull_request`, `base_ref`, `head_ref`); `create_pull_request` defaults to `false`. Returned output is projected to bounded task status/IDs, timestamps, links, and GitHub branch/pull artifacts. Provider states are passed through verbatim, so `queued` is not relabeled as running. Session prompts and other response fields are omitted. There is no automatic retry. Cancellation is explicitly unsupported because the reviewed REST reference has no cancellation endpoint.

The adapter exposes an experimental marker and `runtimeIntegration: "unverified"`. It does not register GitHub credentials, choose authorization on a user's behalf, poll, launch, or wire itself into the Token2OAuth runtime.

## Official evidence

The current GitHub REST reference identifies these endpoints as public preview and documents the routes, request/response fields, headers, and API version `2026-03-10`:

- [REST API endpoints for agent tasks](https://docs.github.com/en/rest/agent-tasks/agent-tasks)
- [Use Copilot cloud agent via the API](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api)

The REST reference documents fine-grained personal access tokens and GitHub App user access tokens. Start requires repository `Agent tasks` read/write permission; list/get require `Agent tasks` read permission. GitHub App installation access tokens are explicitly unsupported. Starting a task requires Copilot Business or Enterprise entitlement. The adapter does not infer entitlement, account quota, rate limits, or a successful live execution.

## Verification and limitations

The focused Node tests use fake fetch only. They cover endpoint construction, API headers, credential resolution and redaction, safe PR default, state/artifact projection, route and input validation, documented authorization/validation/rate-limit failures, transport/server ambiguity, oversized responses, and unsupported cancellation. They make no real GitHub API or task calls. See the commit checks for actual test results.

This is an experimental adapter for a public-preview API, not an integrated product capability. Runtime wiring, credential UX, entitlement behavior, real response compatibility, operational polling, and end-to-end task execution remain unverified. The official API surface may change; revisit its reference before integration or release.
