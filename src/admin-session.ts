import { randomToken } from "./crypto.js";
import { createCsrfToken, verifyCsrfToken } from "./admin-security.js";

interface AdminSession {
  expires: number;
  /** Admin credential epoch the session was created under. */
  epoch: number;
  csrf: string;
}

const MAX_SESSIONS = 500;

export class AdminSessions {
  private sessions = new Map<string, AdminSession>();

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
