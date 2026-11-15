#!/usr/bin/env node
// Check a quantized NLI graph against its fp32 graph on Speck's qualification corpus, through the
// same code path speck-nli serves with. Fails unless every verdict agrees.
//
//   verify.mjs <models dir> <model name> <qualification.ts from Speck>
//
// Both graphs must sit in <models dir>/<model name>/onnx/ (model.onnx and model_quantized.onnx).
import fs from "node:fs";
import { createClassifier } from "../lib/classifier.mjs";

const [modelsDir, name, corpusFile] = process.argv.slice(2);
if (!modelsDir || !name || !corpusFile) { console.error("usage: verify.mjs <models dir> <model name> <qualification.ts>"); process.exit(2); }
const source = fs.readFileSync(corpusFile, "utf8");
const pairs = [...source.matchAll(/premise: "([^"]+)", proposition: "([^"]+)", opposite: "([^"]+)", label: "(\w+)"/g)];
if (pairs.length < 50) { console.error(`only ${pairs.length} corpus pairs found in ${corpusFile}`); process.exit(2); }
const cases = pairs.flatMap(([, premise, proposition, opposite]) => [[premise, proposition], [premise, opposite]]);

const quantized = createClassifier({ name, modelsDir, dtype: "q8" });
const reference = createClassifier({ name, modelsDir, dtype: "fp32" });
let agree = 0;
const disagreements = [];
for (const [premise, hypothesis] of cases) {
  const [q, r] = [await quantized.classify(premise, hypothesis), await reference.classify(premise, hypothesis)];
  if (q.label === r.label) agree++;
  else disagreements.push(`${hypothesis}: int8 ${q.label}, fp32 ${r.label}`);
}
console.log(`${name}: int8 agrees with fp32 on ${agree}/${cases.length} qualification cases`);
for (const line of disagreements.slice(0, 10)) console.log(`  ${line}`);
process.exit(agree === cases.length ? 0 : 1);
