import test from "node:test";
import assert from "node:assert/strict";
import {
  OWNED_PATH,
  OWNED_TARGET,
  ROOT_TARGET,
  SERVICE_UNIT,
  LifecycleController,
  canonicalJson,
  inspectRoutes,
  isWithinOwnedPath,
  ownedSubpath,
  assertWithinOwnedPath,
  parseServeConfig,
  planDown,
  planStatus,
  planUp,
  unrelatedView,
  validateStep,
  DEFAULT_ROUTES,
} from "../dist/lifecycle.js";

const HP = "node.example.ts.net:443";

const sharedConfig = ({ owned = false, funnel = true, extra = {} } = {}) => ({
  TCP: { 443: { HTTPS: true } },
  Web: {
    [HP]: {
      Handlers: {
        "/": { Proxy: ROOT_TARGET },
        ...(owned ? { [OWNED_PATH]: { Proxy: OWNED_TARGET } } : {}),
        ...extra,
      },
    },
  },
  ...(funnel ? { AllowFunnel: { [HP]: true } } : {}),
});

const withOther = (sc) => ({
  ...sc,
  TCP: { ...sc.TCP, 8443: { HTTPS: true } },
  Web: { ...sc.Web, "node.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } },
});

/**
 * In-memory stand-in for systemctl and tailscale. It mirrors the documented
 * Tailscale semantics this module relies on (scoped `off` removes one mount,
 * cascading listener/AllowFunnel cleanup only when no mounts remain; `serve`
 * on a listener clears AllowFunnel, `funnel` sets it). It never touches the OS.
 */
class FakeHost {
  constructor({ config, active = "inactive", misbehave } = {}) {
    this.config = structuredClone(config ?? {});
    this.active = active;
    this.calls = [];
    this.misbehave = misbehave;
    this.onStatusRead = undefined;
  }

  runner = async (command, args) => {
    this.calls.push([command, ...args]);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (command === "systemctl") {
      const [, verb, unit] = args;
      assert.equal(unit, SERVICE_UNIT);
      if (verb === "is-active") return { code: this.active === "active" ? 0 : 3, stdout: this.active + "\n", stderr: "" };
      if (verb === "is-enabled") return ok("enabled\n");
      if (verb === "start") { this.active = "active"; return ok(); }
      if (verb === "stop") { this.active = "inactive"; return ok(); }
    }
    if (command === "tailscale") {
      if (args.join(" ") === "serve status --json") {
        this.onStatusRead?.(this);
        return ok(JSON.stringify(this.config));
      }
      const [sub] = args;
      const https = args.find((a) => a.startsWith("--https=")).slice(8);
      const mount = args.find((a) => a.startsWith("--set-path=")).slice(11);
      const hp = Object.keys(this.config.Web ?? {}).find((k) => k.endsWith(":" + https)) ?? `node.example.ts.net:${https}`;
      if (args.at(-1) === "off") {
        delete this.config.Web[hp].Handlers[mount];
        if (Object.keys(this.config.Web[hp].Handlers).length === 0) {
          delete this.config.Web[hp];
          delete this.config.TCP[https];
          if (this.config.AllowFunnel) delete this.config.AllowFunnel[hp];
        }
      } else {
        this.config.TCP ??= {};
        this.config.TCP[https] ??= { HTTPS: true };
        this.config.Web ??= {};
        this.config.Web[hp] ??= { Handlers: {} };
        this.config.Web[hp].Handlers[mount] = { Proxy: args.at(-1) };
        this.config.AllowFunnel ??= {};
        if (sub === "funnel") this.config.AllowFunnel[hp] = true;
        else delete this.config.AllowFunnel[hp];
      }
      this.misbehave?.(this);
      return ok();
    }
    return { code: 127, stdout: "", stderr: "unexpected command" };
  };

  mutatingCalls() {
    return this.calls.filter(
      (c) => !(c[0] === "systemctl" && ["is-active", "is-enabled"].includes(c[2])) && c.join(" ") !== "tailscale serve status --json",
    );
  }
}

const observe = async (config, active = "inactive") => new LifecycleController(new FakeHost({ config, active }).runner).observe();

const assertNeverDangerous = (steps) => {
  for (const step of steps) {
    const line = [step.command, ...step.args].join(" ");
    assert.doesNotMatch(line, /\breset\b/);
    assert.doesNotMatch(line, /tailscaled/);
    assert.doesNotMatch(line, /--set-path=\/(\s|$)/);
    if (step.kind === "tailscale") assert.ok(step.args.includes(`--set-path=${OWNED_PATH}`), line);
  }
};

test("parseServeConfig accepts empty output and rejects non-objects", () => {
  assert.deepEqual(parseServeConfig(""), {});
  assert.deepEqual(parseServeConfig("{}\n"), {});
  assert.throws(() => parseServeConfig("[]"));
});

test("inspectRoutes classifies root, owned, collision and foreign mounts", () => {
  const absent = inspectRoutes(sharedConfig());
  assert.equal(absent.hostPort, HP);
  assert.equal(absent.funnel, true);
  assert.equal(absent.root.matchesExpected, true);
  assert.equal(absent.owned.state, "absent");

  const owned = inspectRoutes(sharedConfig({ owned: true, extra: { "/token2oauth/pool-a": { Proxy: "http://127.0.0.1:2031" }, "/other": { Proxy: "http://127.0.0.1:7000" } } }));
  assert.equal(owned.owned.state, "owned");
  assert.deepEqual(owned.ownedSubpaths.map((s) => s.mount), ["/token2oauth/pool-a"]);
  assert.deepEqual(owned.foreignMounts, ["/other"]);

  const trailing = inspectRoutes(sharedConfig({ extra: { [OWNED_PATH]: { Proxy: OWNED_TARGET + "/" } } }));
  assert.equal(trailing.owned.state, "owned", "trailing slash on target is the same target");

  const collision = inspectRoutes(sharedConfig({ extra: { [OWNED_PATH]: { Proxy: "http://127.0.0.1:9999" } } }));
  assert.equal(collision.owned.state, "collision");
  const fileCollision = inspectRoutes(sharedConfig({ extra: { [OWNED_PATH + "/"]: { Path: "/srv/x" } } }));
  assert.equal(fileCollision.owned.state, "collision");
});

test("planUp adds only the owned mount with the listener's own subcommand", async () => {
  const funnelPlan = planUp(await observe(sharedConfig()));
  assert.equal(funnelPlan.ok, true);
  assert.deepEqual(funnelPlan.steps.map((s) => [s.command, ...s.args]), [
    ["systemctl", "--user", "start", SERVICE_UNIT],
    ["tailscale", "funnel", "--bg", "--https=443", `--set-path=${OWNED_PATH}`, OWNED_TARGET],
  ]);
  assertNeverDangerous(funnelPlan.steps);

  const servePlan = planUp(await observe(sharedConfig({ funnel: false }), "active"));
  assert.deepEqual(servePlan.steps.map((s) => s.args[0]), ["serve"]);

  const noop = planUp(await observe(sharedConfig({ owned: true }), "active"));
  assert.equal(noop.ok, true);
  assert.deepEqual(noop.steps, []);
});

test("planUp rejects collisions, AllowFunnel flips, TCP forwards and ambiguous hosts", async () => {
  const collision = planUp(await observe(sharedConfig({ extra: { [OWNED_PATH]: { Proxy: "http://127.0.0.1:9999" } } })));
  assert.equal(collision.ok, false);
  assert.match(collision.blockers.join(), /collision/);
  assert.deepEqual(collision.steps, []);

  const flip = planUp(await observe(sharedConfig()), { mode: "serve" });
  assert.equal(flip.ok, false);
  assert.match(flip.blockers.join(), /AllowFunnel/);
  const flipOn = planUp(await observe(sharedConfig({ funnel: false })), { mode: "funnel" });
  assert.equal(flipOn.ok, false);

  const tcp = planUp(await observe({ TCP: { 443: { TCPForward: "127.0.0.1:22" } } }));
  assert.equal(tcp.ok, false);

  const two = sharedConfig();
  two.Web["other.example.ts.net:443"] = { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } };
  assert.equal(planUp(await observe(two)).ok, false);
  assert.equal(planUp(await observe(two), { routes: { host: "node.example.ts.net" } }).ok, true);
});

test("planUp on an empty config creates the listener with the requested mode", async () => {
  const plan = planUp(await observe({}), { mode: "serve" });
  assert.equal(plan.ok, true);
  assert.equal(plan.steps.at(-1).args[0], "serve");
  assert.equal(planUp(await observe({})).steps.at(-1).args[0], "funnel");
});

test("planDown removes only an exactly-matching owned mount, never root", async () => {
  const plan = planDown(await observe(sharedConfig({ owned: true }), "active"));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps.map((s) => [s.command, ...s.args]), [
    ["tailscale", "funnel", "--https=443", `--set-path=${OWNED_PATH}`, "off"],
    ["systemctl", "--user", "stop", SERVICE_UNIT],
  ]);
  assertNeverDangerous(plan.steps);

  const collision = planDown(await observe(sharedConfig({ extra: { [OWNED_PATH]: { Proxy: "http://127.0.0.1:9999" } } }), "active"));
  assert.equal(collision.ok, false);
  assert.match(collision.blockers.join(), /refusing to remove/);

  const only = { TCP: { 443: { HTTPS: true } }, Web: { [HP]: { Handlers: { [OWNED_PATH]: { Proxy: OWNED_TARGET } } } }, AllowFunnel: { [HP]: true } };
  const last = planDown(await observe(only, "active"));
  assert.equal(last.ok, false);
  assert.match(last.blockers.join(), /only handler/);
  assert.equal(planDown(await observe(only, "active"), { keepRoute: true }).ok, true);

  const absent = planDown(await observe(sharedConfig(), "active"));
  assert.equal(absent.ok, true);
  assert.deepEqual(absent.steps.map((s) => s.id), ["service-stop"]);
});

test("dashboard-initiated down requires acknowledging it cannot restart itself", async () => {
  const state = await observe(sharedConfig({ owned: true }), "active");
  const blocked = planDown(state, { invokedFrom: "dashboard" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.blockers.join(), /cannot start itself/);
  assert.equal(planDown(state, { invokedFrom: "dashboard", acknowledgeNoSelfRestart: true }).ok, true);
  assert.equal(planDown(state, { invokedFrom: "dashboard", keepService: true }).ok, true);
});

test("planStatus reports health problems", async () => {
  assert.equal(planStatus(await observe(sharedConfig({ owned: true }), "active")).healthy, true);
  const sick = planStatus(await observe({}, "failed"));
  assert.equal(sick.healthy, false);
  assert.equal(sick.problems.length, 3);
});

test("controller is dry-run by default and makes no OS writes", async () => {
  const host = new FakeHost({ config: sharedConfig() });
  const controller = new LifecycleController(host.runner);
  const plan = await controller.plan("up");
  const before = structuredClone(host.config);
  for (const opts of [undefined, {}, { execute: false }, { execute: "yes" }]) {
    const report = await controller.execute(plan, opts);
    assert.equal(report.executed, false);
    assert.equal(report.commands.length, 2);
  }
  assert.deepEqual(host.mutatingCalls(), []);
  assert.deepEqual(host.config, before);
  assert.equal(host.active, "inactive");
});

test("controller up then down preserves root, AllowFunnel and other listeners", async () => {
  const initial = withOther(sharedConfig());
  const host = new FakeHost({ config: initial });
  const controller = new LifecycleController(host.runner);

  const up = await controller.execute(await controller.plan("up"), { execute: true });
  assert.equal(up.ok, true, up.error);
  assert.equal(host.active, "active");
  assert.equal(host.config.Web[HP].Handlers[OWNED_PATH].Proxy, OWNED_TARGET);
  assert.equal(host.config.Web[HP].Handlers["/"].Proxy, ROOT_TARGET);
  assert.equal(host.config.AllowFunnel[HP], true);

  const down = await controller.execute(await controller.plan("down"), { execute: true });
  assert.equal(down.ok, true, down.error);
  assert.equal(host.active, "inactive");
  assert.equal(canonicalJson(host.config), canonicalJson(initial));
  for (const call of host.mutatingCalls()) assertNeverDangerous([{ command: call[0], args: call.slice(1), kind: call[0] }]);
});

test("controller refuses to write when Serve config drifted after planning", async () => {
  const host = new FakeHost({ config: sharedConfig() });
  const controller = new LifecycleController(host.runner);
  const plan = await controller.plan("up");
  host.config.Web[HP].Handlers["/late"] = { Proxy: "http://127.0.0.1:7777" };
  const report = await controller.execute(plan, { execute: true });
  assert.equal(report.ok, false);
  assert.match(report.error, /changed since the plan/);
  assert.equal(host.mutatingCalls().filter((c) => c[0] === "tailscale").length, 0);
});

test("controller detects unrelated config damage after a write", async () => {
  const host = new FakeHost({
    config: sharedConfig({ owned: true }),
    active: "active",
    misbehave: (h) => { delete h.config.AllowFunnel[HP]; },
  });
  const controller = new LifecycleController(host.runner);
  const report = await controller.execute(await controller.plan("down"), { execute: true });
  assert.equal(report.ok, false);
  assert.match(report.error, /unrelated/);
  assert.equal(host.active, "active", "stops before the service step");
});

test("controller refuses blocked or tampered plans", async () => {
  const host = new FakeHost({ config: sharedConfig({ extra: { [OWNED_PATH]: { Proxy: "http://127.0.0.1:9999" } } }) });
  const controller = new LifecycleController(host.runner);
  const blocked = await controller.execute(await controller.plan("up"), { execute: true });
  assert.equal(blocked.executed, false);
  assert.match(blocked.error, /blocked/);

  const clean = new FakeHost({ config: sharedConfig({ owned: true }), active: "active" });
  const c2 = new LifecycleController(clean.runner);
  const plan = await c2.plan("down");
  plan.steps[0] = { ...plan.steps[0], args: ["serve", "reset"] };
  const report = await c2.execute(plan, { execute: true });
  assert.equal(report.ok, false);
  assert.match(report.error, /unrecognised/);
  assert.deepEqual(clean.mutatingCalls(), []);

  for (const args of [["funnel", "--https=443", "--set-path=/", "off"], ["serve", "--https=443", "off"]]) {
    assert.throws(() => validateStep({ id: "route-remove", kind: "tailscale", command: "tailscale", args, description: "" }, DEFAULT_ROUTES));
  }
});

test("unrelatedView ignores only the owned mount and its sole-handler scaffolding", () => {
  const empty = canonicalJson(unrelatedView({}));
  const onlyOwned = { TCP: { 443: { HTTPS: true } }, Web: { [HP]: { Handlers: { [OWNED_PATH]: { Proxy: OWNED_TARGET } } } }, AllowFunnel: { [HP]: true } };
  assert.equal(canonicalJson(unrelatedView(onlyOwned)), empty);
  assert.equal(canonicalJson(unrelatedView(sharedConfig({ owned: true }))), canonicalJson(unrelatedView(sharedConfig())));
  assert.notEqual(canonicalJson(unrelatedView(sharedConfig())), canonicalJson(unrelatedView(sharedConfig({ funnel: false }))));
});

test("pool paths always stay within /token2oauth", () => {
  assert.equal(ownedSubpath("pool-a"), "/token2oauth/pool-a");
  for (const bad of ["", "..", "a/b", "A", "-x", "x-", "a.b", "%2e%2e", "x".repeat(64)]) {
    assert.throws(() => ownedSubpath(bad), bad);
  }
  assert.equal(isWithinOwnedPath("/token2oauth"), true);
  assert.equal(isWithinOwnedPath("/token2oauth/a/b"), true);
  for (const bad of ["/", "/token2oauthx", "/token2oauth/../x", "/token2oauth/./a", "token2oauth", "/token2oauth/%2e%2e", "/other"]) {
    assert.equal(isWithinOwnedPath(bad), false, bad);
  }
  assert.throws(() => assertWithinOwnedPath("/"));
});
