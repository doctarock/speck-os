#!/usr/bin/env bash
# Speck OS budget-tier probe: Ryzen 9 PRO 6950H (Rembrandt, Radeon 680M iGPU, gfx1035, no NPU).
# Measures what the architecture doc estimates: iGPU (Vulkan) prefill/generation, KV-cache cost,
# CPU STT real-time factor, and how much STT slows the LLM when both run at once.
#
# Needs: llama.cpp built with -DGGML_VULKAN=ON (llama-bench), whisper.cpp (whisper-cli),
#        a 4B GGUF, a whisper model, a 16 kHz mono wav, jq.
# Usage: LLM=qwen3-4b-q4_k_m.gguf WHISPER=ggml-small.en.bin WAV=sample.wav ./budget-probe.sh
set -euo pipefail

LLAMA_BENCH=${LLAMA_BENCH:-llama-bench}
WHISPER_CLI=${WHISPER_CLI:-whisper-cli}
LLM=${LLM:?set LLM to a 4B gguf}
WHISPER=${WHISPER:-}
WAV=${WAV:-}
STT_THREADS=${STT_THREADS:-4}          # cores left for STT/TTS/NLI on the budget tier
OUT=${OUT:-probe-$(hostname)-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"

log() { printf '\n== %s\n' "$*"; }

log "Hardware"
{
  lscpu | grep -E 'Model name|^CPU\(s\)|Thread|MHz'
  free -g
  dmidecode -t memory 2>/dev/null | grep -E 'Speed|Type:' | sort | uniq -c || echo "(run as root for memory speed)"
  lspci -nn | grep -Ei 'vga|display|3d|accel'
  uname -r
  vulkaninfo --summary 2>/dev/null | grep -E 'deviceName|driverName|apiVersion' || echo "vulkaninfo missing"
} | tee "$OUT/hardware.txt"

# GTT = system RAM the iGPU can map. Default is ~50% of RAM. Raise with amdgpu.gttsize / ttm.pages_limit if needed.
DRM=$(ls -d /sys/class/drm/card*/device 2>/dev/null | while read -r d; do [ -f "$d/mem_info_gtt_total" ] && echo "$d" && break; done)
if [ -n "${DRM:-}" ]; then
  echo "VRAM carve-out: $(( $(cat "$DRM/mem_info_vram_total") / 1048576 )) MiB" | tee -a "$OUT/hardware.txt"
  echo "GTT limit:      $(( $(cat "$DRM/mem_info_gtt_total") / 1048576 )) MiB" | tee -a "$OUT/hardware.txt"
fi

sample_mem() {  # background sampler: system used + iGPU VRAM/GTT used, 1 Hz
  while :; do
    used=$(free -m | awk '/Mem:/{print $3}')
    v=0; g=0
    if [ -n "${DRM:-}" ]; then v=$(( $(cat "$DRM/mem_info_vram_used") / 1048576 )); g=$(( $(cat "$DRM/mem_info_gtt_used") / 1048576 )); fi
    echo "$(date +%s) $used $v $g"
    sleep 1
  done
}

log "Idle baseline"
free -m | tee "$OUT/baseline.txt"

log "LLM on iGPU (Vulkan): prefill/gen at context depth 0, 4k, 12k; fp16 vs q8 KV"
sample_mem > "$OUT/mem-llm.log" & SAMPLER=$!
"$LLAMA_BENCH" -m "$LLM" -ngl 99 -fa 1 -p 512,2048 -n 128 -d 0,4096,12288 \
  -ctk f16,q8_0 -ctv f16,q8_0 -r 2 -o json > "$OUT/llm-igpu.json"
kill $SAMPLER
jq -r '.[] | "\(.type_k)\tdepth=\(.n_depth)\tp=\(.n_prompt)\tn=\(.n_gen)\t\(.avg_ts|floor) t/s"' "$OUT/llm-igpu.json" | tee "$OUT/llm-igpu.txt"

log "LLM on CPU only (comparison)"
"$LLAMA_BENCH" -m "$LLM" -ngl 0 -t 8 -p 512 -n 128 -r 2 -o json > "$OUT/llm-cpu.json"
jq -r '.[] | "cpu\tp=\(.n_prompt)\tn=\(.n_gen)\t\(.avg_ts|floor) t/s"' "$OUT/llm-cpu.json" | tee "$OUT/llm-cpu.txt"

if [ -n "$WHISPER" ] && [ -n "$WAV" ]; then
  AUDIO_S=$(soxi -D "$WAV" 2>/dev/null || ffprobe -v error -show_entries format=duration -of csv=p=0 "$WAV")

  stt() {  # prints wall seconds
    local t0 t1; t0=$(date +%s.%N)
    "$WHISPER_CLI" -m "$WHISPER" -f "$WAV" -t "$STT_THREADS" -np > /dev/null 2>&1
    t1=$(date +%s.%N); echo "$t1 - $t0" | bc
  }

  log "STT on CPU alone ($STT_THREADS threads)"
  S_ALONE=$(stt)
  echo "audio=${AUDIO_S}s wall=${S_ALONE}s RTF=$(echo "scale=3; $S_ALONE/$AUDIO_S" | bc)" | tee "$OUT/stt.txt"

  log "Contention: STT on CPU while the LLM generates on iGPU (barge-in worst case)"
  "$LLAMA_BENCH" -m "$LLM" -ngl 99 -fa 1 -p 0 -n 256 -r 3 -o json > "$OUT/llm-contended.json" &
  LLMPID=$!
  sleep 2
  S_BUSY=$(stt)
  wait $LLMPID
  echo "STT under load: wall=${S_BUSY}s RTF=$(echo "scale=3; $S_BUSY/$AUDIO_S" | bc)" | tee -a "$OUT/stt.txt"
  jq -r '.[] | "LLM gen while STT ran: \(.avg_ts|floor) t/s"' "$OUT/llm-contended.json" | tee -a "$OUT/stt.txt"
fi

log "Peak memory during LLM runs (MiB: system used / iGPU vram / gtt)"
sort -k2 -n "$OUT/mem-llm.log" | tail -1 | awk '{print "system="$2" vram="$3" gtt="$4}' | tee "$OUT/peak-mem.txt"

log "Done: results in $OUT/"
