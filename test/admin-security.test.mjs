import test from "node:test";
import assert from "node:assert/strict";
import { verifyPassword } from "../dist/crypto.js";
import {
  accessTokenSurvivesRotation,
  createCsrfToken,
  generateAdminPassword,
  planAdminCredentialRotation,
  validateAdminRedirect,
  verifyCsrfToken,
} from "../dist/admin-security.js";

const stateFixture = () => ({
  version: 1,
  config: { publicBaseUrl: "https://gateway.example/token2oauth", upstreamUrl: "https://upstream.example/mcp" },
  admin: { salt: "old-salt", hash: "old-hash" },
  accounts: [{ id: "account-1", secret: { v: 1, iv: "iv", tag: "tag", data: "encrypted" } }],
  oauthClients: [{ clientId: "client-1", redirectUris: ["https://client.example/callback"] }],
  refreshTokens: [{ tokenHash: "refresh-hash", clientId: "client-1", resource: "resource", scope: "mcp", expiresAt: 9_999_999 }],
});

test("admin passwords are generated from cryptographic random bytes", () => {
  const first = generateAdminPassword();
  const second = generateAdminPassword();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test("CSRF tokens are URL-safe and verified only on an exact constant-time comparison", () => {
  const token = createCsrfToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyCsrfToken(token, token), true);
  assert.equal(verifyCsrfToken(token, createCsrfToken()), false);
  assert.equal(verifyCsrfToken(token, "malformed"), false);
  const nonCanonical = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.equal(verifyCsrfToken(token, nonCanonical), false);
});

test("rotation plans replace only admin and refresh grants and request all process-local revocations", () => {
  const state = stateFixture();
  const originalAdmin = state.admin;
  const originalAccounts = state.accounts;
  const originalConfig = state.config;
  const originalClients = state.oauthClients;
  const plan = planAdminCredentialRotation(state, "a-new-test-password", 1_700_000_000_250);

  assert.deepEqual(state.admin, originalAdmin);
  assert.equal(state.refreshTokens.length, 1);
  assert.equal(verifyPassword("a-new-test-password", plan.statePatch.admin), true);
  assert.deepEqual(plan.statePatch.refreshTokens, []);
  assert.equal(plan.revokeAdminSessions, true);
  assert.equal(plan.revokeAuthorizationCodes, true);
  assert.equal(plan.minimumAcceptedAccessTokenIat, 1_700_000_001);

  const updated = { ...state, ...plan.statePatch };
  assert.equal(updated.config, originalConfig);
  assert.equal(updated.accounts, originalAccounts);
  assert.equal(updated.oauthClients, originalClients);
});

test("rotation rejects weak passwords and invalid cutoff timestamps", () => {
  const state = stateFixture();
  assert.throws(() => planAdminCredentialRotation(state, "short"), /at least 12 characters/);
  assert.throws(() => planAdminCredentialRotation(state, "a-long-enough-password", Number.NaN), /timestamp/);
});

test("access-token claims issued before the cutoff do not survive rotation", () => {
  assert.equal(accessTokenSurvivesRotation({ iat: 99 }, 100), false);
  assert.equal(accessTokenSurvivesRotation({ iat: 100 }, 100), true);
  assert.equal(accessTokenSurvivesRotation({ iat: 100.5 }, 100), false);
});

test("admin redirects allow local paths and same-origin absolute URLs", () => {
  const base = "https://gateway.example/token2oauth";
  assert.equal(validateAdminRedirect("/admin?ok=1", base), "/admin?ok=1");
  assert.equal(validateAdminRedirect("https://gateway.example/next", base), "https://gateway.example/next");
});

test("admin redirects reject protocol-relative, foreign-origin, malformed, and unsafe values", () => {
  const base = "https://gateway.example/token2oauth";
  for (const value of ["//attacker.example/path", "https://gateway.example.attacker.example/", "https://attacker.example/", "https://user@gateway.example/", "javascript:alert(1)", "/\\attacker.example", "/bad\npath"]) {
    assert.equal(validateAdminRedirect(value, base), null, `expected rejection for unsafe redirect`);
  }
});
