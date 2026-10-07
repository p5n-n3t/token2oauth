import { randomBytes, timingSafeEqual } from "node:crypto";
import { hashPassword } from "./crypto.js";
import type { AccessClaims, PersistedState } from "./types.js";

const MIN_ADMIN_PASSWORD_LENGTH = 12;
const CSRF_TOKEN_BYTES = 32;

export interface AdminCredentialRotationPlan {
  /** Apply this narrow patch to PersistedState; unrelated settings and credentials are untouched. */
  statePatch: Pick<PersistedState, "admin" | "refreshTokens">;
  /** Clear the process-local AdminSessions and pending OAuth authorization-code stores. */
  revokeAdminSessions: true;
  revokeAuthorizationCodes: true;
  /** Reject claims with iat below this value after wiring a cutoff check into access-token auth. */
  minimumAcceptedAccessTokenIat: number;
}

/** Generate a 256-bit URL-safe password. Keep the returned value secret and show it only once. */
export function generateAdminPassword(): string {
  return randomBytes(32).toString("base64url");
}

/** Generate a 256-bit synchronizer token suitable for a CSRF form token. */
export function createCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
}

/** Compare a submitted CSRF token without leaking a byte-by-byte timing signal. */
export function verifyCsrfToken(expected: string, submitted: string): boolean {
  if (!isCsrfToken(expected) || !isCsrfToken(submitted)) return false;
  const expectedBytes = Buffer.from(expected, "base64url");
  const submittedBytes = Buffer.from(submitted, "base64url");
  return expectedBytes.length === submittedBytes.length && timingSafeEqual(expectedBytes, submittedBytes);
}

/**
 * Plan an admin password rotation without mutating state or performing persistence.
 * `nowMs` is injectable so callers and tests can agree on the token cutoff boundary.
 */
export function planAdminCredentialRotation(
  _currentState: Readonly<PersistedState>,
  newPassword: string,
  nowMs = Date.now(),
): AdminCredentialRotationPlan {
  if (newPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`Admin password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`);
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error("nowMs must be a non-negative timestamp.");

  return {
    statePatch: {
      admin: hashPassword(newPassword),
      refreshTokens: [],
    },
    revokeAdminSessions: true,
    revokeAuthorizationCodes: true,
    // Existing claims use whole-second iat values. Advancing one second ensures every
    // token issued in the rotation second is rejected by a `iat >= cutoff` check.
    minimumAcceptedAccessTokenIat: Math.floor(nowMs / 1000) + 1,
  };
}

/** Return whether a signed access-token claim survives a previously applied rotation plan. */
export function accessTokenSurvivesRotation(
  claims: Pick<AccessClaims, "iat">,
  minimumAcceptedAccessTokenIat: number,
): boolean {
  return Number.isInteger(claims.iat) && claims.iat >= minimumAcceptedAccessTokenIat;
}

/**
 * Validate an admin login's `next` value. Root-relative paths and absolute URLs on the
 * configured public origin are accepted; protocol-relative and foreign-origin URLs are not.
 */
export function validateAdminRedirect(next: string, publicBaseUrl: string): string | null {
  if (!next || /[\u0000-\u001f\u007f\\]/.test(next)) return null;

  let base: URL;
  try {
    base = new URL(publicBaseUrl);
  } catch {
    return null;
  }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password) return null;

  if (next.startsWith("/")) {
    if (next.startsWith("//")) return null;
    try {
      const target = new URL(next, base);
      return target.origin === base.origin ? target.pathname + target.search + target.hash : null;
    } catch {
      return null;
    }
  }

  try {
    const target = new URL(next);
    return target.origin === base.origin && !target.username && !target.password ? target.toString() : null;
  } catch {
    return null;
  }
}

function isCsrfToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === CSRF_TOKEN_BYTES && bytes.toString("base64url") === value;
}
