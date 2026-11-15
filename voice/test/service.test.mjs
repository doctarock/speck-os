import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { createVoiceService, frame, int16ToFloat } from "../lib/service.mjs";
import { voiceSource, cdpOverPipe } from "../../shell/kiosk-chrome.mjs";

const ORIGIN = "http://127.0.0.1:4310";

/** Fake engines: STT "hears" the number of samples; TTS yields one chunk per sentence. */
function engines() {
  const seen = { sessions: 0, finished: 0, accepted: 0, rates: [] };
  const stt = {
    model: "fake-stt",
    createSession() {
      seen.sessions++;
      let heard = 0;
      return {
        accept(samples, rate) {
          seen.accepted += samples.length;
          seen.rates.push(rate);
          heard += samples.length;
          return heard >= 3200 ? [{ type: "final", text: "hey speck hello" }] : [{ type: "partial", text: "hey" }];
        },
        finish() { seen.finished++; return heard ? [{ type: "final", text: "tail words" }] : []; }
      };
    }
  };
  const tts = {
    voices: () => [{ id: "fake:0", name: "Fake (offline)", lang: "en-US", default: true }],
    sampleRateOf: async () => 16000,
    async synthesize({ text }, onChunk) {
      for (const sentence of text.split(/(?<=\.)\s+/)) {
        if (onChunk(new Float32Array(sentence.length * 10).fill(0.5)) === false) break;
      }
      return { sampleRate: 16000, voice: "fake:0" };
    }
  };
  return { stt, tts, seen };
}

async function start(extra = {}) {
  const { stt, tts, seen } = engines();
  const { server } = createVoiceService({ stt, tts, config: { allowedOrigins: [ORIGIN] }, ...extra });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("health and voices; CORS only for the Speck page's origin", async () => {
  const s = await start();
  try {
    const health = await (await fetch(`${s.base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.stt.model, "fake-stt");
    const voices = await fetch(`${s.base}/v1/voices`, { headers: { Origin: ORIGIN } });
    assert.equal(voices.headers.get("access-control-allow-origin"), ORIGIN);
    assert.deepEqual((await voices.json()).voices.map((v) => v.id), ["fake:0"]);
    const foreign = await fetch(`${s.base}/v1/voices`, { headers: { Origin: "http://evil.example" } });
    assert.equal(foreign.status, 403);
    const preflight = await fetch(`${s.base}/v1/tts`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    assert.equal(preflight.status, 204);
  } finally { await s.close(); }
});

test("TTS streams one frame per sentence, with the sample rate up front", async () => {
  const s = await start();
  try {
    const response = await fetch(`${s.base}/v1/tts`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "One. Two two. Three three three.", rate: 0.96 })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-sample-rate"), "16000");
    const body = Buffer.from(await response.arrayBuffer());
    const counts = [];
    for (let at = 0; at < body.length;) {
      const n = body.readUInt32LE(at);
      counts.push(n);
      assert.ok(Math.abs(body.readInt16LE(at + 4) / 0x7fff - 0.5) < 0.001);
      at += 4 + n * 2;
    }
    assert.deepEqual(counts, [40, 80, 180]);
    const empty = await fetch(`${s.base}/v1/tts`, { method: "POST", body: JSON.stringify({ text: " " }) });
    assert.equal(empty.status, 400);
  } finally { await s.close(); }
});

test("STT over WebSocket: partials, a final at the pause, the rest flushed on stop", async () => {
  const s = await start();
  try {
    const ws = new WebSocket(`${s.base.replace("http", "ws")}/v1/stt`, { headers: { Origin: ORIGIN } });
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({ type: "start", sampleRate: 48000 }));
    const pcm = Buffer.alloc(1600 * 2);
    ws.send(pcm); ws.send(pcm);
    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.send(JSON.stringify({ type: "stop" }));
    await new Promise((resolve) => ws.on("close", resolve));
    assert.deepEqual(messages.map((m) => m.type), ["ready", "partial", "final", "final", "end"]);
    assert.equal(messages[2].text, "hey speck hello");
    assert.equal(messages[3].text, "tail words");
    assert.deepEqual(s.seen.rates, [48000, 48000], "the browser's capture rate is passed on (the engine resamples)");
    assert.equal(s.seen.accepted, 3200);
  } finally { await s.close(); }
});

test("STT refuses other origins", async () => {
  const s = await start();
  try {
    const ws = new WebSocket(`${s.base.replace("http", "ws")}/v1/stt`, { headers: { Origin: "http://evil.example" } });
    const error = await new Promise((resolve) => ws.on("error", resolve));
    assert.match(error.message, /403/);
  } finally { await s.close(); }
});

test("PCM helpers round-trip", () => {
  const f = frame(Float32Array.from([0, 0.5, -0.5, 1, -1, 2]));
  assert.equal(f.readUInt32LE(0), 6);
  const back = int16ToFloat(f.subarray(4));
  assert.deepEqual(Array.from(back, (v) => Math.round(v * 100) / 100), [0, 0.5, -0.5, 1, -1, 1]);
});

test("kiosk injection: config baked into the page script, none when both use Chrome speech", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-"));
  const page = path.join(dir, "page.js");
  fs.writeFileSync(page, "const CONFIG = /*CONFIG*/{ base: \"x\" }/*END*/;");
  const config = path.join(dir, "voice.json");
  fs.writeFileSync(config, JSON.stringify({ port: 4321, allowedOrigins: [ORIGIN], browser: { stt: "local", tts: "both" } }));
  const source = voiceSource({ configPath: config, pagePath: page });
  assert.equal(source, `const CONFIG = {"base":"http://127.0.0.1:4321","origins":["${ORIGIN}"],"stt":"local","tts":"both"};`);
  fs.writeFileSync(config, JSON.stringify({ browser: { stt: "chrome", tts: "chrome" } }));
  assert.equal(voiceSource({ configPath: config, pagePath: page }), null);
  assert.equal(voiceSource({ configPath: path.join(dir, "missing.json"), pagePath: page }), null);
});

test("CDP over the pipe: NUL-framed messages, replies matched by id, events passed on", async () => {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const events = [];
  const send = cdpOverPipe(toChrome, fromChrome, (e) => events.push(e.method));
  const written = [];
  toChrome.on("data", (chunk) => written.push(String(chunk)));
  const reply = send("Page.enable", {}, "S1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(written.join("").replace(/\0$/, "")), { id: 1, method: "Page.enable", params: {}, sessionId: "S1" });
  // A reply and an event split across chunks.
  fromChrome.write('{"method":"Target.attachedToTarget","params":{}}\0{"id":1,"res');
  fromChrome.write('ult":{"ok":true}}\0');
  assert.deepEqual(await reply, { ok: true });
  assert.deepEqual(events, ["Target.attachedToTarget"]);
});
