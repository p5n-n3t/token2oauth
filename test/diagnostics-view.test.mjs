import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDiagnosticEntry,
  renderDiagnosticsView,
} from "../dist/diagnostics-view.js";

test("readable mode normalizes time and severity and correlates provider, pool, request, and session", () => {
  const rendered = formatDiagnosticEntry({
    timestamp: "2025-01-02T03:04:05Z",
    severity: "warning",
    provider: "example-provider",
    accountLabel: "primary",
    requestId: "req-17",
    "Mcp-Session-Id": "sess-29",
    message: "upstream retry scheduled",
  });

  assert.match(rendered, /2025-01-02T03:04:05\.000Z  WARN/);
  assert.match(rendered, /provider=example-provider/);
  assert.match(rendered, /pool\/account=primary/);
  assert.match(rendered, /request=req-17/);
  assert.match(rendered, /session=sess-29/);
  assert.match(rendered, /message: upstream retry scheduled/);
});

test("timezone-free ISO timestamps are consistently interpreted as UTC", () => {
  assert.match(
    formatDiagnosticEntry({ timestamp: "2025-01-02T03:04:05", level: "info" }),
    /2025-01-02T03:04:05\.000Z/,
  );
});

test("raw JSON mode is deterministic and redacts sensitive fields and embedded bearer strings", () => {
  const rendered = formatDiagnosticEntry({
    message: "authorization=Bearer abc.def.ghi",
    token: "top-secret-token",
    authHeader: "Bearer another-secret",
    passphrase: "another-private-value",
    z: 2,
    a: 1,
  }, "json");

  assert.match(rendered, /"token": "\[REDACTED\]"/);
  assert.match(rendered, /authorization=\[REDACTED\]/);
  assert.ok(rendered.indexOf('"a"') < rendered.indexOf('"z"'));
  assert.doesNotMatch(rendered, /top-secret-token|abc\.def\.ghi|another-secret|another-private-value/);
});

test("HTML view escapes dynamic content and provides native accessible raw disclosure controls", () => {
  const html = renderDiagnosticsView([{
    message: '<img src=x onerror="alert(1)">',
    api_key: "do-not-render",
  }], { title: "<Diagnostics>" });

  assert.match(html, /&lt;Diagnostics&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x|onerror="alert|do-not-render/);
  assert.match(html, /<main>/);
  assert.match(html, /<ol aria-label="Diagnostic log entries">/);
  assert.match(html, /<details><summary>Show redacted raw JSON<\/summary>/);
  assert.match(html, /Upstream provider log availability is unknown/);
  assert.doesNotMatch(html, /<script\b|<img\b|<pre[^>]*\sonerror=/i);
});

test("malformed JSON is surfaced without throwing and is redacted", () => {
  const malformed = '{"message":"broken", "authorization":"Bearer abc123';
  const readable = formatDiagnosticEntry(malformed);
  const raw = formatDiagnosticEntry(malformed, "json");

  assert.match(readable, /^Malformed JSON log entry/);
  assert.match(raw, /^Malformed JSON log entry/);
  assert.match(readable, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(raw, /abc123/);
});

test("entry text and HTML entry count are bounded with explicit truncation or omission notices", () => {
  const large = { message: "x".repeat(500) };
  const formatted = formatDiagnosticEntry(large, "json", { maxChars: 96 });
  const html = renderDiagnosticsView([large, large, large], { maxEntries: 2 });

  assert.ok(formatted.length <= 96);
  assert.match(formatted, /\[truncated\]$/);
  assert.equal((html.match(/<article\b/g) || []).length, 2);
  assert.match(html, /1 older entry was omitted by the display limit/);
});

test("sanitizer marks bounded nested strings and collections", () => {
  const rendered = formatDiagnosticEntry({
    message: "x".repeat(25_000),
    items: Array(101).fill("small"),
  }, "json", { maxChars: 30_000 });

  assert.match(rendered, /\[truncated\]/);
  assert.match(rendered, /additional items omitted/);
});

test("cyclic and malformed object values produce a bounded safe fallback", () => {
  const value = { level: "error" };
  value.self = value;
  assert.match(formatDiagnosticEntry(value, "json"), /\[circular\]/);
  assert.doesNotThrow(() => renderDiagnosticsView([value]));
});
