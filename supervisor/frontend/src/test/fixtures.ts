export function makeSlot(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "task-001",
    session_id: "session-001",
    account_id: "night-shift",
    logical_slot: 1,
    workspace_id: "/work/checkout",
    task_summary: "Review a deployment",
    requested_model: "nova-3",
    confirmed_model: "nova-3",
    requested_effort: "low",
    confirmed_effort: "low",
    started_at: 1_790_000_000,
    observed_at: 1_790_000_240,
    provider_state: "working",
    task_state: "running",
    observation_freshness: "fresh",
    references: [],
    ...overrides,
  };
}

export function makeState(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2 as const,
    project: { id: "trump-files", name: "Trump Files" },
    summary: { active_tasks: 1, incidents: 0 },
    accounts: [{ server_key: "night-shift", label: "Night shift", capacity: 4, enabled: true }],
    slots: [makeSlot()],
    incidents: [],
    settings: { interval: 300 },
    capabilities: {
      dispatch: { supported: false, reason: "Dispatch belongs to the configured external worker." },
    },
    cycle: { started_at: null, finished_at: null, checked: null },
    ...overrides,
  };
}

export function makeHistory(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `event-${index}`,
    at: 1_790_000_000 - index,
    kind: index % 2 ? "completed" : "failed",
    title: `Recorded outcome ${index}`,
    detail: "Source: local Snooze history",
    task_id: `task-${index}`,
  }));
}
