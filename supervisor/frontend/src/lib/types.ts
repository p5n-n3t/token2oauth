export interface Account {
  id?: string;
  server_key: string | null;
  label: string | null;
  capacity: number | null;
  enabled: boolean | null;
  adapter?: string | null;
  revision?: number;
  models?: string[];
  efforts?: string[];
  priority?: number;
  reserve?: number;
  allow_unknown_quota?: boolean;
  quota_override?: { value?: number; unit?: string; expires_at?: number | null; source?: string } | null;
  identity?: string | null;
  quota?: { value?: number | null; unit?: string | null; expires_at?: number | null } | null;
  health?: string | null;
  capabilities?: Record<string, Capability>;
}

export interface Slot {
  task_id: string | null;
  session_id: string | null;
  account_id: string | null;
  logical_slot: number | null;
  workspace_id: string | null;
  task_summary: string | null;
  requested_model: string | null;
  confirmed_model: string | null;
  requested_effort: string | null;
  confirmed_effort: string | null;
  started_at: number | null;
  observed_at: number | null;
  provider_state: string | null;
  task_state: string | null;
  observation_freshness: string | null;
  references: string[];
}

export interface Incident {
  task_id: string | null;
  kind: string | null;
  message: string | null;
  at: number | null;
}

export interface Capability {
  supported: boolean;
  reason: string;
}

export interface DashboardState {
  schema_version: 2;
  project: { id: string; name: string };
  summary: { active_tasks: number; incidents: number };
  accounts: Account[];
  slots: Slot[];
  incidents: Incident[];
  settings: {
    interval: number | null;
    revision?: number;
    pause_dispatch?: boolean;
    emergency_stop?: boolean;
    max_concurrent?: number;
    global_concurrent?: number;
    max_recoveries?: number;
    backoff_seconds?: number;
    stall_seconds?: number;
    observation_workers?: number;
    request_timeout?: number;
    reserve?: number;
    allow_unknown_quota?: boolean;
    allow_native?: boolean;
    native_ceiling?: number;
    native_reserve?: number | null;
    model_limits?: Record<string, number>;
    mode?: "conservative" | "balanced" | "custom";
  };
  capabilities: { dispatch: Capability; [key: string]: Capability };
  cycle: { started_at: number | null; finished_at: number | null; checked: number | null };
}

export interface TaskDetail {
  task_id: string;
  summary: string | null;
  instruction: string | null;
  state: string | null;
  attempts: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  references: string[];
}

export interface HistoryEntry {
  id: string;
  at: number | null;
  kind: string;
  title: string;
  detail: string;
  task_id: string | null;
  source?: string;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

export interface QueueTask {
  id: string;
  project: string;
  state: string;
  priority: number;
  revision: number;
  created_at?: number;
  updated_at?: number;
  summary: string;
  approved: boolean;
}

export interface QueuePage {
  tasks: QueueTask[];
  total: number;
  offset: number;
}

export interface InboxDelivery {
  id: string;
  incident: string;
  project: string;
  state: string;
  payload: Record<string, unknown>;
  accepted_at: number | null;
  acknowledged_at: number | null;
  resolved: boolean;
  error_kind: string | null;
}

export interface InboxPage {
  deliveries: InboxDelivery[];
  wake_mode: "configured-channel" | "inbox-only" | string;
  reason: string | null;
}

export type PageKey = "watch" | "queue" | "providers" | "history" | "settings";
