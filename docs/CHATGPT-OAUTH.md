# ChatGPT / OpenAI OAuth setup

Token2OAuth implements the authenticated remote-MCP flow expected by current OpenAI clients.

OpenAI's authentication documentation requires protected-resource metadata, authorization-server metadata, authorization code, PKCE S256, and preservation of the OAuth resource parameter.

Reference: https://developers.openai.com/plugins/build/auth

## Flow

1. Add the Token2OAuth MCP URL to ChatGPT.
2. An unauthenticated request receives 401 with a WWW-Authenticate challenge pointing to protected-resource metadata.
3. ChatGPT discovers Token2OAuth as the authorization server.
4. ChatGPT performs Dynamic Client Registration at /oauth/register.
5. ChatGPT opens /oauth/authorize with a PKCE S256 challenge and the MCP resource.
6. The operator authorizes using the Token2OAuth admin password or an existing admin session.
7. Token2OAuth creates a short-lived one-time code bound to the client, redirect URI, PKCE challenge, resource, and MCP scope.
8. ChatGPT exchanges that code at /oauth/token with the PKCE verifier.
9. Token2OAuth issues a short-lived gateway access token and rotating refresh token.
10. ChatGPT sends the gateway token to /mcp.
11. Token2OAuth validates issuer, audience, expiration, and scope, chooses an upstream credential, and forwards the request.

## Why this is not token passthrough

The upstream provider credential never becomes the OAuth credential held by ChatGPT. One ChatGPT connection can therefore use a managed pool of upstream accounts while the OAuth trust boundary remains stable.

## DCR vs CIMD

Token2OAuth currently implements DCR because it is broadly interoperable and directly supported by the OpenAI MCP flow.

OpenAI also supports Client ID Metadata Documents. CIMD can be added later without changing the upstream pool. Token2OAuth intentionally does not fetch arbitrary client-ID URLs today, avoiding an unnecessary SSRF and trust surface.

## Issuer identification

Token2OAuth advertises authorization response issuer support and returns the iss parameter in authorization responses.

## Troubleshooting

~~~bash
token2oauth doctor
token2oauth oauth clients
curl -i https://host.example/token2oauth/.well-known/oauth-protected-resource
curl -i https://host.example/token2oauth/.well-known/oauth-authorization-server
~~~

If ChatGPT repeatedly requests authorization, verify publicBaseUrl exactly matches the public path used by the MCP connection.
