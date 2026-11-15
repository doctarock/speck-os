#!/usr/bin/env node
// speck-voice: offline speech for the Speck kiosk (speck-voice.service).
//
//   server.mjs                 serve (config: $SPECK_VOICE_CONFIG or /etc/speck-os/voice.json)
//   server.mjs bench           load the configured models and print speed figures
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStt, createTts } from "./lib/engines.mjs";
import { createVoiceService } from "./lib/service.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(process.env.SPECK_VOICE_CONFIG || "/etc/speck-os/voice.json", "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(HERE, "models.json"), "utf8"));
const modelsDir = process.env.SPECK_VOICE_MODELS || config.modelsDir;
const log = (message) => console.log(`[voice] ${message}`);

const t0 = Date.now();
const stt = config.stt?.model ? createStt({ manifest, modelsDir, ...config.stt }) : null;
const tts = config.tts?.models?.length ? createTts({ manifest, modelsDir, ...config.tts }) : null;
if (tts) await tts.warm(config.tts.defaultVoice);   // the default voice is ready before the first reply
log(`models loaded in ${Date.now() - t0} ms (stt ${stt?.model ?? "off"}, ${tts?.voices().length ?? 0} voices)`);

if (process.argv[2] === "bench") {
  const session = stt?.createSession();
  if (session) {
    const second = new Float32Array(16000).map((_, i) => 0.1 * Math.sin(i / 8));
    const start = process.hrtime.bigint();
    for (let i = 0; i < 10; i++) session.accept(second.subarray(0, 1600), 16000);
    console.log(`stt: ${(Number(process.hrtime.bigint() - start) / 1e6 / 1000).toFixed(3)}s compute per 1s of audio (RTF)`);
  }
  if (tts) {
    for (const voice of [config.tts.defaultVoice]) {
      const text = "Hello, I'm Speck. I checked the backups this morning, and everything finished without errors.";
      const start = Date.now();
      let first = null;
      let samples = 0;
      const { sampleRate } = await tts.synthesize({ text, voice }, (chunk) => { first ??= Date.now() - start; samples += chunk.length; });
      const ms = Date.now() - start;
      console.log(`tts ${voice}: first audio after ${first} ms, ${(samples / sampleRate).toFixed(1)} s of speech in ${ms} ms (RTF ${(ms / 1000 / (samples / sampleRate)).toFixed(3)})`);
    }
  }
  console.log(`rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
  process.exit(0);
}

const { server } = createVoiceService({ stt, tts, config, log });
server.listen(config.port ?? 4320, "127.0.0.1", () => log(`listening on http://127.0.0.1:${config.port ?? 4320}`));
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
