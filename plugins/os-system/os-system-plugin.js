/**
 * Plugin Name: OS System
 * Plugin Slug: os-system
 * Description: The agent administers the machine it runs on through speck-broker: any script as
 *   root, packages, services, reboot, snapshots and rollback. Every change is snapshotted and
 *   audited by the broker; the system falls back to the last known good root after two failed boots.
 * Version: 0.2.0
 */

import http from "node:http";
import { readFile } from "node:fs/promises";

const SOCKET = process.env.SPECK_BROKER_SOCKET || "/run/speck-broker/broker.sock";
const OUTPUT_TAIL = 4000;
const S = { type: "string" };

const TOOLS = [
  { name: "os_status", description: "Read the machine's state: kernel, uptime, memory, disk, failed services, upgradable packages, whether a reboot is required, snapshot availability and boot-fallback state.",
    parameters: { type: "object", properties: {} } },
  { name: "os_exec", risk: "high", description: "Run a bash script on this machine, as root by default. Use it for any administration: configuration, diagnostics, installing software, writing files. Root runs are snapshotted first and can be rolled back. Output is the exit code and the end of stdout/stderr.",
    parameters: { type: "object", properties: {
      script: { ...S, description: "The bash script to run" },
      description: { ...S, description: "One line saying what this does and why (recorded in the audit log and the snapshot)" },
      user: { type: "string", enum: ["root", "speck"], description: "Run as root (default) or as the unprivileged speck service user" },
      timeout_sec: { type: "integer", description: "Timeout in seconds (default 600, max 3600)" },
      snapshot: { type: "boolean", description: "Take a snapshot first (default true for root)" }
    }, required: ["script", "description"] } },
  { name: "os_packages", risk: "high", description: "Manage apt packages: update the index, upgrade the system, install, remove, purge or autoremove. Snapshotted (except update). Says whether a reboot is now required.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["update", "upgrade", "install", "remove", "purge", "autoremove"] },
      packages: { type: "array", items: S, description: "Package names, optionally name=version" }
    }, required: ["action"] } },
  { name: "os_service", risk: "high", description: "Control a systemd unit: status, start, stop, restart, reload, enable, disable, mask, unmask.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["status", "start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask"] },
      unit: { ...S, description: "Unit name, e.g. pipewire.service or infer@worker.service" }
    }, required: ["action", "unit"] } },
  { name: "os_power", risk: "high", description: "Reboot or power off the machine after a short delay. Task state survives a reboot. If the system does not come back healthy twice in a row, it boots the last known good root.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["reboot", "poweroff"] },
      reason: { ...S, description: "Why (recorded in the audit log)" },
      delay_sec: { type: "integer", description: "Delay before acting, default 5" }
    }, required: ["action", "reason"] } },
  { name: "os_snapshots", description: "List system snapshots (number, type, date, description). Each mutating operation has a pre and post snapshot.",
    parameters: { type: "object", properties: {} } },
  { name: "os_rollback", risk: "high", description: "Revert every system file changed since a snapshot back to that snapshot. The rollback itself is snapshotted, so it can be undone. Agent memory is not affected. A reboot is usually advisable afterwards.",
    parameters: { type: "object", properties: {
      snapshot: { type: "integer", description: "Snapshot number to return to (use a 'pre' snapshot from os_snapshots)" },
      reason: { ...S, description: "Why" }
    }, required: ["snapshot", "reason"] } },
  { name: "os_update", risk: "high", description: "Update Speck itself. Runs in the background: the new version is built in the spare slot, must pass the test suite and start cleanly against a copy of your state, then replaces the running version. If it isn't healthy for 5 minutes, code and state roll back automatically. Speck restarts during the switch; your tasks resume. Check progress with os_update_status.",
    parameters: { type: "object", properties: {
      bundle: { ...S, description: "Path to a Speck source bundle (.tar.gz) on this machine" },
      git_url: { ...S, description: "Git repository to update from, instead of a bundle" },
      git_ref: { ...S, description: "Branch or tag for git_url" }
    } } },
  { name: "os_update_status", description: "Show the running Speck version in each slot, the current update's phase and log, and recent update history.",
    parameters: { type: "object", properties: {} } },
  { name: "os_update_rollback", risk: "high", description: "Switch back to the previous Speck version. Keeps your memory unless restore_state is true, which also returns your state to just before that update (only needed if the newer version changed the database in a way the old one can't read).",
    parameters: { type: "object", properties: {
      reason: { ...S, description: "Why" },
      restore_state: { type: "boolean", description: "Also restore state from before the update (loses memory formed since)" }
    }, required: ["reason"] } },
  { name: "os_hardware", description: "Show this machine's compute hardware: CPU, integrated and discrete GPUs (with VRAM and PCIe link), NPUs, the eGPU's setup state (driver, llama.cpp backend, planned model, Speck tier, any error), the progress of a running hardware job, and the recommended device for each workload.",
    parameters: { type: "object", properties: {} } },
  { name: "os_hardware_reconcile", risk: "high", description: "Set up the hardware again in the background: install a driver for a newly attached eGPU, build llama.cpp for it, choose the largest model its VRAM fits, start its worker and register it as a higher Speck tier, or retire it if it's gone. This runs automatically at boot; call it after changing /etc/speck-os/hwd.json or the eGPU worker's settings, or after fixing a failed driver. It never reboots: if a driver needs one, os_hardware says so and you decide when (os_power). Check progress with os_hardware.",
    parameters: { type: "object", properties: {} } },
  { name: "os_voice", description: "Show or change where speech is processed. 'local' recognises and speaks entirely on this machine (offline, private); 'chrome' uses Google Chrome's own speech (needs the internet for recognition). For speech output, 'both' lists Chrome's voices next to the local ones. With no arguments it shows the current settings and whether the local speech service is healthy. A change reloads the screen about 8 seconds later, so say what you're doing first. The user picks the voice itself in System → Voice.",
    parameters: { type: "object", properties: {
      recognition: { type: "string", enum: ["local", "chrome"], description: "Speech recognition engine" },
      speech: { type: "string", enum: ["local", "chrome", "both"], description: "Speech output voices" }
    } } },
  { name: "os_audit", description: "Read the most recent entries of the broker's audit log: every script, package, service, power, snapshot and boot event, with outcomes.",
    parameters: { type: "object", properties: { limit: { type: "integer", description: "Entries to return (default 30)" } } } }
];

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request({ socketPath: SOCKET, method, path, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { ok: false, error: text }; }
        if (res.statusCode >= 400) reject(new Error(parsed.error || `broker ${res.statusCode}`));
        else resolve(parsed);
      });
    });
    req.on("error", (error) => reject(new Error(`speck-broker unreachable at ${SOCKET}: ${error.message}`)));
    req.end(payload);
  });
}

const VOICE_CONFIG = process.env.SPECK_VOICE_CONFIG || "/etc/speck-os/voice.json";

async function voiceStatus() {
  let settings = null;
  try { settings = JSON.parse(await readFile(VOICE_CONFIG, "utf8")); } catch { /* not installed */ }
  let service = { healthy: false };
  if (settings) {
    try {
      const response = await fetch(`http://127.0.0.1:${settings.port ?? 4320}/health`, { signal: AbortSignal.timeout(3000) });
      service = { healthy: response.ok, ...(await response.json()) };
    } catch (error) {
      service = { healthy: false, error: error.message };
    }
  }
  return {
    recognition: settings?.browser?.stt ?? "chrome",
    speech: settings?.browser?.tts ?? "chrome",
    sttModel: settings?.stt?.model ?? null,
    voices: settings?.tts?.models ?? [],
    localService: service
  };
}

const tail = (text) => {
  const value = String(text ?? "");
  return value.length > OUTPUT_TAIL ? `…${value.slice(-OUTPUT_TAIL)}` : value;
};

function forModel(result) {
  const out = { ...result };
  if ("stdout" in out) out.stdout = tail(out.stdout);
  if ("stderr" in out) out.stderr = tail(out.stderr);
  delete out.script;
  return JSON.stringify(out);
}

export function createOsSystemPlugin() {
  const handlers = {
    os_status: async () => forModel(await call("GET", "/v1/status")),
    os_exec: async (args) => forModel(await call("POST", "/v1/exec", {
      script: args.script, description: args.description, user: args.user, timeoutSec: args.timeout_sec, snapshot: args.snapshot
    })),
    os_packages: async (args) => forModel(await call("POST", "/v1/pkg", { action: args.action, packages: args.packages || [] })),
    os_service: async (args) => forModel(await call("POST", "/v1/service", { action: args.action, unit: args.unit })),
    os_power: async (args) => forModel(await call("POST", "/v1/power", { action: args.action, reason: args.reason, delaySec: args.delay_sec })),
    os_snapshots: async () => {
      const list = await call("GET", "/v1/snapshots");
      return JSON.stringify({ ...list, snapshots: (list.snapshots || []).slice(-40) });
    },
    os_rollback: async (args) => forModel(await call("POST", "/v1/rollback", { snapshot: args.snapshot, reason: args.reason })),
    os_update: async (args) => {
      const source = args.git_url ? { type: "git", url: args.git_url, ref: args.git_ref || undefined }
        : args.bundle ? { type: "bundle", path: args.bundle } : undefined;
      return JSON.stringify(await call("POST", "/v1/update", { source }));
    },
    os_update_status: async () => JSON.stringify(await call("GET", "/v1/update")),
    os_update_rollback: async (args) => JSON.stringify(await call("POST", "/v1/update/rollback", { reason: args.reason, restoreState: args.restore_state === true })),
    os_hardware: async () => JSON.stringify(await call("GET", "/v1/hw")),
    os_hardware_reconcile: async () => JSON.stringify(await call("POST", "/v1/hw/reconcile", { trigger: "agent" })),
    os_voice: async (args) => {
      const change = {};
      if (["local", "chrome"].includes(args.recognition)) change.stt = args.recognition;
      if (["local", "chrome", "both"].includes(args.speech)) change.tts = args.speech;
      if (Object.keys(change).length) {
        // Values come from the enums above, so they're safe to embed.
        const script = [
          `node -e 'const fs = require("fs"); const f = "${VOICE_CONFIG}"; const c = JSON.parse(fs.readFileSync(f, "utf8"));`
            + ` c.browser = { ...c.browser, ...${JSON.stringify(change)} }; fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\\n");'`,
          "systemd-run --quiet --on-active=8 systemctl restart speck-kiosk.service"
        ].join("\n");
        const result = await call("POST", "/v1/exec", { script, description: `voice settings: ${JSON.stringify(change)}` });
        if (!result.ok) return forModel(result);
      }
      return JSON.stringify({ ...(await voiceStatus()), ...(Object.keys(change).length ? { changed: change, screenReloadsInSeconds: 8 } : {}) });
    },
    os_audit: async (args) => JSON.stringify(await call("GET", `/v1/audit?limit=${Number(args.limit) || 30}`))
  };

  return {
    id: "os-system",
    name: "OS System",
    version: "0.2.0",
    description: "Administer this machine through speck-broker: root scripts, packages, services, reboot, snapshots, rollback, self-update, hardware and eGPU setup, audit.",
    manifest: {
      schemaVersion: 1,
      startupPriority: 20,
      permissions: {
        routes: false,
        uiPanels: false,
        data: false,
        capabilities: ["os:status"],
        hooks: [],
        runtimeContext: [],
        tools: TOOLS.map((tool) => tool.name)
      },
      compatibility: { coreApiMin: "1.7.0", coreApiMax: "" },
      dependencies: { requiredCapabilities: [], optionalCapabilities: [] },
      security: { isolation: "inprocess" }
    },
    async init(api) {
      api.provideCapability("os:status", () => call("GET", "/v1/status"));
      for (const descriptor of TOOLS) {
        api.registerTool({ scopes: ["worker"], ...descriptor }, handlers[descriptor.name]);
      }
    }
  };
}

export const OS_SYSTEM_TOOLS = TOOLS.map((tool) => tool.name);
export default createOsSystemPlugin;
