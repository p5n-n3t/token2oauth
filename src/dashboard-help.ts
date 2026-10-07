import type { PoolStrategy } from "./types.js";

export interface StrategyHelp { title: string; definition: string; example: string }

/**
 * These descriptions match CredentialPool and McpProxy. Under every strategy an
 * established MCP session (and any task it started) stays on the credential
 * that created it; the strategy only chooses the credential for new sessions.
 */
export const strategyHelp: Record<PoolStrategy, StrategyHelp> = {
  "adaptive-sticky": {
    title: "Adaptive sticky",
    definition: "Favor eligible credentials with lower weighted request counts, fewer active requests and fewer failures. New sessions from the same OAuth client prefer the credential that client used before.",
    example: "Use for interactive MCP clients that benefit from keeping one account context while new sessions use healthier, less busy accounts.",
  },
  "round-robin": {
    title: "Round robin",
    definition: "Cycle through currently eligible credentials in order for each new session or stateless request. Established MCP sessions stay on their credential.",
    example: "Use for independent, stateless search requests when each account should receive a similar share of requests.",
  },
  "least-used": {
    title: "Least used",
    definition: "Choose the eligible credential with the lowest lifetime request count divided by its weight; active requests break ties. Request counts are not credit usage.",
    example: "Use for stateless calls when a larger account has a higher weight and should handle proportionally more requests.",
  },
  "weighted-random": {
    title: "Weighted random",
    definition: "Randomly choose an eligible credential in proportion to its weight for each new session or stateless request. Shares converge over many requests.",
    example: "Give a larger stateless search account weight 3 and a smaller one weight 1 for an expected 3:1 request split.",
  },
  "random": {
    title: "Random",
    definition: "Choose uniformly at random from eligible credentials for each new session or stateless request. It does not balance actual credits.",
    example: "Use for interchangeable stateless accounts when exact request distribution is unimportant.",
  },
  "priority": {
    title: "Priority",
    definition: "Prefer the eligible credential with the lowest priority number. Active requests and lifetime request count break equal-priority ties.",
    example: "Use a preferred stateless account first, then use a backup when the preferred account is disabled, rejected or cooling down.",
  },
};

export const parameterHelp = {
  maxFailoverAttempts: "Maximum credential attempts for one request, including the first attempt. 3 means one initial attempt and up to two alternatives. A request moves to another credential when the upstream refused it (401, 402, 429, quota text). After a timeout or 5xx only read-only requests (and tools marked replay-safe on the Tools page) are retried, so a tool call is never run twice. Requests inside an established MCP session stay on their credential.",
  quotaCooldownSeconds: "Fallback wait before a quota-limited credential becomes eligible again. A valid upstream Retry-After overrides this value. A cooldown does not replenish credits.",
  requestTimeoutMs: "Time allowed for each upstream attempt, in milliseconds, including its response stream. 120000 is two minutes. Several attempts can extend total request time; a timeout does not prove a remote operation failed.",
} as const;
