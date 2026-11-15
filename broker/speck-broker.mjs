#!/usr/bin/env node
// speck-broker: the agent's root access. Serves HTTP/JSON on a unix socket that only root and the
// speck user can open.
//
//   speck-broker serve       daemon (speck-broker.service)
//   speck-broker boot-ok     once per boot (speck-boot-ok.service)
//   speck-broker mark-good   make the running root the boot fallback now
//   speck-broker status      print status JSON
//   speck-broker update [<bundle.tar.gz> | <git-url> [ref]]   start a self-update (default source from update.json)
//   speck-broker update-status
//   speck-broker hw-boot     once per boot, before the workers (speck-hwd.service): pin devices, then reconcile
//   speck-broker hw          hardware, eGPU state and placement
//   speck-broker hw-reconcile
//   speck-broker setup-reset   show first-boot setup again on the kiosk
import http from "node:http";
import fs from "node:fs/promises";
import { run, runOk } from "./lib/run.mjs";
import { createAudit } from "./lib/audit.mjs";
import { createSnapshots } from "./lib/snapshots.mjs";
import { createBootGuard } from "./lib/bootguard.mjs";
import { createBroker, BrokerError } from "./lib/broker.mjs";
import { createUpdater, createLinks, createStateGuard, createHistory } from "./lib/updater.mjs";
import { createRecoveryServer } from "./lib/recovery.mjs";
import { createHwd } from "./lib/egpu.mjs";
import { createSpeckModels } from "./lib/speck-models.mjs";
import { createSetup } from "./lib/setup.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOCKET = process.env.SPECK_BROKER_SOCKET || "/run/speck-broker/broker.sock";
const SERVICE_USER = process.env.SPECK_SERVICE_USER || "speck";
const HEALTH_URL = process.env.SPECK_HEALTH_URL || "http://127.0.0.1:4310/api/health";
const HEALTH_UNITS = (process.env.SPECK_HEALTH_UNITS || "speck.service").split(/[\s,]+/).filter(Boolean);
const AUDIT_FILE = process.env.SPECK_BROKER_AUDIT || "/var/lib/speck/.broker/audit.jsonl";
const RECOVERY_PORT = Number(process.env.SPECK_RECOVERY_PORT || 4399);
const UPDATE_CONFIG = process.env.SPECK_UPDATE_CONFIG || "/etc/speck-os/update.json";
const HWD_CONFIG = process.env.SPECK_HWD_CONFIG || "/etc/speck-os/hwd.json";
const SPECK_URL = process.env.SPECK_URL || "http://127.0.0.1:4310";
const MODEL_CONFIG = process.env.SPECK_MODEL_CONFIG || "/var/lib/speck/genesis-runtime/model-processors.json";
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function health(url) {
  if (url) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return response.ok ? { ok: true } : { ok: false, reason: `health ${response.status}` };
    } catch (error) {
      return { ok: false, reason: `health unreachable: ${error.message}` };
    }
  }
  for (const unit of HEALTH_UNITS) {
    const active = (await run("systemctl", ["is-active", unit])).stdout.trim();
    if (active !== "active") return { ok: false, reason: `${unit} is ${active || "unknown"}` };
  }
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
    return response.ok ? { ok: true } : { ok: false, reason: `health ${response.status}` };
  } catch (error) {
    return { ok: false, reason: `health unreachable: ${error.message}` };
  }
}

const audit = createAudit(AUDIT_FILE);
const snapshots = createSnapshots({ run, mode: process.env.SPECK_BROKER_SNAPSHOTS || "auto" });
const bootguard = createBootGuard({
  run, audit, health,
  config: { settleMs: Number(process.env.SPECK_SETTLE_SEC || 600) * 1000 }
});
const updateConfig = JSON.parse(await fs.readFile(UPDATE_CONFIG, "utf8").catch(() => "{}"));
let broker;
const updater = createUpdater({
  run, audit, bootguard,
  health: (url) => health(url),
  links: createLinks({ run }),
  stateGuard: createStateGuard({ run, mountTop: bootguard.mountTop }),
  history: createHistory(path.join(path.dirname(AUDIT_FILE), "updates.json")),
  exclusive: (task) => broker.exclusive(task),
  config: { healthUrl: HEALTH_URL, serviceUser: SERVICE_USER, ...updateConfig }
});
const hwdConfig = JSON.parse(await fs.readFile(HWD_CONFIG, "utf8").catch(() => "{}"));
const hwd = createHwd({
  run, audit,
  config: hwdConfig,
  probeHealth: (url) => health(url),
  speck: createSpeckModels({ baseUrl: SPECK_URL, file: MODEL_CONFIG, owner: `${SERVICE_USER}:${SERVICE_USER}`, run }),
  // System changes go through the broker ops, so they are snapshotted, serialised and audited.
  ops: {
    exec: (body) => broker.handle("POST", "/v1/exec", body),
    service: (body) => broker.handle("POST", "/v1/service", body),
    power: (body) => broker.handle("POST", "/v1/power", body)
  }
});
// First-boot setup and the USB installer (served with the recovery console).
const setup = createSetup({
  run, audit,
  speckHealth: () => health(HEALTH_URL),
  hardware: () => hwd.status(),
  ops: {
    service: (body) => broker.handle("POST", "/v1/service", body),
    power: (body) => broker.handle("POST", "/v1/power", body)
  }
});
broker = createBroker({ run, snapshots, bootguard, audit, updater, hwd, config: { serviceUser: SERVICE_USER } });
const reboot = async (reason) => {
  await audit.append({ op: "power", action: "reboot", reason });
  await run("systemctl", ["reboot"]);
};

async function serve() {
  await fs.rm(SOCKET, { force: true });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://broker");
    let body = {};
    try {
      if (req.method === "POST") {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new BrokerError(413, "body too large");
          chunks.push(chunk);
        }
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      }
      const result = await broker.handle(req.method, url.pathname, body, url.searchParams);
      send(res, 200, result);
    } catch (error) {
      const status = error instanceof BrokerError ? error.status : error instanceof SyntaxError ? 400 : 500;
      send(res, status, { ok: false, error: error.message });
    }
  });
  server.requestTimeout = 0;   // exec and apt can run for an hour
  server.headersTimeout = 60_000;
  await new Promise((resolve) => server.listen(SOCKET, resolve));
  const gid = Number(await runOk(run, "id", ["-g", SERVICE_USER]));
  await fs.chown(SOCKET, 0, gid);
  await fs.chmod(SOCKET, 0o660);
  console.log(`[broker] listening on ${SOCKET} (root:${SERVICE_USER} 0660)`);
  const recovery = createRecoveryServer({ broker, run, health, healthUrl: HEALTH_URL, pagePath: path.join(HERE, "recovery", "index.html"),
    setup, setupPagePath: path.join(HERE, "setup", "index.html") });
  recovery.listen(RECOVERY_PORT, "127.0.0.1", () => console.log(`[broker] recovery console on http://127.0.0.1:${RECOVERY_PORT}/`));
  const stop = () => { recovery.close(); server.close(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

function send(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function callDaemon(method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request({ socketPath: SOCKET, method, path, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => { try { resolve(JSON.parse(text)); } catch { resolve({ ok: false, error: text }); } });
    });
    req.on("error", (error) => resolve({ ok: false, error: error.message }));
    req.end(payload);
  });
}

const command = process.argv[2] || "serve";
const print = (value) => console.log(JSON.stringify(value, null, 2));
switch (command) {
  case "serve": await serve(); break;
  case "boot-ok": {
    const result = await bootguard.bootOk({ reboot });
    print(result);
    if (result.action === "ok") {
      // Stay healthy for the settle period, then have the daemon make this root the fallback.
      await new Promise((resolve) => setTimeout(resolve, result.settleMs));
      print(await callDaemon("POST", "/v1/mark-good"));
    }
    break;
  }
  case "mark-good": print(await bootguard.markGood("cli")); break;
  case "status": print(await broker.handle("GET", "/v1/status")); break;
  case "update": {
    const [arg, ref] = process.argv.slice(3);
    const source = !arg ? undefined
      : /^(https?:|git@|ssh:)/.test(arg) || arg.endsWith(".git") ? { type: "git", url: arg, ref }
      : { type: "bundle", path: path.resolve(arg) };
    print(await callDaemon("POST", "/v1/update", { source }));
    break;
  }
  case "update-status": print(await callDaemon("GET", "/v1/update")); break;
  case "hw-boot": {
    // Synchronous part first (the workers start after this unit): pin the base workers to the iGPU
    // and allow infer@egpu only for the card it was set up for. Then the daemon reconciles in the
    // background: drivers, builds and model downloads can take a long time.
    print(await hwd.boot());
    // The daemon may still be creating its socket (speck-broker.service is Type=simple).
    let started;
    for (let attempt = 0; attempt < 30; attempt++) {
      started = await callDaemon("POST", "/v1/hw/reconcile", { trigger: "boot", reboot: "auto" });
      if (!/unreachable|ENOENT|ECONNREFUSED/.test(String(started.error ?? ""))) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    print(started);
    break;
  }
  case "hw": print(await callDaemon("GET", "/v1/hw")); break;
  case "hw-reconcile": print(await callDaemon("POST", "/v1/hw/reconcile", { trigger: "cli" })); break;
  case "setup-reset": await fs.rm("/var/lib/speck/.broker/setup.json", { force: true }); print({ ok: true }); break;
  default: console.error(`unknown command ${command}`); process.exit(2);
}
