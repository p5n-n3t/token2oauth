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