#!/usr/bin/env bash
# The NLI checker as int8 ONNX on the CPU (speck-nli on :8765, the port Speck's Python sidecar used).
# Builds the model from the pinned fp32 graph and refuses it unless it matches fp32 on Speck's
# qualification corpus. Idempotent; provision.sh and phase1.sh call it.
#
#   sudo ./provision/install-nli.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
. "$REPO/provision/lib-install.sh"

apt-get install -y --no-install-recommends python3-venv curl
inst_nli
inst_nli_model
systemctl daemon-reload
systemctl enable speck-nli.service
systemctl restart speck-nli.service
for _ in $(seq 1 30); do curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:8765/health && break; sleep 1; done
curl -fsS --max-time 2 http://127.0.0.1:8765/health && echo || echo "speck-nli: not healthy (journalctl -u speck-nli)"
