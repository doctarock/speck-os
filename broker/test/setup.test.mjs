import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createSetup, setupRoutes, splitTerse, parseWifiList, keyMgmtFor, wifiKeyfile, friendlyWifiError,
  ggufBytesFor, parseDisks
} from "../lib/setup.mjs";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", truncated: false, timedOut: false, durationMs: 1 });

async function harness({ responses = {}, installer = false, health = { ok: true }, fetchMap = {}, spawn } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "speck-setup-"));
  const paths = {
    stateFile: path.join(dir, "state", "setup.json"),
    installerFlag: path.join(dir, "installer"),
    workersDir: path.join(dir, "workers"),
    modelsDir: path.join(dir, "models"),
    voiceConfig: path.join(dir, "voice.json"),
    nmConnections: path.join(dir, "nm"),
    installScript: "/usr/lib/speck-os/speck-install"
  };
  await fs.mkdir(paths.workersDir, { recursive: true });
  await fs.mkdir(paths.modelsDir, { recursive: true });
  if (installer) await fs.writeFile(paths.installerFlag, "");
  const calls = [];
  const run = async (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    const key = `${command} ${args.join(" ")}`;
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.startsWith(pattern)) return { ...ok(), ...(typeof response === "function" ? await response(key, options) : response) };
    }
    return ok();
  };
  const entries = [];
  const audit = { append: async (entry) => { entries.push(entry); } };
  const opsCalls = [];
  const ops = { service: async (body) => { opsCalls.push(["service", body]); return { ok: true }; }, power: async (body) => { opsCalls.push(["power", body]); return { ok: true }; } };
  let healthNow = health;
  const fetch = async (url) => {
    for (const [prefix, value] of Object.entries(fetchMap)) {
      if (url.startsWith(prefix)) {
        const v = typeof value === "function" ? value(url) : value;
        if (v instanceof Error) throw v;
        return { ok: v.status ? v.status < 400 : true, status: v.status ?? 200, json: async () => v.body };
      }
    }
    throw new Error(`unreachable ${url}`);
  };
  const setup = createSetup({
    run, audit, ops, fetch, spawn,
    speckHealth: async () => healthNow,
    hardware: async () => ({ cpu: { model: "AMD Ryzen 9 PRO 6950H with Radeon Graphics", threads: 16, memoryBytes: 32 * 2 ** 30 }, gpus: [] }),
    config: { paths, completeWaitMs: 50, minDiskBytes: 64e9 },
    sleep: async () => {}
  });
  return { setup, dir, paths, calls, entries, opsCalls, setHealth: (h) => { healthNow = h; } };
}

// ------------------------------------------------------------------ parsing

test("nmcli terse output: escaped colons and backslashes survive", () => {
  assert.deepEqual(splitTerse(String.raw`*:Cafe\: upstairs:72:WPA2`), ["*", "Cafe: upstairs", "72", "WPA2"]);
  assert.deepEqual(splitTerse(String.raw` :back\\slash:40:--`), [" ", "back\\slash", "40", "--"]);
});

test("Wi-Fi list: one entry per name (strongest), connected first, hidden networks dropped", () => {
  const list = parseWifiList([
    " :Home:40:WPA2", " :Home:81:WPA2", "*:Office:35:WPA2 WPA3", " ::90:WPA2", " :Guest:60:--", ""
  ].join("\n"));
  assert.deepEqual(list.map((n) => n.ssid), ["Office", "Home", "Guest"]);
  assert.equal(list[1].signal, 81);
  assert.equal(list[0].connected, true);
  assert.equal(list[2].security, "");
});

test("key management follows the network's security", () => {
  assert.equal(keyMgmtFor("WPA2", "secret123"), "wpa-psk");
  assert.equal(keyMgmtFor("WPA1 WPA2", "secret123"), "wpa-psk");
  assert.equal(keyMgmtFor("WPA2 WPA3", "secret123"), "wpa-psk");   // transition mode: PSK works
  assert.equal(keyMgmtFor("WPA3", "secret123"), "sae");
  assert.equal(keyMgmtFor("", ""), "none");
  assert.throws(() => keyMgmtFor("WPA2 802.1X", ""), /enterprise/);
  assert.throws(() => keyMgmtFor("WEP", "x"), /WEP/);
});

test("keyfile: plain names as text, unusual names as bytes, password escaped", () => {
  const plain = wifiKeyfile({ ssid: "Home Net", password: String.raw`pa\ss;word`, keyMgmt: "wpa-psk", uuid: "u-1" });
  assert.match(plain, /^ssid=Home Net$/m);
  assert.match(plain, /^psk=pa\\\\ss;word$/m);
  assert.match(plain, /^key-mgmt=wpa-psk$/m);
  const odd = wifiKeyfile({ ssid: "a;b", password: "", keyMgmt: "none", uuid: "u-2", hidden: true });
  assert.match(odd, /^ssid=97;59;98;$/m);
  assert.match(odd, /^hidden=true$/m);
  assert.doesNotMatch(odd, /wifi-security/);
});

test("nmcli errors become plain advice", () => {
  assert.match(friendlyWifiError("Error: Connection activation failed: Secrets were required, but not provided."), /password/);
  assert.match(friendlyWifiError("Error: No network with SSID 'x' found."), /in range/);
});

test("GGUF size: exact quant beats lookalikes, split files add up, mmproj ignored", () => {
  const tree = [
    { path: "Qwen3-4B-Q4_K_M.gguf", size: 100, lfs: { size: 2_500_000_000 } },
    { path: "Qwen3-4B-IQ4_K_M.gguf", lfs: { size: 2_000_000_000 } },
    { path: "mmproj-Qwen3-4B-Q4_K_M.gguf", lfs: { size: 600_000_000 } },
    { path: "README.md", size: 10 }
  ];
  assert.equal(ggufBytesFor(tree, "Q4_K_M"), 2_500_000_000);
  const split = [
    { path: "big/Model-Q8_0-00001-of-00002.gguf", lfs: { size: 4e9 } },
    { path: "big/Model-Q8_0-00002-of-00002.gguf", lfs: { size: 3e9 } }
  ];
  assert.equal(ggufBytesFor(split, "Q8_0"), 7e9);
  assert.equal(ggufBytesFor(tree, "Q2_K"), null);
});

test("installable disks: not the install media, not loop/zram, internal first, small ones refused", () => {
  const lsblk = { blockdevices: [
    { name: "sda", path: "/dev/sda", size: 32e9, model: "USB Stick", type: "disk", rm: true, tran: "usb", children: [{ name: "sda1", path: "/dev/sda1", fstype: "vfat" }] },
    { name: "sdb", path: "/dev/sdb", size: 16e9, model: "Small", type: "disk", rm: false, tran: "sata" },
    { name: "nvme0n1", path: "/dev/nvme0n1", size: 1e12, model: "Samsung SSD 980 ", type: "disk", rm: false, tran: "nvme",
      children: [{ name: "nvme0n1p3", path: "/dev/nvme0n1p3", fstype: "ntfs", label: "Windows" }] },
    { name: "loop0", path: "/dev/loop0", size: 1e11, type: "loop" },
    { name: "zram0", path: "/dev/zram0", size: 1e11, type: "disk" }
  ] };
  const disks = parseDisks(lsblk, { exclude: "/dev/sda", minBytes: 64e9 });
  assert.deepEqual(disks.map((d) => d.path), ["/dev/nvme0n1", "/dev/sdb"]);
  assert.equal(disks[0].model, "Samsung SSD 980");
  assert.equal(disks[0].eligible, true);
  assert.equal(disks[0].partitions[0].label, "Windows");
  assert.equal(disks[1].eligible, false);
  assert.match(disks[1].reason, /too small/);
});

// ------------------------------------------------------------------ Wi-Fi

test("Wi-Fi connect: password goes into a root-only keyfile, never argv or the audit log", async () => {
  const { setup, calls, entries, paths, opsCalls } = await harness({
    responses: {
      "nmcli -t -f DEVICE": ok("wlp2s0:wifi:connected:Home\n"),
      "nmcli -t networking connectivity": ok("full\n"),
      "nmcli -t -f IN-USE": ok(" :Home:80:WPA2\n"),
      "systemctl is-active infer@": ok("active\n")
    }
  });
  await fs.writeFile(path.join(paths.workersDir, "worker.env"), "PORT=8080\nMODEL_HF=Qwen/Qwen3-4B-GGUF:Q4_K_M\n");
  const result = await setup.wifiConnect({ ssid: "Home", password: "correct horse" });
  assert.equal(result.ok, true);
  assert.equal(result.network.online, true);
  const files = await fs.readdir(paths.nmConnections);
  assert.equal(files.length, 1);
  const keyfile = await fs.readFile(path.join(paths.nmConnections, files[0]), "utf8");
  assert.match(keyfile, /^psk=correct horse$/m);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(paths.nmConnections, files[0]))).mode & 0o777, 0o600);
  for (const call of calls) assert.ok(!call.args.join(" ").includes("correct horse"), `password leaked into ${call.command} ${call.args.join(" ")}`);
  assert.ok(!JSON.stringify(entries).includes("correct horse"));
  assert.ok(calls.some((c) => c.command === "nmcli" && c.args.join(" ") === `connection load ${path.join(paths.nmConnections, files[0])}`));
  assert.ok(calls.some((c) => c.args.join(" ") === "networking connectivity check"));
  assert.equal(opsCalls.length, 0, "running workers are left alone");
});

test("Wi-Fi connect failure removes the profile and explains", async () => {
  const { setup, calls, paths } = await harness({
    responses: {
      "nmcli --wait 45 connection up": { code: 4, stderr: "Error: Connection activation failed: Secrets were required, but not provided." },
      "nmcli -t -f DEVICE": ok("wlp2s0:wifi:disconnected:--\n"),
      "nmcli -t networking connectivity": ok("none\n")
    }
  });
  const result = await setup.wifiConnect({ ssid: "Home", password: "wrong pass", security: "WPA2" });
  assert.equal(result.ok, false);
  assert.match(result.error, /password/);
  assert.deepEqual(await fs.readdir(paths.nmConnections), []);
  assert.ok(calls.some((c) => c.args[0] === "connection" && c.args[1] === "delete"));
});

test("Wi-Fi connect checks the password length before touching NetworkManager", async () => {
  const { setup, calls } = await harness();
  await assert.rejects(setup.wifiConnect({ ssid: "Home", password: "short", security: "WPA2" }), /8–63/);
  assert.ok(!calls.some((c) => c.args.includes("load")));
});

test("coming online restarts workers that gave up while offline", async () => {
  const { setup, opsCalls, paths } = await harness({
    responses: {
      "systemctl is-active infer@worker.service": ok("activating\n"),
      "systemctl is-active infer@embed.service": ok("active\n")
    }
  });
  await fs.writeFile(path.join(paths.workersDir, "worker.env"), "PORT=8080\nMODEL_HF=Qwen/Qwen3-4B-GGUF:Q4_K_M\n");
  await fs.writeFile(path.join(paths.workersDir, "embed.env"), "PORT=8083\nMODEL_HF=nomic-ai/nomic-embed-text-v1.5-GGUF:F16\n");
  await setup.wifiConnect({ ssid: "Open Cafe", password: "", security: "" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(opsCalls, [["service", { action: "restart", unit: "infer@worker.service" }]]);
});

// ------------------------------------------------------------------ models, voice, time zone

test("model progress: bytes from the cache, size from Hugging Face, eGPU worker left out", async () => {
  const { setup, paths } = await harness({
    responses: { "systemctl is-active": ok("active\n") },
    fetchMap: {
      "http://127.0.0.1:8083/health": { status: 200 },
      "http://127.0.0.1:8080/health": { status: 503 },
      "https://huggingface.co/api/models/Qwen/Qwen3-4B-GGUF/tree/main?recursive=true": { body: [{ path: "Qwen3-4B-Q4_K_M.gguf", lfs: { size: 2000 } }] }
    }
  });
  await fs.writeFile(path.join(paths.workersDir, "worker.env"), "PORT=8080\nMODEL_HF=Qwen/Qwen3-4B-GGUF:Q4_K_M\n");
  await fs.writeFile(path.join(paths.workersDir, "embed.env"), "PORT=8083\nMODEL_HF=nomic-ai/nomic-embed-text-v1.5-GGUF:F16\n");
  await fs.writeFile(path.join(paths.workersDir, "egpu.env"), "PORT=8090\nMODEL_HF=Qwen/Qwen3-14B-GGUF:Q4_K_M\n");
  // llama.cpp's flat cache naming, mid-download
  await fs.writeFile(path.join(paths.modelsDir, "Qwen_Qwen3-4B-GGUF_Qwen3-4B-Q4_K_M.gguf.downloadInProgress"), Buffer.alloc(500));
  const models = await setup.models({ online: true });
  assert.deepEqual(models.map((m) => m.name), ["embed", "worker"]);
  const worker = models.find((m) => m.name === "worker");
  assert.equal(worker.status, "downloading");
  assert.equal(worker.bytes, 500);
  assert.equal(worker.expectedBytes, 2000);
  assert.equal(models.find((m) => m.name === "embed").status, "ready");

  // Download complete but the server is still loading it.
  await fs.writeFile(path.join(paths.modelsDir, "Qwen_Qwen3-4B-GGUF_Qwen3-4B-Q4_K_M.gguf.downloadInProgress"), Buffer.alloc(2000));
  assert.equal((await setup.models({ online: true })).find((m) => m.name === "worker").status, "loading");

  // Offline: nothing to wait for but the network.
  const { setup: offline, paths: p2 } = await harness();
  await fs.writeFile(path.join(p2.workersDir, "worker.env"), "PORT=8080\nMODEL_HF=Qwen/Qwen3-4B-GGUF:Q4_K_M\n");
  assert.equal((await offline.models({ online: false }))[0].status, "waiting-network");
});

test("voice: only known voices, the default changes in voice.json and speck-voice restarts", async () => {
  const { setup, paths, opsCalls } = await harness({
    fetchMap: { "http://127.0.0.1:4320/v1/voices": { body: { voices: [{ id: "kitten-nano:3", name: "Luna", lang: "en-US" }, { id: "kitten-nano:0", name: "Jasper", lang: "en-US" }] } } }
  });
  await fs.writeFile(paths.voiceConfig, JSON.stringify({ port: 4320, tts: { defaultVoice: "kitten-nano:3", threads: 2 } }));
  await assert.rejects(setup.setVoice({ voice: "kokoro-en:99" }), /unknown voice/);
  const result = await setup.setVoice({ voice: "kitten-nano:0" });
  assert.equal(result.defaultVoice, "kitten-nano:0");
  const saved = JSON.parse(await fs.readFile(paths.voiceConfig, "utf8"));
  assert.deepEqual(saved.tts, { defaultVoice: "kitten-nano:0", threads: 2 });
  assert.deepEqual(opsCalls, [["service", { action: "restart", unit: "speck-voice.service" }]]);
  await setup.setVoice({ voice: "kitten-nano:0" });
  assert.equal(opsCalls.length, 1, "no restart when nothing changed");
});

test("time zone must be one timedatectl knows", async () => {
  const { setup, calls } = await harness({ responses: { "timedatectl list-timezones": ok("Australia/Melbourne\nEurope/London\nUTC\n") } });
  await assert.rejects(setup.setTimezone({ zone: "Mars/Olympus" }), /unknown time zone/);
  assert.deepEqual(await setup.setTimezone({ zone: "Australia/Melbourne" }), { ok: true, timezone: "Australia/Melbourne" });
  assert.ok(calls.some((c) => c.args.join(" ") === "set-timezone Australia/Melbourne"));
});

// ------------------------------------------------------------------ flow

test("complete: waits for Speck, then setup is no longer needed", async () => {
  const { setup, setHealth } = await harness({ health: { ok: false, reason: "starting" } });
  assert.deepEqual(await setup.needed(), { mode: "setup", needed: true });
  await setup.setStep({ step: "voice" });
  assert.equal((await setup.state()).step, "voice");
  await assert.rejects(setup.setStep({ step: "nope" }), /unknown step/);
  const late = await setup.complete();
  assert.equal(late.speckHealthy, false, "a slow Speck doesn't trap the user in setup");
  assert.deepEqual(await setup.needed(), { mode: "setup", needed: false });
  setHealth({ ok: true });
  assert.equal((await setup.complete()).speckHealthy, true);
});

test("installer mode: always needed, no completing, install streams progress from speck-install", async () => {
  const children = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.command = command;
    child.args = args;
    children.push(child);
    return child;
  };
  const lsblk = { blockdevices: [
    { name: "sda", path: "/dev/sda", size: 32e9, model: "USB", type: "disk", rm: true, tran: "usb" },
    { name: "nvme0n1", path: "/dev/nvme0n1", size: 5e11, model: "NVMe", type: "disk", rm: false, tran: "nvme" },
    { name: "sdb", path: "/dev/sdb", size: 8e9, model: "Tiny", type: "disk", rm: false, tran: "sata" }
  ] };
  const { setup, entries } = await harness({
    installer: true, spawn,
    responses: {
      "findmnt -no SOURCE /": ok("/dev/sda3[/@]\n"),
      "lsblk -no PKNAME /dev/sda3": ok("sda\n"),
      "lsblk -J": ok(JSON.stringify(lsblk))
    }
  });
  assert.deepEqual(await setup.needed(), { mode: "install", needed: true });
  await assert.rejects(setup.complete(), /installer/);
  await assert.rejects(setup.install({ disk: "/dev/sda" }), /not an installable disk/);
  await assert.rejects(setup.install({ disk: "/dev/sdb" }), /too small/);

  const started = await setup.install({ disk: "/dev/nvme0n1" });
  assert.equal(started.job.state, "running");
  assert.deepEqual(children[0].args, ["--from-running", "--target", "/dev/nvme0n1", "--yes"]);
  await assert.rejects(setup.install({ disk: "/dev/nvme0n1" }), /already running/);
  children[0].stdout.write("@@ 10 Partitioning\nmkfs output\n@@ 55 Copying the system\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(setup.installJob().percent, 55);
  assert.equal(setup.installJob().message, "Copying the system");
  children[0].emit("close", 0);
  await new Promise((r) => setImmediate(r));
  const state = await setup.state();
  assert.equal(state.install.state, "done");
  assert.equal(state.install.percent, 100);
  assert.deepEqual(state.disks.disks.map((d) => d.path), ["/dev/nvme0n1", "/dev/sdb"]);
  assert.ok(entries.some((e) => e.op === "setup.install" && e.ok === true));
});

test("HTTP: POSTs need X-Speck-Setup, the page and needed are served", async () => {
  const { setup, dir } = await harness();
  const page = path.join(dir, "index.html");
  await fs.writeFile(page, "<title>Speck Setup</title>");
  const handle = setupRoutes(setup, page);
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = "application/json") => { res.writeHead(status, { "Content-Type": type }); res.end(type === "application/json" ? JSON.stringify(body) : body); };
    try {
      if (!(await handle(req, res, new URL(req.url, "http://x"), send))) send(404, { ok: false });
    } catch (error) { send(error.status || 500, { ok: false, error: error.message }); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.match(await (await fetch(`${base}/setup`)).text(), /Speck Setup/);
    assert.deepEqual(await (await fetch(`${base}/api/setup/needed`)).json(), { mode: "setup", needed: true });
    const refused = await fetch(`${base}/api/setup/complete`, { method: "POST" });
    assert.equal(refused.status, 403);
    const bad = await fetch(`${base}/api/setup/step`, { method: "POST", headers: { "X-Speck-Setup": "1" }, body: JSON.stringify({ step: "zzz" }) });
    assert.equal(bad.status, 400);
    const good = await fetch(`${base}/api/setup/step`, { method: "POST", headers: { "X-Speck-Setup": "1" }, body: JSON.stringify({ step: "network" }) });
    assert.deepEqual(await good.json(), { ok: true, step: "network" });
    assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  } finally {
    server.close();
  }
});
