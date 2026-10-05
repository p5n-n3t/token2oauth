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
