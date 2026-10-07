# Admin credential rotation and authorization

`src/admin-security.ts` provides standalone helpers for code that manages admin credentials. They do not write state or change the running server.

## Password rotation

`generateAdminPassword()` returns a 256-bit, URL-safe password. Treat the returned string as a secret and show it only through a deliberate one-time delivery path.

`planAdminCredentialRotation(currentState, newPassword, nowMs?)` returns a narrow `statePatch` plus revocation actions. Applying the patch changes only `state.admin` and empties `state.refreshTokens`; it leaves the master encryption key, encrypted upstream accounts, configuration, and OAuth client registrations intact. The caller must also clear the process-local `AdminSessions` and pending authorization-code store. The planner does not mutate or persist `currentState`.

Access tokens are signed, self-contained `AccessClaims` and are not represented in persisted state. The plan's `minimumAcceptedAccessTokenIat` is the first accepted issue time after rotation. The runtime must persist this cutoff and reject claims for which `iat < minimumAcceptedAccessTokenIat` in `OAuthService.authenticateMcp` to make access-token revocation effective across restarts. That check and persistence are not wired into the current server because this task is limited to new standalone files.

## Consent and token use

The current `/oauth/authorize` POST validates the client and its exact registered redirect URI, then requires either a valid `t2o_admin` session or the admin password before issuing an authorization code. A logged-in admin session is consent authority for that request; it is not an OAuth bearer credential. The `/mcp` route separately requires a valid signed access token with the expected issuer, resource audience, and `mcp` scope.

## Form protections and redirects

`createCsrfToken()` and `verifyCsrfToken(expected, submitted)` support synchronizer-token checks on state-changing admin and consent forms. A caller must store the expected token in the session, include it in the form, and verify it before performing the action. The current UI uses `SameSite=Lax` cookies but has no explicit CSRF token check.

`validateAdminRedirect(next, publicBaseUrl)` returns a safe local path or same-origin absolute URL, or `null` for an invalid value. Use it for the admin login `next` parameter instead of prefix checks: strings such as `//attacker.example` and URLs whose hostname merely starts with the configured hostname must be rejected.

## Integration boundary

This scaffolding intentionally does not alter route handlers, add a state schema field, or perform runtime writes. To integrate rotation, apply the returned state patch under the existing `StateStore.update` lock, add bulk-revoke operations to the currently per-token `AdminSessions` and private authorization-code stores, and persist/check the access-token cutoff. Add CSRF checks before protected POST handlers and use the redirect validator in admin login. OAuth callback redirects already use exact registered-URI matching; preserve that check.
