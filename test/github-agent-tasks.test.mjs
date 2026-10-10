import test from "node:test";
import assert from "node:assert/strict";
import {
  GITHUB_AGENT_TASKS_API_VERSION,
  GithubAgentTaskError,
  GithubAgentTasksAdapter,
} from "../dist/providers/github-agent-tasks.js";

const repository = { owner: "octo-org", repo: "snooze" };
const task = {
  id: "task-123",
  state: "queued",
  name: "Test task",
  url: "https://api.github.com/agents/repos/octo-org/snooze/tasks/task-123",
  html_url: "https://github.com/octo-org/snooze/agents/task-123",
  created_at: "2026-10-10T00:00:00Z",
  artifacts: [
    { provider: "github", type: "branch", data: { head_ref: "copilot/fix", base_ref: "main" } },
    { provider: "github", type: "pull", data: { id: 42, global_id: "PR_kwDO" } },
    { provider: "github", type: "pull", data: { id: 7, global_id: "x" }, unsafe_extra: "ignored" },
  ],
  prompt: "private task prompt must not be projected",
};

function adapterWith(fetch, credentials = () => "secret-token-for-test") {
  return new GithubAgentTasksAdapter(credentials, { fetch });
}

test("start uses documented route, API headers and safe no-PR default", async () => {
  const calls = [];
  const adapter = adapterWith(async (url, init) => {
    calls.push({ url: new URL(url), init });
    return Response.json(task, { status: 201 });
  }, (request) => {
    assert.deepEqual(request, { ...repository, permission: "write" });
    return "test-token";
  });

  const result = await adapter.start(repository, { prompt: "Fix a typo\nwithout creating a PR" });
  assert.equal(result.state, "queued");
  assert.equal(result.id, "task-123");
  assert.deepEqual(result.artifacts.map((artifact) => artifact.type), ["branch", "pull", "pull"]);
  assert.equal("prompt" in result, false);
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url.origin, "https://api.github.com");
  assert.equal(url.pathname, "/agents/repos/octo-org/snooze/tasks");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.authorization, "Bearer test-token");
  assert.equal(init.headers.accept, "application/vnd.github+json");
  assert.equal(init.headers["x-github-api-version"], GITHUB_AGENT_TASKS_API_VERSION);
  assert.equal(JSON.parse(init.body).create_pull_request, false);
});

test("list and get use repository-scoped documented paths and preserve provider state", async () => {
  const calls = [];
  const adapter = adapterWith(async (url, init) => {
    calls.push({ url: new URL(url), init });
    return Response.json(calls.length === 1
      ? { tasks: [task], total_active_count: 1, total_archived_count: 0 }
      : { ...task, state: "in_progress", sessions: [{ prompt: "must not escape" }] });
  });
  const listed = await adapter.list(repository, { perPage: 10, page: 2, state: ["queued", "in_progress"] });
  assert.equal(listed.tasks[0].state, "queued");
  assert.equal(listed.total_active_count, 1);
  assert.deepEqual(listed.tasks[0].artifacts[0].data, { head_ref: "copilot/fix", base_ref: "main" });
  const fetched = await adapter.get(repository, "task-123");
  assert.equal(fetched.state, "in_progress");
  assert.equal("sessions" in fetched, false);
  assert.equal(calls[0].url.pathname, "/agents/repos/octo-org/snooze/tasks");
  assert.equal(calls[0].url.searchParams.get("per_page"), "10");
  assert.equal(calls[0].url.searchParams.get("page"), "2");
  assert.equal(calls[0].url.searchParams.get("state"), "queued,in_progress");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret-token-for-test");
  assert.equal(calls[1].url.pathname, "/agents/repos/octo-org/snooze/tasks/task-123");
});

test("invalid repository, task ID, and list filters are rejected before credentials or fetch", async () => {
  let resolutions = 0;
  let fetches = 0;
  const adapter = adapterWith(async () => { fetches++; return Response.json(task, { status: 200 }); }, () => { resolutions++; return "t"; });
  await assert.rejects(adapter.get({ owner: "org/evil", repo: "repo" }, "id"), { category: "validation", requestOutcome: "not_sent" });
  await assert.rejects(adapter.get(repository, "../other"), { category: "validation" });
  await assert.rejects(adapter.list(repository, { state: ["cancel"] }), { category: "validation" });
  await assert.rejects(adapter.list(repository, { perPage: 101 }), { category: "validation" });
  assert.equal(resolutions, 0);
  assert.equal(fetches, 0);
});

test("credential resolver failures and transport errors never expose credential text", async () => {
  const credential = "ghp-very-secret-test-value";
  const resolveFailure = adapterWith(async () => assert.fail("fetch must not run"), () => { throw new Error(credential); });
  await assert.rejects(resolveFailure.list(repository), (error) => {
    assert.ok(error instanceof GithubAgentTaskError);
    assert.equal(error.category, "auth");
    assert.ok(!error.message.includes(credential));
    return true;
  });
  const networkFailure = adapterWith(async (_url, init) => {
    assert.equal(init.redirect, "error");
    throw new Error(`redirect contained ${credential}`);
  }, () => credential);
  await assert.rejects(networkFailure.start(repository, { prompt: "test" }), (error) => {
    assert.equal(error.category, "transport");
    assert.equal(error.requestOutcome, "unknown");
    assert.ok(!error.message.includes(credential));
    return true;
  });
});

test("documented HTTP failures are classified without exposing response bodies", async () => {
  for (const [status, category] of [[401, "auth"], [403, "permission"], [404, "not_found"], [422, "validation"], [429, "rate_limit"]]) {
    const adapter = adapterWith(async () => new Response("sensitive provider detail", { status }));
    await assert.rejects(adapter.get(repository, "task-123"), (error) => {
      assert.equal(error.category, category);
      assert.equal(error.httpStatus, status);
      assert.ok(!error.message.includes("sensitive"));
      return true;
    });
  }
  const server = adapterWith(async () => new Response("server detail", { status: 503 }));
  await assert.rejects(server.start(repository, { prompt: "test" }), { category: "server", requestOutcome: "unknown" });
});

test("oversized bodies are bounded and ambiguous after task submission", async () => {
  const adapter = adapterWith(async () => new Response("x".repeat(1_048_577), { status: 201 }));
  await assert.rejects(adapter.start(repository, { prompt: "test" }), (error) => {
    assert.equal(error.category, "response_too_large");
    assert.equal(error.requestOutcome, "unknown");
    return true;
  });
});

test("cancellation is explicitly unsupported and never sends a request", async () => {
  let fetches = 0;
  const adapter = adapterWith(async () => { fetches++; return Response.json({}); });
  await assert.rejects(adapter.cancel(repository, "task-123"), { category: "unsupported", requestOutcome: "not_sent" });
  assert.equal(fetches, 0);
});
