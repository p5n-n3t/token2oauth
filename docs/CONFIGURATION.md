# Configuration

Persistent settings live in ~/.config/token2oauth/state.json. Use the web UI or CLI rather than editing encrypted credential fields.

## Environment variables

| Variable | Purpose |
|---|---|
| TOKEN2OAUTH_CONFIG_DIR | Override state directory |
| TOKEN2OAUTH_PORT | Listen port |
| TOKEN2OAUTH_HOST | Listen host |
| TOKEN2OAUTH_PUBLIC_BASE_URL | Public OAuth/MCP base URL |
| TOKEN2OAUTH_BASE_PATH | Reverse-proxy path prefix |
| TOKEN2OAUTH_UPSTREAM_URL | Initial upstream MCP URL |
| TOKEN2OAUTH_POOL_STRATEGY | Initial pool strategy |

## Important settings

- upstreamUrl — exact upstream MCP Streamable HTTP endpoint
- upstreamAuthHeader — default authorization
- upstreamAuthScheme — default Bearer
- strategy — credential-selection strategy
- requestTimeoutMs — per-upstream-request timeout
- maxFailoverAttempts — maximum credentials tried for a stateless request
- failoverStateful — default false
- quotaCooldownSeconds — quota cooldown when no Retry-After is supplied
- errorCooldownSeconds — short transient-error cooldown
- quotaStatuses — defaults to 402 and 429
- authFailureStatuses — defaults to 401
- retryStatuses — defaults to 401, 402, 408, 425, 429, 500, 502, 503, 504
- quotaBodyPatterns — configurable regular expressions checked against capped error output

## CLI examples

~~~bash
token2oauth config get upstreamUrl
token2oauth config set strategy least-used
token2oauth config set maxFailoverAttempts 5
token2oauth config set quotaStatuses 402,429
token2oauth config list --json
~~~
