# Pooling and failover

## Recommended: adaptive-sticky

For a new session, eligible credentials are scored using normalized request count, in-flight concurrency, observed failure rate, consecutive failures, and account priority. Once an MCP session ID is known, that session stays pinned to the same credential.

~~~text
unknown ──2xx──▶ healthy
   │               │
   │               ├──429/quota──▶ cooldown ──time──▶ ready
   │               ├──402────────▶ exhausted ─time──▶ ready
   │               ├──401────────▶ auth-failed
   │               └──5xx/net────▶ cooldown ──time──▶ ready
   │
   └──manual disable──────────────▶ disabled
~~~

New credentials intentionally begin as `unknown`; that is not a failed health
check. Use `token2oauth account probe` (or **Test all enabled credentials** in
the admin console) to send a direct authenticated MCP `initialize` request to
each token. Probes run sequentially and save their HTTP result without exposing
the bearer token.

## Stateful sessions

A provider may tie Mcp-Session-Id to server-side state. Replaying the same ID while changing credentials can be incorrect, so failoverStateful is false by default.

## Quota detection

There is no universal MCP quota endpoint. Token2OAuth uses observable signals: HTTP 402, HTTP 429, Retry-After, and configurable response-body patterns for depleted credits, insufficient balance, exceeded quota, usage limits, and rate limiting.

Provider-specific proactive usage checks can be added when a provider publishes a real usage API.

## Strategies

- adaptive-sticky — recommended
- round-robin — deterministic rotation
- least-used — request count normalized by weight
- weighted-random — probabilistic distribution using weights
- random — uniform eligible account
- priority — lowest numeric priority first

## Commands

~~~bash
token2oauth pool status
token2oauth account list
token2oauth account disable ACCOUNT_ID
token2oauth account enable ACCOUNT_ID
token2oauth account reset-health ACCOUNT_ID
token2oauth account probe [ACCOUNT_ID]
token2oauth pool strategy adaptive-sticky
~~~
