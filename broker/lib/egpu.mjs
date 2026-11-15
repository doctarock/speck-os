// speck-hwd: makes whatever GPU is attached useful, with no user steps.
//
// A reconcile job compares the machine with what it should be and fixes the difference, so it is
// safe to run at every boot and on demand:
//   pin base workers → driver → llama.cpp build → model plan → infer@egpu → register with Speck
// Every system change goes through the broker's own ops (snapshots + audit). Nothing is trusted from
// the last run except what the hardware still confirms.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  readPciDevices, classifyGpus, findNpus, pickEgpu, fingerprint, readCpu, parseVulkanSummary,
  parseNvidiaSmi, parseLlamaDevices, deviceEnv, planWorker, modelIdFromHf, placement, GiB
} from "./hwd.mjs";

const DEFAULT_PATHS = {
  sysfs: "/sys",
  proc: "/proc",
  workersDir: "/etc/speck-os/workers",
  runDir: "/run/speck-os/hw",
  stateFile: "/var/lib/speck/.broker/hwd.json",
  placementFile: "/var/lib/speck/.broker/placement.json",
  llamaRoot: "/opt/llama.cpp",
  baseBackendFile: "/etc/speck-os/llama-backend",
  buildScript: "/usr/lib/speck-os/build-llama.sh"
};
const UNIT = "infer@egpu.service";

export class HwdError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createHwd({
  run, ops, speck, audit, config = {}, probeHealth,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date().toISOString()
}) {
  const paths = { ...DEFAULT_PATHS, ...(config.paths ?? {}) };
  const egpu = {
    port: 8090, autoReboot: true, maxDriverAttempts: 2, readyTimeoutSec: 6 * 3600, pollSec: 10, maxRestarts: 3,
    extraArgs: "--jinja -ngl 99 -fa on -ctk q8_0 -ctv q8_0 -np 1 --cache-reuse 256",
    ...(config.egpu ?? {})
  };
  const profiles = config.profiles ?? {};
  const catalog = config.catalog ?? [];
  let job = null;

  // ------------------------------------------------------------------ facts

  async function inventory() {
    const pci = await readPciDevices(paths.sysfs);
    const gpus = classifyGpus(pci);
    return { cpu: await readCpu(paths.proc), gpus, npus: findNpus(pci), egpu: pickEgpu(gpus) };
  }

  async function vulkanDevices() {
    const r = await run("vulkaninfo", ["--summary"], { timeoutMs: 30_000 });
    return r.code === 0 ? parseVulkanSummary(r.stdout) : [];
  }

  async function nvidiaDevices() {
    const r = await run("nvidia-smi", ["--query-gpu=uuid,pci.bus_id,memory.total", "--format=csv,noheader,nounits"], { timeoutMs: 30_000 });
    return r.code === 0 ? parseNvidiaSmi(r.stdout) : [];
  }

  const serverBinary = (backend) => path.join(paths.llamaRoot, `build-${backend}`, "bin", "llama-server");
  const hasBuild = (backend) => fs.access(serverBinary(backend)).then(() => true, () => false);
  const baseBackend = async () => (await fs.readFile(paths.baseBackendFile, "utf8").catch(() => "cpu")).trim() || "cpu";

  async function driverReady(profile, gpu) {
    if (!profile.kernelDrivers?.includes(gpu.driver)) return false;
    if (!profile.check) return true;
    return (await run("bash", ["-c", profile.check], { timeoutMs: 60_000 })).code === 0;
  }

  // ------------------------------------------------------------------ boot-time pieces (no daemon needed)

  /**
   * Keep the base workers on the integrated GPU. llama.cpp's Vulkan backend prefers dedicated GPUs,
   * so without this the 4B base would silently move onto the eGPU. Returns true when running base
   * workers need a restart to pick up the change.
   */
  async function pinBase(inv, vk) {
    let text = "";
    const igpu = inv.gpus.find((g) => g.kind === "integrated");
    if (inv.egpu && igpu && (await baseBackend()) === "vulkan") {
      const env = deviceEnv("vulkan", igpu, { vk, gpus: inv.gpus });
      if (env) text = renderEnv(env, "Base workers stay on the integrated GPU (speck-hwd).");
    }
    const file = path.join(paths.runDir, "base.env");
    const previous = await fs.readFile(file, "utf8").catch(() => null);
    if (previous === text) return false;
    await writeAtomic(file, text);
    return !(previous === null && text === "");
  }

  /**
   * infer@egpu only starts (ExecCondition) when this boot's card matches the one it was set up
   * for, on the same device index. Otherwise a stale Vulkan index could land the worker on the
   * iGPU or the software rasteriser.
   */
  async function bootGate(inv, vk, nvidia, state) {
    const file = path.join(paths.runDir, "egpu.ok");
    const e = state.egpu;
    let ok = false;
    if (inv.egpu && e?.phase === "ready" && e.fingerprint === fingerprint(inv.egpu)) {
      const env = deviceEnv(e.backend, inv.egpu, { vk, nvidia, gpus: inv.gpus });
      ok = env != null && canonical(env) === canonical(e.device);
    }
    if (ok) await writeAtomic(file, `${fingerprint(inv.egpu)}\n`);
    else await fs.rm(file, { force: true });
    return ok;
  }

  async function boot() {
    const inv = await inventory();
    const [vk, nvidia] = await Promise.all([vulkanDevices(), nvidiaDevices()]);
    await pinBase(inv, vk);
    const gate = await bootGate(inv, vk, nvidia, await loadState());
    return { egpu: inv.egpu ? fingerprint(inv.egpu) : null, egpuWorkerAllowed: gate };
  }

  // ------------------------------------------------------------------ reconcile

  async function reconcile(job, { reboot }) {
    const step = (phase, message) => { job.phase = phase; job.message = message; job.log.push({ at: now(), phase, message }); };
    const state = await loadState();
    step("inventory", "reading hardware");
    const inv = await inventory();
    const [vk, nvidia] = await Promise.all([vulkanDevices(), nvidiaDevices()]);

    if (await pinBase(inv, vk)) {
      step("base", "re-pinning the base workers");
      await restartBaseWorkers();
    }

    const gpu = inv.egpu;
    if (!gpu) {
      if (state.egpu?.present) {
        step("retire", "the eGPU is gone; the base model carries on alone");
        await retire(state);
      }
      if (state.egpu) state.egpu.present = false;
      return finish(job, state, inv, "absent", "no eGPU attached");
    }

    const fp = fingerprint(gpu);
    if (state.egpu?.fingerprint !== fp) {
      if (state.egpu?.present) await retire(state);   // a different card: drop the old worker first
      state.egpu = { fingerprint: fp, vendor: gpu.vendor, slot: gpu.slot, driverAttempts: 0, firstSeen: now() };
    }
    Object.assign(state.egpu, { present: true, link: gpu.link });
    const profile = profiles[gpu.vendor];
    if (!profile) return fail(job, state, inv, `no driver profile for ${gpu.vendor} (${gpu.vendorId}:${gpu.deviceId})`);

    // 1. Driver.
    if (!(await driverReady(profile, gpu))) {
      if (!profile.install) {
        return fail(job, state, inv, `${gpu.vendor} card ${gpu.slot} is bound to ${gpu.driver ?? "no driver"}; expected ${profile.kernelDrivers.join(" or ")}`);
      }
      if (state.egpu.driverAttempts >= egpu.maxDriverAttempts) {
        return fail(job, state, inv, `the driver install already ran ${state.egpu.driverAttempts} times for this card without the driver loading; fix it by hand (os_exec), then reconcile again`);
      }
      step("driver", `installing the ${gpu.vendor} driver`);
      state.egpu.driverAttempts += 1;
      await saveState(state);
      const result = await ops.exec({ script: `bash ${profile.install}\n`, description: `eGPU driver for ${gpu.vendor} ${fp}`, timeoutSec: 3600 });
      if (!result.ok) return fail(job, state, inv, `driver install failed: ${tail(result.stderr || result.stdout)}`);
      state.egpu.phase = "reboot-required";
      if (reboot === "auto" && egpu.autoReboot) {
        step("reboot", "driver installed; rebooting to load it");
        await ops.power({ action: "reboot", delaySec: 5, reason: `eGPU driver installed (${fp})` });
        return finish(job, state, inv, "rebooting", "driver installed; rebooting to load it");
      }
      return finish(job, state, inv, "reboot-required", "driver installed; it loads at the next reboot (os_power)");
    }
    state.egpu.driverAttempts = 0;

    // 2. llama.cpp build. Bring the card up on whatever already works (Vulkan), then upgrade to the
    // vendor backend (CUDA) once it's built: a usable tier in minutes, the fast one later.
    const preferred = profile.backend;
    const fallback = profile.fallbackBackend && profile.fallbackBackend !== preferred ? profile.fallbackBackend : null;
    let backend = (await hasBuild(preferred)) ? preferred : fallback && (await hasBuild(fallback)) ? fallback : null;
    if (!backend) {
      backend = fallback ?? preferred;
      step("build", `building llama.cpp for ${backend}`);
      const built = await build(backend);
      if (!built.ok) return fail(job, state, inv, `llama.cpp ${backend} build failed: ${tail(built.stderr || built.stdout)}`);
    }

    const ctx = { job, step, state, inv, gpu, vk, nvidia };
    const up = await bringUp(ctx, backend);
    if (!up.ok) return fail(job, state, inv, up.reason);

    if (backend !== preferred) {
      state.egpu.failedBuilds ??= {};
      if (state.egpu.failedBuilds[preferred] && reboot === "auto") {
        step("build", `skipping the ${preferred} build (failed before); serving on ${backend}`);
      } else {
        step("build", `building llama.cpp for ${preferred}; the eGPU serves on ${backend} meanwhile`);
        const built = await build(preferred);
        if (!built.ok) {
          state.egpu.failedBuilds[preferred] = now();
          job.log.push({ at: now(), phase: "build", message: `${preferred} build failed; staying on ${backend}: ${tail(built.stderr || built.stdout, 300)}` });
        } else {
          delete state.egpu.failedBuilds[preferred];
          const upgraded = await bringUp(ctx, preferred);
          if (!upgraded.ok) {
            job.log.push({ at: now(), phase: "start", message: `${preferred} didn't come up (${upgraded.reason}); back to ${backend}` });
            const back = await bringUp(ctx, backend);
            if (!back.ok) return fail(job, state, inv, back.reason);
          }
        }
      }
    }
    const e = state.egpu;
    return finish(job, state, inv, "ready", `${e.model} (${e.ctx / 1024}k ctx) on ${e.backend}, Speck tier ${e.tier}`);
  }

  async function build(backend) {
    return ops.exec({ script: `bash ${paths.buildScript} ${backend}\n`, description: `llama.cpp ${backend} build for the eGPU`, timeoutSec: 3600 });
  }

  /** Write the worker's settings, (re)start it, wait for it, register it with Speck. */
  async function bringUp({ step, state, inv, gpu, vk, nvidia }, backend) {
    const device = deviceEnv(backend, gpu, { vk, nvidia, gpus: inv.gpus });
    if (!device) return { ok: false, reason: `llama.cpp ${backend} can't see the card at ${gpu.slot}; is its driver loaded?` };

    let vram = gpu.vramBytes ?? nvidia.find((n) => n.slot === gpu.slot)?.memoryBytes ?? null;
    if (!vram) {
      const r = await run(serverBinary(backend), ["--list-devices"], { env: { ...process.env, ...device }, timeoutMs: 60_000 });
      vram = parseLlamaDevices(`${r.stdout}\n${r.stderr}`)[0]?.totalBytes ?? null;
    }
    if (!vram) return { ok: false, reason: "couldn't measure the card's VRAM" };
    const plan = planWorker(vram, catalog, egpu);
    if (!plan) return { ok: false, reason: `${(vram / GiB).toFixed(1)} GiB of VRAM is too small for every model in the catalog` };

    // The agent or user may have edited egpu.env (another model, other flags). Keep those edits
    // while the card and backend are unchanged; a different card gets a fresh plan.
    const planKey = canonical({ backend, hf: plan.hf, ctx: plan.ctx, device, port: egpu.port });
    const envFile = path.join(paths.workersDir, "egpu.env");
    const existing = await fs.readFile(envFile, "utf8").catch(() => null);
    const edited = existing != null && state.egpu.envHash && hash(existing) !== state.egpu.envHash;
    let text = existing;
    if (!(edited && state.egpu.planKey === planKey)) {
      text = renderEnv({
        PORT: egpu.port, MODEL_HF: plan.hf, CTX: plan.ctx, LLAMA_BACKEND: backend, ...device, EXTRA_ARGS: egpu.extraArgs
      }, `eGPU worker, planned by speck-hwd for ${gpu.vendor} ${gpu.slot} (${(vram / GiB).toFixed(1)} GiB). Edits are kept while the card stays the same.`);
      if (text !== existing) await writeAtomic(envFile, text);
      state.egpu.envHash = hash(text);
      state.egpu.planKey = planKey;
    } else {
      step("worker", "keeping the edited egpu.env");
    }
    const env = parseEnv(text);

    await writeAtomic(path.join(paths.runDir, "egpu.ok"), `${fingerprint(gpu)}\n`);
    if ((await run("systemctl", ["is-enabled", UNIT])).stdout.trim() !== "enabled") {
      await ops.service({ action: "enable", unit: UNIT });
    }
    const active = (await run("systemctl", ["is-active", UNIT])).stdout.trim() === "active";
    if (text !== existing || !active || state.egpu.backend !== backend) {
      step("start", `starting ${modelIdFromHf(env.MODEL_HF)} on the eGPU (${backend}); a first start downloads the model`);
      await run("systemctl", ["restart", UNIT], { timeoutMs: 120_000 });
    }
    const ready = await waitReady(Number(env.PORT), step);
    if (!ready.ok) return ready;

    const entry = catalog.find((c) => c.hf === env.MODEL_HF) ?? (env.MODEL_HF === plan.hf ? plan : null);
    const processor = {
      id: "egpu",
      provider: "llama.cpp",
      model: modelIdFromHf(env.MODEL_HF),
      baseUrl: `http://127.0.0.1:${env.PORT}`,
      tier: entry?.tier ?? egpu.defaultTier ?? 3,
      contextSize: Number(env.CTX),
      ...(entry?.parameters ? { parameters: entry.parameters } : {}),
      hardware: `egpu:${gpu.vendor}:${gpu.vendorId}:${gpu.deviceId}`,
      specialties: entry?.specialties ?? ["general"],
      enabled: true
    };
    step("register", `registering ${processor.model} with Speck as tier ${processor.tier}`);
    const registered = await speck.upsert(processor);
    Object.assign(state.egpu, {
      phase: "ready", error: null, backend, device, model: processor.model, hf: env.MODEL_HF, ctx: processor.contextSize,
      tier: processor.tier, vramBytes: vram, estimateBytes: plan.estimateBytes, registeredVia: registered.via, readyAt: now()
    });
    await saveState(state);
    return { ok: true };
  }

  async function waitReady(port, step) {
    const deadline = Date.now() + egpu.readyTimeoutSec * 1000;
    let announced = false;
    while (Date.now() < deadline) {
      const health = await probeHealth(`http://127.0.0.1:${port}/health`);
      if (health.ok) return { ok: true };
      const restarts = Number((await run("systemctl", ["show", "-p", "NRestarts", "--value", UNIT])).stdout.trim() || 0);
      const failed = (await run("systemctl", ["is-failed", "--quiet", UNIT])).code === 0;
      if (failed || restarts >= egpu.maxRestarts) {
        const log = await run("journalctl", ["-u", UNIT, "-n", "15", "--no-pager", "-o", "cat"]);
        return { ok: false, reason: `the eGPU worker ${failed ? "failed" : `restarted ${restarts} times`}: ${tail(log.stdout, 600)}` };
      }
      if (!announced) { step("loading", "waiting for the eGPU worker (downloading or loading the model)"); announced = true; }
      await sleep(egpu.pollSec * 1000);
    }
    return { ok: false, reason: `the eGPU worker wasn't ready after ${egpu.readyTimeoutSec}s` };
  }

  /** Take the eGPU out of service: stop the worker, keep its config, take it out of Speck's routing. */
  async function retire(state) {
    await fs.rm(path.join(paths.runDir, "egpu.ok"), { force: true });
    await run("systemctl", ["stop", UNIT], { timeoutMs: 120_000 });
    if ((await run("systemctl", ["is-enabled", UNIT])).stdout.trim() === "enabled") {
      await ops.service({ action: "disable", unit: UNIT });
    }
    await speck.disable("egpu").catch(() => {});
    if (state.egpu) state.egpu.phase = "absent";
  }

  async function restartBaseWorkers() {
    const r = await run("systemctl", ["list-units", "--type=service", "--state=active", "--plain", "--no-legend", "infer@*"]);
    const units = r.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((u) => u && u !== UNIT);
    if (units.length) await run("systemctl", ["restart", ...units], { timeoutMs: 300_000 });
  }

  async function finish(job, state, inv, result, message) {
    job.result = result;
    job.message = message;
    state.updatedAt = now();
    await saveState(state);
    await writeAtomic(paths.placementFile, `${JSON.stringify({ updatedAt: now(), ...placement(inv, state.egpu && { ...state.egpu, slot: inv.egpu?.slot }) }, null, 2)}\n`);
    await audit.append({
      op: "hwd", trigger: job.trigger, result, message,
      egpu: state.egpu ? { fingerprint: state.egpu.fingerprint, model: state.egpu.model, backend: state.egpu.backend, tier: state.egpu.tier } : null
    });
    return { result, message };
  }

  async function fail(job, state, inv, reason) {
    if (state.egpu) {
      state.egpu.phase = "failed";
      state.egpu.error = reason;
      if (state.egpu.registeredVia) await speck.disable("egpu").catch(() => {});
    }
    job.log.push({ at: now(), phase: "failed", message: reason });
    return finish(job, state, inv, "failed", reason);
  }

  // ------------------------------------------------------------------ state + API

  async function loadState() {
    return JSON.parse(await fs.readFile(paths.stateFile, "utf8").catch(() => "{}"));
  }

  async function saveState(state) {
    await writeAtomic(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  const view = (j) => j && { trigger: j.trigger, startedAt: j.startedAt, finishedAt: j.finishedAt, phase: j.phase, result: j.result, message: j.message, log: j.log.slice(-30) };

  /** Start a reconcile in the background. reboot: "auto" (at boot: reboot for a new driver) | "never". */
  function start({ trigger = "manual", reboot = "never" } = {}) {
    if (job && !job.finishedAt) throw new HwdError(409, `hardware reconcile already running (${job.phase})`);
    const current = { trigger, startedAt: now(), finishedAt: null, phase: "starting", result: null, message: "", log: [] };
    job = current;
    current.promise = reconcile(current, { reboot })
      .catch(async (error) => {
        current.result = "failed";
        current.message = error.message;
        current.log.push({ at: now(), phase: "failed", message: error.message });
        await audit.append({ op: "hwd", trigger, result: "failed", message: error.message }).catch(() => {});
      })
      .finally(() => { current.finishedAt = now(); });
    return { ok: true, job: view(current) };
  }

  async function status() {
    const [inv, state, placementFile] = await Promise.all([
      inventory(), loadState(), fs.readFile(paths.placementFile, "utf8").then(JSON.parse, () => null)
    ]);
    return {
      cpu: inv.cpu,
      gpus: inv.gpus.map(({ slot, vendor, vendorId, deviceId, kind, driver, vramBytes, link }) => ({ slot, vendor, id: `${vendorId}:${deviceId}`, kind, driver, vramBytes, link })),
      npus: inv.npus.map(({ slot, vendor, vendorId, deviceId, driver, ready }) => ({ slot, vendor, id: `${vendorId}:${deviceId}`, driver, ready })),
      egpu: state.egpu ?? null,
      placement: placementFile,
      job: view(job)
    };
  }

  return { inventory, boot, start, status, job: () => job };
}

function renderEnv(values, comment) {
  const lines = comment ? [`# ${comment}`] : [];
  for (const [key, value] of Object.entries(values)) {
    const text = String(value);
    lines.push(/[\s"'$`\\#]/.test(text) ? `${key}="${text.replace(/["\\$`]/g, "\\$&")}"` : `${key}=${text}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
    else if (/^'.*'$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, text, { mode: 0o644 });
  await fs.rename(temporary, file);
}

const hash = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");
const tail = (text, n = 1500) => String(text ?? "").trim().slice(-n);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
