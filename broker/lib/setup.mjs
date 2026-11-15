// First-boot setup, served by the broker next to the recovery console (no model involved).
//
// Two modes:
//   setup    an installed box that hasn't been set up: network, time zone, voice, model download.
//            The kiosk shows it until it's completed, then switches to Speck.
//   install  the USB installer (/etc/speck-os/installer exists): pick the internal disk, copy
//            this system onto it, restart.
//
// Setup acts as root directly (nmcli, timedatectl, speck-install) because it's the user at the
// keyboard, not the agent; service restarts and reboots still go through the broker's ops, and
// every action is audited. Secrets (Wi-Fi passwords) never appear in argv or the audit log.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { parseEnv } from "./egpu.mjs";

const DEFAULT_PATHS = {
  stateFile: "/var/lib/speck/.broker/setup.json",
  installerFlag: "/etc/speck-os/installer",
  workersDir: "/etc/speck-os/workers",
  modelsDir: "/var/lib/speck-infer/models",
  voiceConfig: "/etc/speck-os/voice.json",
  nmConnections: "/etc/NetworkManager/system-connections",
  installScript: "/usr/lib/speck-os/speck-install"
};
const STEPS = ["welcome", "network", "timezone", "voice", "models", "done"];
const MIN_DISK_BYTES = 64e9;

export class SetupError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createSetup({
  run, audit, ops, speckHealth, hardware, fetch = globalThis.fetch, spawn = nodeSpawn,
  config = {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date().toISOString()
}) {
  const paths = { ...DEFAULT_PATHS, ...(config.paths ?? {}) };
  const completeWaitMs = config.completeWaitMs ?? 120_000;
  const expectedCache = new Map();
  let zones = null;
  let installJob = null;

  // ------------------------------------------------------------------ persisted state
  async function load() {
    return JSON.parse(await fs.readFile(paths.stateFile, "utf8").catch(() => "{}"));
  }
  async function save(state) {
    await fs.mkdir(path.dirname(paths.stateFile), { recursive: true });
    const temporary = `${paths.stateFile}.tmp-${process.pid}`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2));
    await fs.rename(temporary, paths.stateFile);
  }
  const exists = (file) => fs.access(file).then(() => true, () => false);
  const mode = async () => (await exists(paths.installerFlag)) ? "install" : "setup";

  async function needed() {
    const m = await mode();
    return { mode: m, needed: m === "install" || !(await load()).completedAt };
  }

  // ------------------------------------------------------------------ network (NetworkManager)
  async function network() {
    const dev = await run("nmcli", ["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"], { timeoutMs: 10_000 });
    if (dev.code !== 0) return { available: false, online: false, connectivity: "unknown", devices: [], wifi: false };
    const devices = lines(dev.stdout).map(splitTerse)
      .map(([device, type, state, connection]) => ({ device, type, state, connection: connection === "--" ? "" : connection }))
      .filter((d) => d.type === "wifi" || d.type === "ethernet");
    const conn = await run("nmcli", ["-t", "networking", "connectivity"], { timeoutMs: 10_000 });
    const connectivity = conn.stdout.trim() || "unknown";
    const connected = devices.some((d) => d.state === "connected");
    return {
      available: true,
      connectivity,
      // Without a connectivity-check URL NetworkManager reports "unknown"; trust a connected link then.
      online: connectivity === "full" || (connectivity === "unknown" && connected),
      wifi: devices.some((d) => d.type === "wifi"),
      devices
    };
  }

  async function wifiScan() {
    const r = await run("nmcli", ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes"], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new SetupError(503, cleanNmError(r.stderr || r.stdout) || "Wi-Fi scan failed");
    return { networks: parseWifiList(r.stdout) };
  }

  async function wifiConnect(body) {
    const ssid = String(body.ssid ?? "");
    const password = String(body.password ?? "");
    const hidden = body.hidden === true;
    if (!ssid || Buffer.byteLength(ssid) > 32) throw new SetupError(400, "network name must be 1–32 bytes");
    if (/[\0-\x1f]/.test(password)) throw new SetupError(400, "password can't contain control characters");
    let security = String(body.security ?? "");
    if (!hidden && !security) {
      const seen = (await wifiScan().catch(() => ({ networks: [] }))).networks.find((n) => n.ssid === ssid);
      security = seen?.security ?? (password ? "WPA2" : "");
    }
    const keyMgmt = keyMgmtFor(security, password);
    if (keyMgmt === "wpa-psk" && !(/^[\x20-\x7e]{8,63}$/.test(password) || /^[0-9a-fA-F]{64}$/.test(password))) {
      throw new SetupError(400, "a WPA password is 8–63 characters");
    }
    if (keyMgmt === "sae" && !password) throw new SetupError(400, "this network needs a password");

    // A NetworkManager keyfile (root-only), so the password never appears in a process list.
    const uuid = crypto.randomUUID();
    const file = path.join(paths.nmConnections, `speck-${uuid}.nmconnection`);
    await fs.mkdir(paths.nmConnections, { recursive: true });
    await fs.writeFile(file, wifiKeyfile({ ssid, password, keyMgmt, uuid, hidden }), { mode: 0o600 });
    await fs.chmod(file, 0o600);
    let result = await run("nmcli", ["connection", "load", file], { timeoutMs: 15_000 });
    if (result.code === 0) result = await run("nmcli", ["--wait", "45", "connection", "up", "uuid", uuid], { timeoutMs: 60_000 });
    const ok = result.code === 0;
    if (!ok) {
      await run("nmcli", ["connection", "delete", "uuid", uuid], { timeoutMs: 15_000 });
      await fs.rm(file, { force: true });
    } else {
      await run("nmcli", ["networking", "connectivity", "check"], { timeoutMs: 20_000 });
      kickWorkers().catch(() => {});
    }
    const error = ok ? undefined : friendlyWifiError(result.stderr || result.stdout);
    await audit.append({ op: "setup.wifi", ssid, keyMgmt, ok, error });
    return { ok, error, network: await network() };
  }

  /** Workers that gave up while offline (or wait to retry) start downloading as soon as we're online. */
  async function kickWorkers() {
    for (const worker of await workerEnvs()) {
      const unit = `infer@${worker.name}.service`;
      const state = (await run("systemctl", ["is-active", unit])).stdout.trim();
      if (["failed", "inactive", "activating"].includes(state)) {
        await run("systemctl", ["reset-failed", unit]);
        await ops.service({ action: "restart", unit });
      }
    }
  }

  // ------------------------------------------------------------------ time zone
  async function timezones() {
    if (!zones) {
      const r = await run("timedatectl", ["list-timezones"], { timeoutMs: 15_000 });
      zones = r.code === 0 ? lines(r.stdout) : [];
    }
    return zones;
  }
  async function currentTimezone() {
    const r = await run("timedatectl", ["show", "-p", "Timezone", "--value"], { timeoutMs: 10_000 });
    return r.stdout.trim() || "UTC";
  }
  async function setTimezone(body) {
    const zone = String(body.zone ?? "");
    if (!(await timezones()).includes(zone)) throw new SetupError(400, `unknown time zone ${zone}`);
    const r = await run("timedatectl", ["set-timezone", zone], { timeoutMs: 15_000 });
    await audit.append({ op: "setup.timezone", zone, ok: r.code === 0 });
    if (r.code !== 0) throw new SetupError(500, r.stderr.trim() || "timedatectl failed");
    return { ok: true, timezone: zone };
  }

  // ------------------------------------------------------------------ models
  async function workerEnvs() {
    const names = (await fs.readdir(paths.workersDir).catch(() => [])).filter((f) => f.endsWith(".env")).sort();
    const out = [];
    for (const file of names) {
      const name = file.slice(0, -4);
      if (name === "egpu") continue;   // speck-hwd owns the eGPU worker and its (large) download
      const env = parseEnv(await fs.readFile(path.join(paths.workersDir, file), "utf8").catch(() => ""));
      if (env.MODEL_HF && env.PORT) out.push({ name, port: Number(env.PORT), modelHf: env.MODEL_HF });
    }
    return out;
  }

  /** Total size of the model's GGUF file(s), from the Hugging Face API (cached; null when unknown). */
  async function expectedBytes(modelHf) {
    if (expectedCache.has(modelHf)) return expectedCache.get(modelHf);
    const [repo, quant = ""] = modelHf.split(":");
    try {
      const response = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return null;
      const bytes = ggufBytesFor(await response.json(), quant);
      if (bytes) expectedCache.set(modelHf, bytes);
      return bytes;
    } catch {
      return null;
    }
  }

  async function models({ online } = {}) {
    const files = await listFiles(paths.modelsDir, 5);
    return Promise.all((await workerEnvs()).map(async (w) => {
      const repoName = w.modelHf.split(":")[0].split("/").pop().toLowerCase();
      const bytes = files.filter((f) => f.path.toLowerCase().includes(repoName)).reduce((sum, f) => sum + f.size, 0);
      const [ready, unit, expected] = await Promise.all([
        probe(fetch, `http://127.0.0.1:${w.port}/health`),
        run("systemctl", ["is-active", `infer@${w.name}.service`]).then((r) => r.stdout.trim()),
        online ? expectedBytes(w.modelHf) : Promise.resolve(expectedCache.get(w.modelHf) ?? null)
      ]);
      let status;
      if (ready) status = "ready";
      else if (expected && bytes >= expected * 0.995) status = "loading";
      else if (bytes > 0 && online) status = "downloading";
      else if (!online) status = "waiting-network";
      else if (unit === "failed") status = "failed";
      else status = "starting";
      return { name: w.name, model: w.modelHf, status, bytes, expectedBytes: expected, unit };
    }));
  }

  // ------------------------------------------------------------------ voice
  async function readVoiceConfig() {
    return JSON.parse(await fs.readFile(paths.voiceConfig, "utf8").catch(() => "null"));
  }
  async function voice() {
    const cfg = await readVoiceConfig();
    if (!cfg) return { available: false };
    let voices = [];
    try {
      const response = await fetch(`http://127.0.0.1:${cfg.port ?? 4320}/v1/voices`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) voices = (await response.json()).voices ?? [];
    } catch { /* service down: the page says so */ }
    return { available: voices.length > 0, defaultVoice: cfg.tts?.defaultVoice ?? null, voices: voices.map(({ id, name, lang }) => ({ id, name, lang })) };
  }
  async function setVoice(body) {
    const id = String(body.voice ?? "");
    const current = await voice();
    if (!current.voices.some((v) => v.id === id)) throw new SetupError(400, `unknown voice ${id}`);
    const cfg = await readVoiceConfig();
    if (cfg.tts?.defaultVoice !== id) {
      cfg.tts = { ...(cfg.tts ?? {}), defaultVoice: id };
      await fs.writeFile(paths.voiceConfig, `${JSON.stringify(cfg, null, 2)}\n`);
      // speck-voice warms the default voice at start, so the first reply in that voice is quick.
      await ops.service({ action: "restart", unit: "speck-voice.service" });
    }
    await audit.append({ op: "setup.voice", voice: id });
    return { ok: true, defaultVoice: id };
  }

  // ------------------------------------------------------------------ installer
  async function sourceDisk() {
    const source = (await run("findmnt", ["-no", "SOURCE", "/"])).stdout.trim().replace(/\[.*\]$/, "");
    if (!source) return "";
    const parent = (await run("lsblk", ["-no", "PKNAME", source])).stdout.trim().split("\n")[0];
    return parent ? `/dev/${parent}` : source;
  }

  async function disks() {
    const r = await run("lsblk", ["-J", "-b", "-o", "NAME,PATH,SIZE,MODEL,SERIAL,TYPE,RM,HOTPLUG,TRAN,FSTYPE,LABEL"], { timeoutMs: 15_000 });
    if (r.code !== 0) throw new SetupError(500, `lsblk failed: ${r.stderr.trim()}`);
    const skip = await sourceDisk();
    return { disks: parseDisks(JSON.parse(r.stdout), { exclude: skip, minBytes: config.minDiskBytes ?? MIN_DISK_BYTES }), installMedia: skip };
  }

  async function install(body) {
    if ((await mode()) !== "install") throw new SetupError(409, "not running from the installer");
    if (installJob?.state === "running") throw new SetupError(409, "an install is already running");
    const target = String(body.disk ?? "");
    const { disks: list } = await disks();
    const disk = list.find((d) => d.path === target);
    if (!disk) throw new SetupError(400, `${target} is not an installable disk`);
    if (!disk.eligible) throw new SetupError(400, disk.reason);
    installJob = { state: "running", disk: target, model: disk.model, percent: 0, message: "Starting", log: [], startedAt: now() };
    const job = installJob;
    await audit.append({ op: "setup.install", disk: target, model: disk.model, sizeBytes: disk.sizeBytes });
    const child = spawn(paths.installScript, ["--from-running", "--target", target, "--yes"], { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const progress = /^@@ (\d+) (.*)$/.exec(line);
        if (progress) { job.percent = Number(progress[1]); job.message = progress[2]; }
        job.log.push(line);
        if (job.log.length > 300) job.log.shift();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => { job.log.push(error.message); });
    child.on("close", async (code) => {
      job.state = code === 0 ? "done" : "failed";
      if (code === 0) { job.percent = 100; job.message = "Installed"; }
      job.finishedAt = now();
      job.exitCode = code;
      await audit.append({ op: "setup.install", disk: target, ok: code === 0, exitCode: code, tail: job.log.slice(-15).join("\n") });
    });
    return { ok: true, job: viewJob(job) };
  }

  const viewJob = (job) => job && { ...job, log: job.log.slice(-60) };

  async function reboot() {
    return ops.power({ action: "reboot", reason: "setup", delaySec: 3 });
  }

  // ------------------------------------------------------------------ flow
  async function setStep(body) {
    const step = String(body.step ?? "");
    if (!STEPS.includes(step)) throw new SetupError(400, `unknown step ${step}`);
    const state = await load();
    state.step = step;
    await save(state);
    return { ok: true, step };
  }

  /** Finish: wait (bounded) for Speck to be up, then hand the screen to it. */
  async function complete() {
    if ((await mode()) === "install") throw new SetupError(409, "the installer has no setup to complete");
    const deadline = Date.now() + completeWaitMs;
    let speck = await speckHealth();
    while (!speck.ok && Date.now() < deadline) {
      await sleep(2000);
      speck = await speckHealth();
    }
    const state = await load();
    state.completedAt = now();
    await save(state);
    await audit.append({ op: "setup.complete", speckHealthy: speck.ok });
    return { ok: true, speckHealthy: speck.ok, reason: speck.ok ? undefined : speck.reason };
  }

  async function state() {
    const m = await mode();
    const saved = await load();
    const base = { mode: m, needed: m === "install" || !saved.completedAt, completedAt: saved.completedAt ?? null, step: saved.step ?? "welcome" };
    const hw = await hardware().catch(() => null);
    if (m === "install") {
      return { ...base, hardware: hw, disks: await disks().catch((error) => ({ error: error.message, disks: [] })), install: viewJob(installJob) };
    }
    const net = await network();
    const [tz, mdl, vc, speck] = await Promise.all([currentTimezone(), models({ online: net.online }), voice(), speckHealth()]);
    return { ...base, hardware: hw, network: net, timezone: tz, models: mdl, voice: vc, speck };
  }

  return {
    state, needed, network, wifiScan, wifiConnect, timezones, setTimezone, models, voice, setVoice,
    disks, install, reboot, setStep, complete, installJob: () => installJob
  };
}

// -------------------------------------------------------------------- HTTP
/**
 * Routes under /setup and /api/setup/ on the recovery console's server. POSTs need the
 * X-Speck-Setup header, which a cross-site form can't send.
 */
export function setupRoutes(setup, pagePath) {
  const routes = {
    "GET /api/setup/needed": () => setup.needed(),
    "GET /api/setup/state": () => setup.state(),
    "GET /api/setup/timezones": async () => ({ zones: await setup.timezones() }),
    "POST /api/setup/wifi/scan": () => setup.wifiScan(),
    "POST /api/setup/wifi/connect": (body) => setup.wifiConnect(body),
    "POST /api/setup/timezone": (body) => setup.setTimezone(body),
    "POST /api/setup/voice": (body) => setup.setVoice(body),
    "POST /api/setup/step": (body) => setup.setStep(body),
    "POST /api/setup/complete": () => setup.complete(),
    "POST /api/setup/install": (body) => setup.install(body),
    "POST /api/setup/reboot": () => setup.reboot()
  };
  return async function handle(req, res, url, send) {
    if (req.method === "GET" && url.pathname === "/setup") {
      send(200, await fs.readFile(pagePath, "utf8"), "text/html; charset=utf-8");
      return true;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return false;
    if (req.method === "POST") {
      if (req.headers["x-speck-setup"] !== "1") { send(403, { ok: false, error: "missing X-Speck-Setup header" }); return true; }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10_000) { send(413, { ok: false, error: "too large" }); return true; }
      }
      send(200, await route(raw ? JSON.parse(raw) : {}));
      return true;
    }
    send(200, await route({}));
    return true;
  };
}

// -------------------------------------------------------------------- parsing (exported for tests)
const lines = (text) => String(text).split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);

/** nmcli -t output: fields split on ':', with '\:' and '\\' escaped. */
export function splitTerse(line) {
  const out = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) { current += line[++i]; continue; }
    if (c === ":") { out.push(current); current = ""; continue; }
    current += c;
  }
  out.push(current);
  return out;
}

/** One entry per network name (the strongest access point), connected first, then by signal. */
export function parseWifiList(text) {
  const byName = new Map();
  for (const [inUse, ssid, signal, security] of lines(text).map(splitTerse)) {
    if (!ssid) continue;   // hidden networks are joined by name
    const entry = { ssid, signal: Number(signal) || 0, security: security === "--" ? "" : (security ?? "").trim(), connected: inUse === "*" };
    const seen = byName.get(ssid);
    if (!seen) byName.set(ssid, entry);
    else {
      seen.connected ||= entry.connected;
      if (entry.signal > seen.signal) Object.assign(seen, { signal: entry.signal, security: entry.security });
    }
  }
  return [...byName.values()].sort((a, b) => Number(b.connected) - Number(a.connected) || b.signal - a.signal);
}

export function keyMgmtFor(security, password) {
  const s = String(security).toUpperCase();
  if (/802\.1X/.test(s)) throw new SetupError(400, "enterprise (802.1X) Wi-Fi isn't supported in setup yet; use Ethernet, then ask Speck to set it up");
  if (/WEP/.test(s)) throw new SetupError(400, "WEP networks aren't supported (WEP is insecure)");
  if (!s && !password) return "none";
  if (/WPA3/.test(s) && !/WPA[12]/.test(s)) return "sae";
  return "wpa-psk";
}

/** GKeyFile string escaping: backslash, leading space, control characters. */
function keyfileString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/^ /, "\\s");
}

export function wifiKeyfile({ ssid, password, keyMgmt, uuid, hidden = false }) {
  // Plain names are written as text; anything unusual as NetworkManager's byte-list form.
  const plainSsid = /^[A-Za-z0-9_.()+,&@!#%*=?~'-][A-Za-z0-9 _.()+,&@!#%*=?~'-]*$/.test(ssid) && !ssid.endsWith(" ");
  const ssidValue = plainSsid ? ssid : `${[...Buffer.from(ssid, "utf8")].join(";")};`;
  const out = [
    "[connection]", `id=${keyfileString(ssid)}`, `uuid=${uuid}`, "type=wifi", "autoconnect=true", "",
    "[wifi]", "mode=infrastructure", `ssid=${ssidValue}`, ...(hidden ? ["hidden=true"] : []), ""
  ];
  if (keyMgmt !== "none") out.push("[wifi-security]", `key-mgmt=${keyMgmt}`, `psk=${keyfileString(password)}`, "");
  out.push("[ipv4]", "method=auto", "", "[ipv6]", "addr-gen-mode=default", "method=auto", "");
  return out.join("\n");
}

function cleanNmError(text) {
  return String(text ?? "").trim().split("\n").pop()?.replace(/^Error:\s*/, "") ?? "";
}

export function friendlyWifiError(text) {
  const raw = cleanNmError(text);
  if (/secrets were required|802-11-wireless-security|psk/i.test(raw)) return "Couldn't connect. Check the password and try again.";
  if (/no network with ssid|not found/i.test(raw)) return "That network isn't in range.";
  if (/timeout|timed out/i.test(raw)) return "The network didn't answer in time. Try again, or move closer to the router.";
  return raw || "Couldn't connect.";
}

/** The GGUF file(s) llama-server -hf would fetch for a quant: split parts together, mmproj excluded. */
export function ggufFilesFor(entries, quant) {
  const q = String(quant).toLowerCase();
  const files = (Array.isArray(entries) ? entries : []).filter((e) => {
    const name = String(e.path ?? "").toLowerCase();
    return name.endsWith(".gguf") && !name.includes("mmproj") && (!q || name.includes(q));
  });
  if (!files.length) return [];
  // Several single-file matches (e.g. "Q4_K_M" and "IQ4_K_M") → prefer the exact quant suffix.
  const exact = files.filter((e) => new RegExp(`[-_.]${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-\\d{5}-of-\\d{5})?\\.gguf$`).test(String(e.path).toLowerCase()));
  return exact.length ? exact : files.slice(0, 1);
}

export function ggufBytesFor(entries, quant) {
  const files = ggufFilesFor(entries, quant);
  return files.reduce((sum, e) => sum + Number(e.lfs?.size ?? e.size ?? 0), 0) || null;
}

/** Disks the installer may write to: whole disks, not the install media, big enough. */
export function parseDisks(lsblk, { exclude = "", minBytes = MIN_DISK_BYTES } = {}) {
  const out = [];
  for (const dev of lsblk.blockdevices ?? []) {
    if (dev.type !== "disk") continue;
    const devPath = dev.path ?? `/dev/${dev.name}`;
    if (/^\/dev\/(zram|loop|sr|ram)/.test(devPath)) continue;
    if (devPath === exclude) continue;
    const size = Number(dev.size ?? 0);
    const removable = dev.rm === true || dev.rm === "1" || dev.hotplug === true || dev.hotplug === "1";
    const partitions = (dev.children ?? []).map((c) => ({ path: c.path ?? `/dev/${c.name}`, fstype: c.fstype ?? null, label: c.label ?? null, sizeBytes: Number(c.size ?? 0) }));
    let reason = "";
    if (size < minBytes) reason = `too small (needs at least ${Math.round(minBytes / 1e9)} GB)`;
    out.push({
      path: devPath, model: (dev.model ?? "").trim() || "Disk", serial: dev.serial ?? null, sizeBytes: size,
      transport: dev.tran ?? null, removable, partitions, eligible: !reason, reason: reason || undefined
    });
  }
  // Internal (NVMe/SATA) disks first: that's almost always where it should go.
  return out.sort((a, b) => Number(a.removable) - Number(b.removable) || Number(b.eligible) - Number(a.eligible) || b.sizeBytes - a.sizeBytes);
}

async function listFiles(dir, depth) {
  const out = [];
  async function walk(current, level) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;   // HF cache snapshots link to blobs: count blobs once
      if (entry.isDirectory()) { if (level < depth) await walk(full, level + 1); continue; }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (stat) out.push({ path: full, size: stat.size });
    }
  }
  await walk(dir, 0);
  return out;
}

async function probe(fetch, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}
