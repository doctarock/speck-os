// Offline speech for the Speck kiosk. kiosk-chrome.mjs injects this into every page before the
// page's own scripts run, replacing the Web Speech API with local engines behind the same
// interface, so Speck's voice.js (wake word, end-of-request detection, barge-in) works unchanged:
//
//   SpeechRecognition / webkitSpeechRecognition → mic → WebSocket → speck-voice STT
//   speechSynthesis / SpeechSynthesisUtterance  → speck-voice TTS → streamed PCM → Web Audio
//
// The injector replaces the CONFIG literal below.
(() => {
  const CONFIG = /*CONFIG*/{ base: "http://127.0.0.1:4320", origins: ["http://127.0.0.1:4310", "http://localhost:4310"], stt: "local", tts: "local" }/*END*/;
  if (window.__speckVoiceLocal || !CONFIG.origins.includes(location.origin)) return;
  window.__speckVoiceLocal = { config: CONFIG };
  const WS_BASE = CONFIG.base.replace(/^http/, "ws");

  const fire = (target, type, init = {}) => {
    const event = Object.assign(new Event(type), init);
    target.dispatchEvent(event);
    const handler = target[`on${type}`];
    if (typeof handler === "function") handler.call(target, event);
    return event;
  };

  // ------------------------------------------------------------------ microphone (shared)
  // One capture graph for the life of the page; recognitions subscribe while they run.
  const WORKLET = `class Tap extends AudioWorkletProcessor {
    process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
  }
  registerProcessor("speck-tap", Tap);`;
  let micGraph = null;
  function microphone() {
    micGraph ??= (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const context = new AudioContext();
      await context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
      const tap = new AudioWorkletNode(context, "speck-tap");
      context.createMediaStreamSource(stream).connect(tap);
      const listeners = new Set();
      const batch = Math.round(context.sampleRate / 10);   // ~100 ms per message
      let pending = new Float32Array(0);
      tap.port.onmessage = ({ data }) => {
        if (!listeners.size) { pending = new Float32Array(0); return; }
        const joined = new Float32Array(pending.length + data.length);
        joined.set(pending);
        joined.set(data, pending.length);
        pending = joined;
        if (pending.length < batch) return;
        const pcm = new Int16Array(pending.length);
        for (let i = 0; i < pending.length; i++) {
          const v = Math.max(-1, Math.min(1, pending[i]));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        pending = new Float32Array(0);
        for (const listener of listeners) listener(pcm.buffer);
      };
      if (context.state === "suspended") await context.resume().catch(() => {});
      return { sampleRate: context.sampleRate, listeners, context };
    })().catch((error) => { micGraph = null; throw error; });
    return micGraph;
  }

  // ------------------------------------------------------------------ recognition
  let failures = 0;   // consecutive service failures: back off so restart loops stay calm
  const backoff = () => Math.min(5000, 400 * 2 ** Math.min(failures, 4));

  class LocalSpeechRecognition extends EventTarget {
    constructor() {
      super();
      this.continuous = false;
      this.interimResults = false;
      this.lang = navigator.language || "en-US";
      this.maxAlternatives = 1;
      this.grammars = null;
      for (const type of ["start", "end", "result", "error", "nomatch", "audiostart", "audioend", "speechstart", "speechend", "soundstart", "soundend"]) this[`on${type}`] = null;
      this._state = "idle";
      this._ws = null;
      this._results = [];
      this._listener = null;
      this._spoke = false;
    }

    start() {
      if (this._state !== "idle") throw new DOMException("recognition has already started", "InvalidStateError");
      this._state = "starting";
      this._results = [];
      this._spoke = false;
      const token = this._token = {};
      this._open(token).catch((error) => { if (this._token === token) this._fail(error); });
    }

    async _open(token) {
      const mic = await microphone();
      const ws = new WebSocket(`${WS_BASE}/v1/stt`);
      ws.binaryType = "arraybuffer";
      if (this._token === token) this._ws = ws;
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(Object.assign(new Error("speech service unreachable"), { code: "network" }));
      });
      if (this._token !== token || this._state !== "starting") { ws.close(); return; }   // stopped while connecting
      ws.onerror = null;
      ws.onmessage = (message) => this._message(JSON.parse(message.data));
      ws.onclose = () => { if (this._token === token) this._finished(); };
      ws.send(JSON.stringify({ type: "start", sampleRate: mic.sampleRate, lang: this.lang }));
      this._listener = (pcm) => { if (ws.readyState === WebSocket.OPEN && this._state === "running") ws.send(pcm); };
      mic.listeners.add(this._listener);
      this._mic = mic;
      this._state = "running";
      failures = 0;
      fire(this, "start");
      fire(this, "audiostart");
    }

    _message(message) {
      if (message.type === "partial" || message.type === "final") {
        if (!this._spoke) { this._spoke = true; fire(this, "soundstart"); fire(this, "speechstart"); }
        if (message.type === "partial" && !this.interimResults) return;
        this._emit(String(message.text || ""), message.type === "final");
      } else if (message.type === "error") {
        this._fail(Object.assign(new Error(message.error), { code: "network" }));
      }
    }

    // The last result is the one being spoken; a partial replaces it, a final settles it.
    _emit(text, isFinal) {
      if (!text) return;
      let index = this._results.length;
      if (index && !this._results[index - 1].isFinal) index--;
      const alternative = { transcript: index && this.continuous ? ` ${text}` : text, confidence: isFinal ? 0.9 : 0.5 };
      const result = Object.assign([alternative], { isFinal, item: (i) => result[i] });
      this._results[index] = result;
      this._results.length = index + 1;
      const results = Object.assign(this._results.slice(), { item: (i) => this._results[i] });
      fire(this, "result", { resultIndex: index, results });
      if (isFinal && !this.continuous) this.stop();
    }

    stop() {
      if (this._state === "starting") { this._state = "stopping"; this._ws?.close(); this._finished(); return; }
      if (this._state !== "running") return;
      this._state = "stopping";
      // The service turns what's buffered into a final result, then closes.
      try { this._ws.send(JSON.stringify({ type: "stop" })); } catch { /* closing anyway */ }
      setTimeout(() => this._ws?.close(), 2000);
    }

    abort() {
      if (this._state === "idle") return;
      this._state = "stopping";
      this._ws?.close();
      this._finished();
    }

    _fail(error) {
      if (this._state === "idle") return;
      const code = error?.name === "NotAllowedError" ? "not-allowed" : error?.code === "network" ? "network" : "audio-capture";
      if (code === "network") failures++;
      this._state = "failing";
      this._ws?.close();
      // Delay error + end when the service is down, so the page's restart loop backs off.
      setTimeout(() => {
        fire(this, "error", { error: code, message: String(error?.message || code) });
        this._state = "stopping";
        this._finished();
      }, code === "network" ? backoff() : 0);
    }

    _finished() {
      if (this._state === "idle" || this._state === "failing") return;
      if (this._listener) this._mic?.listeners.delete(this._listener);
      this._listener = null;
      this._ws = null;
      this._state = "idle";
      if (this._spoke) { fire(this, "speechend"); fire(this, "soundend"); }
      fire(this, "audioend");
      fire(this, "end");
    }
  }

  // ------------------------------------------------------------------ synthesis
  const nativeSynth = window.speechSynthesis;
  const NativeUtterance = window.SpeechSynthesisUtterance;

  class LocalSpeechSynthesisUtterance extends EventTarget {
    constructor(text = "") {
      super();
      this.text = String(text);
      this.lang = "";
      this.voice = null;
      this.volume = 1;
      this.rate = 1;
      this.pitch = 1;
      for (const type of ["start", "end", "error", "pause", "resume", "mark", "boundary"]) this[`on${type}`] = null;
    }
  }

  let localVoices = [];
  const isLocal = (voice) => !voice || String(voice.voiceURI || "").startsWith("speck-voice:");

  class LocalSpeechSynthesis extends EventTarget {
    constructor() {
      super();
      this.onvoiceschanged = null;
      this._queue = [];
      this._current = null;
      this._generation = 0;
      this._output = null;
    }
    get speaking() { return Boolean(this._current); }
    get pending() { return this._queue.length > 0; }
    get paused() { return this._output?.state === "suspended"; }

    getVoices() {
      const native = CONFIG.tts === "both" && nativeSynth ? nativeSynth.getVoices() : [];
      return [...localVoices, ...native];
    }

    speak(utterance) {
      this._queue.push(utterance);
      this._prefetch(utterance);
      if (!this._current) this._next();
    }

    cancel() {
      this._generation++;
      const dropped = [this._current, ...this._queue].filter(Boolean);
      this._queue = [];
      this._current = null;
      for (const job of dropped) {
        job._abort?.abort();
        for (const source of job._sources ?? []) { try { source.stop(); } catch { /* not started */ } }
        if (job._native) nativeSynth?.cancel();
      }
      for (const job of dropped) fire(job, "error", { error: "interrupted", utterance: job, charIndex: 0, elapsedTime: 0 });
    }

    pause() { this._output?.suspend(); }
    resume() { this._output?.resume(); }

    _context() {
      this._output ??= new AudioContext();
      if (this._output.state === "suspended") this._output.resume().catch(() => {});
      return this._output;
    }

    // Start fetching audio as soon as an utterance is queued, so the next chunk is ready
    // (or already streaming) by the time the current one finishes.
    _prefetch(utterance) {
      if (!isLocal(utterance.voice) || utterance._response) return;
      utterance._abort = new AbortController();
      const voice = utterance.voice ? String(utterance.voice.voiceURI).slice("speck-voice:".length) : undefined;
      utterance._response = fetch(`${CONFIG.base}/v1/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: utterance.text, voice, rate: utterance.rate }),
        signal: utterance._abort.signal
      });
      utterance._response.catch(() => {});
    }

    async _next() {
      const utterance = this._queue.shift();
      if (!utterance) return;
      this._current = utterance;
      const generation = this._generation;
      const done = (type, extra = {}) => {
        if (this._generation !== generation || this._current !== utterance) return;
        this._current = null;
        fire(utterance, type, { utterance, charIndex: utterance.text.length, elapsedTime: 0, ...extra });
        this._next();
      };
      if (!isLocal(utterance.voice)) return this._speakNative(utterance, done);
      try {
        const response = await utterance._response;
        if (!response.ok) throw new Error(`speech service ${response.status}`);
        const sampleRate = Number(response.headers.get("X-Sample-Rate")) || 24000;
        const context = this._context();
        const gain = context.createGain();
        gain.gain.value = Math.max(0, Math.min(1, utterance.volume ?? 1));
        gain.connect(context.destination);
        utterance._sources = [];
        let at = 0;
        let started = false;
        let buffered = new Uint8Array(0);
        const reader = response.body.getReader();
        for (;;) {
          const { value, done: ended } = await reader.read();
          if (this._generation !== generation) return;
          if (value) {
            const joined = new Uint8Array(buffered.length + value.length);
            joined.set(buffered);
            joined.set(value, buffered.length);
            buffered = joined;
          }
          // Each frame: uint32 LE sample count, then int16 LE samples. Schedule it gaplessly.
          while (buffered.length >= 4) {
            const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
            const count = view.getUint32(0, true);
            if (buffered.length < 4 + count * 2) break;
            const audio = context.createBuffer(1, Math.max(1, count), sampleRate);
            const channel = audio.getChannelData(0);
            for (let i = 0; i < count; i++) channel[i] = view.getInt16(4 + i * 2, true) / 0x8000;
            buffered = buffered.slice(4 + count * 2);
            const source = context.createBufferSource();
            source.buffer = audio;
            source.connect(gain);
            at = Math.max(at, context.currentTime + 0.03);
            source.start(at);
            at += audio.duration;
            utterance._sources.push(source);
            if (!started) { started = true; fire(utterance, "start", { utterance, charIndex: 0, elapsedTime: 0 }); }
          }
          if (ended) break;
        }
        if (!started) throw new Error("no audio");
        const last = utterance._sources.at(-1);
        last.onended = () => done("end");
      } catch (error) {
        if (this._generation !== generation) return;
        done("error", { error: "synthesis-failed", message: String(error?.message || error) });
      }
    }

    _speakNative(utterance, done) {
      if (!nativeSynth || !NativeUtterance) return done("error", { error: "synthesis-unavailable" });
      const native = new NativeUtterance(utterance.text);
      for (const key of ["lang", "voice", "volume", "rate", "pitch"]) if (utterance[key] != null && utterance[key] !== "") native[key] = utterance[key];
      native.onstart = () => fire(utterance, "start", { utterance, charIndex: 0, elapsedTime: 0 });
      native.onend = () => done("end");
      native.onerror = (event) => done("error", { error: event.error || "synthesis-failed" });
      utterance._native = native;
      nativeSynth.speak(native);
    }
  }

  const synthesis = new LocalSpeechSynthesis();

  async function loadVoices() {
    try {
      const response = await fetch(`${CONFIG.base}/v1/voices`);
      const { voices } = await response.json();
      localVoices = voices.map((v) => Object.freeze({
        name: v.name, lang: v.lang, voiceURI: `speck-voice:${v.id}`, localService: true, default: Boolean(v.default)
      }));
      fire(synthesis, "voiceschanged");
    } catch {
      setTimeout(loadVoices, 5000);   // the service may still be starting
    }
  }

  // ------------------------------------------------------------------ install
  const define = (name, value) => Object.defineProperty(window, name, { value, configurable: true, writable: true });
  if (CONFIG.stt === "local") {
    define("SpeechRecognition", LocalSpeechRecognition);
    define("webkitSpeechRecognition", LocalSpeechRecognition);
  }
  if (CONFIG.tts !== "chrome") {
    define("speechSynthesis", synthesis);
    define("SpeechSynthesisUtterance", LocalSpeechSynthesisUtterance);
    loadVoices();
  }
})();
