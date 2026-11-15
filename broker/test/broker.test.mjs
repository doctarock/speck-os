import test from "node:test";
import assert from "node:assert/strict";
import { createBroker } from "../lib/broker.mjs";
import { createSnapshots } from "../lib/snapshots.mjs";

function fakeRun(responses = {}) {
  const calls = [];
  let snapNumber = 10;
  const runner = async (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    const key = `${command} ${args.join(" ")}`;
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.startsWith(pattern)) {
        const value = typeof response === "function" ? await response(key, options) : response;
        return { code: 0, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 1, ...value };
      }
    }
    if (command === "snapper" && args.includes("list-configs")) {
      return ok(JSON.stringify({ configs: [{ config: "root", subvolume: "/" }] }));
    }
    if (command === "snapper" && args.includes("create")) return ok(String(++snapNumber));
    return ok("");
  };
  return { runner, calls };
}
const ok = (stdout) => ({ code: 0, stdout, stderr: "", truncated: false, timedOut: false, durationMs: 1 });

function setup(responses, snapshotMode = "auto") {
  const { runner, calls } = fakeRun(responses);
  const entries = [];
  const audit = { append: async (entry) => { entries.push(entry); }, tail: async () => entries };
  const marks = [];
  const bootguard = { scheduleMarkGood: (reason) => marks.push(reason), markGood: async () => ({ marked: true }), status: async () => ({}) };
  const snapshots = createSnapshots({ run: runner, mode: snapshotMode });
  const broker = createBroker({ run: runner, snapshots, bootguard, audit });
  return { broker, calls, entries, marks, bootguard };
}

test("root exec runs between a pre and a post snapshot, is audited, and schedules mark-good", async () => {
  const { broker, calls, entries, marks } = setup();
  const result = await broker.handle("POST", "/v1/exec", { script: "echo hi\nsystemctl restart foo", description: "restart foo" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot, { pre: 11, post: 12 });
  const order = calls.filter((c) => !(c.command === "snapper" && c.args.includes("list-configs"))).map((c) => c.command === "snapper" ? `snapper:${c.args[c.args.indexOf("--type") + 1]}` : c.command);
  assert.deepEqual(order, ["snapper:pre", "bash", "snapper:post"]);
  const bash = calls.find((c) => c.command === "bash");
  assert.equal(bash.options.input, "echo hi\nsystemctl restart foo");
  assert.equal(entries[0].op, "exec");
  assert.equal(entries[0].script, "echo hi\nsystemctl restart foo");
  assert.deepEqual(marks, ["exec: restart foo"]);
});

test("a failed script still gets its post snapshot and is reported, not thrown", async () => {
  const { broker, entries, marks } = setup({ "bash -s": { code: 3, stderr: "boom" } });
  const result = await broker.handle("POST", "/v1/exec", { script: "false" });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.snapshot, { pre: 11, post: 12 });
  assert.equal(entries[0].ok, false);
  assert.equal(marks.length, 0, "failures never become the boot fallback");
});

test("exec as the service user uses runuser and skips the snapshot by default", async () => {
  const { broker, calls } = setup();
  const result = await broker.handle("POST", "/v1/exec", { script: "id", user: "speck" });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot, undefined);
  assert.deepEqual(calls.find((c) => c.command === "runuser").args, ["-u", "speck", "--", "bash", "-s"]);
});

test("exec refuses other users and empty scripts", async () => {
  const { broker } = setup();
  await assert.rejects(broker.handle("POST", "/v1/exec", { script: "id", user: "nobody" }), /user must be/);
  await assert.rejects(broker.handle("POST", "/v1/exec", { script: "  " }), /script is required/);
});

test("without snapper, ops still run and say why they were unprotected", async () => {
  const { broker } = setup({ "snapper --jsonout list-configs": { code: 1, stderr: "snapper: command not found" } });
  const result = await broker.handle("POST", "/v1/exec", { script: "true" });
  assert.equal(result.ok, true);
  assert.match(result.snapshot.skipped, /snapper unavailable/);
});

test("package install takes any valid package names; update is not snapshotted", async () => {
  const { broker, calls } = setup();
  const install = await broker.handle("POST", "/v1/pkg", { action: "install", packages: ["htop", "linux-image-generic", "foo=1.2-3"] });
  assert.equal(install.ok, true);
  assert.ok(install.snapshot.pre);
  const apt = calls.filter((c) => c.command === "apt-get").at(-1);
  assert.deepEqual(apt.args.slice(-4), ["install", "htop", "linux-image-generic", "foo=1.2-3"]);

  const update = await broker.handle("POST", "/v1/pkg", { action: "update" });
  assert.equal(update.snapshot, undefined);
  await assert.rejects(broker.handle("POST", "/v1/pkg", { action: "install", packages: ["htop; rm -rf /"] }), /invalid package/);
});

test("upgrade stops at a failed apt-get update", async () => {
  const { broker, calls } = setup({ "apt-get update": { code: 100, stderr: "no network" } });
  const result = await broker.handle("POST", "/v1/pkg", { action: "upgrade" });
  assert.equal(result.ok, false);
  assert.equal(calls.filter((c) => c.command === "apt-get").length, 1);
});

test("service restart is not snapshotted, enable is", async () => {
  const { broker } = setup({ "systemctl is-active": { stdout: "active\n" } });
  const restart = await broker.handle("POST", "/v1/service", { action: "restart", unit: "pipewire.service" });
  assert.equal(restart.snapshot, undefined);
  assert.equal(restart.active, "active");
  const enable = await broker.handle("POST", "/v1/service", { action: "enable", unit: "infer@egpu.service" });
  assert.ok(enable.snapshot.pre);
  await assert.rejects(broker.handle("POST", "/v1/service", { action: "restart", unit: "a b" }), /invalid unit/);
});

test("reboot is scheduled after the response, with the reason audited", async () => {
  const { broker, entries } = setup();
  const scheduled = [];
  const result = await broker.handle("POST", "/v1/power", { action: "reboot", reason: "kernel upgrade" }, undefined,
    { schedule: (ms, fn) => scheduled.push({ ms, fn }) });
  assert.deepEqual(result, { ok: true, action: "reboot", inSeconds: 5 });
  assert.equal(scheduled[0].ms, 5000);
  assert.equal(entries[0].reason, "kernel upgrade");
});

test("a scheduled reboot first confirms the current boot, then reboots", async () => {
  const { broker, calls, bootguard } = setup();
  const order = [];
  bootguard.confirmBoot = async () => { order.push("confirm"); return { confirmed: true }; };
  const scheduled = [];
  await broker.handle("POST", "/v1/power", { action: "reboot", reason: "eGPU driver" }, undefined,
    { schedule: (ms, fn) => scheduled.push(fn) });
  await scheduled[0]();
  order.push(...calls.filter((c) => c.command === "systemctl").map((c) => c.args.join(" ")));
  assert.deepEqual(order, ["confirm", "reboot"]);
});

test("rollback is itself snapshotted so it can be undone", async () => {
  const { broker, calls } = setup();
  const result = await broker.handle("POST", "/v1/rollback", { snapshot: 7, reason: "audio broke" });
  assert.equal(result.ok, true);
  assert.ok(result.snapshot.pre);
  assert.ok(calls.some((c) => c.command === "snapper" && c.args.includes("undochange") && c.args.includes("7..0")));
});

test("mutations are serialised", async () => {
  let running = 0;
  let peak = 0;
  const { broker } = setup({
    "bash -s": async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { code: 0 };
    }
  });
  await Promise.all([1, 2, 3].map((n) => broker.handle("POST", "/v1/exec", { script: `echo ${n}`, snapshot: false })));
  assert.equal(peak <= 1, true);
});

test("unknown routes are 404", async () => {
  const { broker } = setup();
  await assert.rejects(broker.handle("DELETE", "/v1/everything"), (error) => error.status === 404);
});
