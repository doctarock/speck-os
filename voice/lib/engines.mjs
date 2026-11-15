// sherpa-onnx engines for speck-voice: streaming STT and sentence-streamed TTS. The only module
// that touches sherpa-onnx; the server takes engines with the same shape, so tests use fakes.
//
// Pinned to sherpa-onnx-node 1.13.x: 2.0 dropped the built-in espeak-ng frontend, so its TTS needs
// phonemes supplied by the caller, and the voices were trained on espeak-ng's exact output.
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function loadSherpa() {
  return require("sherpa-onnx-node");
}

/** Streaming recognizer. Each session emits partials as you speak and a final at each pause. */
export function createStt({ sherpa = loadSherpa(), manifest, modelsDir, model, threads = 2, endpointSilenceSec = 0.8 }) {
  const entry = manifest[model];
  if (!entry || entry.kind !== "stt") throw new Error(`unknown STT model ${model}`);
  const dir = path.join(modelsDir, entry.dir);
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: Object.fromEntries(Object.entries(entry.transducer).map(([k, f]) => [k, path.join(dir, f)])),
      tokens: path.join(dir, entry.tokens),
      numThreads: threads, provider: "cpu", debug: 0
    },
    decodingMethod: "greedy_search",
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: endpointSilenceSec,
    rule3MinUtteranceLength: 20
  });

  function createSession() {
    const stream = recognizer.createStream();
    let shown = "";
    let rate = 16000;   // the stream keeps the first rate it is fed; padding must match it
    const decode = () => { while (recognizer.isReady(stream)) recognizer.decode(stream); };
    const text = () => tidy(recognizer.getResult(stream).text);
    return {
      /** Float32 samples in [-1, 1] → [{ type: "partial" | "final", text }] */
      accept(samples, sampleRate) {
        rate = sampleRate;
        stream.acceptWaveform({ samples, sampleRate });
        decode();
        const current = text();
        if (recognizer.isEndpoint(stream)) {
          recognizer.reset(stream);
          shown = "";
          return current ? [{ type: "final", text: current }] : [];
        }
        if (current === shown) return [];
        shown = current;
        return current ? [{ type: "partial", text: current }] : [];
      },
      /** Flush what's buffered (the user stopped): the last words become final. */
      finish() {
        // Half a second of silence at the stream's own rate (sherpa rejects a rate change mid-stream).
        stream.acceptWaveform({ samples: new Float32Array(Math.round(rate / 2)), sampleRate: rate });
        stream.inputFinished();
        decode();
        const current = text();
        return current ? [{ type: "final", text: current }] : [];
      }
    };
  }
  return { model, createSession };
}

/** Text to speech, one sentence at a time so playback starts before the whole reply is made. */
export function createTts({ sherpa = loadSherpa(), manifest, modelsDir, models, threads = 2, defaultVoice }) {
  const loaded = new Map();   // model id → Promise<OfflineTts>
  const queues = new Map();   // model id → Promise (one generation at a time per engine)
  const voices = [];
  for (const id of models) {
    const entry = manifest[id];
    if (!entry || entry.kind !== "tts") throw new Error(`unknown TTS model ${id}`);
    for (const v of entry.voices) {
      const voiceId = `${id}:${v.sid}`;
      voices.push({ id: voiceId, name: `${v.name} (${entry.title.split(" (")[0]}, offline)`, lang: v.lang, model: id, sid: v.sid, default: voiceId === defaultVoice });
    }
  }
  if (!voices.some((v) => v.default) && voices[0]) voices[0].default = true;

  function engine(id) {
    if (!loaded.has(id)) {
      const entry = manifest[id];
      const dir = path.join(modelsDir, entry.dir);
      const files = Object.fromEntries(Object.entries(entry.files).map(([k, f]) => [k, path.join(dir, f)]));
      const config = { model: { [entry.engine]: files, numThreads: threads, provider: "cpu", debug: 0 }, maxNumSentences: 1 };
      const promise = sherpa.OfflineTts.createAsync ? sherpa.OfflineTts.createAsync(config) : Promise.resolve(new sherpa.OfflineTts(config));
      loaded.set(id, promise.catch((error) => { loaded.delete(id); throw error; }));
    }
    return loaded.get(id);
  }

  /**
   * onChunk(Float32Array) is called per sentence as it's ready; return false from it to stop
   * (the listener went away). Resolves to { sampleRate }.
   */
  async function synthesize({ text, voice, speed = 1 }, onChunk) {
    const chosen = voices.find((v) => v.id === voice) ?? voices.find((v) => v.default);
    if (!chosen) throw new Error("no TTS voice configured");
    const tts = await engine(chosen.model);
    const previous = queues.get(chosen.model) ?? Promise.resolve();
    let release;
    queues.set(chosen.model, new Promise((resolve) => { release = resolve; }));
    await previous;
    try {
      let streamed = false;
      let stopped = false;
      const audio = await tts.generateAsync({
        text, sid: chosen.sid, speed,
        onProgress: ({ samples }) => {
          if (stopped) return 0;
          streamed = true;
          if (onChunk(samples) === false) { stopped = true; return 0; }
          return 1;
        }
      });
      if (!streamed && !stopped && audio?.samples?.length) onChunk(audio.samples);
      return { sampleRate: tts.sampleRate, voice: chosen.id };
    } finally {
      release();
    }
  }

  return {
    voices: () => voices.map(({ id, name, lang, default: isDefault }) => ({ id, name, lang, default: isDefault })),
    sampleRateOf: async (voice) => (await engine((voices.find((v) => v.id === voice) ?? voices.find((v) => v.default)).model)).sampleRate,
    warm: (voice) => engine((voices.find((v) => v.id === voice) ?? voices.find((v) => v.default)).model),
    synthesize
  };
}

/** Models without casing (all caps) read better in sentence case. */
function tidy(text) {
  const t = String(text ?? "").trim();
  if (!t || /[a-z]/.test(t)) return t;
  const lower = t.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
