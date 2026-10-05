# Token2OAuth

<p align="center">
  <strong>Turn bearer-token MCP servers into OAuth-connected MCP servers—with encrypted multi-account pooling.</strong>
</p>

<p align="center">
  <img alt="Tests" src="https://img.shields.io/badge/tests-4%2F4%20passing-44DC93">
  <img alt="Node 22+" src="https://img.shields.io/badge/Node.js-22%2B-5FA04E?logo=nodedotjs&logoColor=white">
  <img alt="OAuth 2.1 + PKCE" src="https://img.shields.io/badge/OAuth-2.1%20%2B%20PKCE-7B61FF">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-Streamable%20HTTP-51D3EF">
  <img alt="Tailscale" src="https://img.shields.io/badge/Tailscale-Funnel-111111?logo=tailscale">
  <a href="./LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

Token2OAuth is a self-hosted **OAuth facade + smart credential pool + reverse proxy** for remote MCP servers that normally expect a static bearer token.

ChatGPT connects to **one** Token2OAuth MCP URL using OAuth. Token2OAuth keeps upstream provider credentials encrypted on the host, chooses a healthy credential for each new MCP session, and forwards the request to the real upstream MCP server.

It was designed for the common case where you own several legitimate provider accounts or keys with separate quotas and do **not** want to configure one ChatGPT connector per account.

> Use Token2OAuth only with accounts and credentials you are authorized to use, and in accordance with the upstream service's terms and limits.

## Architecture

~~~text
                              OAuth authorization code + PKCE
┌─────────────┐             ┌──────────────────────────────┐
│ ChatGPT Web │────────────▶│         Token2OAuth          │
│             │◀────────────│  OAuth AS + MCP resource     │
└─────────────┘             │                              │
                            │  adaptive credential pool    │
                            │  A  healthy                  │
                            │  B  cooldown (429)           │
                            │  C  healthy                  │
                            │  D  exhausted                │
                            │  E  healthy                  │
                            └──────────────┬───────────────┘
                                           │ Bearer upstream-token
                                           ▼
                                ┌──────────────────────┐
                                │ Upstream MCP server  │
                                └──────────────────────┘
~~~

### Highlights

- **One ChatGPT connection, many upstream credentials**
- OAuth authorization code flow with **PKCE S256**
- Protected-resource and authorization-server metadata
- Dynamic Client Registration (DCR)
- Resource-bound short-lived gateway access tokens
- Rotating refresh tokens
- AES-256-GCM encryption for upstream bearer credentials at rest
- No upstream bearer token is returned to ChatGPT or rendered back into the admin UI
- Streamable HTTP/SSE-friendly MCP proxy
- MCP session affinity using <code>Mcp-Session-Id</code>
- Smart 401 / 402 / 429 / 5xx handling and <code>Retry-After</code> support
- Configurable quota/error body matching and cooldown recovery
- Six pool strategies
- Polished browser admin console
- Headless CLI
- Idempotent installer
- Tailscale detection and optional automatic installation
- Tailscale path mounting **without resetting existing routes**
- systemd user service, Docker, tests, and GitHub Actions

## Quick install

~~~bash
curl -fsSL https://raw.githubusercontent.com/p5n-n3t/token2oauth/main/install.sh | bash
~~~

The installer detects an existing Tailscale installation. If Tailscale is missing, it can install the official client. It does **not** reset existing Serve/Funnel routes.

| Item | Default |
|---|---|
| Local listen | <code>127.0.0.1:2030</code> |
| Public path | <code>/token2oauth</code> |
| Exposure | Tailscale Funnel |
| State | <code>~/.config/token2oauth</code> |
| Program | <code>~/.local/share/token2oauth</code> |
| CLI | <code>~/.local/bin/token2oauth</code> |

An existing root service can coexist with Token2OAuth:

~~~text
https://my-host.my-tailnet.ts.net/
├── /             → existing service
└── /token2oauth  → Token2OAuth :2030
~~~

Tailscale supports path-specific mounts with <code>--set-path</code>, so Token2OAuth does not have to replace the root Funnel.

### Installer switches

~~~text
--prefix PATH
--port N
--path PATH
--mode funnel|serve|none
--public-base-url URL
--upstream-url URL
--branch NAME
--repo URL
--no-tailscale
--no-service
--force-root
--yes
--dry-run
~~~

Examples:

~~~bash
./install.sh --port 2030 --path /token2oauth

./install.sh --mode serve --path /token2oauth

./install.sh --mode none \
  --public-base-url https://mcp.example.com/token2oauth

./install.sh \
  --upstream-url https://provider.example.com/mcp
~~~

## First run

### 1. Open the admin console

The installer prints the Gateway, MCP, and Admin URLs. On first initialization it also generates an admin password. Only its scrypt hash is persisted.

### 2. Configure the real upstream MCP URL

Use the web Admin console, or:

~~~bash
token2oauth config set upstreamUrl https://provider.example.com/mcp
~~~

### 3. Add your authorized provider accounts

~~~bash
token2oauth account add --label "Pro account 1"
token2oauth account add --label "Pro account 2" --weight 1.5
token2oauth account add --label "Pro account 3" --priority 50
~~~

The interactive CLI disables terminal echo while the token is entered.

For automation:

~~~bash
printf '%s' "$PROVIDER_TOKEN" |
  token2oauth account add --label "CI account" --token-stdin

token2oauth account add \
  --label "Environment account" \
  --token-env PROVIDER_TOKEN
~~~

### 4. Add one URL to ChatGPT

Add only:

~~~text
https://your-node.your-tailnet.ts.net/token2oauth/mcp
~~~

Token2OAuth advertises OAuth metadata. ChatGPT performs OAuth with Token2OAuth; upstream bearer tokens stay on your host.

See [ChatGPT OAuth](docs/CHATGPT-OAUTH.md).

## Smart pooling

The default strategy is **adaptive-sticky**.

For a new MCP session, Token2OAuth favors an enabled credential with low normalized usage, low error rate, no cooldown, and low current concurrency. Once the upstream establishes an MCP session, Token2OAuth pins that session to the same upstream credential.

This distributes load **without randomly switching accounts in the middle of a stateful MCP session**.

| Signal | Default action |
|---|---|
| 2xx | mark healthy and clear failure streak |
| 401 | mark credential auth-failed |
| 402 | mark exhausted and cool down |
| 429 | honor Retry-After, cool down, choose another |
| quota/credit exhaustion text | cool down even if provider uses another status |
| 5xx, timeout, network failure | short cooldown and failover |
| request already has Mcp-Session-Id | no cross-account failover by default |

There is intentionally no fake "remaining credits" counter. If a provider publishes a real usage endpoint, a provider adapter can add proactive checks. Otherwise provider responses are more reliable than guessing.

See [Pooling and failover](docs/POOLING.md).

## Pool strategies

~~~bash
token2oauth pool strategy adaptive-sticky
token2oauth pool strategy round-robin
token2oauth pool strategy least-used
token2oauth pool strategy weighted-random
token2oauth pool strategy random
token2oauth pool strategy priority
~~~

- **adaptive-sticky** — recommended; affinity + usage/error/concurrency score
- **round-robin** — deterministic rotation among eligible accounts
- **least-used** — request count normalized by weight
- **weighted-random** — probabilistic distribution using account weights
- **random** — uniform random eligible credential
- **priority** — lowest numeric priority first

## CLI

~~~text
token2oauth init
token2oauth serve

token2oauth account add
token2oauth account list
token2oauth account enable ID
token2oauth account disable ID
token2oauth account remove ID
token2oauth account reset-health [ID]

token2oauth pool status
token2oauth pool strategy STRATEGY

token2oauth config list
token2oauth config get KEY
token2oauth config set KEY VALUE

token2oauth oauth clients
token2oauth oauth revoke-client CLIENT_ID

token2oauth admin reset-password

token2oauth tailscale status
token2oauth tailscale expose --mode funnel --path /token2oauth --port 2030

token2oauth doctor
~~~

Every command supports <code>--help</code> through Commander.

## LightSprint

Token2OAuth is provider-agnostic. For LightSprint or another service, configure the **actual remote MCP endpoint that accepts the account's bearer credential**, then add each authorized account token to the pool.

Example labels:

~~~text
LightSprint Pro #1
LightSprint Pro #2
LightSprint Pro #3
LightSprint Pro #4
LightSprint Pro #5
~~~

The public LightSprint CLI/plugin demonstrates Bearer-token API calls, token refresh and explicit handling of HTTP 429. Token2OAuth therefore treats 429/Retry-After as a strong cooldown signal by default, while also supporting configurable credit/quota patterns. It does not assume an undocumented balance endpoint.

## Tailscale

Token2OAuth never calls <code>tailscale funnel reset</code> or <code>tailscale serve reset</code>.

The generated route is equivalent to:

~~~bash
tailscale funnel --bg \
  --https=443 \
  --set-path=/token2oauth \
  http://127.0.0.1:2030
~~~

See [Tailscale deployment](docs/TAILSCALE.md).

## Docker

Tailscale normally stays on the host:

~~~bash
docker compose up -d --build
tailscale funnel --bg --https=443 --set-path=/token2oauth http://127.0.0.1:2030
~~~

Persist the data volume. It contains encrypted account envelopes, OAuth client state, and the local master key.

## Security

Upstream tokens are encrypted with AES-256-GCM using a random 256-bit key stored separately in <code>~/.config/token2oauth/master.key</code>. The admin UI never reveals a stored bearer token. Gateway OAuth access tokens are short-lived and audience-bound; refresh tokens are stored as hashes and rotated.

Read [SECURITY.md](SECURITY.md) before putting the gateway on a public hostname.

## Development

~~~bash
git clone https://github.com/p5n-n3t/token2oauth.git
cd token2oauth
npm install
npm test
npm run dev
~~~

The test suite includes RFC 7636 PKCE verification, encryption round-trip, failure classification, a full DCR/authorization/token flow, live 429→healthy credential failover, and refresh-token rotation.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [ChatGPT / OpenAI OAuth](docs/CHATGPT-OAUTH.md)
- [Pooling and failover](docs/POOLING.md)
- [Configuration](docs/CONFIGURATION.md)
- [Tailscale deployment](docs/TAILSCALE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT