import { randomToken } from "./crypto.js";
import { createCsrfToken, verifyCsrfToken } from "./admin-security.js";

interface AdminSession {
  expires: number;
  /** Admin credential epoch the session was created under. */
  epoch: number;
  csrf: string;
}

const MAX_SESSIONS = 500;
/** Failed admin-password attempts allowed per client address per window. */
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_ADDRESSES = 5000;

export class AdminSessions {
  private sessions = new Map<string, AdminSession>();
  private failures = new Map<string, { count: number; resetAt: number }>();

  /**
   * Shared admin-password throttle for every place that accepts the password
   * (admin login and OAuth consent). Returns seconds to wait, or 0.
   */
  passwordBlocked(client: string): number {
    const entry = this.failures.get(client);
    if (!entry || entry.resetAt <= Date.now() || entry.count < LOGIN_FAILURE_LIMIT) return 0;
    return Math.ceil((entry.resetAt - Date.now()) / 1000);
  }

  passwordFailed(client: string): void {
    const now = Date.now();
    const entry = this.failures.get(client);
    const current = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    current.count += 1;
    this.failures.delete(client);
    this.failures.set(client, current);
    // Evict the oldest addresses instead of clearing every counter.
    while (this.failures.size > MAX_TRACKED_ADDRESSES) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  passwordSucceeded(client: string): void {
    this.failures.delete(client);
  }

  create(ttlMs = 12 * 60 * 60 * 1000, epoch = 0): string {
    const token = randomToken(32);
    this.sessions.set(token, { expires: Date.now() + ttlMs, epoch, csrf: createCsrfToken() });
    this.prune();
    return token;
  }

  /**
   * A session is valid only while unexpired and created under the current
   * admin epoch, so a password rotation (from the dashboard or the CLI, in
   * another process) signs out every existing browser session.
   */
  valid(token: string | undefined, epoch = 0): boolean {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expires <= Date.now() || session.epoch !== epoch) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /** The synchronizer CSRF token bound to a session, if the session exists. */
  csrfToken(token: string | undefined): string | undefined {
    return token ? this.sessions.get(token)?.csrf : undefined;
  }

  verifyCsrf(token: string | undefined, submitted: unknown): boolean {
    const expected = this.csrfToken(token);
    return Boolean(expected) && typeof submitted === "string" && verifyCsrfToken(expected!, submitted);
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  revokeAll(): void {
    this.sessions.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expires <= now) this.sessions.delete(token);
    }
    // Bound memory even under a flood of logins: drop the oldest sessions.
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const item of header.split(";")) {
    const idx = item.indexOf("=");
    if (idx < 0) continue;
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      // A malformed cookie must not crash request handling.
    }
  }
  return out;
}

export function adminEpoch(state: { security?: { adminEpoch?: number } }): number {
  return state.security?.adminEpoch ?? 0;
}
