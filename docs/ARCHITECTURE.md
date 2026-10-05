# Architecture

Token2OAuth separates two trust domains.

## Client-facing OAuth

ChatGPT or another MCP client treats Token2OAuth as an OAuth-protected MCP resource and OAuth authorization server. The client discovers metadata, registers through DCR, uses authorization code plus PKCE S256, and receives a short-lived Token2OAuth access token.

## Upstream credentials

Provider credentials are encrypted at rest and used only for requests from Token2OAuth to the configured upstream MCP endpoint.

~~~text
Client OAuth credential
       ↓
Token2OAuth
       ↓
Provider credential
~~~

## OAuth routes

~~~text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/oauth/register
/oauth/authorize
/oauth/token
~~~

## MCP proxy

The /mcp route verifies the Token2OAuth access token and proxies to the configured upstream endpoint. The downstream Authorization header is removed and replaced with the selected upstream credential.

MCP headers including Mcp-Session-Id, Mcp-Protocol-Version, Accept, and Last-Event-ID pass through.

## Persistent state

~~~text
~/.config/token2oauth/
├── state.json
└── master.key
~~~

The state file contains encrypted credential envelopes. The master key is generated locally with mode 0600. Writes use atomic rename plus a cross-process lock.

## Path-prefixed deployments

The public base URL can contain a path, for example:

~~~text
https://node.tailnet.ts.net/token2oauth
~~~

The app accepts both prefixed and unprefixed local routes so it works with reverse proxies that preserve or strip the external mount prefix.
