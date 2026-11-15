#!/usr/bin/env bash
# Build the NLI checker model speck-nli serves: the fp32 ONNX graph and tokenizer at a pinned
# revision → weight-only 8-bit (quantize.py) → checked against fp32 on Speck's qualification
# corpus (verify.mjs; any disagreement fails the build) → only the int8 graph is kept.
#
#   build-model.sh <models dir> [<Speck's src/metacognition/qualification.ts>]
#
# Needs python3-venv (onnx + onnxruntime go into a throwaway venv) and speck-nli's node_modules.
# Downloads ~1.8 GB; leaves ~1.05 GB.
set -euo pipefail
NAME=MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli   # MIT
REVISION=b3546ea6b0346eb6f8d5d68b13c7dc6d0376b3d7
MODELS=${1:?usage: build-model.sh <models dir> [<qualification.ts>]}
CORPUS=${2:-/opt/speck/current/src/metacognition/qualification.ts}
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=$MODELS/$NAME

if [ -f "$DEST/onnx/model_quantized.onnx" ] && [ -f "$DEST/.verified" ]; then
  echo "$NAME: already built"; exit 0
fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/model/$NAME/onnx"
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json added_tokens.json onnx/model.onnx; do
  echo "downloading $f"
  curl -fsSL --retry 3 -o "$WORK/model/$NAME/$f" "https://huggingface.co/$NAME/resolve/$REVISION/$f"
done

python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q onnx==1.17.0 onnxruntime==1.23.2
"$WORK/venv/bin/python" "$HERE/quantize.py" "$WORK/model/$NAME/onnx/model.onnx" "$WORK/model/$NAME/onnx/model_quantized.onnx"

node "$HERE/verify.mjs" "$WORK/model" "$NAME" "$CORPUS"

rm "$WORK/model/$NAME/onnx/model.onnx"
echo "$REVISION weight-only-8bit verified $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WORK/model/$NAME/.verified"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mv "$WORK/model/$NAME" "$DEST"
echo "$NAME: built into $DEST"
