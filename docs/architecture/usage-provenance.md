# Usage provenance and billing-pool dimensions

This extends the event/provider-usage distinction in [`TELEMETRY.md`](../TELEMETRY.md). Usage observations must say what was measured, who or what reported it, when, and at what scope. Never turn capacity, request counts, prompt counts, or an undocumented budget into credits or tokens.

## Minimal observation shape

Keep the existing `metric`, `value`, `unit`, `source`, and `observedAt` fields. Add or carry explicit dimensions for:

- **billing pool**: workspace identity (LightSprint Pro's documented credit pool);
- **principal/account**: the user or credential that initiated the work, for attribution only;
- **provider/model**: include a model only when the source identifies it;
- **work item**: task, job, session, and optional execution slot identifiers, when supplied by the source;
- **knowledge state**: `observed`, `reported`, `estimated`, or `unknown`, with a reason for unknown values.

Represent unavailable metrics as `value: null` plus `knowledgeState: "unknown"` and a reason. Record an estimate separately from a provider/session-reported amount, and never sum estimates with observations. An observation source should identify an exact API field, documented response/header, or dated official entitlement rule. Preserve the source timestamp and local `recordedAt` separately when both exist.

## LightSprint mapping as of 2026-10-10

| Source field or fact | Mapping | Treatment |
|---|---|---|
| Session status `model`, `provider` | provider/model dimensions scoped to one session | Reported identity only; not a cost breakdown. |
| `promptCount` | prompt-count metric, unit `prompts` | Reported count; not tokens or credits. |
| `budgetUsed`, `maxBudget` | budget metrics | Unit/credit relationship unknown; retain the source fields without conversion. |
| `aiGatewaySessionCostUsd` | session cost, unit `USD` | Reported session value; keep separate from workspace credits and invoices until its accounting method is documented. |
| `sandboxTier`, `fundingSource` | session metadata | Labels only; not quantities. |
| Pro: 10M credits per seat/month | workspace entitlement rule, source `https://app.lightsprint.ai/docs/billing/` | Documented allocation into one shared workspace pool. May describe entitlement when actual seat count and plan are known; never represents remaining balance or consumption. |
| Balance, credit debits, input/output tokens, per-slot/model totals | — | `unknown` until an authorized source explicitly reports them. The current exposed MCP schema has no such usage/balance endpoint. |

The workspace pool is counted once. User, credential, task, session, model, and slot dimensions explain attribution; they do not create additional balances. If a later source reports both a parent total and child breakdowns, choose one aggregation level for totals and retain the other only as attribution to avoid double counting. Slot concurrency/capacity metrics belong to operational telemetry, not credit usage.

This mapping is a proposal only: existing telemetry supports provider usage with model/account/pool and explicit unknown records, but does not yet carry all task/session/slot dimensions or LightSprint billing data. No integration or new billing endpoint is asserted here.
