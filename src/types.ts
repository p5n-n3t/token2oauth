import type { ToolPolicy } from "./tool-policy.js";

export type PoolStrategy =
  | "adaptive-sticky"
  | "round-robin"
  | "least-used"
  | "weighted-random"
  | "random"
  | "priority";

export type AccountState =
  | "healthy"
  | "cooldown"
  | "exhausted"
  | "auth-failed"
  | "disabled"
  | "unknown";

export interface EncryptedSecret {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export interface AccountStats {
  requests: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastUsedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  cooldownUntil?: number;
  state: AccountState;
  lastStatus?: number;
  lastError?: string;
  lastProbeAt?: number;
  lastProbeOk?: boolean;
  lastProbeStatus?: number;
  lastProbeError?: string;
}

export interface UpstreamAccount {
  id: string;
  label: string;
  provider: string;
  secret: EncryptedSecret;
  enabled: boolean;
  weight: number;
  priority: number;
  createdAt: number;
  stats: AccountStats;
  metadata?: Record<string, string>;
}

export interface GatewayConfig {
  upstreamUrl: string;
  upstreamAuthHeader: string;
  upstreamAuthScheme: string;
  strategy: PoolStrategy;
  basePath: string;
  publicBaseUrl: string;
  requestTimeoutMs: number;
  maxFailoverAttempts: number;
  failoverStateful: boolean;
  quotaCooldownSeconds: number;
  errorCooldownSeconds: number;
  quotaStatuses: number[];
  authFailureStatuses: number[];
  retryStatuses: number[];
  quotaBodyPatterns: string[];
  /**
   * Optional server-side MCP tool policy. Undefined means passthrough, which
   * keeps state files written before tool policies existed fully compatible.
   */
  toolPolicy?: ToolPolicy;
  /**
   * Tools that are known to be read-only and therefore safe to replay on a
   * different credential after an ambiguous failure (timeout, 5xx).
   */
  readOnlyTools?: string[];
}

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  tokenEndpointAuthMethod: string;
  createdAt: number;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  /** Admin credential epoch at issue time; codes from an older epoch are rejected. */
  adminEpoch?: number;
  resource: string;
  scope: string;
  expiresAt: number;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

/** Non-secret tool inventory captured from one upstream account via tools/list. */
export interface StoredToolRecord {
  name: string;
  title?: string;
  description?: string;
  schemaHash: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface StoredCapabilities {
  capturedAt: number;
  ok: boolean;
  complete: boolean;
  error?: string;
  surfaceHash?: string;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  tools: StoredToolRecord[];
}

export interface SecurityState {
  /** Incremented on admin credential rotation; older admin sessions and codes die. */
  adminEpoch?: number;
  /** Access tokens with iat (seconds) below this value are rejected. */
  accessTokenNotBefore?: number;
  adminRotatedAt?: number;
}

export interface PersistedState {
  version: 1;
  config: GatewayConfig;
  admin: {
    salt: string;
    hash: string;
  };
  accounts: UpstreamAccount[];
  oauthClients: OAuthClient[];
  refreshTokens: RefreshTokenRecord[];
  security?: SecurityState;
  /** Tool inventory per upstream account id. */
  capabilities?: Record<string, StoredCapabilities>;
}

export interface AccessClaims {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
}
