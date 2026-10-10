import test from "node:test";
import assert from "node:assert/strict";
import {
  createExaWebInformationAdapter,
  createFirecrawlWebInformationAdapter,
  WebInformationInputError,
  WebInformationProviderError,
} from "../dist/providers/web-information.js";

function fixture(provider, response = {}) {
  const calls = [];
  const credential = "secret-fixture-token-do-not-leak";
  const adapterDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    },
    resolveCredential: async (name) => {
      assert.equal(name, provider);
      return credential;
    },
  };
  return { calls, credential, deps: adapterDeps };
}

function visibleError(error) {
  return [error.name, error.message, error.provider, error.category, error.requestOutcome, error.httpStatus].join(" ");
}

test("Exa search uses its fixed REST route, API-key header, and typed options", async () => {
  const { calls, credential, deps } = fixture("exa", {
    results: [{ title: "Example", url: "https://example.com", highlights: ["A useful excerpt"], score: 0.9 }],
    costDollars: 0.004,
  });
  const adapter = createExaWebInformationAdapter(deps);
  const result = await adapter.search({
    query: "example query",
    maxResults: 3,
    providerOptions: { type: "neural", includeDomains: ["example.com"], highlights: true },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.exa.ai/search");
  assert.equal(calls[0].init.headers["x-api-key"], credential);
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: "example query",
    type: "neural",
    numResults: 3,
    contents: { highlights: true },
    includeDomains: ["example.com"],
  });
  assert.deepEqual(result.results, [{ url: "https://example.com", title: "Example", snippet: "A useful excerpt", score: 0.9 }]);
  assert.deepEqual(result.usage, { known: true, value: { costUsd: 0.004 }, source: "provider-response" });
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test("Exa extracts by id through /contents and marks absent usage unknown", async () => {
  const { calls, deps } = fixture("exa", { results: [{ url: "https://example.com/", title: "Page", text: "Page text" }] });
  const adapter = createExaWebInformationAdapter(deps);
  const result = await adapter.extract({ url: "https://example.com", providerOptions: { text: true, highlights: false } });

  assert.equal(calls[0].url, "https://api.exa.ai/contents");
  assert.deepEqual(JSON.parse(calls[0].init.body), { ids: ["https://example.com/"], text: true, highlights: false });
  assert.deepEqual(result.results, [{ url: "https://example.com/", title: "Page", content: "Page text" }]);
  assert.deepEqual(result.usage, { known: false, reason: "provider response did not include usage" });
});

test("Firecrawl uses fixed v2 routes, bearer auth, and validated scrape formats", async () => {
  const searchFixture = fixture("firecrawl", { web: [{ title: "Example", url: "https://example.com", description: "Snippet" }] });
  const adapter = createFirecrawlWebInformationAdapter(searchFixture.deps);
  const searched = await adapter.search({ query: "example", maxResults: 4, providerOptions: { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } });
  assert.equal(searchFixture.calls[0].url, "https://api.firecrawl.dev/v2/search");
  assert.equal(searchFixture.calls[0].init.headers.authorization, `Bearer ${searchFixture.credential}`);
  assert.equal(searchFixture.calls[0].init.headers["x-api-key"], undefined);
  assert.deepEqual(JSON.parse(searchFixture.calls[0].init.body), { query: "example", limit: 4, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } });
  assert.deepEqual(searched.results[0], { url: "https://example.com", title: "Example", snippet: "Snippet" });

  const scrapeFixture = fixture("firecrawl", { success: true, data: { markdown: "Extracted", metadata: { sourceURL: "https://example.com/", title: "Page" }, creditsCost: 2 } });
  const scrapeAdapter = createFirecrawlWebInformationAdapter(scrapeFixture.deps);
  const extracted = await scrapeAdapter.extract({ url: "https://example.com", providerOptions: { formats: ["markdown", "html"], onlyMainContent: true } });
  assert.equal(scrapeFixture.calls[0].url, "https://api.firecrawl.dev/v2/scrape");
  assert.deepEqual(JSON.parse(scrapeFixture.calls[0].init.body), { url: "https://example.com/", formats: ["markdown", "html"], onlyMainContent: true });
  assert.deepEqual(extracted.results, [{ url: "https://example.com/", title: "Page", content: "Extracted", contentByFormat: { markdown: "Extracted" } }]);
  assert.deepEqual(extracted.usage, { known: true, value: { credits: 2 }, source: "provider-response" });
});

test("unknown provider options, invalid URLs, and oversized search inputs fail before fetch", async () => {
  const { calls, deps } = fixture("exa", { results: [] });
  const adapter = createExaWebInformationAdapter(deps);
  await assert.rejects(adapter.search({ query: "ok", providerOptions: { invented: true } }), WebInformationInputError);
  await assert.rejects(adapter.extract({ url: "file:///etc/passwd" }), WebInformationInputError);
  await assert.rejects(adapter.search({ query: "x".repeat(2_001) }), WebInformationInputError);
  await assert.rejects(adapter.search({ query: "ok", maxResults: 21 }), WebInformationInputError);
  assert.equal(calls.length, 0);
});

test("results are capped and long snippets are bounded", async () => {
  const payload = { results: Array.from({ length: 30 }, (_, index) => ({ url: `https://example.com/${index}`, text: "x".repeat(25_000) })) };
  const adapter = createExaWebInformationAdapter(fixture("exa", payload).deps);
  const result = await adapter.search({ query: "many results", maxResults: 20 });
  assert.equal(result.results.length, 20);
  assert.equal(result.results[0].snippet.length, 20_000);
});

test("malformed or non-HTTP provider result URLs are discarded", async () => {
  const adapter = createFirecrawlWebInformationAdapter(fixture("firecrawl", {
    web: [
      { url: "javascript:alert(1)", title: "bad scheme" },
      { url: "https://user:pass@example.com/", title: "embedded credentials" },
      { url: "https://example.com/good", title: "good" },
    ],
  }).deps);
  const result = await adapter.search({ query: "url validation" });
  assert.deepEqual(result.results, [{ url: "https://example.com/good", title: "good" }]);
});

test("oversized upstream response is rejected within the configured byte bound", async () => {
  let calls = 0;
  const adapter = createExaWebInformationAdapter({
    fetch: async () => { calls += 1; return new Response(JSON.stringify({ results: [{ url: "https://example.com", text: "too big" }] })); },
    resolveCredential: () => "secret-token",
    maxResponseBytes: 12,
  });
  await assert.rejects(adapter.search({ query: "bounded" }), (error) => {
    assert.ok(error instanceof WebInformationProviderError);
    assert.equal(error.category, "unknown");
    assert.equal(error.requestOutcome, "unknown");
    assert.doesNotMatch(visibleError(error), /secret-token|too big/);
    return true;
  });
  assert.equal(calls, 1);
});

test("pre-abort sends no request; abort during fetch is ambiguous and is not retried", async () => {
  let preAbortedCalls = 0;
  const signalController = new AbortController();
  signalController.abort();
  const preAborted = createExaWebInformationAdapter({ fetch: async () => { preAbortedCalls += 1; return new Response("{}"); }, resolveCredential: () => "token" });
  await assert.rejects(preAborted.search({ query: "cancel", signal: signalController.signal }), (error) => {
    assert.equal(error.requestOutcome, "not_sent");
    return true;
  });
  assert.equal(preAbortedCalls, 0);

  let calls = 0;
  const duringFetch = createExaWebInformationAdapter({
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      calls += 1;
      init.signal.addEventListener("abort", () => reject(new DOMException("secret query echo", "AbortError")), { once: true });
    }),
    resolveCredential: () => "secret-token",
    timeoutMs: 15,
  });
  await assert.rejects(duringFetch.search({ query: "cancel" }), (error) => {
    assert.equal(error.category, "transient");
    assert.equal(error.requestOutcome, "unknown");
    assert.doesNotMatch(visibleError(error), /secret-token|secret query echo/);
    return true;
  });
  assert.equal(calls, 1);
});

test("provider status errors are categorized without echoing credentials or response bodies", async (t) => {
  const cases = [
    [401, "auth", "rejected"],
    [402, "quota", "rejected"],
    [429, "rate_limit", "rejected"],
    [503, "transient", "unknown"],
  ];
  for (const [status, category, outcome] of cases) {
    await t.test(String(status), async () => {
      let calls = 0;
      const adapter = createFirecrawlWebInformationAdapter({
        fetch: async () => { calls += 1; return new Response("secret provider body", { status, headers: status === 429 ? { "retry-after": "3" } : {} }); },
        resolveCredential: () => "secret-token",
      });
      await assert.rejects(adapter.search({ query: "private query" }), (error) => {
        assert.ok(error instanceof WebInformationProviderError);
        assert.equal(error.category, category);
        assert.equal(error.requestOutcome, outcome);
        assert.equal(error.httpStatus, status);
        if (status === 429) assert.equal(error.retryAfterMs, 3_000);
        assert.doesNotMatch(visibleError(error), /secret-token|secret provider body|private query/);
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test("network failure is attempted once; there is no automatic paid cross-provider retry", async () => {
  let exaCalls = 0;
  let firecrawlCalls = 0;
  const adapter = createExaWebInformationAdapter({
    fetch: async () => { exaCalls += 1; throw new Error("private query and token must not escape"); },
    resolveCredential: () => "secret-token",
  });
  await assert.rejects(adapter.search({ query: "private query" }), (error) => {
    assert.equal(error.category, "transient");
    assert.equal(error.requestOutcome, "unknown");
    assert.doesNotMatch(visibleError(error), /private query|secret-token/);
    return true;
  });
  assert.equal(exaCalls, 1);
  assert.equal(firecrawlCalls, 0);
});
