import { Readable } from "node:stream";
import type { Request, Response } from "express";
import type { AccessClaims } from "./types.js";
import { CredentialPool } from "./pool.js";
import { StateStore } from "./store.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
  "cookie",
  "content-length",
]);

function copyRequestHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const item of raw) headers.append(key, item);
    } else {
      headers.set(key, String(raw));
    }
  }
  return headers;
}

function copyResponseHeaders(source: Headers, res: Response): void {
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "set-cookie") return;
    res.setHeader(key, value);
  });
}

async function responseTextCapped(response: globalThis.Response, max = 1024 * 1024): Promise<string> {
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > max) return buf.subarray(0, max).toString("utf8") + "\n[truncated]";
  return buf.toString("utf8");
}

export class McpProxy {
  constructor(
    private readonly store: StateStore,
    private readonly pool: CredentialPool,
  ) {}

  handler = async (req: Request, res: Response) => {
    let state = await this.store.load();
    if (!state.config.upstreamUrl) {
      return res.status(503).json({
        error: "upstream_not_configured",
        message: "Set the upstream MCP URL in the Token2OAuth admin page or CLI.",
      });
    }

    const incomingSession = req.header("mcp-session-id") || undefined;
    const claims = (res.locals as any).oauthClaims as AccessClaims | undefined;
    const affinityKey = incomingSession || claims?.sub;
    const attempted = new Set<string>();
    const stateful = Boolean(incomingSession);
    const maxAttempts = stateful && !state.config.failoverStateful
      ? 1
      : Math.max(1, Math.min(state.config.maxFailoverAttempts, state.accounts.length || 1));

    let lastStatus = 503;
    let lastBody = "";
    let lastHeaders: Headers | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      state = await this.store.load();
      const account = this.pool.pick(state, {
        sessionId: affinityKey,
        exclude: attempted,
      });
      if (!account) break;
      attempted.add(account.id);
      this.pool.start(account.id);

      try {
        const token = await this.store.revealToken(account);
        const target = new URL(state.config.upstreamUrl);
        const incoming = new URL(req.originalUrl, "http://token2oauth.local");
        target.search = incoming.search;

        const headers = copyRequestHeaders(req);
        const scheme = state.config.upstreamAuthScheme.trim();
        headers.set(
          state.config.upstreamAuthHeader,
          scheme ? scheme + " " + token : token,
        );
        headers.set("x-token2oauth-gateway", "1");

        const body =
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : Buffer.isBuffer(req.body)
              ? req.body
              : req.body === undefined
                ? undefined
                : Buffer.from(
                    typeof req.body === "string" ? req.body : JSON.stringify(req.body),
                  );

        const upstream = await fetch(target, {
          method: req.method,
          headers,
          body: body ? new Uint8Array(body) : undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(state.config.requestTimeoutMs),
        });

        const upstreamSession = upstream.headers.get("mcp-session-id") || undefined;
        if (upstream.ok) {
          this.pool.bindSession(incomingSession, account.id);
          this.pool.bindSession(upstreamSession, account.id);
          await this.pool.success(account.id, upstream.status, upstreamSession || affinityKey);
          copyResponseHeaders(upstream.headers, res);
          res.status(upstream.status);
          if (!upstream.body || req.method === "HEAD") return res.end();
          Readable.fromWeb(upstream.body as any).pipe(res);
          return;
        }

        const text = await responseTextCapped(upstream);
        lastStatus = upstream.status;
        lastBody = text;
        lastHeaders = upstream.headers;
        const result = await this.pool.failure(
          account.id,
          {
            status: upstream.status,
            body: text,
            retryAfter: upstream.headers.get("retry-after"),
          },
          state.config,
        );

        if (!result.retryable || stateful && !state.config.failoverStateful) break;
      } catch (error: any) {
        lastStatus = 502;
        lastBody = JSON.stringify({
          error: "upstream_unavailable",
          message: error?.name === "TimeoutError" ? "Upstream request timed out." : String(error?.message || error),
        });
        const result = await this.pool.failure(
          account.id,
          { error: String(error?.message || error) },
          state.config,
        );
        if (!result.retryable || stateful && !state.config.failoverStateful) break;
      } finally {
        this.pool.finish(account.id);
      }
    }

    if (lastHeaders) copyResponseHeaders(lastHeaders, res);
    res.status(lastStatus);
    if (!res.getHeader("content-type")) res.type("application/json");
    if (lastBody) return res.send(lastBody);
    return res.status(503).json({
      error: "no_healthy_upstream_credentials",
      message: "Every enabled upstream credential is unavailable, cooling down, exhausted, or authentication-failed.",
    });
  };
}
