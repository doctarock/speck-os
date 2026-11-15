#!/usr/bin/env node
// End to end with real Chrome and real models (not part of `npm test`):
//
//   node voice/test/e2e-chrome.mjs <chrome binary> <models dir>
//
// Kitten speaks "Hey Speck, ..." into a WAV that Chrome uses as its (fake) microphone; a page
// that only knows the standard Web Speech API (as Speck's voice.js does) must hear it through
// the injected local recognizer and speak a reply through the local synthesiser.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStt, createTts } from "../lib/engines.mjs";
import { createVoiceService } from "../lib/service.mjs";

const [chrome, modelsDir] = process.argv.slice(2);
if (!chrome || !modelsDir) { console.error("usage: e2e-chrome.mjs <chrome> <models dir>"); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "..", "models.json"), "utf8"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "speck-voice-e2e-"));
const SPOKEN = "Hey Speck, what's the weather like tomorrow?";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// 1. Engines + the microphone recording.
const stt = createStt({ manifest, modelsDir, model: "kroko-en" });
const tts = createTts({ manifest, modelsDir, models: ["kitten-nano"], defaultVoice: "kitten-nano:1" });
const chunks = [];
const { sampleRate } = await tts.synthesize({ text: SPOKEN, voice: "kitten-nano:2" }, (c) => { chunks.push(Float32Array.from(c)); });
const wav = path.join(work, "mic.wav");
writeWav(wav, [new Float32Array(sampleRate), ...chunks, new Float32Array(sampleRate * 3)], sampleRate);

// 2. The page and the voice service.
const reports = [];
let pageOrigin;
const page = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { const r = JSON.parse(body); reports.push(r); console.log("  page:", JSON.stringify(r)); res.end("ok"); });
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>e2e</title><script type="module">
    const report = (o) => fetch("/report", { method: "POST", body: JSON.stringify(o) });
    report({ phase: "loaded", local: Boolean(window.__speckVoiceLocal), recognizer: webkitSpeechRecognition.name, synth: speechSynthesis.constructor.name });
    speechSynthesis.addEventListener("voiceschanged", () => report({ phase: "voices", count: speechSynthesis.getVoices().length, first: speechSynthesis.getVoices()[0]?.name }));
    const r = new webkitSpeechRecognition();
    r.continuous = true; r.interimResults = true;
    let partials = 0;
    r.onstart = () => report({ phase: "start" });
    r.onerror = (e) => report({ phase: "error", error: e.error, message: e.message });
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) report({ phase: "final", text: res[0].transcript, partials });
        else partials++;
      }
    };
    r.start();
    setTimeout(() => {
      const u = new SpeechSynthesisUtterance("Hello, I am Speck. This voice runs offline. The second sentence streams while the first plays.");
      u.rate = 0.96;
      const t0 = performance.now();
      u.onstart = () => report({ phase: "tts-start", ms: Math.round(performance.now() - t0) });
      u.onend = () => report({ phase: "tts-end", ms: Math.round(performance.now() - t0) });
      u.onerror = (e) => report({ phase: "tts-error", error: e.error, message: e.message });
      speechSynthesis.speak(u);
    }, 300);
  </script>`);
});
const pagePort = await listen(page);
pageOrigin = `http://127.0.0.1:${pagePort}`;
const config = { allowedOrigins: [pageOrigin], browser: { stt: "local", tts: "local" } };
const { server: voice } = createVoiceService({ stt, tts, config });
config.port = await listen(voice);
const configPath = path.join(work, "voice.json");
fs.writeFileSync(configPath, JSON.stringify(config));

// 3. Chrome through the kiosk launcher.
const launcher = spawn(process.execPath, [path.join(REPO, "shell", "kiosk-chrome.mjs"), `${pageOrigin}/`], {
  env: {
    ...process.env,
    SPECK_CHROME: chrome,
    SPECK_VOICE_CONFIG: configPath,
    SPECK_VOICE_PAGE: path.join(REPO, "voice", "page", "voice-local.js"),
    SPECK_CHROME_FLAGS: [
      "--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run",
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`,
      "--autoplay-policy=no-user-gesture-required"
    ].join(" ")
  },
  stdio: ["ignore", "inherit", "inherit"]
});

// 4. Verdict.
const has = (phase, test = () => true) => reports.some((r) => r.phase === phase && test(r));
const deadline = Date.now() + 60_000;
// The fake microphone loops the recording; recognition may join mid-sentence the first time round.
while (Date.now() < deadline && !(has("final", (r) => /speck/i.test(r.text) && /weather/i.test(r.text)) && has("tts-end"))) {
  if (has("error") || has("tts-error")) break;
  await new Promise((r) => setTimeout(r, 250));
}
launcher.kill("SIGTERM");
voice.close();
page.close();
const checks = {
  "injected before page scripts": has("loaded", (r) => r.local && r.recognizer === "LocalSpeechRecognition" && r.synth === "LocalSpeechSynthesis"),
  "local voices listed": has("voices", (r) => r.count > 0),
  "recognition started": has("start"),
  "heard the wake word and request": has("final", (r) => /speck/i.test(r.text) && /weather/i.test(r.text)),
  "interim results streamed": has("final", (r) => r.partials > 0),
  "speech started": has("tts-start"),
  "speech finished": has("tts-end")
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
setTimeout(() => process.exit(Object.values(checks).every(Boolean) ? 0 : 1), 500);

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
