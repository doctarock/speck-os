#!/usr/bin/env bash
# Phase 4: offline voice. Installs speck-voice (local STT + TTS), the models it's configured for,
# and the kiosk launcher that puts it into the Speck page. Idempotent; provision.sh and phase1.sh
# call it, and it can be run on its own.
#
#   sudo ./provision/install-voice.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
. "$REPO/provision/lib-install.sh"

apt-get install -y --no-install-recommends bzip2 curl
inst_voice
inst_voice_models
inst_runtime_units   # kiosk launcher + Chrome policy (KIOSK defaults to 1)

systemctl daemon-reload
systemctl enable speck-voice.service
systemctl restart speck-voice.service
PORT=$(node -p 'require("/etc/speck-os/voice.json").port ?? 4320')
for _ in $(seq 1 60); do curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" && echo || echo "speck-voice: not healthy (journalctl -u speck-voice)"
# The page script is injected when Chrome starts: restart the kiosk to pick up changes.
systemctl is-active --quiet speck-kiosk.service && systemctl restart speck-kiosk.service || true
