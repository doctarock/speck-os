#!/usr/bin/env node
// Turn phase end to end (not part of `npm test`): Speck's real UI in Chrome, offline voice
// injected as the kiosk does, a synthesised "Hey Speck, ..." as the microphone. Watches Speck's
// /api/voice/phase from the server side:
//   wake word → listening (background and queue held) → request submitted → idle
//   reply spoken → speaking → done → idle
//
//   node voice/test/e2e-turn-phase.mjs <speck dir (built)> <chrome> <voice models dir>
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStt, createTts } from "../lib/engines.mjs";
import { createVoiceService } from "../lib/service.mjs";
import { voiceSource, cdpOverPipe } from "../../shell/kiosk-chrome.mjs";

const [speckDir, chrome, modelsDir] = process.argv.slice(2);
if (!speckDir || !chrome || !modelsDir) { console.error("usage: e2e-turn-phase.mjs <speck dir> <chrome> <voice models dir>"); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const PORT = 4417;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// 1. Speck with throwaway state, no models.
const speck = spawn(process.execPath, ["dist/server.js"], {
  cwd: speckDir,
  env: { ...process.env, NODE_ENV: "production", SPECK_HOST: "127.0.0.1", SPECK_PORT: String(PORT),
    SPECK_DB_PATH: path.join(work, "speck.sqlite"), SPECK_GENESIS_RUNTIME_PATH: path.join(work, "gr"), SPECK_EMBEDDING_ENABLED: "false" },
  stdio: ["ignore", "ignore", "inherit"]
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${ORIGIN}/api/health`)).ok) break; } catch {} await sleep(500); }

// 2. Offline voice for Speck's origin, and the microphone recording.
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "voice", "models.json"), "utf8"));
const stt = createStt({ manifest, modelsDir, model: "kroko-en" });
const tts = createTts({ manifest, modelsDir, models: ["kitten-nano"], defaultVoice: "kitten-nano:3" });
const chunks = [];
const { sampleRate } = await tts.synthesize({ text: "Hey Speck, what is on my calendar tomorrow?", voice: "kitten-nano:5" }, (c) => { chunks.push(Float32Array.from(c)); });
const wav = path.join(work, "mic.wav");
// Leading silence (voice gets switched on first), the request, then a long pause so it submits.
writeWav(wav, [new Float32Array(sampleRate * 4), ...chunks, new Float32Array(sampleRate * 30)], sampleRate);
const config = { allowedOrigins: [ORIGIN], browser: { stt: "local", tts: "local" }, tts: { defaultVoice: "kitten-nano:3" } };
const { server: voice } = createVoiceService({ stt, tts, config });
config.port = await new Promise((r) => voice.listen(0, "127.0.0.1", () => r(voice.address().port)));
const configPath = path.join(work, "voice.json");
fs.writeFileSync(configPath, JSON.stringify(config));

// 3. Chrome on Speck's UI.
const browser = spawn(chrome, [
  "--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`,
  "--autoplay-policy=no-user-gesture-required", "--remote-debugging-pipe", "about:blank"
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const send = cdpOverPipe(browser.stdio[3], browser.stdio[4], (m) => {
  if (m.method === "Runtime.exceptionThrown") console.log("  page exception:", m.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? m.params.exceptionDetails?.text);
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") console.log("  page error:", m.params.entry.text, m.params.entry.url ?? "");
});
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);
await page("Page.enable");
await page("Runtime.enable");
await page("Log.enable");
await page("Page.addScriptToEvaluateOnNewDocument", { source: voiceSource({ configPath, pagePath: path.join(REPO, "voice", "page", "voice-local.js") }) });
// Record every phase report the page sends, to compare with what the server saw.
await page("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { window.__phases = []; window.__heard = []; window.addEventListener("observer:voice-transcript", (e) => { if (e.detail?.isFinal) window.__heard.push(e.detail.text); }); const f = window.fetch; window.fetch = function (url, options) {
  if (String(url).includes("/api/voice/phase") && options?.body) window.__phases.push({ at: Date.now(), ...JSON.parse(options.body) });
  return f.apply(this, arguments); }; })();` });
await page("Page.navigate", { url: `${ORIGIN}/` });
const js = async (expression) => (await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;

// Server-side phase timeline, sampled every 100 ms.
const timeline = [];
let sampling = true;
(async () => {
  while (sampling) {
    try {
      const s = await (await fetch(`${ORIGIN}/api/voice/phase`)).json();
      const last = timeline.at(-1);
      if (!last || last.phase !== s.phase || last.holdsQueue !== s.holdsQueue) timeline.push({ at: Date.now(), phase: s.phase, holdsQueue: s.holdsQueue, holdsBackground: s.holdsBackground });
    } catch {}
    await sleep(100);
  }
})();
const until = async (predicate, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return true; await sleep(150); } return false; };

try {
  await until(() => js("Boolean(document.querySelector('#voiceButton')) && Boolean(window.__speckVoiceLocal)"), 20_000);
  console.log("  page:", JSON.stringify(await js(`({ button: Boolean(document.querySelector('#voiceButton')), disabled: document.querySelector('#voiceButton')?.disabled,
    title: document.querySelector('#voiceButton')?.title, local: Boolean(window.__speckVoiceLocal), url: location.href, ready: document.readyState })`)));
  // speck.js binds the button once its imports (three.js, …) have loaded: retry until it takes.
  await until(() => js("document.readyState === 'complete'"), 60_000);
  const enabled = await until(async () => {
    if (await js("document.querySelector('#voiceButton').getAttribute('aria-pressed') === 'true'")) return true;
    await js("document.querySelector('#voiceButton').click()");
    await sleep(700);
    return false;
  }, 60_000);
  check("voice enabled in Speck", enabled);
  const heard = await until(() => timeline.some((t) => t.phase === "listening"), 90_000);
  check("wake word → Speck holds background and queue (listening)", heard && timeline.some((t) => t.phase === "listening" && t.holdsQueue && t.holdsBackground));
  // The idle between submitting and Speck's spoken answer can last milliseconds: check what the
  // page reported, and that the server stopped holding the queue once listening ended.
  const sent = async () => JSON.parse((await js("JSON.stringify(window.__phases)")) || "[]");
  const submitted = await until(async () => {
    const s = await sent();
    return s.some((p, i) => p.phase === "idle" && s.slice(0, i).some((q) => q.phase === "listening"));
  }, 30_000);
  check("request submitted → page reports idle before anything else", submitted, await js("document.querySelector('#quickPrompt')?.value || ''"));
  check("queue released after listening", await until(() => timeline.some((t, i) => i > 0 && timeline[i - 1].holdsQueue && !t.holdsQueue), 30_000));

  // Let Speck finish whatever it said, then speak a reply of our own.
  await until(() => timeline.at(-1)?.phase === "idle", 30_000);
  const before = timeline.length;
  await js(`window.dispatchEvent(new CustomEvent("speck:reply", { detail: { text: "Tomorrow you have a dentist appointment at ten. Nothing else is booked." } }))`);
  check("reply spoken → speaking (background held, queue free)", await until(() => timeline.slice(before).some((t) => t.phase === "speaking" && t.holdsBackground && !t.holdsQueue), 10_000));
  check("speech ends → idle", await until(() => timeline.length > before + 1 && timeline.at(-1)?.phase === "idle", 30_000));
  const [status, phase] = await Promise.all([
    fetch(`${ORIGIN}/api/runtime/status`).then((r) => r.json()),
    fetch(`${ORIGIN}/api/voice/phase`).then((r) => r.json())
  ]);
  check("runtime status reports the phase", status.turnPhase?.phase === phase.phase, `${status.turnPhase?.phase} / ${phase.phase}`);
  console.log("page sent:", (await sent()).map((p) => p.phase).join(" → "));
  console.log("heard:", (await js("JSON.stringify(window.__heard)")) ?? "");
} finally {
  sampling = false;
  browser.kill();
  speck.kill();
  voice.close();
}
const t0 = timeline[0]?.at ?? 0;
console.log("timeline:", timeline.map((t) => `${((t.at - t0) / 1000).toFixed(1)}s ${t.phase}${t.holdsQueue ? "+queue" : ""}`).join(" → "));
setTimeout(() => process.exit(results.every(Boolean) ? 0 : 1), 300);

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
