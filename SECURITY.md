# Security policy

## Reporting

Use a GitHub private security advisory for vulnerabilities that could expose credentials, bypass OAuth authorization, defeat PKCE, cross account boundaries, or enable SSRF.

Do not put live provider credentials, OAuth codes, access tokens, refresh tokens, master keys, or admin passwords in public issues.

## Secret storage

Token2OAuth encrypts upstream credentials with AES-256-GCM. A random 256-bit master seed is generated locally at ~/.config/token2oauth/master.key, and independent encryption/signing subkeys are derived from it with HKDF-SHA256.

Protect the full configuration directory. Anyone able to read both state.json and master.key can decrypt upstream credentials.

## Admin interface

The admin UI requires the gateway admin password and uses an HttpOnly, SameSite=Lax session cookie. For internet-facing deployments, use HTTPS, a strong unique password, a patched host, and optional additional reverse-proxy access policy around /admin.

## OAuth controls

Token2OAuth requires PKCE S256, binds authorization codes to client/redirect/resource, uses short-lived one-time codes, includes issuer identification, validates issuer/audience/expiration/scope, hashes refresh tokens at rest, and rotates refresh tokens.

## Upstream proxy

The downstream OAuth Authorization value is never forwarded upstream. It is replaced with the selected provider credential. Upstream Set-Cookie values are not forwarded to the MCP client.

## Logs

Token2OAuth intentionally does not log raw provider credentials. New adapters must preserve this invariant.