#!/usr/bin/env node
// speck-nli: Speck's NLI checker as int8 ONNX on the CPU, a drop-in for sidecars/nli/server.py
// (same API, same port) without Python or torch. About 0.65 GB on disk and in memory instead
// of ~3 GB for torch fp32.
//
//   node server.mjs                      serve (config: SPECK_NLI_CONFIG, default /etc/speck-os/nli.json)
//   node server.mjs bench [premise] [hypothesis]   load, time a few checks, print RSS
import fs from "node:fs";
import { createClassifier } from "./lib/classifier.mjs";
import { createNliService } from "./lib/service.mjs";

const configPath = process.env.SPECK_NLI_CONFIG || "/etc/speck-os/nli.json";
const config = {
  host: "127.0.0.1", port: 8765, modelsDir: "/var/lib/speck-infer/nli", threads: 2, models: [], preload: true,
  ...JSON.parse(fs.readFileSync(configPath, "utf8"))
};
const classifiers = config.models.map((name) => createClassifier({ name, modelsDir: config.modelsDir, threads: config.threads }));

if (process.argv[2] === "bench") {
  const premise = process.argv[3] || "The backup finished at 3 am and every file was copied.";
  const hypothesis = process.argv[4] || "Some files were not copied.";
  for (const c of classifiers) {
    let t = Date.now();
    await c.load();
    console.log(`${c.name}: loaded in ${Date.now() - t} ms, RSS ${(process.memoryUsage().rss / 1e9).toFixed(2)} GB`);
    const times = [];
    let result;
    for (let i = 0; i < 5; i++) { t = Date.now(); result = await c.classify(premise, hypothesis); times.push(Date.now() - t); }
    console.log(`  ${result.label} ${JSON.stringify(Object.fromEntries(Object.entries(result.scores).map(([k, v]) => [k, Number(v.toFixed(4))])))}`);
    console.log(`  per check: ${times.join(", ")} ms (threads ${config.threads}); RSS ${(process.memoryUsage().rss / 1e9).toFixed(2)} GB`);
  }
  process.exit(0);
}

const { server } = createNliService({ classifiers, log: (line) => console.log(`[nli] ${line}`) });
server.listen(config.port, config.host, () => console.log(`[nli] on http://${config.host}:${config.port} (${config.models.join(", ") || "no models"})`));
// Load at start so the first check doesn't pay for it; a missing model is reported, not fatal.
if (config.preload) for (const c of classifiers) c.load().then(() => console.log(`[nli] loaded ${c.name}`), (e) => console.error(`[nli] ${c.name}: ${e.message}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
