// speck-voice HTTP + WebSocket service (127.0.0.1 only). Engine-agnostic: takes { stt, tts }.
//
//   GET  /health                 engines and activity
//   GET  /v1/voices              local voices
//   POST /v1/tts {text, voice, rate}
//        → X-Sample-Rate header, then frames: uint32 LE sample count + int16 LE samples,
//          one frame per sentence as it's synthesised
//   WS   /v1/stt                 client: {"type":"start","sampleRate":16000} then binary int16 LE
//                                mono frames, then {"type":"stop"}
//                                server: ready | partial {text} | final {text} | end | error {error}
//
// Only the Speck page's origins may use it (CORS + WebSocket Origin check).
import http from "node:http";
import { WebSocketServer } from "ws";

const MAX_TEXT = 5000;

export function createVoiceService({ stt, tts, config = {}, log = () => {} }) {
  const allowed = new Set(config.allowedOrigins ?? ["http://127.0.0.1:4310", "http://localhost:4310"]);
  const stats = { sttSessions: 0, ttsActive: 0, startedAt: new Date().toISOString() };
  const originOk = (origin) => !origin || allowed.has(origin);

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "X-Sample-Rate, X-Voice");
    }
  }

  function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw Object.assign(new Error("body too large"), { status: 413 });
      chunks.push(chunk);
    }
    try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
    catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
  }

  async function speak(req, res) {
    const body = await readJson(req);
    const text = String(body.text ?? "").trim().slice(0, MAX_TEXT);
    if (!text) return json(res, 400, { ok: false, error: "text is required" });
    const speed = Math.min(2, Math.max(0.5, Number(body.rate) || 1));
    const voice = body.voice ? String(body.voice) : undefined;
    const sampleRate = await tts.sampleRateOf(voice);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "X-Sample-Rate": String(sampleRate), "Cache-Control": "no-store" });
    let open = true;
    res.on("close", () => { open = false; });
    stats.ttsActive++;
    try {
      const result = await tts.synthesize({ text, voice, speed }, (samples) => {
        if (!open) return false;
        res.write(frame(samples));
        return true;
      });
      log(`tts ${result.voice} ${text.length} chars`);
    } catch (error) {
      log(`tts failed: ${error.message}`);
    } finally {
      stats.ttsActive--;
      res.end();
    }
  }

  const server = http.createServer(async (req, res) => {
    cors(req, res);
    if (!originOk(req.headers.origin)) return json(res, 403, { ok: false, error: "origin not allowed" });
    const url = new URL(req.url, "http://voice");
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, stt: stt ? { model: stt.model } : null, tts: tts ? { voices: tts.voices().length } : null, ...stats });
      }
      if (req.method === "GET" && url.pathname === "/v1/voices") return json(res, 200, { voices: tts ? tts.voices() : [] });
      if (req.method === "POST" && url.pathname === "/v1/tts") {
        if (!tts) return json(res, 503, { ok: false, error: "TTS not configured" });
        return await speak(req, res);
      }
      return json(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? 500, { ok: false, error: error.message });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://voice");
    if (url.pathname !== "/v1/stt" || !originOk(req.headers.origin) || !stt) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => recognise(ws));
  });

  function recognise(ws) {
    let session = null;
    let sampleRate = 16000;
    const send = (message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
    const emit = (events) => events.forEach(send);
    stats.sttSessions++;
    ws.on("close", () => { stats.sttSessions--; session = null; });
    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          if (!session) return send({ type: "error", error: "send start first" });
          emit(session.accept(int16ToFloat(data), sampleRate));
          return;
        }
        const message = JSON.parse(String(data));
        if (message.type === "start") {
          sampleRate = Number(message.sampleRate) || 16000;
          session = stt.createSession();
          send({ type: "ready", model: stt.model });
        } else if (message.type === "stop") {
          if (session) emit(session.finish());
          session = null;
          send({ type: "end" });
          ws.close(1000);
        }
      } catch (error) {
        send({ type: "error", error: error.message });
      }
    });
  }

  return { server, stats };
}

/** One frame: uint32 LE sample count, then int16 LE samples. */
export function frame(samples) {
  const out = Buffer.alloc(4 + samples.length * 2);
  out.writeUInt32LE(samples.length, 0);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 4 + i * 2);
  }
  return out;
}

export function int16ToFloat(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
  const out = new Float32Array(Math.floor(buffer.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buffer.readInt16LE(i * 2) / 0x8000;
  return out;
}
