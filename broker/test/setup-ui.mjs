#!/usr/bin/env node
// First-boot setup and the USB installer, end to end in real Chrome (not part of `npm test`):
//
//   node broker/test/setup-ui.mjs <chrome binary> <voice models dir> [<screenshot dir>]
//
// The real setup module and page, with a scripted machine underneath (nmcli, timedatectl,
// lsblk, model downloads, speck-install) and the real offline voice service injected the way the
// kiosk does it. Clicks through every step, checks what reached the machine, and saves a
// screenshot of each screen.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createSetup, setupRoutes } from "../lib/setup.mjs";
import { createStt, createTts } from "../../voice/lib/engines.mjs";
import { createVoiceService } from "../../voice/lib/service.mjs";
import { voiceSource, cdpOverPipe } from "../../shell/kiosk-chrome.mjs";

const [chrome, modelsDir, shotsArg] = process.argv.slice(2);
if (!chrome || !modelsDir) { console.error("usage: setup-ui.mjs <chrome> <voice models dir> [<screenshot dir>]"); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "speck-setup-ui-"));
const shots = shotsArg || path.join(work, "shots");
fs.mkdirSync(shots, { recursive: true });
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

// ------------------------------------------------------------------ voice (real engines)
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "voice", "models.json"), "utf8"));
const stt = createStt({ manifest, modelsDir, model: "kroko-en" });
const tts = createTts({ manifest, modelsDir, models: ["kitten-nano"], defaultVoice: "kitten-nano:3" });
const chunks = [];
const { sampleRate } = await tts.synthesize({ text: "Hey Speck, this is a microphone test.", voice: "kitten-nano:1" }, (c) => { chunks.push(Float32Array.from(c)); });
const wav = path.join(work, "mic.wav");
writeWav(wav, [new Float32Array(sampleRate), ...chunks, new Float32Array(sampleRate * 2)], sampleRate);
const voiceConfig = { allowedOrigins: [], browser: { stt: "local", tts: "local" }, tts: { defaultVoice: "kitten-nano:3" } };
let ttsRequests = 0;

// ------------------------------------------------------------------ the scripted machine
const dirs = { workersDir: path.join(work, "workers"), modelsDir: path.join(work, "models"), nm: path.join(work, "nm") };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const WORKERS = { worker: [8080, "Qwen/Qwen3-4B-GGUF:Q4_K_M", 25e6], intake: [8081, "LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q8_0", 12e6], toolcaller: [8082, "iromu/Qwen3-0.6B-tools-GGUF:Q8_0", 6e6], embed: [8083, "nomic-ai/nomic-embed-text-v1.5-GGUF:F16", 2.7e6] };
for (const [name, [port, model]] of Object.entries(WORKERS)) fs.writeFileSync(path.join(dirs.workersDir, `${name}.env`), `PORT=${port}\nMODEL_HF=${model}\n`);
const voiceConfigFile = path.join(work, "voice.json");
const m = {
  online: false, ssid: "", loaded: "", tz: "UTC", ready: new Set(), speckOk: true, calls: [], ops: [],
  installer: false, child: null
};
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", truncated: false, timedOut: false, durationMs: 1 });
const ZONES = Intl.supportedValuesOf("timeZone").concat("UTC").sort();
async function run(command, args = []) {
  const key = `${command} ${args.join(" ")}`;
  m.calls.push(key);
  if (key.startsWith("nmcli -t -f DEVICE")) return ok(`wlp1s0:wifi:${m.ssid ? "connected" : "disconnected"}:${m.ssid || "--"}\nenp2s0:ethernet:unavailable:--\n`);
  if (key === "nmcli -t networking connectivity") return ok(m.online ? "full\n" : "none\n");
  if (key.startsWith("nmcli -t -f IN-USE")) {
    await sleep(600);
    return ok([`${m.ssid === "Home" ? "*" : " "}:Home:82:WPA2`, " :Home:41:WPA2", " :Neighbours 5G:55:WPA2 WPA3", String.raw` :Cafe\: Guest:30:--`, " :Printer-Direct:18:WPA2"].join("\n"));
  }
  if (args[0] === "connection" && args[1] === "load") { m.loaded = args[2]; return ok(); }
  if (key.startsWith("nmcli --wait 45 connection up")) {
    await sleep(800);
    const text = fs.readFileSync(m.loaded, "utf8");
    if (/^psk=correct horse$/m.test(text)) { m.ssid = /^ssid=(.*)$/m.exec(text)[1]; m.online = true; return ok(); }
    return { ...ok(), code: 4, stderr: "Error: Connection activation failed: Secrets were required, but not provided." };
  }
  if (key === "timedatectl list-timezones") return ok(ZONES.join("\n"));
  if (key.startsWith("timedatectl show")) return ok(`${m.tz}\n`);
  if (key.startsWith("timedatectl set-timezone")) { m.tz = args[1]; return ok(); }
  if (key.startsWith("systemctl is-active")) return ok("active\n");
  if (key === "findmnt -no SOURCE /") return ok("/dev/sda3[/@]\n");
  if (key === "lsblk -no PKNAME /dev/sda3") return ok("sda\n");
  if (key.startsWith("lsblk -J")) {
    return ok(JSON.stringify({ blockdevices: [
      { name: "sda", path: "/dev/sda", size: 32e9, model: "SanDisk Ultra", type: "disk", rm: true, tran: "usb" },
      { name: "nvme0n1", path: "/dev/nvme0n1", size: 1024209543168, model: "Samsung SSD 980 PRO 1TB", type: "disk", rm: false, tran: "nvme",
        children: [{ name: "nvme0n1p1", path: "/dev/nvme0n1p1", fstype: "vfat", label: "SYSTEM" }, { name: "nvme0n1p3", path: "/dev/nvme0n1p3", fstype: "ntfs", label: "Windows" }] },
      { name: "sdb", path: "/dev/sdb", size: 32e9, model: "Card Reader", type: "disk", rm: true, tran: "usb" }
    ] }));
  }
  return ok();
}
async function fakeFetch(url, options) {
  const health = /^http:\/\/127\.0\.0\.1:(808\d)\/health$/.exec(url);
  if (health) {
    const name = Object.keys(WORKERS).find((n) => WORKERS[n][0] === Number(health[1]));
    return { ok: m.ready.has(name), status: m.ready.has(name) ? 200 : 503, json: async () => ({}) };
  }
  const hf = /^https:\/\/huggingface\.co\/api\/models\/(.+)\/tree\/main/.exec(url);
  if (hf) {
    const [, model, size] = Object.values(WORKERS).find(([, model]) => model.startsWith(`${hf[1]}:`));
    const quant = model.split(":")[1];
    return { ok: true, status: 200, json: async () => [{ path: `${hf[1].split("/")[1].replace(/-GGUF$/, "")}-${quant}.gguf`, lfs: { size } }] };
  }
  return fetch(url, options);
}
const growDownloads = (fraction) => {
  for (const [name, [, model, size]] of Object.entries(WORKERS)) {
    if (m.ready.has(name)) continue;
    fs.writeFileSync(path.join(dirs.modelsDir, `${model.replace(/[/:]/g, "_")}.gguf.downloadInProgress`), Buffer.alloc(Math.round(size * Math.min(1, fraction * (name === "embed" ? 3 : 1)))));
  }
};
function fakeSpawn(command, args) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.args = args;
  m.child = child;
  return child;
}

const installerFlag = path.join(work, "installer");
const setup = createSetup({
  run, fetch: fakeFetch, spawn: fakeSpawn,
  audit: { append: async () => {} },
  ops: { service: async (body) => { m.ops.push(body); return { ok: true }; }, power: async (body) => { m.ops.push(body); return { ok: true }; } },
  speckHealth: async () => (m.speckOk ? { ok: true } : { ok: false, reason: "starting" }),
  hardware: async () => ({
    cpu: { model: "AMD Ryzen 9 PRO 6950H with Radeon Graphics", threads: 16, memoryBytes: 32 * 2 ** 30 },
    gpus: [{ vendor: "amd", kind: "integrated", vramBytes: 512 * 2 ** 20 }], egpu: null
  }),
  config: { paths: { stateFile: path.join(work, "setup.json"), installerFlag, workersDir: dirs.workersDir, modelsDir: dirs.modelsDir,
    voiceConfig: voiceConfigFile, nmConnections: dirs.nm, installScript: "speck-install" }, completeWaitMs: 4000 }
});
const handle = setupRoutes(setup, path.join(REPO, "broker", "setup", "index.html"));
const server = http.createServer(async (req, res) => {
  const send = (status, body, type = "application/json") => { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(type === "application/json" ? JSON.stringify(body) : body); };
  try {
    if (!(await handle(req, res, new URL(req.url, "http://setup"), send))) send(404, { ok: false, error: "not found" });
  } catch (error) { send(error.status || 500, { ok: false, error: error.message }); }
});
const origin = `http://127.0.0.1:${await listen(server)}`;
voiceConfig.allowedOrigins.push(origin);   // the service reads its origins when created
const { server: voiceServer } = createVoiceService({ stt, tts, config: voiceConfig, log: (line) => { if (line.startsWith("tts ")) ttsRequests++; } });
voiceConfig.port = await listen(voiceServer);
fs.writeFileSync(voiceConfigFile, JSON.stringify({ ...voiceConfig, modelsDir }, null, 2));

// ------------------------------------------------------------------ Chrome, driven over CDP
const browser = spawn(chrome, [
  "--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run", "--hide-scrollbars",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`,
  "--autoplay-policy=no-user-gesture-required", "--remote-debugging-pipe", "about:blank"
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const send = cdpOverPipe(browser.stdio[3], browser.stdio[4], () => {});
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);
await page("Page.enable");
await page("Runtime.enable");
await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
await page("Page.addScriptToEvaluateOnNewDocument", { source: voiceSource({ configPath: voiceConfigFile, pagePath: path.join(REPO, "voice", "page", "voice-local.js") }) });

const js = async (expression) => {
  const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const text = () => js("document.querySelector('main').innerText");
async function until(what, predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await predicate()) return true; } catch { /* page loading */ }
    await sleep(150);
  }
  console.log(`  timed out waiting for: ${what}\n  page says: ${(await text().catch(() => "")).slice(0, 400)}`);
  return false;
}
const click = (selector) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no ${selector.replace(/"/g, "'")}"); el.click(); return true; })()`);
const type = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
let shotN = 0;
async function shot(name) {
  const { data } = await page("Page.captureScreenshot", { format: "png" });
  const file = path.join(shots, `${String(++shotN).padStart(2, "0")}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
}
const has = async (s) => (await text()).includes(s);

try {
  // ---------------------------------------------------------------- setup mode
  await page("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await page("Page.navigate", { url: `${origin}/setup` });
  check("welcome shows the hardware", await until("welcome", async () => (await has("Let's get Speck ready")) && (await has("Ryzen 9 PRO 6950H"))));
  check("offline voice injected into the setup page", await js("Boolean(window.__speckVoiceLocal)"));
  await shot("welcome");

  await click('[data-do="next"]');
  check("network step scans Wi-Fi", await until("networks", () => js("document.querySelectorAll('[data-net]').length === 5")));
  check("escaped network names and duplicates handled", (await has("Cafe: Guest")) && (await js("[...document.querySelectorAll('[data-net]')].filter(b => b.innerText.startsWith('Home')).length")) === 1);
  await shot("network");

  await click('[data-net="0"]');
  await until("password field", () => js("Boolean(document.querySelector('#wifiPassword'))"));
  await type("#wifiPassword", "wrong pass");
  await js("document.querySelector('#wifiForm').requestSubmit()");
  check("wrong password explained", await until("error", () => has("Check the password")));
  await shot("wifi-wrong-password");
  await type("#wifiPassword", "correct horse");
  await js("document.querySelector('#wifiForm').requestSubmit()");
  check("connects with the right password", await until("connected", () => has("Connected to Home")));
  check("password never in a command line", !m.calls.some((c) => c.includes("correct horse")));
  await shot("network-connected");

  await click('[data-do="next"]');
  check("time zone list loads", await until("zones", () => js("document.querySelectorAll('[data-zone]').length > 50")));
  await type("#zoneSearch", "melb");
  await until("filtered", () => js("document.querySelectorAll('[data-zone]').length === 1"));
  await click('[data-zone="Australia/Melbourne"]');
  await until("selected", () => has("Australia/Melbourne".replace("_", " ")));
  await shot("timezone");
  await click('[data-do="saveZone"]');
  check("time zone set on the machine", await until("tz", () => m.tz === "Australia/Melbourne"));

  check("voice step lists the local voices", await until("voices", () => js("document.querySelectorAll('[data-voice]').length === 8")));
  await click('[data-voice="kitten-nano:0"]');
  check("choosing a voice plays it", await until("tts", () => ttsRequests >= 1, 15_000));
  await click('[data-do="mic"]');
  check("microphone test hears speech offline", await until("transcript", async () => /microphone test/i.test(await js("document.querySelector('#transcript').innerText")), 20_000),
    await js("document.querySelector('#transcript')?.innerText").catch(() => ""));
  await shot("voice");
  await click('[data-do="saveVoice"]');
  await until("models step", () => has("models"));
  const savedVoice = JSON.parse(fs.readFileSync(voiceConfigFile, "utf8")).tts.defaultVoice;
  check("voice saved and speck-voice restarted", savedVoice === "kitten-nano:0" && m.ops.some((o) => o.unit === "speck-voice.service"), savedVoice);

  growDownloads(0.4);
  m.ready.add("embed");
  check("model downloads show progress", await until("progress", async () => (await has("Getting Speck's models")) && (await has("10 MB of 25 MB")), 8000));
  await shot("models-downloading");
  growDownloads(1);
  await sleep(2700);
  for (const name of Object.keys(WORKERS)) m.ready.add(name);
  check("all models ready", await until("ready", () => has("Models are ready"), 8000));
  await click('[data-do="next"]');
  await until("done", () => has("Speck is ready"));
  await shot("done");
  await click('[data-do="finish"]');
  check("finishing hands over to Speck", await until("complete", async () => !(await setup.needed()).needed, 8000));
  await shot("starting-speck");

  await page("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await page("Page.navigate", { url: `${origin}/setup?later=1` });
  check("after setup, the page offers network and time zone again", await until("complete view", () => has("Setup is complete")));
  await click('[data-go="network"]');
  await until("network", () => has("Connected to Home"));
  await shot("dark-network-later");

  // ---------------------------------------------------------------- installer mode
  fs.writeFileSync(installerFlag, "");
  await page("Page.navigate", { url: `${origin}/setup` });
  check("installer welcome", await until("install welcome", () => has("Install Speck OS")));
  await shot("install-welcome");
  await click('[data-do="next"]');
  check("disks: internal first, install stick hidden", await until("disks", () => js("[...document.querySelectorAll('[data-disk]')].map(b => b.dataset.disk).join(',') === '/dev/nvme0n1,/dev/sdb'")));
  check("small disk refused", await js("document.querySelector('[data-disk=\"/dev/sdb\"]').disabled"));
  await click('[data-disk="/dev/nvme0n1"]');
  await click('[data-do="install"]');
  await until("armed", () => has("Press again to erase"));
  check("existing contents named before erasing", await has("Windows"));
  await shot("install-confirm");
  check("first press doesn't erase", m.child === null);
  await click('[data-do="install"]');
  check("second press starts speck-install", await until("spawned", () => m.child !== null) && m.child.args.join(" ") === "--from-running --target /dev/nvme0n1 --yes");
  m.child.stdout.write("@@ 5 Partitioning /dev/nvme0n1\n@@ 47 Copying the system\n");
  check("install progress shown", await until("progress", () => has("Copying the system"), 8000));
  await shot("installing");
  m.child.stdout.write("@@ 90 Installing the bootloader\n@@ 100 Installed\n");
  m.child.emit("close", 0);
  check("finished install asks for a restart", await until("finished", () => has("Remove the USB stick"), 8000));
  await shot("install-finished");
  await click('[data-do="reboot"]');
  check("restart goes through the broker", await until("reboot", () => m.ops.some((o) => o.action === "reboot")));

  // Narrow screen sanity: no horizontal scroll.
  await page("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page("Page.navigate", { url: `${origin}/setup` });
  await until("loaded", () => has("Installed"));
  check("no horizontal scroll at phone width", await js("document.documentElement.scrollWidth <= window.innerWidth"));
  await shot("narrow");
} catch (error) {
  check(`no errors (${error.message})`, false);
} finally {
  browser.kill();
  server.close();
  voiceServer.close();
}
console.log(`\nscreenshots: ${shots}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
setTimeout(() => process.exit(failed ? 1 : 0), 300);

function writeWav(file, parts, rate) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = Buffer.alloc(44 + total * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + total * 2, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(total * 2, 40);
  let at = 44;
  for (const p of parts) for (const v of p) { out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 0x7fff), at); at += 2; }
  fs.writeFileSync(file, out);
}
