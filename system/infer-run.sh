#!/usr/bin/env bash
# Entry point for infer@<name>: llama-server on the right build and device.
#
#   infer-run.sh <name>           run; settings come from the unit's environment files
#   infer-run.sh --check <name>   ExecCondition: the eGPU worker runs only on a card speck-hwd
#                                 confirmed this boot (a stale device index could land it on the
#                                 iGPU or the software rasteriser)
#
# Device pinning arrives as environment: GGML_VK_VISIBLE_DEVICES (Vulkan) or CUDA_VISIBLE_DEVICES.
set -euo pipefail
if [ "${1:-}" = --check ]; then
  if [ "${2:-}" = egpu ] && [ ! -f /run/speck-os/hw/egpu.ok ]; then
    echo "eGPU not confirmed this boot; speck-hwd will start it"
    exit 1
  fi
  exit 0
fi

: "${PORT:?}" "${MODEL_HF:?}" "${CTX:?}"
bin=/usr/local/bin/llama-server
[ -n "${LLAMA_BACKEND:-}" ] && bin=/opt/llama.cpp/build-$LLAMA_BACKEND/bin/llama-server
# A model baked into the image (tools/fetch-model.mjs) loads from disk; otherwise llama-server
# downloads it from Hugging Face into LLAMA_CACHE on first start.
model=(-hf "$MODEL_HF")
local_dir=${LLAMA_LOCAL_MODELS:-/var/lib/speck-infer/models/local}/$(printf '%s' "$MODEL_HF" | tr '/:' '__')
first=$(ls "$local_dir"/*.gguf 2>/dev/null | sort | head -1 || true)
[ -n "$first" ] && model=(-m "$first")
# EXTRA_ARGS is a list of flags, split on purpose.
# shellcheck disable=SC2086
exec "$bin" --host 127.0.0.1 --port "$PORT" "${model[@]}" -c "$CTX" ${EXTRA_ARGS:-}
