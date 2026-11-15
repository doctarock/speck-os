// NLI cross-encoder on ONNX Runtime (CPU): premise + hypothesis → entailment / contradiction /
// neutral. The only module that touches transformers.js; the server takes classifiers with the
// same shape, so tests use fakes.
import path from "node:path";

/** Map a model's class name onto Speck's three labels (as Speck's Python sidecar does). */
export function speckLabel(label) {
  const l = String(label).toLowerCase();
  if (l.startsWith("entail")) return "entailment";
  if (l.startsWith("contra")) return "contradiction";
  if (l.startsWith("neutral") || l.startsWith("not_entail")) return "neutral";
  return null;
}

export function softmax(values) {
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

/** Scores and label from logits, given the model's id2label. */
export function verdict(logits, id2label) {
  const probabilities = softmax(Array.from(logits));
  const scores = {};
  probabilities.forEach((p, i) => {
    const label = speckLabel(id2label[i] ?? id2label[String(i)]);
    if (label) scores[label] = p;
  });
  const label = Object.keys(scores).reduce((best, key) => (scores[key] > scores[best] ? key : best));
  return { label, scores };
}

/**
 * Pairs any sound NLI model gets right with near certainty. A model is served only after it
 * passes them, which catches a mis-quantized graph before Speck ever sees a verdict from it.
 * The int8 file published with DeBERTa-v3-large-mnli-fever-anli-ling-wanli (dynamic int8)
 * gets 9/12, with 0.02 as its lowest confidence in the right answer; the weight-only 8-bit
 * graph tools/build-model.sh makes gets 12/12, lowest 0.989.
 */
export const CANARIES = [
  ["The cat is sleeping on the sofa.", "An animal is on the sofa.", "entailment"],
  ["Maria locked the front door before she left.", "The front door was locked when Maria left.", "entailment"],
  ["The meeting was moved from Monday to Wednesday.", "The meeting now takes place on Wednesday.", "entailment"],
  ["All twelve students passed the exam.", "Every student passed.", "entailment"],
  ["The store closes at 9 pm every day.", "The store is open all night.", "contradiction"],
  ["The patient's fever had gone by the time she was discharged.", "The patient still had a fever when she was discharged.", "contradiction"],
  ["Tom has never been to France.", "Tom visited Paris last year.", "contradiction"],
  ["The glass is completely empty.", "The glass is full of water.", "contradiction"],
  ["The man is reading a newspaper on the train.", "The man is going to work.", "neutral"],
  ["She bought a new laptop yesterday.", "The laptop was expensive.", "neutral"],
  ["The concert started at eight.", "The band played for three hours.", "neutral"],
  ["A child is playing in the park.", "The child's mother is watching.", "neutral"]
];

export class SelfCheckError extends Error {}

/**
 * Lazily loaded classifier for one model directory (Hugging Face layout, int8 graph at
 * onnx/model_quantized.onnx). Inference is serialised: one check at a time, at a bounded
 * thread count, so it never takes the whole CPU from speech. Before its first verdict it must
 * pass the canaries: every one right, each with at least `minConfidence` in the right answer.
 * A model that fails is refused until the service restarts (it won't get better on retry).
 */
export function createClassifier({ name, modelsDir, threads = 2, dtype = "q8", transformers, selfCheck = { minConfidence: 0.9 } }) {
  let loading = null;
  let refused = null;
  let queue = Promise.resolve();
  let check = null;

  async function infer(state, premise, hypothesis) {
    const inputs = await state.tokenizer(premise, { text_pair: hypothesis, truncation: true });
    const { logits } = await state.model(inputs);
    return verdict(logits.data, state.id2label);
  }

  async function load() {
    if (refused) throw refused;
    loading ??= (async () => {
      const t = transformers ?? (await import("@huggingface/transformers"));
      t.env.allowRemoteModels = false;
      t.env.localModelPath = modelsDir.endsWith(path.sep) || modelsDir.endsWith("/") ? modelsDir : `${modelsDir}/`;
      const options = { dtype, device: "cpu", session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } };
      const [tokenizer, model] = await Promise.all([
        t.AutoTokenizer.from_pretrained(name),
        t.AutoModelForSequenceClassification.from_pretrained(name, options)
      ]);
      const id2label = model.config.id2label;
      const labels = Object.values(id2label).map(speckLabel).filter(Boolean).sort();
      if (labels.join() !== "contradiction,entailment,neutral") {
        throw new Error(`${name} does not have entailment, contradiction and neutral classes: ${JSON.stringify(id2label)}`);
      }
      const state = { tokenizer, model, id2label };
      if (selfCheck) {
        let right = 0;
        let lowest = 1;
        for (const [premise, hypothesis, want] of CANARIES) {
          const result = await infer(state, premise, hypothesis);
          if (result.label === want) right++;
          lowest = Math.min(lowest, result.scores[want] ?? 0);
        }
        check = { right, total: CANARIES.length, lowestConfidence: Number(lowest.toFixed(4)), passed: right === CANARIES.length && lowest >= selfCheck.minConfidence };
        if (!check.passed) {
          throw new SelfCheckError(`${name} failed its self-check (${right}/${CANARIES.length} canaries right, lowest confidence ${check.lowestConfidence}): `
            + "the graph is probably mis-quantized. The int8 file published on Hugging Face for this model is; build one with nli/tools/build-model.sh");
        }
      }
      return state;
    })();
    try {
      return await loading;
    } catch (error) {
      loading = null;
      if (error instanceof SelfCheckError) refused = error;   // a bad graph stays bad
      throw error;   // otherwise a later request may retry (e.g. after the model is installed)
    }
  }

  function classify(premise, hypothesis) {
    const run = queue.then(async () => infer(await load(), premise, hypothesis));
    queue = run.catch(() => {});
    return run;
  }

  return {
    name, classify,
    load: () => load().then(() => true),
    loaded: () => loading !== null && !refused,
    status: () => ({ loaded: loading !== null && !refused, selfCheck: check, refused: refused?.message ?? null })
  };
}
