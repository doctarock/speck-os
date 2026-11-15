import fs from "node:fs/promises";

/**
 * A/B self-update for Speck.
 *
 *   stage  -> fetch the new version into the inactive slot, apply the speck-os overlay
 *   build  -> npm install/ci + build, as the speck user
 *   gate   -> configured checks (default: Speck's own test suite)
 *   smoke  -> start the new build on a spare port against a reflink copy of the agent's state,
 *             with cron and the task queue paused; it must report healthy
 *   switch -> stop Speck, snapshot the agent's state, point /opt/speck/current at the new slot, start
 *   watch  -> Speck must stay healthy for watchSec; otherwise roll back code and state
 *
 * Runs inside the broker, so it survives Speck restarting. Agent state is snapshotted because a
 * new version may migrate the database one way; rolling back code alone would not be enough.
 */
export function createUpdater({ run, health, audit, links, stateGuard, history, exclusive, bootguard, config = {}, sleep, now = () => new Date() }) {
  const cfg = {
    root: "/opt/speck",
    overlay: "/usr/lib/speck-os/overlay",
    serviceUser: "speck",
    unit: "speck.service",
    healthUrl: "http://127.0.0.1:4310/api/health",
    smokePort: 4311,
    smokeDir: "/var/lib/speck-smoke",
    stateDir: "/var/lib/speck",
    npmCache: "/var/cache/speck-npm",
    gate: [{ name: "speck tests", command: "npm test", timeoutSec: 1800 }],
    readySec: 180,
    watchSec: 300,
    watchIntervalSec: 10,
    failuresToRollback: 3,
    ...config
  };
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let job = null;

  const asUser = (script, options = {}) => run("runuser", ["-u", cfg.serviceUser, "--", "bash", "-c", script], {
    timeoutMs: 1_800_000,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cfg.stateDir, LANG: "C.UTF-8", npm_config_cache: cfg.npmCache, CI: "1" },
    ...options
  });

  function log(entry) {
    const line = { at: now().toISOString(), ...entry };
    job.log.push(line);
    if (job.log.length > 200) job.log.shift();
  }

  async function step(name, fn) {
    job.phase = name;
    log({ phase: name, event: "start" });
    const result = await fn();
    if (result && result.code !== undefined && result.code !== 0) {
      const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim().slice(-3000);
      throw new UpdateError(name, `${name} failed (exit ${result.code}${result.timedOut ? ", timed out" : ""})`, detail);
    }
    log({ phase: name, event: "ok" });
    return result;
  }

  async function stage(target, source) {
    const dir = `${cfg.root}/slots/${target}`;
    await step("stage", async () => {
      let result = await run("rm", ["-rf", dir]);
      if (result.code !== 0) return result;
      await run("mkdir", ["-p", dir]);
      if (source.type === "bundle") {
        result = await run("tar", ["-xzf", source.path, "-C", dir], { timeoutMs: 600_000 });
      } else if (source.type === "git") {
        result = await run("git", ["clone", "--depth", "1", ...(source.ref ? ["--branch", source.ref] : []), source.url, dir], { timeoutMs: 900_000 });
      } else {
        throw new UpdateError("stage", `unknown source type ${source.type}`);
      }
      if (result.code !== 0) return result;
      result = await run("cp", ["-a", `${cfg.overlay}/.`, `${dir}/`]);
      if (result.code !== 0) return result;
      await run("install", ["-d", "-o", cfg.serviceUser, "-g", cfg.serviceUser, cfg.npmCache]);
      return run("chown", ["-R", `${cfg.serviceUser}:${cfg.serviceUser}`, dir]);
    });
    return dir;
  }

  async function build(dir) {
    await step("build", () => asUser(
      `set -e; cd '${dir}'; if [ -d vendor/genesis-runtime ]; then (cd vendor/genesis-runtime && npm install --omit=dev --no-audit --no-fund); fi; npm ci --no-audit --no-fund; npm run build`
    ));
  }

  async function gate(dir) {
    for (const check of cfg.gate) {
      await step(`gate: ${check.name}`, () => asUser(`cd '${dir}' && ${check.command}`, { timeoutMs: (check.timeoutSec ?? 1800) * 1000 }));
    }
    await step("prune", () => asUser(`cd '${dir}' && npm prune --omit=dev --no-audit --no-fund`));
  }

  async function smoke(dir) {
    await step("smoke", async () => {
      await run("rm", ["-rf", cfg.smokeDir]);
      let result = await run("cp", ["-a", "--reflink=auto", cfg.stateDir, cfg.smokeDir], { timeoutMs: 900_000 });
      if (result.code !== 0) return result;
      await run("rm", ["-rf", `${cfg.smokeDir}/.broker`]);
      // The smoke instance must not act: no cron jobs, no queued work, no recovered tasks.
      await run("node", ["-e", PAUSE_STATE, `${cfg.smokeDir}/genesis-runtime/genesis-ui-state.json`]);
      await run("chown", ["-R", `${cfg.serviceUser}:${cfg.serviceUser}`, cfg.smokeDir]);
      const env = [
        `SPECK_PORT=${cfg.smokePort}`, "SPECK_HOST=127.0.0.1", `SPECK_DB_PATH=${cfg.smokeDir}/speck.sqlite`,
        `SPECK_GENESIS_RUNTIME_PATH=${cfg.smokeDir}/genesis-runtime`, "SPECK_RECOVER_INTERRUPTED=false"
      ].join(" ");
      const started = asUser(`cd '${dir}' && exec env $(grep -v '^#' /etc/speck-os/speck.env | xargs) ${env} timeout 150 node dist/server.js`, { timeoutMs: 160_000 });
      const url = cfg.healthUrl.replace(/:\d+\//, `:${cfg.smokePort}/`);
      let check = { ok: false, reason: "not started" };
      for (let i = 0; i < 24 && !check.ok; i++) {
        await wait(5000);
        check = await health(url);
      }
      await run("fuser", ["-k", `${cfg.smokePort}/tcp`]);   // `timeout 150` is the backstop
      const output = await started;
      await run("rm", ["-rf", cfg.smokeDir]);
      if (!check.ok) return { code: 1, stdout: output.stdout, stderr: `smoke instance never became healthy: ${check.reason}\n${output.stderr}` };
      return { code: 0 };
    });
  }

  async function writeRelease(dir, source, version) {
    const release = { version, source, stagedAt: now().toISOString(), jobId: job.id };
    await run("tee", [`${dir}/.speck-os-release.json`], { input: JSON.stringify(release, null, 2) });
  }

  async function healthyFor(seconds, intervalSec) {
    const base = Number((await run("systemctl", ["show", "-p", "NRestarts", "--value", cfg.unit])).stdout.trim() || 0);
    let failures = 0;
    const rounds = Math.max(1, Math.ceil(seconds / intervalSec));
    for (let i = 0; i < rounds; i++) {
      await wait(intervalSec * 1000);
      const check = await health(cfg.healthUrl);
      failures = check.ok ? 0 : failures + 1;
      if (failures >= cfg.failuresToRollback) return { ok: false, reason: `unhealthy ${failures} checks in a row: ${check.reason}` };
      const restarts = Number((await run("systemctl", ["show", "-p", "NRestarts", "--value", cfg.unit])).stdout.trim() || 0);
      if (restarts - base >= 2) return { ok: false, reason: `${cfg.unit} restarted ${restarts - base} times` };
    }
    return { ok: true };
  }

  async function waitReady() {
    for (let i = 0; i < Math.ceil(cfg.readySec / 5); i++) {
      if ((await health(cfg.healthUrl)).ok) return { ok: true };
      await wait(5000);
    }
    return { ok: false, reason: `not healthy within ${cfg.readySec}s` };
  }

  async function switchTo(target, label) {
    return exclusive(async () => {
      await run("systemctl", ["stop", cfg.unit], { timeoutMs: 120_000 });
      const snap = await stateGuard.snapshot(label);
      await links.set(target);
      await run("systemctl", ["start", cfg.unit], { timeoutMs: 120_000 });
      return snap;
    });
  }

  async function restore(slot, stateSnapshot, reason) {
    return exclusive(async () => {
      await run("systemctl", ["stop", cfg.unit], { timeoutMs: 120_000 });
      await links.set(slot);
      const restored = stateSnapshot?.id ? await stateGuard.restore(stateSnapshot.id) : { restored: false, reason: "no state snapshot" };
      await run("systemctl", ["start", cfg.unit], { timeoutMs: 120_000 });
      await audit.append({ op: "update.rollback", to: slot, reason, state: restored });
      return restored;
    });
  }

  async function pipeline(source) {
    const previous = await links.current();
    const target = previous === "a" ? "b" : "a";
    job.from = previous;
    job.to = target;
    const version = source.version || (source.type === "git" ? `${source.url}#${source.ref || "HEAD"}` : source.path);
    try {
      const dir = await stage(target, source);
      await build(dir);
      await gate(dir);
      await smoke(dir);
      await writeRelease(dir, source, version);

      job.phase = "switch";
      log({ phase: "switch", event: "start", from: previous, to: target });
      job.stateSnapshot = await switchTo(target, `before update ${job.id}`);
      log({ phase: "switch", event: "ok", stateSnapshot: job.stateSnapshot });

      job.phase = "watch";
      const ready = await waitReady();
      const watched = ready.ok ? await healthyFor(cfg.watchSec, cfg.watchIntervalSec) : ready;
      if (!watched.ok) {
        log({ phase: "watch", event: "failed", reason: watched.reason });
        job.phase = "rollback";
        job.rollback = await restore(previous, job.stateSnapshot, `watch failed: ${watched.reason}`);
        job.status = "rolled-back";
        job.error = watched.reason;
        return;
      }
      log({ phase: "watch", event: "ok" });
      job.status = "succeeded";
      bootguard?.scheduleMarkGood(`update ${job.id} to slot ${target}`);
      await stateGuard.prune(3).catch(() => {});
    } catch (error) {
      job.status = "failed";
      job.error = error.message;
      if (error.detail) job.detail = error.detail;
      log({ phase: job.phase, event: "failed", error: error.message });
      // Failures before the switch never touched the running system.
      if (["switch", "watch", "rollback"].includes(job.phase)) {
        job.rollback = await restore(previous, job.stateSnapshot, `error: ${error.message}`).catch((e) => ({ error: e.message }));
        job.status = "rolled-back";
      }
    } finally {
      job.phase = "done";
      job.finishedAt = now().toISOString();
      await audit.append({ op: "update", jobId: job.id, status: job.status, from: job.from, to: job.to, version, error: job.error });
      await history.add(summary(job));
    }
  }

  function start(source = cfg.defaultSource) {
    if (job && job.phase !== "done") {
      const error = new Error(`update ${job.id} is already running (${job.phase})`);
      error.status = 409;
      throw error;
    }
    if (!source || !source.type) {
      const error = new Error("no update source: pass {type:'bundle', path} or {type:'git', url, ref}, or set defaultSource in /etc/speck-os/update.json");
      error.status = 400;
      throw error;
    }
    job = { id: `u${now().getTime().toString(36)}`, source, status: "running", phase: "queued", startedAt: now().toISOString(), log: [] };
    job.done = pipeline(source);
    return summary(job);
  }

  /**
   * Manual rollback to the other slot (a problem noticed after the watch window). Code only by
   * default: restoring state would discard everything the agent learned since that update. Pass
   * restoreState when the new version migrated the database in a way the old one can't read.
   */
  async function rollback(reason = "requested", { restoreState = false } = {}) {
    if (job && job.phase !== "done") {
      const error = new Error("an update is running");
      error.status = 409;
      throw error;
    }
    const current = await links.current();
    const other = current === "a" ? "b" : "a";
    const last = (await history.list()).find((entry) => entry.status === "succeeded" && entry.to === current);
    if (!last) {
      const error = new Error(`no successful update into slot ${current} to roll back`);
      error.status = 409;
      throw error;
    }
    const restored = await restore(other, restoreState ? last.stateSnapshot : null, reason);
    await history.add({ id: `r${now().getTime().toString(36)}`, status: "manual-rollback", from: current, to: other, reason, state: restored, finishedAt: now().toISOString() });
    return { ok: true, from: current, to: other, state: restored };
  }

  async function status() {
    const current = await links.current();
    const releases = {};
    for (const slot of ["a", "b"]) {
      const text = await run("cat", [`${cfg.root}/slots/${slot}/.speck-os-release.json`]);
      releases[slot] = text.code === 0 ? safeJson(text.stdout) : null;
    }
    return { current, releases, job: job ? summary(job, true) : null, history: (await history.list()).slice(0, 10) };
  }

  return { start, rollback, status, get job() { return job; } };
}

class UpdateError extends Error {
  constructor(phase, message, detail) { super(message); this.phase = phase; this.detail = detail; }
}

function summary(job, withLog = false) {
  const { done, log, ...rest } = job;
  return withLog ? { ...rest, log: log.slice(-40) } : rest;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const PAUSE_STATE = `
const fs = require("fs"); const f = process.argv[1];
let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
s.queuePaused = true; s.cronJobs = [];
fs.writeFileSync(f, JSON.stringify(s));`;

/** /opt/speck/current -> slots/<a|b>, switched atomically (rename over the old link). */
export function createLinks({ run, root = "/opt/speck" }) {
  return {
    async current() {
      const target = await fs.readlink(`${root}/current`).catch(() => `${root}/slots/a`);
      return target.replace(/\/+$/, "").endsWith("/b") ? "b" : "a";
    },
    async set(slot) {
      const result = await run("bash", ["-c", `ln -sfn '${root}/slots/${slot}' '${root}/current.next' && mv -T '${root}/current.next' '${root}/current'`]);
      if (result.code !== 0) throw new Error(`switching to slot ${slot} failed: ${result.stderr}`);
    }
  };
}

/** Read-only btrfs snapshots of the agent's state subvolume (@speck), taken with Speck stopped. */
export function createStateGuard({ run, mountTop, stateDir = "/var/lib/speck", subvol = "@speck", now = () => new Date() }) {
  return {
    async snapshot(label) {
      let top;
      try { top = await mountTop(); } catch (error) { return { id: null, skipped: `state not protected: ${error.message}` }; }
      const id = `${subvol}-pre-${now().toISOString().replace(/[:.]/g, "-")}`;
      const result = await run("btrfs", ["subvolume", "snapshot", "-r", `${top}/${subvol}`, `${top}/${id}`]);
      if (result.code !== 0) return { id: null, skipped: `state not protected: ${result.stderr.trim()}` };
      return { id, label };
    },
    async restore(id) {
      const top = await mountTop();
      // The broker's own audit and update history stay as they are: they record the rollback.
      const result = await run("rsync", ["-aHAX", "--delete", "--exclude=/.broker/", `${top}/${id}/`, `${stateDir}/`], { timeoutMs: 1_800_000 });
      return result.code === 0 ? { restored: true, from: id } : { restored: false, error: result.stderr.trim().slice(-500) };
    },
    async prune(keep) {
      let top;
      try { top = await mountTop(); } catch { return; }
      const list = await run("bash", ["-c", `ls -1d '${top}/${subvol}'-pre-* 2>/dev/null | sort`]);
      const all = list.stdout.trim().split("\n").filter(Boolean);
      for (const path of all.slice(0, Math.max(0, all.length - keep))) {
        await run("btrfs", ["subvolume", "delete", path]);
      }
    }
  };
}

/** Update history, newest first, kept with the audit log on the state subvolume. */
export function createHistory(file) {
  async function list() {
    try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return []; }
  }
  async function add(entry) {
    const entries = [entry, ...(await list())].slice(0, 50);
    await fs.writeFile(file, JSON.stringify(entries, null, 2));
  }
  return { list, add };
}
