import fs from "node:fs/promises";
import os from "node:os";
import { SYSTEM_PATH } from "./run.mjs";

const UNIT = /^[A-Za-z0-9@._:\\-]{1,200}$/;
const PACKAGE = /^[a-z0-9][a-z0-9+.:=~-]{0,200}$/;
const MAX_SCRIPT = 256 * 1024;
const APT_OPTS = ["-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"];

export class BrokerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * The agent's root access. Speck holds full administrative power: any script as root, any package,
 * any service, reboot. The broker doesn't restrict what can be done; it makes every change
 * recoverable (snapper pre/post around each mutation), serialised and audited.
 */
export function createBroker({ run, snapshots, bootguard, audit, updater, hwd, config = {} }) {
  const serviceUser = config.serviceUser ?? "speck";
  let queue = Promise.resolve();

  /** Mutations run one at a time (apt and snapper both need it). */
  function exclusive(task) {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  }

  async function protectedOp(op, description, snapshot, work) {
    return exclusive(async () => {
      let pre = null;
      let snapshotNote;
      if (snapshot) {
        const state = await snapshots.available();
        if (state.ok) pre = await snapshots.pre(`${op}: ${description}`);
        else snapshotNote = state.reason;
      }
      let result;
      try {
        result = await work();
      } finally {
        const post = pre != null ? await snapshots.post(pre, `${op}: ${description}`).catch(() => null) : null;
        const snapshot_ = pre != null ? { pre, post } : snapshotNote ? { skipped: snapshotNote } : undefined;
        if (result) result.snapshot = snapshot_;
        await audit.append({ op, description, snapshot: snapshot_, ...(result ? summarize(result) : { error: "threw" }) });
      }
      if (result.ok && snapshot) bootguard.scheduleMarkGood(`${op}: ${description}`);
      return result;
    });
  }

  function shaped(raw) {
    return {
      ok: raw.code === 0 && !raw.timedOut,
      exitCode: raw.code,
      timedOut: raw.timedOut,
      durationMs: raw.durationMs,
      stdout: raw.stdout,
      stderr: raw.stderr,
      truncated: raw.truncated
    };
  }

  const execEnv = (home) => ({ PATH: SYSTEM_PATH, HOME: home, LANG: "C.UTF-8", DEBIAN_FRONTEND: "noninteractive", TERM: "dumb" });

  async function exec(body) {
    const script = String(body.script ?? "");
    if (!script.trim()) throw new BrokerError(400, "script is required");
    if (script.length > MAX_SCRIPT) throw new BrokerError(413, `script is larger than ${MAX_SCRIPT} bytes`);
    const user = body.user ?? "root";
    if (user !== "root" && user !== serviceUser) throw new BrokerError(400, `user must be "root" or "${serviceUser}"`);
    const timeoutMs = clampSeconds(body.timeoutSec, 600, 3600) * 1000;
    const snapshot = body.snapshot ?? user === "root";
    const description = String(body.description || firstLine(script));
    return protectedOp("exec", description, snapshot, async () => {
      const raw = user === "root"
        ? await run("bash", ["-s"], { input: script, timeoutMs, env: execEnv("/root"), cwd: "/root" })
        : await run("runuser", ["-u", serviceUser, "--", "bash", "-s"], { input: script, timeoutMs, env: execEnv(config.serviceHome ?? "/var/lib/speck"), cwd: "/" });
      return { ...shaped(raw), user, script };
    });
  }

  async function packages(body) {
    const action = String(body.action ?? "");
    const names = Array.isArray(body.packages) ? body.packages.map(String) : [];
    const bad = names.find((name) => !PACKAGE.test(name));
    if (bad) throw new BrokerError(400, `invalid package name: ${bad}`);
    let steps;
    switch (action) {
      case "update": steps = [["apt-get", ["update"]]]; break;
      case "upgrade": steps = [["apt-get", ["update"]], ["apt-get", [...APT_OPTS, "full-upgrade"]]]; break;
      case "install":
      case "remove":
      case "purge":
        if (!names.length) throw new BrokerError(400, `${action} needs packages`);
        steps = [["apt-get", [...APT_OPTS, action, ...names]]];
        break;
      case "autoremove": steps = [["apt-get", [...APT_OPTS, "autoremove"]]]; break;
      default: throw new BrokerError(400, "action must be update, upgrade, install, remove, purge or autoremove");
    }
    const description = `${action}${names.length ? " " + names.join(" ") : ""}`;
    return protectedOp("pkg", description, action !== "update", async () => {
      const outputs = [];
      let last;
      for (const [command, args] of steps) {
        last = await run(command, args, { timeoutMs: 3_600_000, env: execEnv("/root") });
        outputs.push(last);
        if (last.code !== 0) break;
      }
      const merged = { ...last, stdout: outputs.map((o) => o.stdout).join("\n"), stderr: outputs.map((o) => o.stderr).join("\n") };
      const rebootRequired = await fs.access("/var/run/reboot-required").then(() => true, () => false);
      return { ...shaped(merged), action, packages: names, rebootRequired };
    });
  }

  async function service(body) {
    const action = String(body.action ?? "");
    const unit = String(body.unit ?? "");
    if (!UNIT.test(unit)) throw new BrokerError(400, "invalid unit name");
    const allowed = ["status", "start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask"];
    if (!allowed.includes(action)) throw new BrokerError(400, `action must be one of ${allowed.join(", ")}`);
    if (action === "status") {
      const raw = await run("systemctl", ["status", "--no-pager", "--lines=30", unit]);
      return { ...shaped(raw), ok: true, active: (await run("systemctl", ["is-active", unit])).stdout.trim() };
    }
    const persistent = ["enable", "disable", "mask", "unmask"].includes(action);
    return protectedOp("service", `${action} ${unit}`, persistent, async () => {
      const raw = await run("systemctl", [action, unit], { timeoutMs: 300_000 });
      const active = (await run("systemctl", ["is-active", unit])).stdout.trim();
      return { ...shaped(raw), action, unit, active };
    });
  }

  async function power(body, { schedule }) {
    const action = String(body.action ?? "");
    if (action !== "reboot" && action !== "poweroff") throw new BrokerError(400, "action must be reboot or poweroff");
    const delaySec = clampSeconds(body.delaySec, 5, 3600);
    const reason = String(body.reason || "unspecified");
    await audit.append({ op: "power", action, delaySec, reason });
    schedule(delaySec * 1000, async () => {
      // A deliberate reboot from a healthy system mustn't count toward the boot fallback.
      if (action === "reboot") await bootguard.confirmBoot?.().catch(() => {});
      return run("systemctl", [action]);
    });
    return { ok: true, action, inSeconds: delaySec };
  }

  async function snapshotList() {
    return snapshots.list();
  }

  async function snapshotCreate(body) {
    const description = String(body.description || "manual");
    return exclusive(async () => {
      const number = await snapshots.single(description);
      await audit.append({ op: "snapshot.create", number, description });
      return { ok: true, number };
    });
  }

  /** Live rollback: revert files changed since a snapshot. Itself protected, so it can be undone. */
  async function rollback(body) {
    const number = Number(body.snapshot);
    if (!Number.isInteger(number) || number <= 0) throw new BrokerError(400, "snapshot must be a snapshot number");
    const reason = String(body.reason || "unspecified");
    return protectedOp("rollback", `to #${number}: ${reason}`, true, async () => {
      try {
        const output = await snapshots.undo(number);
        return { ok: true, exitCode: 0, to: number, stdout: output, rebootRecommended: true };
      } catch (error) {
        return { ok: false, exitCode: 1, to: number, stderr: error.message };
      }
    });
  }

  async function status() {
    const [failed, uptime, meminfo, disk, upgradable, boot, snaps] = await Promise.all([
      run("systemctl", ["--failed", "--no-legend", "--plain"]),
      fs.readFile("/proc/uptime", "utf8").catch(() => "0"),
      fs.readFile("/proc/meminfo", "utf8").catch(() => ""),
      run("df", ["-B1", "--output=target,size,used,avail", "/", "/var/lib/speck", "/boot"]),
      run("bash", ["-c", "apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep -c '^Inst' || true"]),
      bootguard.status(),
      snapshots.available()
    ]);
    const mem = Object.fromEntries(meminfo.split("\n").filter(Boolean).map((line) => {
      const [key, value] = line.split(":");
      return [key, Number.parseInt(value, 10) * 1024];
    }));
    return {
      hostname: os.hostname(),
      kernel: os.release(),
      uptimeSec: Math.round(Number.parseFloat(uptime)),
      memory: { totalBytes: mem.MemTotal, availableBytes: mem.MemAvailable },
      disks: disk.stdout.trim().split("\n").slice(1).map((line) => {
        const [mount, size, used, avail] = line.trim().split(/\s+/);
        return { mount, sizeBytes: Number(size), usedBytes: Number(used), availBytes: Number(avail) };
      }),
      failedUnits: failed.stdout.trim().split("\n").filter(Boolean).map((line) => line.split(/\s+/)[0]),
      upgradablePackages: Number(upgradable.stdout.trim() || 0),
      rebootRequired: await fs.access("/var/run/reboot-required").then(() => true, () => false),
      snapshots: snaps.ok ? { available: true } : { available: false, reason: snaps.reason },
      boot
    };
  }

  async function markGood() {
    return exclusive(() => bootguard.markGood("requested"));
  }

  function withStatus(fn) {
    return async (...args) => {
      if (!updater) throw new BrokerError(503, "updater not configured");
      try { return await fn(...args); } catch (error) {
        throw error.status ? new BrokerError(error.status, error.message) : error;
      }
    };
  }
  const updateStart = withStatus(async (body) => updater.start(body.source));
  const updateStatus = withStatus(async () => updater.status());
  const updateRollback = withStatus(async (body) => updater.rollback(String(body.reason || "requested"), { restoreState: body.restoreState === true }));

  function withHwd(fn) {
    return async (...args) => {
      if (!hwd) throw new BrokerError(503, "speck-hwd not configured");
      try { return await fn(...args); } catch (error) {
        throw error.status ? new BrokerError(error.status, error.message) : error;
      }
    };
  }
  const hwStatus = withHwd(async () => hwd.status());
  const hwReconcile = withHwd(async (body) => hwd.start({ trigger: String(body.trigger || "manual"), reboot: body.reboot === "auto" ? "auto" : "never" }));

  async function auditTail(query) {
    return { entries: await audit.tail(clampSeconds(query.get("limit"), 50, 500)) };
  }

  /** Route table: (method, path) → handler. Transport-independent, so tests call it directly. */
  async function handle(method, pathname, body = {}, query = new URLSearchParams(), context = {}) {
    const schedule = context.schedule ?? ((ms, fn) => setTimeout(fn, ms).unref?.());
    const key = `${method} ${pathname}`;
    switch (key) {
      case "GET /v1/status": return status();
      case "POST /v1/exec": return exec(body);
      case "POST /v1/pkg": return packages(body);
      case "POST /v1/service": return service(body);
      case "POST /v1/power": return power(body, { schedule });
      case "GET /v1/snapshots": return snapshotList();
      case "POST /v1/snapshots": return snapshotCreate(body);
      case "POST /v1/rollback": return rollback(body);
      case "POST /v1/mark-good": return markGood();
      case "GET /v1/audit": return auditTail(query);
      case "POST /v1/update": return updateStart(body);
      case "GET /v1/update": return updateStatus();
      case "POST /v1/update/rollback": return updateRollback(body);
      case "GET /v1/hw": return hwStatus();
      case "POST /v1/hw/reconcile": return hwReconcile(body);
      default: throw new BrokerError(404, `no route ${key}`);
    }
  }

  return { handle, exclusive };
}

function clampSeconds(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.round(number), max);
}

function firstLine(script) {
  return script.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#!")) ?? "script";
}

function summarize(result) {
  return {
    ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs,
    ...(result.script ? { script: result.script, user: result.user } : {}),
    ...(result.packages ? { packages: result.packages, action: result.action } : {}),
    ...(result.unit ? { unit: result.unit, action: result.action } : {}),
    stderrTail: String(result.stderr ?? "").slice(-2000)
  };
}
