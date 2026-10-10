import test from "node:test";
import assert from "node:assert/strict";
import { renderSupervisorDashboard } from "../dist/supervisor-ui.js";

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
  assert.match(html, /Unknown denominator/);
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
  assert.match(loading, /Snapshot is loading/);
  assert.match(loading, /No provider groups were supplied/);
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
