import test from "node:test";
import assert from "node:assert/strict";
import { createUpdater } from "../lib/updater.mjs";

const res = (code = 0, stdout = "", stderr = "") => ({ code, stdout, stderr, timedOut: false, truncated: false, durationMs: 1 });

function setup({ failOn = null, smokeHealthy = true, mainHealthy = () => true, failSwitch = false } = {}) {
  const calls = [];
  const run = async (command, args = [], options = {}) => {
    const line = `${command} ${args.join(" ")}`;
    calls.push(line);
    if (failOn && line.includes(failOn)) return res(1, "", `boom in ${failOn}`);
    if (command === "systemctl" && args[0] === "show") return res(0, "0\n");
    return res();
  };
  let current = "a";
  const linkLog = [];
  const links = {
    current: async () => current,
    set: async (slot) => {
      if (failSwitch && slot === "b") throw new Error("ln failed");
      linkLog.push(slot); current = slot;
    }
  };
  const stateOps = [];
  const stateGuard = {
    snapshot: async (label) => { stateOps.push(`snapshot:${label}`); return { id: "@speck-pre-1", label }; },
    restore: async (id) => { stateOps.push(`restore:${id}`); return { restored: true, from: id }; },
    prune: async () => { stateOps.push("prune"); }
  };
  const entries = [];
  const history = { items: [], list: async () => history.items, add: async (e) => { history.items.unshift(e); } };
  const marks = [];
  let mainChecks = 0;
  const health = async (url) => {
    if (url.includes(":4311/")) return smokeHealthy ? { ok: true } : { ok: false, reason: "smoke down" };
    mainChecks++;
    return mainHealthy(mainChecks) ? { ok: true } : { ok: false, reason: "speck down" };
  };
  const updater = createUpdater({
    run, health, links, stateGuard, history,
    audit: { append: async (e) => { entries.push(e); } },
    exclusive: (task) => task(),
    bootguard: { scheduleMarkGood: (r) => marks.push(r) },
    sleep: async () => {},
    config: { watchSec: 30, watchIntervalSec: 10 }
  });
  return { updater, calls, linkLog, stateOps, entries, history, marks, current: () => current };
}

const bundle = { type: "bundle", path: "/tmp/speck-src.tar.gz", version: "speck 1.2.3" };

test("a good update builds, gates and smoke-tests the inactive slot, then switches and stays", async () => {
  const t = setup();
  const started = t.updater.start(bundle);
  assert.equal(started.status, "running");
  await t.updater.job.done;
  const job = t.updater.job;
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(t.current(), "b");
  assert.deepEqual(t.stateOps.slice(0, 1), [`snapshot:before update ${job.id}`]);
  const order = ["tar -xzf /tmp/speck-src.tar.gz -C /opt/speck/slots/b", "npm ci", "npm test", "npm prune", "cp -a --reflink=auto", "systemctl stop speck.service", "systemctl start speck.service"]
    .map((needle) => t.calls.findIndex((c) => c.includes(needle)));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `steps out of order: ${order}`);
  assert.ok(t.calls.some((c) => c.startsWith("cp -a /usr/lib/speck-os/overlay/. /opt/speck/slots/b/")), "speck-os overlay applied");
  assert.equal(t.marks.length, 1);
  assert.equal(t.history.items[0].status, "succeeded");
  assert.equal(t.history.items[0].stateSnapshot.id, "@speck-pre-1");
});

test("a failing test gate never touches the running system", async () => {
  const t = setup({ failOn: "npm test" });
  t.updater.start(bundle);
  await t.updater.job.done;
  assert.equal(t.updater.job.status, "failed");
  assert.match(t.updater.job.error, /gate: speck tests failed/);
  assert.match(t.updater.job.detail, /boom in npm test/);
  assert.equal(t.current(), "a");
  assert.ok(!t.calls.some((c) => c.startsWith("systemctl stop")));
  assert.deepEqual(t.stateOps, []);
});

test("a build that can't start against a copy of the agent's state is rejected before the switch", async () => {
  const t = setup({ smokeHealthy: false });
  t.updater.start(bundle);
  await t.updater.job.done;
  assert.equal(t.updater.job.status, "failed");
  assert.match(t.updater.job.detail, /never became healthy/);
  assert.equal(t.current(), "a");
  assert.ok(t.calls.some((c) => c.includes("queuePaused")), "smoke copy has cron and the queue paused");
  assert.ok(t.calls.some((c) => c === "rm -rf /var/lib/speck-smoke"), "smoke copy removed");
});

test("unhealthy after the switch: code and state roll back automatically", async () => {
  const t = setup({ mainHealthy: (n) => n === 1 });   // ready once, then down
  t.updater.start(bundle);
  await t.updater.job.done;
  const job = t.updater.job;
  assert.equal(job.status, "rolled-back");
  assert.match(job.error, /unhealthy 3 checks in a row/);
  assert.equal(t.current(), "a");
  assert.deepEqual(t.linkLog, ["b", "a"]);
  assert.ok(t.stateOps.includes("restore:@speck-pre-1"));
  assert.equal(t.marks.length, 0, "a rolled-back update never becomes the boot fallback");
  assert.equal(t.entries.find((e) => e.op === "update.rollback").to, "a");
});

test("a switch that fails halfway restarts the previous version", async () => {
  const t = setup({ failSwitch: true });
  t.updater.start(bundle);
  await t.updater.job.done;
  assert.equal(t.updater.job.status, "rolled-back");
  assert.equal(t.current(), "a");
  assert.equal(t.calls.filter((c) => c === "systemctl start speck.service").length, 1);
});

test("only one update at a time", async () => {
  const t = setup();
  t.updater.start(bundle);
  assert.throws(() => t.updater.start(bundle), (error) => error.status === 409);
  await t.updater.job.done;
});

test("no source and no default is a clear error", () => {
  const t = setup();
  assert.throws(() => t.updater.start(undefined), (error) => error.status === 400 && /no update source/.test(error.message));
});

test("manual rollback switches code back and keeps the agent's memory unless asked", async () => {
  const t = setup();
  t.updater.start(bundle);
  await t.updater.job.done;
  t.stateOps.length = 0;

  const result = await t.updater.rollback("tool calls broke");
  assert.equal(result.to, "a");
  assert.equal(t.current(), "a");
  assert.deepEqual(t.stateOps, []);
  assert.equal(t.history.items[0].status, "manual-rollback");
});

test("manual rollback can restore the state snapshot when asked", async () => {
  const t = setup();
  t.updater.start(bundle);
  await t.updater.job.done;
  await t.updater.rollback("schema incompatible", { restoreState: true });
  assert.ok(t.stateOps.includes("restore:@speck-pre-1"));
});
