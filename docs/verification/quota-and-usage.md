# Quota and usage verification — 2026-10-10

The verified native LightSprint session status exposes `aiGatewaySessionCostUsd`, `promptCount`, `budgetUsed`, `maxBudget`, `fundingSource`, `sandboxTier`, and the reported model. The gateway records bounded baseline and subsequent observations as durable operation receipts. The supervisor derives nonnegative per-task cost/prompt deltas from accepted receipts within the same attempt and generation; model changes or missing observations do not produce invented deltas.

The dashboard displays those deltas for gateway-managed tasks and their registered session/model, and sums distinct task-generation deltas per account with an explicit coverage count. This is tracked job usage, not a complete account billing ledger. External or historical activity outside registered gateway jobs is not included. Provider-reported USD is provisional, not an invoice charge, credit conversion, or proof of savings. Missing observations remain missing instead of becoming zero.

Exact remaining account/workspace credits, renewal dates, model-specific credit/token consumption, and provider concurrency maxima have not been exposed by the tested API. They remain unknown. The reported session budget fields observed as `0 / 500` have an unreported unit and must not be described as 500 remaining credits. The UI labels that denominator as a provider session budget and keeps it separate from account quota and available worker capacity.

[Official LightSprint pricing](https://lightsprint.ai/pricing), verified 2026-10-10, describes included Pro credits as shared across the team. A billing pool shared by multiple accounts must have one balance identity; its balance cannot be added repeatedly under each account. An exact remaining-balance display requires a documented billing API or supported export with identity, unit, and observation time. No undocumented billing endpoint or browser-session extraction is used.

## Real evidence

- Two managed tasks completed after their initiating MCP client exited. Their durable reported USD increases were $0.001314 and $0.000838, with one additional provider prompt each and reported model `gpt-6-luna`.
- `../evidence/2026-10-10-durable-usage-snapshot.json` records the recovered administrative projection. Account totals each cover one task generation, rather than implying complete account usage.
- An authenticated temporary dashboard rendered the real persisted values and explicit unknown quota/capacity. Browser inspection at 390 CSS pixels found `scrollWidth = innerWidth = 390`. Screenshots are in `../../output/playwright/supervisor-live-usage-{desktop,mobile}.png`.
- Browser inspection also found and corrected Python epoch-second timestamps being rendered as 1970 dates. Origin-client status remains unknown until a client heartbeat is registered; a running backend does not prove the original interactive orchestrator is online.

The installed service on port 2030 is unchanged. This functionality is on the integration branch, not a production deployment or completed product release.
