// HTTP API, identical to Speck's Python NLI sidecar (sidecars/nli/server.py), so Speck's `nli`
// processors use it unchanged:
//
//   POST /classify {"model", "premise", "hypothesis"} → {"label", "scores": {entailment, contradiction, neutral}}
//   GET  /health → {"ok", "loaded", "device"}
//
// Only models installed on the box are served (no downloads at request time).
import http from "node:http";

export function createNliService({ classifiers, log = () => {} }) {
  const byName = new Map(classifiers.map((c) => [c.name, c]));
  const stats = { checks: 0, failures: 0, lastMs: 0 };

  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        const models = Object.fromEntries([...byName.values()].map((c) => [c.name, c.status?.() ?? { loaded: c.loaded() }]));
        const refused = Object.values(models).some((m) => m.refused);
        // Not ok while a model is refused by its self-check: a checker that can't be trusted is a fault.
        return json(res, refused ? 503 : 200, {
          ok: !refused, loaded: [...byName.values()].filter((c) => c.loaded()).map((c) => c.name),
          installed: [...byName.keys()], device: "cpu", models, ...stats
        });
      }
      if (req.method !== "POST" || req.url !== "/classify") return json(res, 404, { error: "not found" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 200_000) return json(res, 413, { error: "too large" });
      }
      const body = raw ? JSON.parse(raw) : {};
      const { model, premise, hypothesis } = body;
      if (![model, premise, hypothesis].every((v) => typeof v === "string" && v)) {
        return json(res, 400, { error: "model, premise and hypothesis are required" });
      }
      const classifier = byName.get(model);
      if (!classifier) return json(res, 400, { error: `model ${model} is not installed (installed: ${[...byName.keys()].join(", ") || "none"})` });
      const started = Date.now();
      const result = await classifier.classify(premise, hypothesis);
      stats.checks++;
      stats.lastMs = Date.now() - started;
      log(`classify ${model} ${result.label} ${stats.lastMs} ms`);
      return json(res, 200, result);
    } catch (error) {
      stats.failures++;
      // Reported to Speck as an unusable judgment, as the Python sidecar does.
      return json(res, error instanceof SyntaxError ? 400 : 500, { error: error.message });
    }
  });
  return { server, stats };
}
