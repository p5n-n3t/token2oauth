import express, { type NextFunction, type Request, type Response } from "express";
import { adminEpoch, parseCookies, AdminSessions } from "./admin-session.js";
import { validateJobToolArguments, type JobToolName } from "./job-submit.js";
import type { StateStore } from "./store.js";

export interface SupervisorCaller {
  /** OAuth client id; the durable bridge uses this to enforce project ownership. */
  clientId: string;
  projectId: string;
}

/** Semantic injection seam. A concrete adapter must delegate to the durable R13/R14 bridge. */
export interface SupervisorBackend {
  callTool(name: JobToolName, args: unknown, caller: SupervisorCaller): Promise<unknown>;
  readAdmin?(projectId: string): Promise<unknown>;
  controlAdmin?(input: { projectId: string; action: "pause_dispatch" | "resume_dispatch" | "emergency_stop"; expectedRevision: number }): Promise<unknown>;
}

export class SupervisorUnavailable extends Error {
  constructor() { super("Durable supervisor bridge is not configured"); this.name = "SupervisorUnavailable"; }
}

export class SupervisorApi {
  constructor(private readonly backend?: SupervisorBackend) {}

  get enabled(): boolean { return Boolean(this.backend); }

  async callTool(name: JobToolName, raw: unknown, clientId: string): Promise<unknown> {
    if (!this.backend) throw new SupervisorUnavailable();
    const args = validateJobToolArguments(name, raw) as Record<string, unknown>;
    const projectId = String(args.projectId);
    // The bridge must authorize this OAuth client against this exact project and
    // enforce ownership on all job/task/result/inbox reads and controls.
    return this.backend.callTool(name, args, { clientId, projectId });
  }
}

export function createSupervisorAdminRouter(store: StateStore, sessions: AdminSessions, backend?: SupervisorBackend) {
  const router = express.Router();
  const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    const state = await store.load();
    const token = parseCookies(req.headers.cookie)["t2o_admin"];
    if (!sessions.valid(token, adminEpoch(state))) return res.status(401).json({ error: "admin_session_required" });
    res.locals.supervisorAdminToken = token;
    next();
  };
  const requireCsrf = (req: Request, res: Response, next: NextFunction) => {
    const token = res.locals.supervisorAdminToken as string | undefined;
    if (!token || !sessions.verifyCsrf(token, req.header("x-csrf-token"))) return res.status(403).json({ error: "csrf_invalid" });
    next();
  };
  router.get("/admin/api/v1/supervisor/:projectId", requireAdmin, async (req, res) => {
    if (!backend?.readAdmin) return res.status(503).json({ error: "supervisor_unavailable" });
    const projectId = req.params.projectId;
    if (typeof projectId !== "string") return res.status(404).json({ error: "project_unavailable" });
    try { return res.json(await backend.readAdmin(projectId)); }
    catch { return res.status(404).json({ error: "project_unavailable" }); }
  });
  router.post("/admin/api/v1/supervisor/control", express.json({ limit: "16kb" }), requireAdmin, requireCsrf, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (!backend?.controlAdmin) return res.status(503).json({ error: "supervisor_unavailable" });
    if (!body || typeof body.projectId !== "string" || !["pause_dispatch", "resume_dispatch", "emergency_stop"].includes(String(body.action)) || !Number.isInteger(body.expectedRevision)) {
      return res.status(400).json({ error: "invalid_control_request" });
    }
    try {
      const result = await backend.controlAdmin(body as { projectId: string; action: "pause_dispatch" | "resume_dispatch" | "emergency_stop"; expectedRevision: number });
      return res.json(result);
    } catch { return res.status(409).json({ error: "control_conflict" }); }
  });
  return router;
}
