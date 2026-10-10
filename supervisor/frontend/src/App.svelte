<script lang="ts">
  import { onMount } from "svelte";
  import Shell from "./components/Shell.svelte";
  import Watch from "./components/Watch.svelte";
  import Queue from "./components/Queue.svelte";
  import Providers from "./components/Providers.svelte";
  import History from "./components/History.svelte";
  import HistoryPage from "./components/history/HistoryPage.svelte";
  import Settings from "./components/Settings.svelte";
  import TaskDrawer from "./components/TaskDrawer.svelte";
  import { getDashboardState, getHistory, getInbox, getQueue, getTaskDetail, getProviders, postControl, postLegacy } from "./lib/api";
  import type { ControlReceipt } from "./lib/api";
  import { LiveQuery } from "./lib/liveQuery.svelte";
  import { SettledPoller } from "./lib/settledPoller";
  import type { DashboardState, HistoryEntry, InboxPage, PageKey, QueueTask, TaskDetail } from "./lib/types";

  let dashboard = $state<DashboardState | null>(null);
  let page = $state<PageKey>("watch");
  let theme = $state<"dark" | "light">("dark");
  let loading = $state(true);
  let checking = $state(false);
  let saving = $state(false);
  let loadError = $state("");
  let notice = $state("");
  let historyEntries = $state<HistoryEntry[]>([]);
  let historyTotal = $state(0);
  let historyOffset = $state(0);
  const historyLimit = 25;
  let historyQuery = $state("");
  let historyLoading = $state(false);
  let historyError = $state("");
  let historyLoaded = $state(false);
  let historyRequestId = 0;
  let historyAbort: AbortController | null = null;
  let queueTasks = $state<QueueTask[]>([]);
  let queueTotal = $state(0);
  let queueOffset = $state(0);
  const queueLimit = 50;
  let queueLoading = $state(false);
  let queueError = $state("");
  let queueRequestId = 0;
  let queueAbort: AbortController | null = null;
  let inbox = $state<InboxPage | null>(null);
  let inboxError = $state("");
  let controlSaving = $state(false);
  let controlNotice = $state("");
  let drawerOpen = $state(false);
  let drawerLoading = $state(false);
  let drawerError = $state("");
  let taskDetail = $state<TaskDetail | null>(null);
  let selectedTaskId = $state<string | null>(null);
  let statePoller: SettledPoller<DashboardState> | null = null;
  const query = new LiveQuery();

  const selectedSlot = $derived(dashboard?.slots.find((slot) => slot.task_id === selectedTaskId) ?? null);
  const connectionLabel = $derived(loadError ? "Stale · last state retained" : dashboard ? "Connected" : "Connecting");

  function applyTheme(next: "dark" | "light") {
    theme = next;
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("snooze-theme", next); } catch { /* Storage may be disabled in private contexts. */ }
  }
  function toggleTheme() { applyTheme(theme === "dark" ? "light" : "dark"); }

  function refreshHistory(offset = historyOffset, nextQuery = historyQuery) {
    const requestId = ++historyRequestId;
    historyAbort?.abort();
    const controller = new AbortController();
    historyAbort = controller;
    historyLoading = true;
    historyError = "";
    void getHistory({ offset, limit: historyLimit, query: nextQuery }, (path, init) => fetch(path, { ...init, signal: controller.signal }))
      .then((result) => {
        if (requestId !== historyRequestId) return;
        historyEntries = result.entries;
        historyTotal = result.total;
        historyOffset = result.offset;
        historyQuery = nextQuery;
        historyLoaded = true;
      })
      .catch((error: unknown) => {
        if (requestId !== historyRequestId || controller.signal.aborted) return;
        historyError = error instanceof Error ? error.message : "The history request failed.";
      })
      .finally(() => {
        if (requestId !== historyRequestId) return;
        historyLoading = false;
        historyAbort = null;
      });
  }

  function refreshQueue(offset = queueOffset): Promise<void> {
    const requestId = ++queueRequestId;
    queueAbort?.abort();
    const controller = new AbortController();
    queueAbort = controller;
    queueLoading = true;
    queueError = "";
    return getQueue(offset, queueLimit, (path, init) => fetch(path, { ...init, signal: controller.signal }))
      .then((result) => {
        if (requestId !== queueRequestId) return;
        queueTasks = result.tasks;
        queueTotal = result.total;
        queueOffset = result.offset;
      })
      .catch((error: unknown) => {
        if (requestId !== queueRequestId || controller.signal.aborted) return;
        queueError = error instanceof Error ? error.message : "The queue request failed.";
      })
      .finally(() => {
        if (requestId !== queueRequestId) return;
        queueLoading = false;
        queueAbort = null;
      });
  }

  async function refreshProviders() {
    try {
      const result = await getProviders();
      if (dashboard) dashboard = { ...dashboard, accounts: result.accounts };
    } catch (error) {
      controlNotice = error instanceof Error ? `Provider list refresh failed: ${error.message}` : "Provider list refresh failed.";
    }
  }

  async function refreshInbox() {
    try { inbox = await getInbox(); inboxError = ""; }
    catch (error) { inboxError = error instanceof Error ? error.message : "The delivery inbox request failed."; }
  }

  function navigate(next: PageKey) {
    page = next;
    window.scrollTo(0, 0);
    if (next === "history" && !historyLoaded) refreshHistory(0, "");
    if (next === "queue" && !queueTasks.length) refreshQueue(0);
    if (next === "providers") void refreshProviders();
    if (next === "watch") void refreshInbox();
  }

  async function inspect(taskId: string) {
    selectedTaskId = taskId;
    taskDetail = null;
    drawerError = "";
    drawerLoading = true;
    drawerOpen = true;
    try { taskDetail = await getTaskDetail(taskId); }
    catch (error) { drawerError = error instanceof Error ? error.message : "The task request failed."; }
    finally { drawerLoading = false; }
  }

  function closeDrawer() {
    drawerOpen = false;
    selectedTaskId = null;
    taskDetail = null;
    drawerError = "";
  }

  async function checkNow() {
    checking = true;
    notice = "";
    try {
      await postLegacy("/api/check", {});
      notice = "Check accepted by the local service. Watch will update when the next cycle is reported.";
      await statePoller?.refresh();
    } catch (error) { notice = error instanceof Error ? error.message : "The check request failed."; }
    finally { checking = false; }
  }

  async function acknowledge(taskId: string | null, kind: string | null) {
    if (!taskId || !kind) return;
    notice = "";
    try {
      await postLegacy("/api/ack", { job: taskId, kind });
      notice = "Legacy local acknowledgement recorded. Durable delivery acknowledgment and resolution are separate.";
      await statePoller?.refresh();
      if (historyLoaded) refreshHistory(historyOffset, historyQuery);
    } catch (error) { notice = error instanceof Error ? error.message : "The acknowledgement was not recorded."; }
  }

  async function saveInterval(interval: number) {
    saving = true;
    notice = "";
    try {
      await postLegacy("/api/settings", { interval });
      notice = "Check interval saved by the local service.";
      await statePoller?.refresh();
    } catch (error) { notice = error instanceof Error ? error.message : "The setting was not saved."; }
    finally { saving = false; }
  }

  async function control(action: string, target: string, values: Record<string, unknown>, revision: number): Promise<ControlReceipt | null> {
    if (!dashboard) return null;
    controlSaving = true;
    controlNotice = `Submitting ${action}; waiting for the coordinator receipt…`;
    try {
      const receipt = await postControl({ action, target_id: target, values, expected_revision: revision });
      const state = receipt.state === "confirmed" ? "Confirmed" : receipt.state === "pending" ? "Pending" : "Rejected";
      controlNotice = `${state} · ${action} · HTTP ${receipt.status_code}${receipt.reason ? ` · ${receipt.reason}` : ""} · receipt ${receipt.action_id || "not reported"}`;
      if (receipt.state !== "rejected") {
        await statePoller?.refresh();
        if (page === "queue" || ["task-add", "hold", "approve", "prioritize", "retry", "resume", "cancel"].includes(action)) await refreshQueue(queueOffset);
        if (page === "providers" || ["account-config", "account-test"].includes(action)) await refreshProviders();
        if (page === "watch" || ["incident-ack", "coordinator-register"].includes(action)) await refreshInbox();
      }
      return receipt;
    } catch (error) {
      controlNotice = error instanceof Error
        ? `No receipt received · ${action} · ${error.message}. Reconcile state before repeating.`
        : `No receipt received · ${action}. Reconcile state before repeating.`;
      return null;
    } finally { controlSaving = false; }
  }

  function savePolicy(values: Record<string, unknown>, revision: number) {
    return control("policy-config", dashboard?.project.id ?? "", values, revision);
  }
  function navigateHistory(offset: number) { refreshHistory(offset, historyQuery); }
  function searchHistory(value: string) { refreshHistory(0, value); }

  onMount(() => {
    try {
      const saved = localStorage.getItem("snooze-theme");
      if (saved === "dark" || saved === "light") applyTheme(saved);
      else applyTheme("dark");
    } catch { applyTheme("dark"); }
    statePoller = new SettledPoller<DashboardState>(
      async (signal) => {
        const generation = query.begin(performance.now());
        const started = performance.now();
        const step = query.start("dashboard state", started);
        if (!dashboard) loading = true;
        try {
          const next = await getDashboardState(signal);
          if (query.isCurrent(generation)) query.settle(step, { name: "dashboard state", startMs: 0, durationMs: performance.now() - started });
          return next;
        } catch (error) { query.abandon(step); throw error; }
        finally { query.end(generation); }
      },
      (next) => { dashboard = next; loadError = ""; loading = false; },
      (error) => { loadError = dashboard ? error.message : `Snooze could not load the worker state. ${error.message}`; loading = false; },
      { intervalMs: 10_000, timeoutMs: 8_000, maxBackoffMs: 120_000 },
    );
    statePoller.start();
    void refreshInbox();
    return () => {
      statePoller?.stop();
      historyAbort?.abort();
      queueAbort?.abort();
    };
  });
</script>

<Shell active={page} projectName={dashboard?.project.name ?? "Snooze project"} {connectionLabel} {theme} onnav={navigate} ontoggleTheme={toggleTheme}>
  {#if dashboard}
    {#if loadError}<p class="stale-banner global-stale" role="status">Refresh failed: {loadError}. The last received state is still shown.</p>{/if}
    {#if controlNotice}<p class="control-receipt" role="status" data-testid="control-receipt">{controlNotice}</p>{/if}
    {#if page === "watch"}
      <Watch {dashboard} loading={checking} {notice} {inbox} {inboxError} oninspect={inspect} oncheck={checkNow} onack={acknowledge}
        onregister={(coordinatorId) => void control("coordinator-register", dashboard?.project.id ?? "", { coordinator_id: coordinatorId }, dashboard?.settings.revision ?? 0)}
        onincidentack={(deliveryId, coordinatorId) => void control("incident-ack", deliveryId, { coordinator_id: coordinatorId }, dashboard?.settings.revision ?? 0)} />
    {:else if page === "queue"}
      <Queue {dashboard} tasks={queueTasks} total={queueTotal} offset={queueOffset} limit={queueLimit} loading={queueLoading || controlSaving} error={queueError} onpage={refreshQueue} oninspect={inspect} oncontrol={control} />
    {:else if page === "providers"}
      <Providers {dashboard} oncontrol={control} />
    {:else if page === "history"}
      <HistoryPage oninspect={inspect} />
      <History entries={historyEntries} total={historyTotal} offset={historyOffset} limit={historyLimit} query={historyQuery} loading={historyLoading} error={historyError} oninspect={inspect} onpage={navigateHistory} onsearch={searchHistory} />
    {:else}
      <Settings {dashboard} saving={saving || controlSaving} {notice} onsave={saveInterval} onpolicy={savePolicy} oncontrol={control} />
    {/if}
  {:else}
    <section class="startup-state" role="status"><div class="startup-mark">S</div><p class="eyebrow">LOCAL WORKER CONTROL</p><h1>Connecting to Snooze</h1><p>{loadError || "Loading the latest worker state…"}</p><button type="button" class="retry-button" onclick={() => void statePoller?.refresh()}>Try again</button></section>
  {/if}
</Shell>

<TaskDrawer open={drawerOpen} detail={taskDetail} slot={selectedSlot} loading={drawerLoading} error={drawerError} onclose={closeDrawer} />
