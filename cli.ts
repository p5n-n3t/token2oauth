#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promisify } from "node:util";
import { Command } from "commander";
import { hashPassword } from "./crypto.js";
import { CredentialPool } from "./pool.js";
import { StateStore, normalizeBasePath } from "./store.js";
import { startServer } from "./server.js";
import type { GatewayConfig, PoolStrategy } from "./types.js";

const execFileAsync = promisify(execFile);
const program = new Command();

program
  .name("token2oauth")
  .description("OAuth 2.1 facade + smart bearer-token pool for remote MCP servers")
  .version("0.1.0");

function store() {
  return new StateStore();
}

async function ensureStore() {
  const s = store();
  const init = await s.init();
  if (init.adminPassword) {
    console.log("Generated admin password: " + init.adminPassword);
    console.log("Save it now; only its password hash is persisted.\n");
  }
  return s;
}

async function promptSecret(prompt = "Bearer token: "): Promise<string> {
  let echoDisabled = false;
  try {
    if (process.stdin.isTTY && process.platform !== "win32") {
      output.write(prompt);
      execFileSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
      echoDisabled = true;
      const rl = createInterface({ input, output, terminal: false });
      const value = await rl.question("");
      rl.close();
      output.write("\n");
      return value.trim();
    }
    const rl = createInterface({ input, output });
    const value = await rl.question(prompt);
    rl.close();
    return value.trim();
  } finally {
    if (echoDisabled) {
      try { execFileSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] }); } catch {}
    }
  }
}

program
  .command("init")
  .description("Initialize encrypted state and gateway settings")
  .option("--admin-password <password>", "set an initial admin password")
  .option("--public-base-url <url>", "public gateway base URL, including any path prefix")
  .option("--base-path <path>", "path prefix, e.g. /token2oauth")
  .option("--upstream-url <url>", "upstream MCP endpoint")
  .action(async (opts) => {
    const s = store();
    const result = await s.init({
      adminPassword: opts.adminPassword,
      publicBaseUrl: opts.publicBaseUrl,
      basePath: opts.basePath,
      upstreamUrl: opts.upstreamUrl,
    });
    console.log(result.created ? "Initialized Token2OAuth." : "Token2OAuth is already initialized.");
    console.log("State: " + s.statePath);
    if (result.adminPassword) {
      console.log("\nAdmin password: " + result.adminPassword);
      console.log("Save this now; only a password hash is persisted.");
    }
  });

program
  .command("serve")
  .description("Run the Token2OAuth gateway")
  .option("-p, --port <port>", "listen port", (v) => Number(v), Number(process.env.TOKEN2OAUTH_PORT || 2030))
  .option("--host <host>", "listen host", process.env.TOKEN2OAUTH_HOST || "127.0.0.1")
  .option("--public-base-url <url>", "override saved public base URL")
  .option("--base-path <path>", "override saved path prefix")
  .option("--upstream-url <url>", "override saved upstream MCP endpoint")
  .option("--strategy <strategy>", "override pool strategy")
  .action(async (opts) => {
    const s = await ensureStore();
    if (opts.publicBaseUrl || opts.basePath !== undefined || opts.upstreamUrl || opts.strategy) {
      await s.update((state) => {
        if (opts.publicBaseUrl) state.config.publicBaseUrl = String(opts.publicBaseUrl).replace(/\/$/, "");
        if (opts.basePath !== undefined) state.config.basePath = normalizeBasePath(opts.basePath);
        if (opts.upstreamUrl) state.config.upstreamUrl = String(opts.upstreamUrl);
        if (opts.strategy) state.config.strategy = opts.strategy as PoolStrategy;
      });
    }
    await startServer({ host: opts.host, port: opts.port });
  });

const account = program.command("account").description("Manage encrypted upstream credentials");

account
  .command("add")
  .description("Add an upstream bearer token")
  .requiredOption("-l, --label <label>", "friendly account label")
  .option("--provider <provider>", "provider/preset name", "generic-bearer-mcp")
  .option("--token <token>", "token value (prefer --token-stdin or interactive prompt)")
  .option("--token-env <name>", "read token from an environment variable")
  .option("--token-file <path>", "read token from a file")
  .option("--token-stdin", "read the token from stdin")
  .option("--weight <number>", "routing weight", Number, 1)
  .option("--priority <number>", "priority; lower is preferred in priority mode", Number, 100)
  .action(async (opts) => {
    const s = await ensureStore();
    let token = opts.token ? String(opts.token).trim() : "";
    if (!token && opts.tokenEnv) token = String(process.env[opts.tokenEnv] || "").trim();
    if (!token && opts.tokenFile) token = (await readFile(opts.tokenFile, "utf8")).trim();
    if (!token && opts.tokenStdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      token = Buffer.concat(chunks).toString("utf8").trim();
    }
    if (!token) token = await promptSecret();
    if (!token) throw new Error("empty token");
    const added = await s.addAccount({
      label: opts.label,
      token,
      provider: opts.provider,
      weight: opts.weight,
      priority: opts.priority,
    });
    console.log("Added " + added.label + " (" + added.id + ").");
  });

account
  .command("list")
  .alias("ls")
  .description("List accounts and health without revealing secrets")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const s = await ensureStore();
    const state = await s.load();
    const rows = new CredentialPool(s).snapshot(state);
    if (opts.json) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) return console.log("No accounts configured.");
    console.table(rows.map((r) => ({
      id: r.id,
      label: r.label,
      enabled: r.enabled,
      state: r.state,
      requests: r.requests,
      success: r.successes,
      failures: r.failures,
      lastHTTP: r.lastStatus || "",
    })));
  });

for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
  account
    .command(name + " <id>")
    .description(name + " an account")
    .action(async (id) => {
      const s = await ensureStore();
      await s.setAccountEnabled(id, enabled);
      console.log(name + "d " + id);
    });
}

account
  .command("remove <id>")
  .alias("rm")
  .description("Permanently remove an encrypted credential")
  .action(async (id) => {
    const s = await ensureStore();
    console.log((await s.removeAccount(id)) ? "Removed " + id : "Account not found.");
  });

account
  .command("reset-health [id]")
  .description("Clear cooldown/auth-failure state for one account or all accounts")
  .action(async (id) => {
    const s = await ensureStore();
    await s.resetAccountHealth(id);
    console.log(id ? "Reset " + id : "Reset all account health.");
  });

account
  .command("probe [id]")
  .description("Send an authenticated MCP initialize health probe to one account or all enabled accounts")
  .action(async (id) => {
    const s = await ensureStore();
    const credentialPool = new CredentialPool(s);
    const results = id ? [await credentialPool.probeAccount(id)] : await credentialPool.probeAll();
    console.table(results.map((result) => ({
      id: result.accountId,
      label: result.label,
      ok: result.ok,
      status: result.status || "",
      result: result.error || "healthy",
    })));
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  });

const pool = program.command("pool").description("Inspect or configure pool routing");
pool
  .command("status")
  .option("--json")
  .action(async (opts) => {
    const s = await ensureStore();
    const state = await s.load();
    const snapshot = new CredentialPool(s).snapshot(state);
    if (opts.json) console.log(JSON.stringify({ strategy: state.config.strategy, accounts: snapshot }, null, 2));
    else {
      console.log("Strategy: " + state.config.strategy);
      console.table(snapshot.map((r) => ({ label: r.label, state: r.state, active: r.active, requests: r.requests, failures: r.failures })));
    }
  });
pool
  .command("strategy <strategy>")
  .description("Set adaptive-sticky|round-robin|least-used|weighted-random|random|priority")
  .action(async (strategy) => {
    const allowed = ["adaptive-sticky", "round-robin", "least-used", "weighted-random", "random", "priority"];
    if (!allowed.includes(strategy)) throw new Error("Unknown strategy: " + strategy);
    const s = await ensureStore();
    await s.setConfig("strategy", strategy as PoolStrategy);
    console.log("Pool strategy set to " + strategy);
  });

const config = program.command("config").description("Read or change gateway configuration");
config.command("list").option("--json").action(async (opts) => {
  const s = await ensureStore();
  const cfg = (await s.load()).config;
  if (opts.json) console.log(JSON.stringify(cfg, null, 2));
  else console.table(Object.entries(cfg).map(([key, value]) => ({ key, value: Array.isArray(value) ? value.join(",") : String(value) })));
});
config.command("get <key>").action(async (key: keyof GatewayConfig) => {
  const s = await ensureStore();
  const cfg = (await s.load()).config as any;
  if (!(key in cfg)) throw new Error("Unknown config key: " + key);
  console.log(typeof cfg[key] === "object" ? JSON.stringify(cfg[key], null, 2) : cfg[key]);
});
config.command("set <key> <value>").action(async (key: keyof GatewayConfig, raw: string) => {
  const s = await ensureStore();
  const state = await s.load();
  const cfg: any = state.config;
  if (!(key in cfg)) throw new Error("Unknown config key: " + key);
  const current = cfg[key];
  let value: any = raw;
  if (typeof current === "number") value = Number(raw);
  else if (typeof current === "boolean") value = /^(1|true|yes|on)$/i.test(raw);
  else if (Array.isArray(current)) value = raw.split(",").map((v) => /^\d+$/.test(v.trim()) ? Number(v.trim()) : v.trim());
  if (key === "basePath") value = normalizeBasePath(String(value));
  if (key === "publicBaseUrl") value = String(value).replace(/\/$/, "");
  await s.update((st) => { (st.config as any)[key] = value; });
  console.log(String(key) + " = " + (typeof value === "object" ? JSON.stringify(value) : value));
});

const admin = program.command("admin").description("Gateway administrator operations");
admin.command("reset-password").option("--password <password>").action(async (opts) => {
  const s = await ensureStore();
  const password = opts.password || await promptSecret("New admin password: ");
  if (password.length < 12) throw new Error("Use at least 12 characters.");
  await s.update((state) => { state.admin = hashPassword(password); });
  console.log("Admin password updated.");
});

const oauth = program.command("oauth").description("Inspect registered OAuth clients");
oauth.command("clients").option("--json").action(async (opts) => {
  const s = await ensureStore();
  const clients = (await s.load()).oauthClients;
  if (opts.json) console.log(JSON.stringify(clients, null, 2));
  else console.table(clients.map((c) => ({ clientId: c.clientId, name: c.clientName || "", redirects: c.redirectUris.join(", "), created: new Date(c.createdAt).toISOString() })));
});
oauth.command("revoke-client <clientId>").action(async (clientId) => {
  const s = await ensureStore();
  await s.update((state) => {
    state.oauthClients = state.oauthClients.filter((c) => c.clientId !== clientId);
    state.refreshTokens = state.refreshTokens.filter((r) => r.clientId !== clientId);
  });
  console.log("Revoked OAuth client " + clientId);
});

const tailscale = program.command("tailscale").description("Tailscale Serve/Funnel helpers");
tailscale.command("status").action(async () => {
  try {
    const { stdout } = await execFileAsync("tailscale", ["funnel", "status"]);
    console.log(stdout.trim());
  } catch (error: any) {
    console.error(error?.stderr || error?.message || error);
    process.exitCode = 1;
  }
});
tailscale
  .command("expose")
  .description("Add a Tailscale path route without resetting existing routes")
  .option("--mode <mode>", "funnel or serve", "funnel")
  .option("--path <path>", "public path", "/token2oauth")
  .option("--port <port>", "local Token2OAuth port", Number, 2030)
  .option("--https-port <port>", "Tailscale HTTPS listener", Number, 443)
  .action(async (opts) => {
    if (!["funnel", "serve"].includes(opts.mode)) throw new Error("mode must be funnel or serve");
    const path = normalizeBasePath(opts.path) || "/";
    const args = [opts.mode, "--bg", "--https=" + opts.httpsPort, "--set-path=" + path, "http://127.0.0.1:" + opts.port];
    const { stdout, stderr } = await execFileAsync("tailscale", args);
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
  });

program
  .command("doctor")
  .description("Check state, upstream, Tailscale, and local runtime")
  .option("--json")
  .action(async (opts) => {
    const s = await ensureStore();
    const state = await s.load();
    const checks: any[] = [];
    checks.push({ check: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version });
    checks.push({ check: "state", ok: true, detail: s.statePath });
    checks.push({ check: "upstream", ok: Boolean(state.config.upstreamUrl), detail: state.config.upstreamUrl || "not configured" });
    checks.push({ check: "credentials", ok: state.accounts.some((a) => a.enabled), detail: state.accounts.length + " configured" });
    try {
      const { stdout } = await execFileAsync("tailscale", ["version"]);
      checks.push({ check: "tailscale", ok: true, detail: stdout.split("\n")[0] });
    } catch {
      checks.push({ check: "tailscale", ok: false, detail: "not installed or unavailable" });
    }
    if (opts.json) console.log(JSON.stringify(checks, null, 2));
    else console.table(checks);
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((error) => {
  console.error("token2oauth:", error?.message || error);
  process.exitCode = 1;
});
