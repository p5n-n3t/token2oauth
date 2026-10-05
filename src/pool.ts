import type {
  GatewayConfig,
  PersistedState,
  PoolStrategy,
  UpstreamAccount,
} from "./types.js";
import { StateStore } from "./store.js";

export interface FailureInfo {
  status?: number;
  body?: string;
  retryAfter?: string | null;
  error?: string;
}

function retryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function bodyMatchesQuota(body: string | undefined, cfg: GatewayConfig): boolean {
  if (!body) return false;
  const sample = body.slice(0, 16_384);
  return cfg.quotaBodyPatterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(sample);
    } catch {
      return sample.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

export class CredentialPool {
  private rr = 0;
  private active = new Map<string, number>();
  private sessionAffinity = new Map<string, { accountId: string; touchedAt: number }>();

  constructor(private readonly store: StateStore) {}

  private isEligible(account: UpstreamAccount, now = Date.now()): boolean {
    if (!account.enabled || account.stats.state === "disabled") return false;
    if (
      (account.stats.state === "auth-failed" ||
        account.stats.state === "exhausted" ||
        account.stats.state === "cooldown") &&
      account.stats.cooldownUntil &&
      account.stats.cooldownUntil <= now
    ) {
      return true;
    }
    if (account.stats.state === "auth-failed" && !account.stats.cooldownUntil) return false;
    if (account.stats.state === "exhausted" && !account.stats.cooldownUntil) return false;
    if (account.stats.cooldownUntil && account.stats.cooldownUntil > now) return false;
    return true;
  }

  private cleanupAffinity(): void {
    if (this.sessionAffinity.size < 1000) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, value] of this.sessionAffinity) {
      if (value.touchedAt < cutoff) this.sessionAffinity.delete(key);
    }
  }

  bindSession(sessionId: string | undefined, accountId: string): void {
    if (!sessionId) return;
    this.sessionAffinity.set(sessionId, { accountId, touchedAt: Date.now() });
    this.cleanupAffinity();
  }

  private selectByStrategy(
    candidates: UpstreamAccount[],
    strategy: PoolStrategy,
  ): UpstreamAccount {
    if (candidates.length === 1) return candidates[0];

    switch (strategy) {
      case "round-robin": {
        const picked = candidates[this.rr % candidates.length];
        this.rr = (this.rr + 1) % Number.MAX_SAFE_INTEGER;
        return picked;
      }
      case "random":
        return candidates[Math.floor(Math.random() * candidates.length)];
      case "weighted-random": {
        const total = candidates.reduce((n, a) => n + Math.max(0.01, a.weight), 0);
        let target = Math.random() * total;
        for (const account of candidates) {
          target -= Math.max(0.01, account.weight);
          if (target <= 0) return account;
        }
        return candidates[candidates.length - 1];
      }
      case "priority":
        return [...candidates].sort(
          (a, b) =>
            a.priority - b.priority ||
            (this.active.get(a.id) || 0) - (this.active.get(b.id) || 0) ||
            a.stats.requests - b.stats.requests,
        )[0];
      case "least-used":
        return [...candidates].sort(
          (a, b) =>
            a.stats.requests / Math.max(0.01, a.weight) -
              b.stats.requests / Math.max(0.01, b.weight) ||
            (this.active.get(a.id) || 0) - (this.active.get(b.id) || 0),
        )[0];
      case "adaptive-sticky":
      default:
        return [...candidates].sort((a, b) => this.score(a) - this.score(b))[0];
    }
  }

  private score(account: UpstreamAccount): number {
    const active = this.active.get(account.id) || 0;
    const failureRate =
      account.stats.requests > 0
        ? account.stats.failures / account.stats.requests
        : 0;
    const normalizedUsage = account.stats.requests / Math.max(0.01, account.weight);
    return (
      normalizedUsage +
      active * 8 +
      failureRate * 25 +
      account.stats.consecutiveFailures * 15 +
      account.priority / 1000
    );
  }

  pick(
    state: PersistedState,
    options: { sessionId?: string; exclude?: Set<string> } = {},
  ): UpstreamAccount | undefined {
    const exclude = options.exclude || new Set<string>();
    const eligible = state.accounts.filter(
      (a) => this.isEligible(a) && !exclude.has(a.id),
    );
    if (!eligible.length) return undefined;

    if (state.config.strategy === "adaptive-sticky" && options.sessionId) {
      const affinity = this.sessionAffinity.get(options.sessionId);
      if (affinity) {
        const sticky = eligible.find((a) => a.id === affinity.accountId);
        if (sticky) {
          affinity.touchedAt = Date.now();
          return sticky;
        }
      }
    }
    return this.selectByStrategy(eligible, state.config.strategy);
  }

  start(accountId: string): void {
    this.active.set(accountId, (this.active.get(accountId) || 0) + 1);
  }

  finish(accountId: string): void {
    const current = Math.max(0, (this.active.get(accountId) || 1) - 1);
    if (current === 0) this.active.delete(accountId);
    else this.active.set(accountId, current);
  }

  async success(accountId: string, status: number, sessionId?: string): Promise<void> {
    this.bindSession(sessionId, accountId);
    await this.store.update((state) => {
      const account = state.accounts.find((a) => a.id === accountId);
      if (!account) return;
      account.stats.requests += 1;
      account.stats.successes += 1;
      account.stats.consecutiveFailures = 0;
      account.stats.lastUsedAt = Date.now();
      account.stats.lastSuccessAt = Date.now();
      account.stats.lastStatus = status;
      account.stats.lastError = undefined;
      account.stats.cooldownUntil = undefined;
      account.stats.state = "healthy";
    });
  }

  classifyFailure(
    info: FailureInfo,
    cfg: GatewayConfig,
  ): {
    retryable: boolean;
    state: UpstreamAccount["stats"]["state"];
    cooldownUntil?: number;
    message: string;
  } {
    const status = info.status;
    const quota =
      (status !== undefined && cfg.quotaStatuses.includes(status)) ||
      bodyMatchesQuota(info.body, cfg);

    if (status !== undefined && cfg.authFailureStatuses.includes(status)) {
      return {
        retryable: true,
        state: "auth-failed",
        message: "upstream authentication rejected",
      };
    }

    if (quota) {
      const retryMs = retryAfterMs(info.retryAfter);
      return {
        retryable: true,
        state: status === 402 ? "exhausted" : "cooldown",
        cooldownUntil:
          Date.now() + (retryMs ?? cfg.quotaCooldownSeconds * 1000),
        message: "upstream quota/rate limit detected",
      };
    }

    const retryable =
      status === undefined || cfg.retryStatuses.includes(status);
    return {
      retryable,
      state: retryable ? "cooldown" : "healthy",
      cooldownUntil: retryable
        ? Date.now() + cfg.errorCooldownSeconds * 1000
        : undefined,
      message: info.error || (status ? "upstream HTTP " + status : "upstream failure"),
    };
  }

  async failure(
    accountId: string,
    info: FailureInfo,
    cfg: GatewayConfig,
  ): Promise<{ retryable: boolean }> {
    const classification = this.classifyFailure(info, cfg);
    await this.store.update((state) => {
      const account = state.accounts.find((a) => a.id === accountId);
      if (!account) return;
      account.stats.requests += 1;
      account.stats.failures += 1;
      account.stats.consecutiveFailures += 1;
      account.stats.lastUsedAt = Date.now();
      account.stats.lastFailureAt = Date.now();
      account.stats.lastStatus = info.status;
      account.stats.lastError = classification.message;
      account.stats.state = classification.state;
      account.stats.cooldownUntil = classification.cooldownUntil;
    });
    return { retryable: classification.retryable };
  }

  snapshot(state: PersistedState) {
    const now = Date.now();
    return state.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      provider: a.provider,
      enabled: a.enabled,
      weight: a.weight,
      priority: a.priority,
      state:
        a.stats.cooldownUntil && a.stats.cooldownUntil <= now && a.enabled
          ? "ready"
          : a.stats.state,
      active: this.active.get(a.id) || 0,
      requests: a.stats.requests,
      successes: a.stats.successes,
      failures: a.stats.failures,
      cooldownUntil: a.stats.cooldownUntil,
      lastStatus: a.stats.lastStatus,
      lastError: a.stats.lastError,
    }));
  }
}
