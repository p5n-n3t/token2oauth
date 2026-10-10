import { expect, test, type Page, type Route } from "@playwright/test";

function publicAccounts() {
  return Array.from({ length: 9 }, (_, index) => ({
    id: `lightsprint${index + 1}`, server_key: `lightsprint${index + 1}`, label: `Lightsprint ${index + 1}`,
    adapter: "lightsprint", enabled: true, capacity: 12, revision: 0, models: ["codex-5"], efforts: ["low", "medium"],
    priority: 0, reserve: 0, allow_unknown_quota: false, quota_override: null, identity: null, quota: null, health: "unknown",
    capabilities: { observe: { supported: true, reason: null }, cancel: { supported: false, reason: "Provider has not confirmed cancellation capability." } },
  }));
}

test("integrated History reads scoped analytics and exports through the real Python API", async ({page}) => {
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.getByTestId('nav-history').click();
  const report=page.getByTestId('rich-history-page');
  await expect(report.getByText('Recorded events',{exact:true})).toBeVisible();
  await expect(report.getByText('Input tokens',{exact:true})).toBeVisible();
  const exported=await report.getByRole('link',{name:'Export JSON'}).getAttribute('href');
  const response=await page.evaluate(async url=>{
    const r=await fetch(url!);return {status:r.status,body:await r.json()};
  },exported);
  expect(response.status).toBe(200);
  expect(response.body.filters.project_id).toBe('trump-files');
  expect(response.body.native.summary.input_tokens.value).toBeGreaterThan(0);
  expect(JSON.stringify(response.body)).not.toContain('e2e-cookie-token');
  await page.getByRole('button',{name:'Switch to light theme'}).click();
  await expect(report).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await expect(report.getByRole('link',{name:'Export JSON'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
  expect(errors).toEqual([]);
});

async function installCoordinatorFixture(page: Page, options: { managed?: boolean } = {}) {
  let policy: Record<string, unknown> = {
    interval: 300, pause_dispatch: true, emergency_stop: false, max_concurrent: 12, global_concurrent: 24,
    max_recoveries: 2, backoff_seconds: 60, reserve: 0, allow_unknown_quota: false, allow_native: false,
    native_ceiling: 0, native_reserve: null, model_limits: {}, mode: "balanced", revision: 0,
  };
  const accounts = publicAccounts();
  if (options.managed) accounts[0].capabilities.cancel = { supported: true, reason: null };
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    id: `task-${String(index).padStart(3, "0")}`, project: "trump-files", state: index % 4 ? "running" : "waiting",
    priority: 0, revision: 0, summary: index === 0 ? "Review release candidate" : `Inspect deployment batch ${index}`,
    approved: true, created_at: 1_790_000_000, updated_at: 1_790_000_000,
  }));
  let registered = false;
  let acknowledged = false;
  let cancelPending = false;
  let rejectAccountOnce = false;
  let nextActionId = 0;
  const delivery = {
    id: "delivery-001", incident: "incident-001", project: "trump-files", state: "accepted", payload: { kind: "attention", message: "Coordinator needs a response." },
    accepted_at: 1_790_000_000, acknowledged_at: null, resolved: false, error_kind: null,
  };

  await page.route("**/api/v2/state", async (route: Route) => {
    try {
      const response = await route.fetch();
      const state = await response.json();
      state.settings = { ...state.settings, ...policy };
      state.capabilities = {
        ...state.capabilities,
        dispatch: options.managed ? { supported: true, reason: null } : { supported: false, reason: "This project is externally managed. Snooze cannot control its dispatcher." },
        pause: options.managed ? { supported: true, reason: null } : { supported: false, reason: "This project is externally managed. Snooze cannot control its dispatcher." },
        emergency_stop: options.managed ? { supported: true, reason: null } : { supported: false, reason: "This project is externally managed. Snooze cannot control its dispatcher." },
      };
      state.accounts = accounts;
      if (cancelPending) state.slots = state.slots.map((slot: { task_id: string; task_state: string }) => slot.task_id === "task-000" ? { ...slot, task_state: "cancel_pending" } : slot);
      await route.fulfill({ response, contentType: "application/json", body: JSON.stringify(state) });
    } catch { /* Navigating away can cancel the service fixture response. */ }
  });
  await page.route("**/api/v2/queue**", async (route: Route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ tasks: tasks.slice(offset, offset + limit), total: tasks.length, offset }) });
  });
  await page.route("**/api/v2/providers", async (route: Route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts }) });
  });
  await page.route("**/api/v2/inbox", async (route: Route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ deliveries: [delivery], wake_mode: "inbox-only", reason: "No documented coordinator wake channel is configured." }) });
  });
  await page.route("**/api/v2/control", async (route: Route) => {
    const request = route.request().postDataJSON() as { action: string; target_id: string; values: Record<string, unknown>; expected_revision: number };
    let state = "confirmed";
    let reason: string | null = null;
    let statusCode = 200;
    let revision = request.expected_revision;
    if (request.action === "policy-config") {
      if (request.expected_revision !== policy.revision) { state = "rejected"; reason = "Stale revision"; statusCode = 409; }
      else { policy = { ...policy, ...request.values, revision: Number(policy.revision) + 1 }; revision = Number(policy.revision); }
    } else if (request.action === "account-config") {
      const account = accounts.find((candidate) => candidate.id === request.target_id);
      if (rejectAccountOnce) { rejectAccountOnce = false; state = "rejected"; reason = "Stale revision"; statusCode = 409; }
      else if (!account || account.revision !== request.expected_revision) { state = "rejected"; reason = "Stale revision"; statusCode = 409; }
      else { Object.assign(account, request.values, { revision: account.revision + 1 }); revision = account.revision; }
    } else if (request.action === "account-test") {
      revision = accounts.find((candidate) => candidate.id === request.target_id)?.revision ?? 0;
    } else if (request.action === "coordinator-register") {
      registered = true;
    } else if (request.action === "incident-ack") {
      if (!registered) { state = "rejected"; reason = "Register a coordinator for this project first."; statusCode = 409; }
      else { acknowledged = true; delivery.acknowledged_at = 1_790_000_100; delivery.state = "acknowledged"; }
    } else if (request.action === "task-add") {
      const ids = request.values.output_contract as { ids?: string[] };
      const scope = request.values.scope_keys as string[];
      if (!Array.isArray(scope) || !Array.isArray(ids?.ids) || scope.length !== ids.ids.length || scope.some((id) => !ids.ids?.includes(id))) {
        state = "rejected"; reason = "Record scopes must exactly match output IDs."; statusCode = 400;
      } else {
        tasks.push({ id: String(request.values.id), project: "trump-files", state: "draft", priority: 0, revision: 0, summary: String(request.values.instructions), approved: false });
      }
    } else if (request.action === "cancel") {
      cancelPending = true; state = "pending"; reason = "Awaiting provider acknowledgment; scope remains owned."; statusCode = 202;
      const task = tasks.find((candidate) => candidate.id === request.target_id);
      if (task) { task.state = "cancel_pending"; task.revision += 1; revision = task.revision; }
    } else if (["hold", "approve", "prioritize", "retry", "resume"].includes(request.action)) {
      const task = tasks.find((candidate) => candidate.id === request.target_id);
      if (!task || task.revision !== request.expected_revision) { state = "rejected"; reason = "Stale revision"; statusCode = 409; }
      else {
        if (request.action === "hold") task.state = "held";
        if (request.action === "approve") { task.approved = true; task.state = "queued"; }
        if (request.action === "prioritize") task.priority = Number(request.values.priority);
        task.revision += 1; revision = task.revision;
      }
    } else if (request.action === "dispatch-pause" || request.action === "emergency-stop") {
      if (!options.managed) { state = "rejected"; reason = "External dispatcher owns this project; Snooze cannot pause or stop it."; statusCode = 409; }
      else { policy[request.action === "dispatch-pause" ? "pause_dispatch" : "emergency_stop"] = request.action === "dispatch-pause" ? request.values.paused : request.values.stopped; policy.revision = Number(policy.revision) + 1; revision = Number(policy.revision); }
    } else {
      state = "rejected"; reason = "Unsupported fixture action."; statusCode = 409;
    }
    const receipt = { action_id: `fixture-${++nextActionId}`, state, reason, revision, status_code: statusCode };
    await route.fulfill({ status: statusCode, contentType: "application/json", body: JSON.stringify(receipt) });
  });

  return { tasks, accounts, delivery, setRejectAccountOnce: () => { rejectAccountOnce = true; }, getAcknowledged: () => acknowledged };
}

test("command centre pages server data, bounds the DOM and stays usable across themes and sizes", async ({ page }) => {
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  await installCoordinatorFixture(page);
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^(127\.0\.0\.1|localhost)$/.test(url.hostname)) externalRequests.push(request.url());
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  const stateResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/v2/state"));
  await page.goto("/");
  await expect(page.getByTestId("watch-view")).toBeVisible();
  const stateResponse = await stateResponsePromise;
  const stateBytes = (await stateResponse.body()).byteLength;
  const occupiedRows = await page.getByTestId("watch-row").count();
  console.log(`Fixture load: ${occupiedRows} active rows; schema-v2 state payload ${stateBytes} bytes.`);
  await expect(page.getByRole("heading", { name: "Worker watch." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Emergency stop" })).toBeDisabled();
  await expect(page.getByTestId("delivery-inbox")).toContainText("Inbox only");
  await page.screenshot({ path: "/tmp/snooze-watch-dark-desktop.png", fullPage: true });

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "/tmp/snooze-watch-light-desktop.png", fullPage: true });

  await page.getByTestId("nav-queue").click();
  await expect(page.getByTestId("queue-view")).toBeVisible();
  await expect(page.getByTestId("queue-row")).toHaveCount(50);
  await expect(page.getByRole("button", { name: "Reassign" }).first()).toBeDisabled();
  await page.getByRole("button", { name: "Add task draft" }).click();
  await expect(page.getByTestId("task-draft-form")).toBeVisible();
  await page.screenshot({ path: "/tmp/snooze-queue-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByTestId("queue-row")).toHaveCount(50);

  await page.getByTestId("nav-providers").click();
  await expect(page.getByTestId("providers-view")).toBeVisible();
  await expect(page.getByText("Credential status").first().locator("..")).toContainText("Not reported");
  await page.getByRole("button", { name: "Edit account" }).first().click();
  await expect(page.getByTestId("account-editor").first()).toBeVisible();
  await page.screenshot({ path: "/tmp/snooze-providers-desktop.png", fullPage: true });

  const historyResponsePromise = page.waitForResponse((response) => response.url().includes("/api/v2/history/events"));
  await page.getByTestId("nav-history").click();
  await expect(page.getByTestId("history-view")).toBeVisible();
  const historyResponse = await historyResponsePromise;
  const historyJson = await historyResponse.json();
  const historyBytes = (await historyResponse.body()).byteLength;
  await expect(page.getByTestId("history-row")).toHaveCount(25);
  expect(historyJson.total).toBe(10_002);
  expect(historyJson.entries).toHaveLength(25);
  expect(new URL(historyResponse.url()).searchParams.get("limit")).toBe("25");
  console.log(`Fixture history: ${historyJson.total.toLocaleString()} records; page payload ${historyBytes} bytes; rendered DOM rows ${await page.getByTestId("history-row").count()}.`);
  await page.screenshot({ path: "/tmp/snooze-history-desktop.png", fullPage: true });
  await page.getByRole("searchbox", { name: "Search history" }).fill("Completed assignment 000");
  await expect(page.getByText("Completed assignment 000")).toBeVisible();

  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: /Dispatch/ }).click();
  await expect(page.getByLabel("Maximum recoveries")).toHaveValue("2");
  await expect(page.getByRole("button", { name: "Resume dispatch" })).toBeDisabled();
  await page.screenshot({ path: "/tmp/snooze-settings-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("nav-watch").click();
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".mobile-worker-card").first()).toBeVisible();
  await page.screenshot({ path: "/tmp/snooze-watch-dark-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "/tmp/snooze-watch-light-mobile.png", fullPage: true });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);

  await page.getByTestId("nav-queue").click();
  await page.getByRole("button", { name: "Previous page" }).click();
  const firstMobileTask = page.getByTestId("queue-mobile-row").filter({ hasText: "task-000" });
  await expect(firstMobileTask).toBeVisible();
  await firstMobileTask.getByRole("button", { name: "Inspect" }).click();
  const drawer = page.getByRole("dialog", { name: "Task inspection drawer" });
  await expect(drawer).toBeVisible();
  await expect.poll(async () => page.locator(".kit-detail-drawer").evaluate((element) => element.getBoundingClientRect().left)).toBeLessThan(1);
  await page.screenshot({ path: "/tmp/snooze-task-drawer-mobile.png", fullPage: true });
  await expect(drawer).toContainText('<img src=x onerror="alert(1)"> Keep this assigned prompt literal.');
  await expect(drawer.locator("img")).toHaveCount(0);
  await expect(drawer.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(drawer.getByRole("link")).toHaveCount(1);
  await expect(drawer.getByRole("link")).toHaveAttribute("href", "https://docs.example.test/runbook");
  await page.keyboard.press("Tab");
  await expect(drawer.getByRole("button", { name: "Close task inspection" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(drawer.getByRole("link")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await page.getByTestId("queue-mobile-row").filter({ hasText: "task-000" }).getByRole("button", { name: "Inspect" }).click();
  const animationDuration = await page.locator(".kit-detail-drawer").evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration));
  expect(animationDuration).toBeLessThan(0.001);
  await page.keyboard.press("Escape");
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("control forms preserve revisions, rejection/pending truth, and durable acknowledgment semantics", async ({ page }) => {
  const fixture = await installCoordinatorFixture(page);
  fixture.setRejectAccountOnce();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("watch-view")).toBeVisible();

  await page.getByTestId("nav-providers").click();
  await expect(page.getByTestId("providers-view")).toBeVisible();
  await page.getByRole("button", { name: "Edit account" }).first().click();
  await page.getByLabel("Models").first().fill("codex-5, gpt-5");
  await page.getByRole("button", { name: "Save account" }).first().click();
  await expect(page.getByTestId("control-receipt")).toContainText("Rejected · account-config · HTTP 409 · Stale revision");
  await expect(page.getByTestId("account-editor").first()).toBeVisible();
  await page.getByRole("button", { name: "Save account" }).first().click();
  await expect(page.getByTestId("control-receipt")).toContainText("Confirmed · account-config");
  expect(fixture.accounts[0].models).toEqual(["codex-5", "gpt-5"]);
  await page.getByRole("button", { name: "Test connection" }).first().click();
  await expect(page.getByTestId("control-receipt")).toContainText("Confirmed · account-test");

  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: /Dispatch/ }).click();
  await page.getByLabel("Project concurrency limit").fill("6");
  await page.getByRole("button", { name: "Save operational policy" }).click();
  await expect(page.getByTestId("control-receipt")).toContainText("Confirmed · policy-config");
  expect(fixture.tasks).toHaveLength(100);
  await page.reload();
  await expect(page.getByTestId("watch-view")).toBeVisible();
  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: /Dispatch/ }).click();
  await expect(page.getByLabel("Project concurrency limit")).toHaveValue("6");

  await page.getByTestId("nav-watch").click();
  await page.getByRole("button", { name: "Register coordinator" }).click();
  await expect(page.getByTestId("control-receipt")).toContainText("Confirmed · coordinator-register");
  await page.getByRole("button", { name: "Acknowledge delivery" }).click();
  await expect(page.getByTestId("control-receipt")).toContainText("Confirmed · incident-ack");
  await expect(page.getByText("Acknowledged").first()).toBeVisible();
  expect(fixture.getAcknowledged()).toBe(true);
  expect(fixture.delivery.resolved).toBe(false);
  await expect(page.getByText(/does not resolve the incident/i)).toBeVisible();

  await page.getByTestId("nav-queue").click();
  await page.getByRole("button", { name: "Add task draft" }).click();
  await page.getByLabel("Task ID").fill("draft-001");
  await page.getByLabel("Scope record IDs").fill("record:1");
  await page.getByLabel("Input reference").fill("immutable://record-1");
  await page.getByLabel("Input SHA-256").fill("a".repeat(64));
  await page.getByLabel("Output record IDs").fill("record:1");
  await page.getByLabel("Output fields").fill("summary, status");
  await page.getByLabel("Required model").fill("codex-5");
  await page.getByLabel("Task instructions").fill("Summarize record 1 using the supplied contract.");
  await expect(page.getByRole("button", { name: "Save draft packet" })).toBeEnabled();
  await page.getByRole("button", { name: "Save draft packet" }).click();
  await expect(page.getByTestId("control-receipt")).toContainText("Confirmed · task-add");
  await expect(page.getByText("101", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await page.getByRole("button", { name: "Next page" }).click();
  const draftRow = page.getByTestId("queue-row").filter({ hasText: "draft-001" });
  await expect(draftRow).toContainText("Draft");
  await draftRow.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("control-receipt")).toContainText("Confirmed · approve");
});

test("hanging state fetches time out without overlap and stop on unmount", async ({ page }) => {
  let requests = 0;
  await page.addInitScript(() => {
    const tracker = { active: 0, maximum: 0 };
    (window as unknown as { __stateFetchTracker: typeof tracker }).__stateFetchTracker = tracker;
    const original = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const stateRequest = new URL(rawUrl, location.href).pathname === "/api/v2/state";
      if (stateRequest) { tracker.active += 1; tracker.maximum = Math.max(tracker.maximum, tracker.active); }
      return original(input, init).finally(() => { if (stateRequest) tracker.active -= 1; });
    }) as typeof window.fetch;
  });
  await page.route("**/api/v2/state", async (route) => {
    requests += 1;
    try {
      if (requests === 1) return await route.continue();
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      await route.continue();
    } catch { /* The app's timeout aborts the browser request. */ }
  });
  await page.goto("/");
  await expect(page.getByTestId("watch-view")).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.locator(".global-stale")).toContainText("timed out", { timeout: 10_500 });
  expect(requests).toBe(2);
  const fetchTracker = await page.evaluate(() => (window as unknown as { __stateFetchTracker: { active: number; maximum: number } }).__stateFetchTracker);
  expect(fetchTracker.maximum).toBe(1);
  expect(fetchTracker.active).toBe(0);
  const settledRequestCount = requests;
  await page.goto("about:blank");
  await page.waitForTimeout(100);
  expect(requests).toBe(settledRequestCount);
});

test("provider cancellation stays pending while the task still owns its scope", async ({ page }) => {
  await installCoordinatorFixture(page, { managed: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("watch-view")).toBeVisible();
  await page.getByTestId("nav-queue").click();
  await expect(page.getByTestId("queue-row")).toHaveCount(50);
  await page.locator('[data-task-id="task-000"]').getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("control-receipt")).toContainText("Pending · cancel · HTTP 202 · Awaiting provider acknowledgment; scope remains owned.");
  await expect(page.getByTestId("queue-row").filter({ hasText: "task-000" })).toContainText("cancel_pending");
});
