import test from "node:test";
import assert from "node:assert/strict";
import { createNliService } from "../lib/service.mjs";
import { createClassifier, verdict, speckLabel, softmax, CANARIES } from "../lib/classifier.mjs";

const NAME = "MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli";
const ID2LABEL = { 0: "entailment", 1: "neutral", 2: "contradiction" };

/** transformers.js stand-in: logits favour whichever label the hypothesis names. */
function fakeTransformers({ id2label = ID2LABEL, failLoads = 0, broken = false } = {}) {
  const calls = { loads: 0, active: 0, maxActive: 0, options: null };
  return {
    calls,
    env: {},
    AutoTokenizer: { from_pretrained: async () => async (premise, { text_pair }) => ({ premise, hypothesis: text_pair }) },
    AutoModelForSequenceClassification: {
      from_pretrained: async (_name, options) => {
        calls.loads++;
        calls.options = options;
        if (calls.loads <= failLoads) throw new Error("model files missing");
        const model = async ({ hypothesis }) => {
          calls.active++;
          calls.maxActive = Math.max(calls.maxActive, calls.active);
          await new Promise((r) => setTimeout(r, 5));
          calls.active--;
          const canary = CANARIES.find(([, h]) => h === hypothesis);
          let want = canary ? ["entailment", "neutral", "contradiction"].indexOf(canary[2]) : ["entail", "neutral", "contra"].findIndex((w) => hypothesis.includes(w));
          // Like the published dynamic-int8 graph: contradictions come out neutral.
          if (broken && want === 2) want = 1;
          return { logits: { data: Float32Array.from([0, 1, 2].map((i) => (i === want ? 4 : 0))) } };
        };
        model.config = { id2label };
        return model;
      }
    }
  };
}

async function serve(classifiers) {
  const { server, stats } = createNliService({ classifiers });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/classify`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  return { server, stats, base, post };
}

test("labels and scores follow the Python sidecar's mapping", () => {
  assert.equal(speckLabel("ENTAILMENT"), "entailment");
  assert.equal(speckLabel("not_entailment"), "neutral");
  assert.equal(speckLabel("contradiction"), "contradiction");
  assert.equal(speckLabel("other"), null);
  const p = softmax([1, 2, 3]);
  assert.ok(Math.abs(p.reduce((a, b) => a + b) - 1) < 1e-9);
  const v = verdict(Float32Array.from([0.1, 0.2, 3]), ID2LABEL);
  assert.equal(v.label, "contradiction");
  assert.deepEqual(Object.keys(v.scores).sort(), ["contradiction", "entailment", "neutral"]);
});

test("same API as sidecars/nli/server.py: classify, health, errors", async () => {
  const transformers = fakeTransformers();
  const classifier = createClassifier({ name: NAME, modelsDir: "/models", transformers });
  const { server, base, post } = await serve([classifier]);
  try {
    const ok = await post({ model: NAME, premise: "The door was locked.", hypothesis: "contra: the door was open" });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.label, "contradiction");
    assert.ok(body.scores.contradiction > 0.9);
    assert.equal((await post({ model: NAME, premise: "x" })).status, 400);
    const unknown = await post({ model: "other/model", premise: "a", hypothesis: "b" });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /not installed/);
    assert.equal((await post("{not json")).status, 400);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.device, "cpu");
    assert.deepEqual(health.loaded, [NAME]);
    assert.equal(health.checks, 1);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});

test("int8 graph, bounded threads, local files only", async () => {
  const transformers = fakeTransformers();
  const classifier = createClassifier({ name: NAME, modelsDir: "/var/lib/speck-infer/nli", threads: 3, transformers });
  await classifier.classify("p", "entail");
  assert.equal(transformers.calls.options.dtype, "q8");
  assert.equal(transformers.calls.options.session_options.intraOpNumThreads, 3);
  assert.equal(transformers.env.allowRemoteModels, false);
  assert.equal(transformers.env.localModelPath, "/var/lib/speck-infer/nli/");
});

test("checks run one at a time, so a burst never takes every core", async () => {
  const transformers = fakeTransformers();
  const classifier = createClassifier({ name: NAME, modelsDir: "/m", transformers });
  const results = await Promise.all(["entail", "neutral", "contra", "entail"].map((h) => classifier.classify("p", h)));
  assert.deepEqual(results.map((r) => r.label), ["entailment", "neutral", "contradiction", "entailment"]);
  assert.equal(transformers.calls.maxActive, 1);
  assert.equal(transformers.calls.loads, 1);
});

test("a model without the three NLI classes is refused; a failed load can be retried", async () => {
  const wrong = createClassifier({ name: NAME, modelsDir: "/m", transformers: fakeTransformers({ id2label: { 0: "positive", 1: "negative" } }) });
  await assert.rejects(wrong.classify("p", "h"), /entailment, contradiction and neutral/);
  const flaky = fakeTransformers({ failLoads: 1 });
  const classifier = createClassifier({ name: NAME, modelsDir: "/m", transformers: flaky });
  await assert.rejects(classifier.classify("p", "entail"), /model files missing/);
  assert.equal((await classifier.classify("p", "entail")).label, "entailment");
});

test("a mis-quantized graph fails the self-check and is never served", async () => {
  const transformers = fakeTransformers({ broken: true });
  const classifier = createClassifier({ name: NAME, modelsDir: "/m", transformers });
  const { server, base, post } = await serve([classifier]);
  try {
    const first = await post({ model: NAME, premise: "p", hypothesis: "entail" });
    assert.equal(first.status, 500);
    assert.match((await first.json()).error, /self-check.*8\/12 canaries.*mis-quantized/);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 503);
    const body = await health.json();
    assert.equal(body.ok, false);
    assert.equal(body.models[NAME].selfCheck.right, 8);
    assert.match(body.models[NAME].refused, /mis-quantized/);
    assert.equal((await post({ model: NAME, premise: "p", hypothesis: "entail" })).status, 500);
    assert.equal(transformers.calls.loads, 1, "a refused graph isn't reloaded on every request");
  } finally {
    server.close();
  }
});

test("a sound graph passes the self-check and reports it", async () => {
  const classifier = createClassifier({ name: NAME, modelsDir: "/m", transformers: fakeTransformers() });
  await classifier.load();
  const { selfCheck, refused } = classifier.status();
  assert.equal(refused, null);
  assert.deepEqual({ right: selfCheck.right, total: selfCheck.total, passed: selfCheck.passed }, { right: CANARIES.length, total: CANARIES.length, passed: true });
});

test("low confidence alone fails the self-check", async () => {
  const classifier = createClassifier({ name: NAME, modelsDir: "/m", transformers: fakeTransformers(), selfCheck: { minConfidence: 0.99 } });
  await assert.rejects(classifier.load(), /self-check \(12\/12 canaries right, lowest confidence 0\.96/);
});
