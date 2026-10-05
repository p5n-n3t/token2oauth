import express from "express";
import { AdminSessions } from "./admin-session.js";
import { OAuthService } from "./oauth.js";
import { CredentialPool } from "./pool.js";
import { McpProxy } from "./proxy.js";
import { StateStore, normalizeBasePath } from "./store.js";

export interface ServerOptions {
  host?: string;
  port?: number;
}

export async function buildApp(store = new StateStore()) {
  await store.init();
  const state = await store.load();
  const sessions = new AdminSessions();
  const pool = new CredentialPool(store);
  const oauth = new OAuthService(store, sessions);
  const proxy = new McpProxy(store, pool);
  const ui = new (await import("./ui.js")).AdminUi(store, pool, sessions);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"]);

  const router = express.Router();
  router.use(oauth.router);
  router.use(ui.router);
  router.all(
    "/mcp",
    express.raw({ type: "*/*", limit: "32mb" }),
    oauth.authenticateMcp,
    proxy.handler,
  );

  const basePath = normalizeBasePath(state.config.basePath);
  if (basePath) app.use(basePath, router);
  // Also accept unprefixed routes. This makes Tailscale --set-path work whether
  // the reverse proxy strips the mount prefix or forwards it.
  app.use(router);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((error: any, _req: any, res: any, _next: any) => {
    console.error("[token2oauth]", error);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error", message: String(error?.message || error) });
  });

  return { app, store, pool };
}

export async function startServer(options: ServerOptions = {}) {
  const store = new StateStore();
  const init = await store.init();
  const { app } = await buildApp(store);
  const host = options.host || process.env.TOKEN2OAUTH_HOST || "127.0.0.1";
  const port = options.port || Number(process.env.TOKEN2OAUTH_PORT || 2030);

  const server = app.listen(port, host, () => {
    console.log("");
    console.log("  Token2OAuth");
    console.log("  ───────────────────────────────────────────");
    console.log("  Local:  http://" + host + ":" + port);
    void store.load().then((state) => {
      console.log("  Public: " + state.config.publicBaseUrl);
      console.log("  MCP:    " + state.config.publicBaseUrl.replace(/\/$/, "") + "/mcp");
      console.log("  Admin:  " + state.config.publicBaseUrl.replace(/\/$/, "") + "/admin");
      console.log("  Pool:   " + state.config.strategy);
      if (init.adminPassword) {
        console.log("");
        console.log("  NEW ADMIN PASSWORD");
        console.log("  " + init.adminPassword);
        console.log("  Save this now. It will not be shown by the server again.");
      }
      console.log("");
    });
  });

  return { server, store, init };
}
