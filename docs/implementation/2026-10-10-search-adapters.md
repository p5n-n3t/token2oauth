# Exa and Firecrawl web-information adapters

**Assignment:** `T2O-R09-20261010`
**Status:** implemented, unit-tested with injected fetch; no provider runtime credentials were available or used.

## Contract

`src/providers/web-information.ts` exports the provider-neutral `WebInformationAdapter` shape with `search` and `extract` operations, shared result/usage types, and explicit capabilities. Exa maps extraction to Contents; Firecrawl maps it to Scrape. Provider-specific search, content-format, and filtering options have TypeScript types and runtime allowlist/range validation. Unknown provider options and unsupported operations are rejected instead of silently dropped. Crawl, async jobs, webhooks, MCP, Tavily, and Scrape.do are outside this implementation.

The adapters use only fixed official origins and documented routes:

| Adapter | Search | Extract | Authentication |
| --- | --- | --- | --- |
| Exa | `POST https://api.exa.ai/search` | `POST https://api.exa.ai/contents` | `x-api-key` |
| Firecrawl | `POST https://api.firecrawl.dev/v2/search` | `POST https://api.firecrawl.dev/v2/scrape` | `Authorization: Bearer …` |

## Safety and error behavior

The caller injects both `fetch` and `resolveCredential`; the module reads no environment variables, has no mutable global credential state, and does not log or persist credentials, queries, URLs, or response bodies. Provider credentials are added only to the fixed-origin request header. Redirects are rejected to prevent credential forwarding. Inputs, request size, response bytes, result count, content length, and timeout are bounded. Caller aborts before send make no request; aborts/timeouts/network errors after fetch begins are marked `requestOutcome: "unknown"` because the provider may have processed the request.

HTTP failures use typed categories `auth`, `quota`, `rate_limit`, `transient`, or `unknown`, with a separate outcome (`not_sent`, `rejected`, or `unknown`) and bounded Retry-After metadata. The adapter performs one request only: there is no same-provider retry or cross-provider fallback after an ambiguous result. Usage is marked observed only when the response contains supported explicit usage fields; otherwise it is `{ known: false, reason }`.

## Validation and limits

`test/web-information.test.mjs` uses stub fetch responses to check route/body/auth, option validation, result and response bounds, cancellation, error classification, secret non-leakage, explicit unknown usage, and one-shot ambiguous failures. `npm test` is the required verification command.

No live provider request or paid operation was executed. Tests demonstrate local request construction and error handling only; provider credentials, live response compatibility, actual billing fields, quota behavior, and production network cancellation remain runtime-unverified. This change intentionally does not wire the adapters into the server, index, or CLI; the architecture lead owns that contract.

## Source provenance

Routes/auth and option behavior are based on the official pages reviewed 2026-10-10: [Exa Search](https://exa.ai/docs/reference/search), [Exa Contents](https://exa.ai/docs/contents/quickstart), [Firecrawl Search](https://docs.firecrawl.dev/api-reference/endpoint/search), [Firecrawl Scrape](https://docs.firecrawl.dev/api-reference/endpoint/scrape), and the bounded comparison in [the provider research report](../research/2026-10-10-search-providers.md). Runtime behavior was not independently verified.
