#!/usr/bin/env bash
# Speck OS phase 0: turn a fresh Ubuntu 24.04 Server (minimized) into a Speck OS box.
# Idempotent; safe to re-run after changing config or the Speck tarball.
# (The installable image, image/, builds the same system from the same install steps.)
#
#   sudo ./provision/provision.sh dist/speck-src.tar.gz
#
# Env:
#   LLAMA_BACKEND=cpu|vulkan   (default cpu; the 6950H/680M will use vulkan)
#   LLAMA_REF=<git ref>        (default master; the commit actually built is recorded)
#   SKIP_KIOSK=1               (headless: Speck + workers only)
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
. /etc/os-release
[ "${ID}-${VERSION_ID}" = "ubuntu-24.04" ] || echo "warning: tested on ubuntu 24.04, this is ${PRETTY_NAME}"

REPO=$(cd "$(dirname "$0")/.." && pwd)
TARBALL=$(realpath "${1:?usage: provision.sh <speck-src.tar.gz>}")
LLAMA_BACKEND=${LLAMA_BACKEND:-cpu}
LLAMA_REF=${LLAMA_REF:-master}
KIOSK=1; [ "${SKIP_KIOSK:-0}" = 1 ] && KIOSK=0
export KIOSK
. "$REPO/provision/lib-install.sh"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "Packages"
inst_packages
inst_node
[ "$KIOSK" = 1 ] && inst_chrome

step "Users"
inst_users

step "llama.cpp ($LLAMA_BACKEND @ $LLAMA_REF)"
inst_llama "$LLAMA_BACKEND" "$LLAMA_REF"
LLAMA_COMMIT=$(git -C /opt/llama.cpp/src rev-parse --short HEAD)

step "Speck into slot A"
inst_speck_slot "$TARBALL"
SPECK_VERSION=$(cat "${TARBALL%.tar.gz}.version" 2>/dev/null || echo unknown)

step "Speck state + config"
inst_config
systemctl stop speck.service 2>/dev/null || true   # Speck rewrites its UI state; seed while it's down
seed_approvals

step "systemd units"
inst_runtime_units
systemctl daemon-reload
for w in worker intake toolcaller embed; do systemctl enable "infer@$w.service"; done
systemctl enable speck.service
if [ "$KIOSK" = 1 ]; then
  for dm in gdm3 gdm lightdm sddm; do systemctl disable --now "$dm" 2>/dev/null || true; done
  systemctl enable speck-kiosk.service
  systemctl set-default graphical.target
fi

cat > /etc/speck-os/versions <<EOF
speck-os phase0 provisioned $(date -u +%Y-%m-%dT%H:%M:%SZ)
$SPECK_VERSION
llama.cpp $LLAMA_COMMIT ($LLAMA_BACKEND)
node $(node --version)
chrome $(google-chrome-stable --version 2>/dev/null || echo none)
EOF

if [ "$KIOSK" = 1 ]; then
  step "Offline voice (speck-voice + kiosk launcher)"
  "$REPO/provision/install-voice.sh"
fi

step "NLI checker (speck-nli, int8 ONNX)"
"$REPO/provision/install-nli.sh"

WORKERS=(worker intake toolcaller embed)
step "Starting workers (first start downloads models)"
for w in "${WORKERS[@]}"; do systemctl restart "infer@$w.service"; done
for w in "${WORKERS[@]}"; do
  port=$(. "/etc/speck-os/workers/$w.env"; echo "$PORT")
  printf '  %-11s :%s ' "$w" "$port"
  for _ in $(seq 1 900); do
    curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$port/health" && { echo ready; continue 2; }
    systemctl is-failed --quiet "infer@$w.service" && { echo "FAILED (journalctl -u infer@$w)"; continue 2; }
    sleep 2
  done
  echo "timeout"
done

systemctl restart speck.service
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:4310/api/health && break
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:4310/api/health >/dev/null && echo "speck: healthy" || echo "speck: not healthy (journalctl -u speck)"

[ "$KIOSK" = 1 ] && systemctl restart speck-kiosk.service

step "Done"
cat /etc/speck-os/versions
