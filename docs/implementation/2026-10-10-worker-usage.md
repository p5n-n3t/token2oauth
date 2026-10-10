# Bounded session metadata in durable worker receipts

Built on integration head `e436156a1e1857e355e3f0e37fd081bd6660803f`, including the native nested session-status mapping `{ status: { sessionStatus, ... } }`. Accepted `chat_session` receipts now include a model and sanitized usage snapshot from the accepted preflight status; accepted `observe_session` receipts include the latest model and usage snapshot for both running and idle sessions. The native `model` maps to `reportedModel`, and native `aiGatewaySessionCostUsd` maps to the receipt's `reportedSessionCostUsd` field. That USD value remains provisional session-reported data, not an invoice or verified debit.

The worker emits only finite nonnegative cost/budget values, nonnegative safe-integer prompt counts, positive finite maxBudget, and nonempty labels up to 64 characters. Model labels are capped at 128 characters. Each missing, null, malformed, or overlong field is omitted; the worker adds no default zero. Only the six contract fields are copied into `result.usage`; user IDs, credential references, branches, prompts, providers, tokens, and other status fields are excluded. Operation outcomes and stored-receipt retry behavior are unchanged.

## Verification

- `npm run build`: passed.
- `node --test test/job-worker.test.mjs`: 15/15 passed, including native-shaped baseline/latest usage, running-session capture without a transcript read, zero values only when explicitly reported, invalid-field omission/redaction, and one-send result-receipt retry behavior.
- `npm test`: 194/194 passed.
