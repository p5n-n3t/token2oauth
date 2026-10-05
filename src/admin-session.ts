import { randomToken } from "./crypto.js";

export class AdminSessions {
  private sessions = new Map<string, number>();

  create(ttlMs = 12 * 60 * 60 * 1000): string {
    const token = randomToken(32);
    this.sessions.set(token, Date.now() + ttlMs);
    this.prune();
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires) return false;
    if (expires <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, expires] of this.sessions) {
      if (expires <= now) this.sessions.delete(token);
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
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}
