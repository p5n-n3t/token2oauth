import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { normalizeSupervisorSnapshot, renderSupervisorDashboard } from "../dist/supervisor-ui.js";

test("renders nested workforce hierarchy with native keyboard disclosures", () => {
  const html = renderSupervisorDashboard({ providers: [{ id: "p", label: "Provider", status: "healthy", accounts: [{ id: "a", label: "Account", status: "ready", workspaces: [{ id: "w", label: "Workspace", workers: [{ id: "worker-1", status: "working" }] }] }] }] });
  assert.match(html, /<details class="distribution"><summary><span class="provider-title">Provider/);
  assert.match(html, /Workspace Workspace/);
  assert.match(html, /worker-1/);
  assert.match(html, /<nav aria-label="Dashboard sections">/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /<script\b/i);
});

test("capacity bars require a known positive denominator and show exact values", () => {
  const html = renderSupervisorDashboard({ providers: [{ id: "known", label: "Known", status: "ready", capacity: { used: 4, limit: 10, unit: "jobs" }, accounts: [{ id: "unknown", label: "Unknown", status: "ready", quota: { used: 3 } }] }] });
  assert.match(html, /4 \/ 10 jobs/);
  assert.match(html, /aria-valuenow="4"/);
  assert.match(html, /Limit not reported/);
  assert.equal((html.match(/role="meter"/g) || []).length, 1);
});

test("escapes untrusted content and redacts structured and embedded secrets in raw details", () => {
  const html = renderSupervisorDashboard({ state: "error", error: '<img src=x onerror="alert(1)">', events: [{ severity: "error", message: '<svg onload="x"> Bearer abc123.def4567890123456', raw: { api_key: "hidden-key", note: "authorization=Bearer abc123.def4567890123456" } }] });
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;svg onload=&quot;x&quot;&gt;/);
  assert.match(html, /Show sanitized raw event/);
  assert.match(html, /\[REDACTED\]/);
  assert.doesNotMatch(html, /hidden-key|abc123\.def4567890123456|<img src=x|<svg onload=/);
});

test("search, severity and pause filters apply to bounded local event data", () => {
  const snapshot = { events: [
    { id: "a", severity: "warning", message: "quota paused", paused: true },
    { id: "b", severity: "info", message: "worker started", paused: false },
  ] };
  const html = renderSupervisorDashboard(snapshot, { search: "quota", severity: "warning", pause: "paused" });
  assert.match(html, /quota paused/);
  assert.doesNotMatch(html, /worker started/);
  assert.match(html, /name="search" value="quota"/);
});

test("empty/loading/error states are explicit, records are bounded, and no write controls are invented", () => {
  const loading = renderSupervisorDashboard({ state: "loading", jobs: Array.from({ length: 5 }, (_, i) => ({ id: `j${i}`, status: "queued" })) }, { maxItems: 2 });
  assert.match(loading, /Loading operations data/);
  assert.match(loading, /No provider groups are available/);
  assert.equal((loading.match(/<code>j\d<\/code>/g) || []).length, 2);
  assert.doesNotMatch(loading, /Pause all|Resume|Retry job|<form[^>]*method="post"/i);
  const errored = renderSupervisorDashboard({ state: "error" });
  assert.match(errored, /role="alert"/);
});

test("time series use only supplied points and malformed timestamps degrade safely", () => {
  const html = renderSupervisorDashboard({ observedAt: 9e99, series: [{ label: "Queue depth", unit: "jobs", points: [{ value: 2 }, { value: 5 }] }] });
  assert.match(html, /Measured values: 2jobs · 5jobs/);
  assert.match(html, /Time unavailable/);
  assert.doesNotMatch(html, /setInterval|Math\.random|Loading traffic/);
});

test("live polling is nonce-gated and preserves unrelated hierarchy/focus nodes", () => {
  const standalone = renderSupervisorDashboard({});
  assert.doesNotMatch(standalone, /id="live-pause"|<script\b/);
  const html = renderSupervisorDashboard({}, { nonce: "nonce-value", liveFeedUrl: "/admin/api/v1/supervisor/project/live" });
  assert.match(html, /<script nonce="nonce-value">/);
  assert.match(html, /new URL\(root\.dataset\.feedUrl,location\.href\)/);
  assert.match(html, /url\.origin!==location\.origin/);
  assert.match(html, /clearInterval\(timer\)/);
  assert.match(html, /addEventListener\("pagehide"/);
  assert.match(html, /Live updates paused/);
  assert.match(html, /id="live-pause" type="button"/);
  assert.match(html, /document\.activeElement\.closest\("#live-events"\)/);
  assert.match(html, /list\.innerHTML=payload\.eventsHtml/);
  const pollScript = html.match(/<script nonce="nonce-value">([\s\S]*?)<\/script>/)?.[1] || "";
  assert.doesNotMatch(pollScript, /getElementById\("workforce"\)|getElementById\("live-health"\).*innerHTML/);
});

test("live pause stops polling and pagehide clears the interval", async () => {
  const html = renderSupervisorDashboard({}, { nonce: "n", liveFeedUrl: "/admin/api/v1/supervisor/p/live" });
  const script = html.match(/<script nonce="n">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const events = { innerHTML: "initial" };
  const status = { textContent: "" };
  const button = { textContent: "", attributes: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; } };
  const root = { dataset: { feedUrl: "/admin/api/v1/supervisor/p/live" } };
  const nodes = { "live-shell": root, "live-pause": button, "live-status": status, "live-events": events, "event-filter": null };
  const listeners = {};
  let nextTimer = 0;
  const intervals = new Map();
  const cleared = [];
  const health = { textContent: "unknown" };
  const context = {
    URL,
    location: { href: "https://local.test/admin/supervisor/p", origin: "https://local.test" },
    document: { hidden: false, activeElement: null, getElementById: (id) => nodes[id] || null, querySelector: (selector) => selector.includes("supervisor") ? health : null, addEventListener: (name, fn) => { listeners[name] = fn; } },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    fetch: async (url) => ({ ok: true, json: async () => ({ ok: true, eventsHtml: "<p>fresh</p>", supervisor: "healthy", orchestrator: "unknown" }) }),
    setInterval: (fn) => { const id = ++nextTimer; intervals.set(id, fn); return id; },
    clearInterval: (id) => { cleared.push(id); intervals.delete(id); },
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.innerHTML, "<p>fresh</p>");
  assert.equal(health.textContent, "healthy");
  assert.equal(intervals.size, 1);
  button.listeners.click();
  assert.equal(intervals.size, 0);
  assert.equal(status.textContent, "Live updates paused");
  button.listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(intervals.size, 1);
  listeners.pagehide();
  assert.equal(intervals.size, 0);
  assert.ok(cleared.length >= 2);
});

test("trusted snapshot normalization preserves absent observations as unknown", () => {
  const snapshot = normalizeSupervisorSnapshot({ summary: { active_tasks: 9 }, accounts: [{ id: "account-1", capacity: 5 }] });
  assert.equal(snapshot.providers, undefined);
  assert.equal(snapshot.events, undefined);
  assert.equal(snapshot.supervisor, undefined);
  assert.equal(snapshot.orchestrator, undefined);
});

test("responsive layout contains intrinsic mobile widths and wraps long identifiers", () => {
  const html = renderSupervisorDashboard({ providers: [{ id: "provider-" + "x".repeat(120), label: "Provider", status: "ready" }] });
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
  assert.match(style, /grid-template-columns:minmax\(0,1fr\)/);
  assert.match(style, /\.rail nav\{[^}]*width:100%;min-width:0;max-width:100%;overflow-x:auto/);
  assert.match(style, /summary\{max-width:100%;overflow-wrap:anywhere\}/);
  assert.match(style, /\.filter label\{[^}]*min-width:0;flex:1 1 145px\}/);
  assert.match(style, /input,select\{[^}]*width:100%;max-width:100%;min-width:0/);
  assert.doesNotMatch(style, /overflow-x\s*:\s*hidden/);
  assert.match(html, /provider-x{20,}/);
});

test("Python assignment receipts normalize into visible jobs without fabricating provider data", () => {
  const snapshot = normalizeSupervisorSnapshot({
    assignments: [{ assignmentId: "batch-1", projectId: "project-1", state: "queued", revision: 3, taskCount: 2 }],
    total: 1,
    offset: 0,
    hasMore: false,
  });
  assert.equal(snapshot.providers, undefined);
  assert.equal(snapshot.jobs[0].id, "batch-1");
  assert.equal(snapshot.jobs[0].status, "queued");
  assert.equal(snapshot.jobs[0].taskCount, 2);
  assert.equal(snapshot.jobs[0].revision, 3);
  assert.equal(snapshot.jobs[0].workspace, undefined);
  const html = renderSupervisorDashboard(snapshot);
  assert.match(html, /Assignment batch-1/);
  assert.match(html, /2 tasks · revision 3/);
  assert.match(html, /No provider groups are available/);
  assert.doesNotMatch(html, /snapshot supplied|no actions are implied|unknown denominator/i);
});

test("reported task and account usage stays provisional, sourced, and unknown when absent", () => {
  const html = renderSupervisorDashboard(normalizeSupervisorSnapshot({
    providers: [{ id: "p", label: "LightSprint", status: "available", accounts: [
      { id: "acct-known", label: "Known", status: "healthy", usage: { reportedCostDeltaUsd: 0.125, coveredTaskGenerations: 2, totalTaskGenerations: 3, observedAt: 1791000000, source: "lightsprint-session-status", provisional: true } },
      { id: "acct-unknown", label: "Unknown", status: "healthy" },
    ] }],
    workers: [{ id: "session-a", status: "eligible", model: "gpt-6-luna", usage: { reportedSessionCostUsd: 0.5, reportedCostDeltaUsd: 0.125, promptCountDelta: 2, budgetUsed: 4, maxBudget: 10, fundingSource: "shared", sandboxTier: "standard", observedAt: 1791000000, source: "lightsprint-session-status", provisional: true, budgetUnit: "unknown" } }],
  }));
  assert.match(html, /Reported USD increase: \$0\.1250 USD · provisional/);
  assert.match(html, /2 of 3 task generations with reported cost/);
  assert.match(html, /Task increase.*\$0\.1250 USD/);
  assert.match(html, /Reported session total:.*\$0\.5000 USD/);
  assert.match(html, /Provider session budget \(unit not reported\): 4 \/ 10/);
  assert.match(html, /Remaining quota is not reported; workspace billing may be shared/);
  assert.match(html, /LightSprint session status/);
  assert.match(html, /Model:.*gpt-6-luna/);
  assert.doesNotMatch(html, /credits? remaining|credit balance|\$0\.0000/);
  assert.equal((html.match(/role="meter"/g) || []).length, 1);
});

test("malformed and secret-bearing usage never becomes fabricated zero or active markup", () => {
  const html = renderSupervisorDashboard(normalizeSupervisorSnapshot({
    providers: [{ id: "p", label: "P", status: "available", accounts: [{ id: "a", label: "A", status: "ready", usage: { reportedCostDeltaUsd: -1, coveredTaskGenerations: 1, totalTaskGenerations: 1 } }] }],
    workers: [{ id: "s", status: "eligible", usage: { reportedCostDeltaUsd: -1, budgetUsed: 4, maxBudget: 0, fundingSource: '<img src=x> Bearer abc123.def4567890123456' } }],
  }));
  assert.match(html, /Usage not reported|No reported increase/);
  assert.match(html, /Provider session budget: 4 \/ maximum not reported/);
  assert.doesNotMatch(html, /\$0\.0000|aria-valuenow="4"|<img src=x|abc123\.def4567890123456/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /\[REDACTED\]/);
});
