import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import { verifyPassword } from "./crypto.js";
import { AdminSessions, parseCookies } from "./admin-session.js";
import { CredentialPool } from "./pool.js";
import { StateStore } from "./store.js";
import type { PoolStrategy } from "./types.js";
import { strategyHelp, parameterHelp } from "./dashboard-help.js";

const strategies: PoolStrategy[] = [
  "adaptive-sticky",
  "round-robin",
  "least-used",
  "weighted-random",
  "random",
  "priority",
];

function e(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const css = String.raw`
:root{color-scheme:dark;--bg:#080a0f;--panel:#11151e;--line:#ffffff16;--muted:#97a3b8;--text:#f7f9fc;--cyan:#51d3ef;--purple:#7a64ff;--green:#44dc93;--yellow:#f5c451;--red:#ff6b7d;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 9% 0,#15385e 0,transparent 28%),radial-gradient(circle at 90% 20%,#34215d 0,transparent 27%),var(--bg);color:var(--text);min-height:100vh}
a{color:#a8c5ff;text-decoration:none}.wrap{width:min(1180px,92vw);margin:0 auto;padding:34px 0 70px}.nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:32px}.brand{display:flex;align-items:center;gap:12px}.logo{width:44px;height:44px;border-radius:14px;background:linear-gradient(135deg,var(--cyan),var(--purple));display:grid;place-items:center;font-weight:900;box-shadow:0 13px 40px #625fff4a}.muted{color:var(--muted)}.tiny{font-size:12px}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:11px;color:#8fa6cc;font-weight:750}
.hero{padding:26px 0 14px}.hero h1{font-size:clamp(34px,6vw,68px);letter-spacing:-.055em;line-height:.96;margin:8px 0 18px;max-width:800px}.gradient{background:linear-gradient(100deg,#dff9ff 0,#62d5f2 35%,#9b83ff 76%,#e6d4ff);-webkit-background-clip:text;color:transparent}.lead{font-size:18px;line-height:1.65;color:#b3bed0;max-width:760px}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px;margin-top:24px}.card{grid-column:span 4;background:#10141dcf;border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 20px 70px #0005;backdrop-filter:blur(18px)}.card.wide{grid-column:span 8}.card.full{grid-column:1/-1}.card h2,.card h3{margin:6px 0 12px}.metric{font-size:30px;font-weight:850;letter-spacing:-.04em}.pill{display:inline-flex;gap:7px;align-items:center;padding:6px 9px;border:1px solid var(--line);border-radius:999px;font-size:12px;background:#ffffff08}.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green)}.dot.warn{background:var(--yellow)}.dot.bad{background:var(--red)}
code,.mono{font-family:"SFMono-Regular",Consolas,monospace}.copy{padding:13px;border:1px solid var(--line);background:#080b11;border-radius:12px;word-break:break-all;font-size:12px;color:#c9d3e5}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 9px;border-bottom:1px solid #ffffff0d;font-size:13px}th{color:#8290a6;font-size:11px;text-transform:uppercase;letter-spacing:.08em}tr:last-child td{border:0}
form.inline{display:inline}label{display:block;color:#aeb8ca;font-size:12px;margin:12px 0 6px}input,select{width:100%;padding:11px 12px;border-radius:11px;background:#090c12;border:1px solid #ffffff18;color:#f7f8fb;outline:none}input:focus,select:focus{border-color:#708bff;box-shadow:0 0 0 3px #708bff22}.row{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
button,.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:11px;padding:10px 13px;font-weight:750;color:white;background:linear-gradient(135deg,#41cbea,#6d5df5);cursor:pointer}.btn.secondary,button.secondary{background:#ffffff0b;border:1px solid #ffffff18}.danger{background:#ff556a1c!important;border:1px solid #ff667735!important;color:#ff9aa7!important}.actions{display:flex;gap:7px;flex-wrap:wrap}.flash{padding:12px 14px;border:1px solid #52d89f3c;background:#3cd88a13;border-radius:12px;color:#9cf0c4;margin:0 0 16px}
.footer{margin-top:34px;color:#68758c;font-size:12px;text-align:center}.login{min-height:100vh;display:grid;place-items:center}.login .card{width:min(440px,92vw);grid-column:auto}
@media(max-width:850px){.card,.card.wide{grid-column:1/-1}.row{grid-template-columns:1fr}.nav{align-items:flex-start}.hide-sm{display:none}}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080a0f"><title>${e(title)} · Token2OAuth</title><style>${css}</style></head><body>${body}</body></html>`;
}

export class AdminUi {
  readonly router: Router = express.Router();

  constructor(
    private readonly store: StateStore,
    private readonly pool: CredentialPool,
    private readonly sessions: AdminSessions,
  ) {
    this.router.get("/", this.home);
    this.router.get("/healthz", this.health);
    this.router.get("/admin/login", this.loginGet);
    this.router.post("/admin/login", express.urlencoded({ extended: false }), this.loginPost);
    this.router.post("/admin/logout", this.requireAdmin, this.logout);
    this.router.get("/admin", this.requireAdmin, this.admin);
    this.router.post("/admin/accounts", this.requireAdmin, express.urlencoded({ extended: false }), this.addAccount);
    this.router.post("/admin/accounts/:id/toggle", this.requireAdmin, express.urlencoded({ extended: false }), this.toggleAccount);
    this.router.post("/admin/accounts/:id/reset", this.requireAdmin, this.resetAccount);
    this.router.post("/admin/accounts/:id/probe", this.requireAdmin, this.probeAccount);
    this.router.post("/admin/accounts/probe-all", this.requireAdmin, this.probeAll);
    this.router.post("/admin/accounts/:id/remove", this.requireAdmin, this.removeAccount);
    this.router.post("/admin/config", this.requireAdmin, express.urlencoded({ extended: false }), this.saveConfig);
  }

  private base = async () => (await this.store.load()).config.publicBaseUrl.replace(/\/$/, "");

  private requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie)["t2o_admin"];
    if (!this.sessions.valid(token)) {
      const state = await this.store.load();
      const base = state.config.publicBaseUrl.replace(/\/$/, "");
      return res.redirect(302, base + "/admin/login?next=" + encodeURIComponent(base + "/admin"));
    }
    next();
  };

  private home = async (_req: Request, res: Response) => {
    const state = await this.store.load();
    const base = state.config.publicBaseUrl.replace(/\/$/, "");
    const snapshot = this.pool.snapshot(state);
    const ready = snapshot.filter((a) => ["healthy", "ready", "unknown"].includes(String(a.state)) && a.enabled).length;
    res.type("html").send(page("Gateway", `<main class="wrap">
<div class="nav"><div class="brand"><div class="logo">T2</div><div><strong>Token2OAuth</strong><div class="eyebrow">Bearer → OAuth 2.1</div></div></div><a class="btn secondary" href="${e(base)}/admin">Admin console</a></div>
<section class="hero"><div class="eyebrow">MCP credential gateway</div><h1>One OAuth connection.<br><span class="gradient">Many upstream tokens.</span></h1><p class="lead">A self-hosted OAuth facade for bearer-token MCP servers, with encrypted credentials, sticky sessions, adaptive pooling, quota-aware cooldowns and optional Tailscale Funnel exposure.</p></section>
<section class="grid">
<div class="card"><div class="eyebrow">Gateway</div><div class="metric"><span class="dot"></span> Online</div><p class="muted tiny">OAuth metadata and MCP proxy are available.</p></div>
<div class="card"><div class="eyebrow">Credential pool</div><div class="metric">${ready}<span class="muted"> / ${snapshot.length}</span></div><p class="muted tiny">currently selectable accounts</p></div>
<div class="card"><div class="eyebrow">Strategy</div><div class="metric" style="font-size:21px">${e(state.config.strategy)}</div><p class="muted tiny">session-aware selection policy</p></div>
<div class="card wide"><div class="eyebrow">ChatGPT / MCP URL</div><h3>Protected MCP endpoint</h3><div class="copy">${e(base)}/mcp</div></div>
<div class="card"><div class="eyebrow">Discovery</div><h3>OAuth 2.1</h3><p class="muted tiny">Authorization code + PKCE S256, DCR, refresh rotation, resource-bound access tokens.</p></div>
</section><div class="footer">Token2OAuth · secrets stay encrypted on this host</div></main>`));
  };

  private health = async (_req: Request, res: Response) => {
    const state = await this.store.load();
    const snapshot = this.pool.snapshot(state);
    res.json({
      ok: true,
      version: 1,
      upstreamConfigured: Boolean(state.config.upstreamUrl),
      strategy: state.config.strategy,
      accounts: snapshot.length,
      selectable: snapshot.filter((a) => a.enabled && !["cooldown", "exhausted", "auth-failed", "disabled"].includes(String(a.state))).length,
    });
  };

  private loginGet = async (req: Request, res: Response) => {
    const base = await this.base();
    res.type("html").send(page("Admin login", `<main class="login"><section class="card"><div class="brand"><div class="logo">T2</div><div><strong>Token2OAuth</strong><div class="eyebrow">Admin console</div></div></div>
<h2>Unlock your gateway</h2><p class="muted">Manage upstream MCP endpoints, encrypted bearer credentials, routing and pool health.</p>
<form method="post" action="${e(base)}/admin/login"><input type="hidden" name="next" value="${e(String(req.query.next || base + "/admin"))}"><label>Admin password</label><input type="password" name="password" required autofocus autocomplete="current-password"><button type="submit">Sign in →</button></form></section></main>`));
  };

  private loginPost = async (req: Request, res: Response) => {
    const state = await this.store.load();
    if (!verifyPassword(String(req.body.password || ""), state.admin)) {
      return res.status(401).type("html").send(page("Login failed", '<main class="login"><section class="card"><h2>Incorrect password</h2><p class="muted">The gateway admin password did not match.</p><a class="btn" href="./login">Try again</a></section></main>'));
    }
    const token = this.sessions.create();
    const secure = state.config.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
    res.setHeader("Set-Cookie", "t2o_admin=" + encodeURIComponent(token) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200" + secure);
    const next = String(req.body.next || state.config.publicBaseUrl + "/admin");
    res.redirect(302, next.startsWith("/") || next.startsWith(state.config.publicBaseUrl) ? next : state.config.publicBaseUrl + "/admin");
  };

  private logout = async (req: Request, res: Response) => {
    const state = await this.store.load();
    this.sessions.revoke(parseCookies(req.headers.cookie)["t2o_admin"]);
    res.setHeader("Set-Cookie", "t2o_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    res.redirect(302, state.config.publicBaseUrl + "/");
  };

  private admin = async (req: Request, res: Response) => {
    const state = await this.store.load();
    const base = state.config.publicBaseUrl.replace(/\/$/, "");
    const accounts = this.pool.snapshot(state);
    const notice = typeof req.query.notice === "string" ? req.query.notice : req.query.ok ? "Saved successfully." : "";
    const message = notice ? '<div class="flash">' + e(notice) + "</div>" : "";
    const rows = accounts.map((a) => {
      const dot = ["healthy", "ready", "unknown"].includes(String(a.state)) ? "" : a.state === "cooldown" ? "warn" : "bad";
      const probe = a.lastProbeAt
        ? (a.lastProbeOk ? "OK " + e(a.lastProbeStatus || "") : "Failed " + e(a.lastProbeStatus || a.lastProbeError || ""))
        : "Not tested";
      return `<tr><td><strong>${e(a.label)}</strong><div class="tiny muted mono">${e(a.id)}</div></td><td><span class="pill"><span class="dot ${dot}"></span>${e(a.state)}</span></td><td>${a.successes}/${a.requests}</td><td>${e(a.lastStatus || "—")}</td><td>${probe}</td><td><div class="actions"><form class="inline" method="post" action="${e(base)}/admin/accounts/${e(a.id)}/probe"><button class="secondary" type="submit">Test credential</button></form><form class="inline" method="post" action="${e(base)}/admin/accounts/${e(a.id)}/toggle"><input type="hidden" name="enabled" value="${a.enabled ? "0" : "1"}"><button class="secondary" type="submit">${a.enabled ? "Disable" : "Enable"}</button></form><form class="inline" method="post" action="${e(base)}/admin/accounts/${e(a.id)}/reset"><button class="secondary" type="submit">Reset health</button></form><form class="inline" method="post" action="${e(base)}/admin/accounts/${e(a.id)}/remove" onsubmit="return confirm('Remove this credential?')"><button class="danger" type="submit">Remove</button></form></div></td></tr>`;
    }).join("");

    const strategyOptions = strategies.map((s) => '<option value="' + e(s) + '"' + (state.config.strategy === s ? " selected" : "") + ">" + e(s) + "</option>").join("");

    res.type("html").send(page("Admin", `<main class="wrap"><div class="nav"><div class="brand"><div class="logo">T2</div><div><strong>Token2OAuth</strong><div class="eyebrow">Control plane</div></div></div><div class="actions"><a class="btn secondary" href="${e(base)}/">Gateway</a><form class="inline" method="post" action="${e(base)}/admin/logout"><button class="secondary">Sign out</button></form></div></div>
${message}<section class="grid">
<div class="card full"><div class="eyebrow">Connection</div><h2>ChatGPT MCP endpoint</h2><div class="copy">${e(base)}/mcp</div><p class="muted tiny">Add this single URL to ChatGPT. Token2OAuth handles OAuth; you do not create one MCP connection per upstream account.</p></div>
<div class="card wide"><div class="eyebrow">Upstream</div><h2>MCP target & routing</h2><form method="post" action="${e(base)}/admin/config"><label>Upstream MCP URL</label><input name="upstreamUrl" value="${e(state.config.upstreamUrl)}" placeholder="https://provider.example.com/mcp" required><div class="row"><div><label>Pool strategy</label><select id="pool-strategy" name="strategy" aria-describedby="strategy-definition strategy-example">${strategyOptions}</select></div><div><label for="maxFailoverAttempts">Max failover attempts <span title="${e(parameterHelp.maxFailoverAttempts)}" tabindex="0" aria-label="Help for Max failover attempts">ⓘ</span></label><input type="number" min="1" max="20" id="maxFailoverAttempts" title="${e(parameterHelp.maxFailoverAttempts)}" aria-describedby="maxFailoverAttempts-help" name="maxFailoverAttempts" value="${e(state.config.maxFailoverAttempts)}"><details class="tiny muted"><summary>What does this control?</summary><p id="maxFailoverAttempts-help">${e(parameterHelp.maxFailoverAttempts)}</p></details></div></div><div class="row"><div><label for="quotaCooldownSeconds">Quota cooldown (seconds) <span title="${e(parameterHelp.quotaCooldownSeconds)}" tabindex="0" aria-label="Help for Quota cooldown (seconds)">ⓘ</span></label><input type="number" min="1" id="quotaCooldownSeconds" title="${e(parameterHelp.quotaCooldownSeconds)}" aria-describedby="quotaCooldownSeconds-help" name="quotaCooldownSeconds" value="${e(state.config.quotaCooldownSeconds)}"><details class="tiny muted"><summary>What does this control?</summary><p id="quotaCooldownSeconds-help">${e(parameterHelp.quotaCooldownSeconds)}</p></details></div><div><label for="requestTimeoutMs">Request timeout (ms) <span title="${e(parameterHelp.requestTimeoutMs)}" tabindex="0" aria-label="Help for Request timeout (ms)">ⓘ</span></label><input type="number" min="1000" id="requestTimeoutMs" title="${e(parameterHelp.requestTimeoutMs)}" aria-describedby="requestTimeoutMs-help" name="requestTimeoutMs" value="${e(state.config.requestTimeoutMs)}"><details class="tiny muted"><summary>What does this control?</summary><p id="requestTimeoutMs-help">${e(parameterHelp.requestTimeoutMs)}</p></details></div></div><button type="submit">Save gateway settings</button></form></div>
<div class="card" aria-live="polite"><div class="eyebrow">Selected strategy</div><h3 id="strategy-title">${e(strategyHelp[state.config.strategy].title)}</h3><p class="muted tiny" id="strategy-definition">${e(strategyHelp[state.config.strategy].definition)}</p><strong class="tiny">Example use case</strong><p class="muted tiny" id="strategy-example">${e(strategyHelp[state.config.strategy].example)}</p><p class="muted tiny">For stateful MCP servers, use adaptive sticky. Cross-account task and job ownership needs provider-specific routing.</p></div>
<div class="card full"><div class="eyebrow">Credential pool</div><h2>Upstream accounts</h2><p class="muted tiny">New tokens are <code>unknown</code> until used. Test credentials sends one authenticated MCP <code>initialize</code> request to each selected account; it does not create a ChatGPT OAuth connection or reveal a token.</p>${rows ? `<div class="actions" style="margin:12px 0"><form class="inline" method="post" action="${e(base)}/admin/accounts/probe-all"><button type="submit">Test all enabled credentials</button></form></div><div style="overflow:auto"><table><thead><tr><th>Account</th><th>State</th><th>Success</th><th>Last HTTP</th><th>Probe</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No bearer credentials have been added yet.</p>'}</div>
<div class="card full"><div class="eyebrow">Add credential</div><h2>Add an upstream bearer token</h2><p class="muted tiny">The token is AES-256-GCM encrypted before it is written to disk. It is never rendered back into this page.</p><form method="post" action="${e(base)}/admin/accounts"><div class="row"><div><label>Label</label><input name="label" placeholder="LightSprint Pro #1" required></div><div><label>Provider / preset</label><input name="provider" value="generic-bearer-mcp"></div></div><label>Bearer token</label><input type="password" name="token" autocomplete="off" required><div class="row"><div><label>Weight</label><input type="number" step="0.1" min="0.1" name="weight" value="1"></div><div><label>Priority (lower first)</label><input type="number" name="priority" value="100"></div></div><button type="submit">Encrypt & add credential</button></form></div>
</section><script>
const help = ${JSON.stringify(strategyHelp).replaceAll("<", "\\u003c")};
const strategySelect = document.getElementById("pool-strategy");
strategySelect.addEventListener("change", () => {
  const selected = help[strategySelect.value];
  if (!selected) return;
  document.getElementById("strategy-title").textContent = selected.title;
  document.getElementById("strategy-definition").textContent = selected.definition;
  document.getElementById("strategy-example").textContent = selected.example;
});
</script><div class="footer">Secrets: ${e(this.store.dir)} · Public base: ${e(base)}</div></main>`));
  };

  private addAccount = async (req: Request, res: Response) => {
    const token = String(req.body.token || "").trim();
    if (!token) return res.status(400).send("token required");
    const base = await this.base();
    await this.store.addAccount({
      label: String(req.body.label || "Account").slice(0, 120),
      token,
      provider: String(req.body.provider || "generic-bearer-mcp").slice(0, 80),
      weight: Number(req.body.weight || 1),
      priority: Number(req.body.priority || 100),
    });
    res.redirect(303, base + "/admin?ok=1");
  };

  private toggleAccount = async (req: Request, res: Response) => {
    const base = await this.base();
    await this.store.setAccountEnabled(String(req.params.id), String(req.body.enabled) === "1");
    res.redirect(303, base + "/admin?ok=1");
  };

  private resetAccount = async (req: Request, res: Response) => {
    const base = await this.base();
    await this.store.resetAccountHealth(String(req.params.id));
    res.redirect(303, base + "/admin?ok=1");
  };

  private probeAccount = async (req: Request, res: Response) => {
    const base = await this.base();
    const result = await this.pool.probeAccount(String(req.params.id));
    const notice = result.ok
      ? result.label + " passed authenticated MCP probe (HTTP " + result.status + ")."
      : result.label + " probe failed: " + (result.error || "unknown error") + ".";
    res.redirect(303, base + "/admin?notice=" + encodeURIComponent(notice));
  };

  private probeAll = async (_req: Request, res: Response) => {
    const base = await this.base();
    const results = await this.pool.probeAll();
    const passed = results.filter((result) => result.ok).length;
    res.redirect(303, base + "/admin?notice=" + encodeURIComponent("Tested " + results.length + " enabled credentials: " + passed + " passed, " + (results.length - passed) + " failed."));
  };

  private removeAccount = async (req: Request, res: Response) => {
    const base = await this.base();
    await this.store.removeAccount(String(req.params.id));
    res.redirect(303, base + "/admin?ok=1");
  };

  private saveConfig = async (req: Request, res: Response) => {
    const base = await this.base();
    const strategy = strategies.includes(req.body.strategy as PoolStrategy)
      ? (req.body.strategy as PoolStrategy)
      : "adaptive-sticky";
    await this.store.update((state) => {
      state.config.upstreamUrl = String(req.body.upstreamUrl || "").trim();
      state.config.strategy = strategy;
      state.config.maxFailoverAttempts = Math.max(1, Math.min(20, Number(req.body.maxFailoverAttempts || 3)));
      state.config.quotaCooldownSeconds = Math.max(1, Number(req.body.quotaCooldownSeconds || 900));
      state.config.requestTimeoutMs = Math.max(1000, Number(req.body.requestTimeoutMs || 120000));
    });
    res.redirect(303, base + "/admin?ok=1");
  };
}
