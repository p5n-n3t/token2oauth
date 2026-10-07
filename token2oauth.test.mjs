import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encryptSecret,
  decryptSecret,
  pkceS256,
} from "../dist/crypto.js";
import { StateStore } from "../dist/store.js";
import { CredentialPool } from "../dist/pool.js";
import { buildApp } from "../dist/server.js";

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });

const close = (server) => new Promise((resolve) => server.close(resolve));

test("PKCE S256 matches RFC 7636 example", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(
    pkceS256(verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("credential encryption round-trips with AES-256-GCM", () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptSecret("super-secret-bearer", key);
  assert.notEqual(encrypted.data, "super-secret-bearer");
  assert.equal(decryptSecret(encrypted, key), "super-secret-bearer");
});

test("pool classifies auth, quota, and transient failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-pool-"));
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  const store = new StateStore();
  await store.init({ adminPassword: "long-test-password" });
  const pool = new CredentialPool(store);
  const cfg = (await store.load()).config;

  assert.equal(pool.classifyFailure({ status: 401 }, cfg).state, "auth-failed");
  assert.equal(pool.classifyFailure({ status: 429, retryAfter: "2" }, cfg).state, "cooldown");
  assert.equal(
    pool.classifyFailure({ status: 403, body: "AI credits exhausted" }, cfg).retryable,
    true,
  );
  await rm(dir, { recursive: true, force: true });
});

test("credential probes authenticate every enabled account without pool selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-probe-"));
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  const upstream = createHttpServer((req, res) => {
    if (req.headers.authorization === "Bearer good-token") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: "token2oauth-health-probe", result: {} }));
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad token" }));
  });
  const address = await listen(upstream);
  const store = new StateStore();
  await store.init({ adminPassword: "long-test-password" });
  await store.update((state) => { state.config.upstreamUrl = `http://127.0.0.1:${address.port}/mcp`; });
  const good = await store.addAccount({ label: "good", token: "good-token" });
  const bad = await store.addAccount({ label: "bad", token: "bad-token" });
  const pool = new CredentialPool(store);
  const results = await pool.probeAll();
  assert.deepEqual(results.map((result) => [result.accountId, result.ok, result.status]), [
    [good.id, true, 200],
    [bad.id, false, 401],
  ]);
  const checked = new Map(pool.snapshot(await store.load()).map((row) => [row.id, row]));
  assert.equal(checked.get(good.id).state, "healthy");
  assert.equal(checked.get(good.id).lastProbeOk, true);
  assert.equal(checked.get(bad.id).state, "auth-failed");
  assert.equal(checked.get(bad.id).lastProbeOk, false);
  await close(upstream);
  await rm(dir, { recursive: true, force: true });
});

test("OAuth PKCE flow issues resource-bound tokens and MCP failover rotates to a healthy credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-integration-"));
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;

  const seen = [];
  const upstream = createHttpServer((req, res) => {
    const auth = req.headers.authorization || "";
    seen.push({ auth, session: req.headers["mcp-session-id"] || null });
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (auth === "Bearer token-A") {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "1",
        });
        return res.end(JSON.stringify({ error: "rate limit reached" }));
      }
      if (auth === "Bearer token-B") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "session-B",
        });
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          }),
        );
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad token" }));
    });
  });
  const upAddr = await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upAddr.port}/mcp`;

  const store = new StateStore();
  await store.init({ adminPassword: "correct-horse-battery-staple" });
  const { app } = await buildApp(store);
  const gateway = createHttpServer(app);
  const gwAddr = await listen(gateway);
  const base = `http://127.0.0.1:${gwAddr.port}`;
  await store.update((state) => {
    state.config.publicBaseUrl = base;
    state.config.basePath = "";
    state.config.upstreamUrl = upstreamUrl;
    state.config.strategy = "priority";
    state.config.maxFailoverAttempts = 3;
  });

  const a = await store.addAccount({ label: "A", token: "token-A", priority: 1 });
  const b = await store.addAccount({ label: "B", token: "token-B", priority: 2 });
  await store.update((state) => {
    state.accounts.find((x) => x.id === a.id).priority = 1;
    state.accounts.find((x) => x.id === b.id).priority = 2;
  });

  const registration = await fetch(base + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Integration Test",
      redirect_uris: [base + "/callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();

  const verifier = "a".repeat(64);
  const challenge = pkceS256(verifier);
  const resource = base + "/mcp";
  const authForm = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: base + "/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource,
    scope: "mcp",
    admin_password: "correct-horse-battery-staple",
  });
  const authorized = await fetch(base + "/oauth/authorize", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authForm,
  });
  assert.equal(authorized.status, 302);
  const redirect = new URL(authorized.headers.get("location"));
  assert.equal(redirect.searchParams.get("state"), "state-123");
  assert.equal(redirect.searchParams.get("iss"), base);
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(base + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: base + "/callback",
      code,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  const mcp = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer " + tokens.access_token,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(mcp.status, 200);
  assert.equal(mcp.headers.get("mcp-session-id"), "session-B");
  const payload = await mcp.json();
  assert.equal(payload.result.protocolVersion, "2025-06-18");
  assert.deepEqual(seen.slice(0, 2).map((x) => x.auth), ["Bearer token-A", "Bearer token-B"]);

  const stateAfter = await store.load();
  const aa = stateAfter.accounts.find((x) => x.id === a.id);
  const bb = stateAfter.accounts.find((x) => x.id === b.id);
  assert.equal(aa.stats.state, "cooldown");
  assert.equal(bb.stats.state, "healthy");

  const refresh = await fetch(base + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource,
    }),
  });
  assert.equal(refresh.status, 200);
  const refreshed = await refresh.json();
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);

  await close(gateway);
  await close(upstream);
  await rm(dir, { recursive: true, force: true });
});
