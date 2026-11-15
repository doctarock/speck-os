#!/usr/bin/env bash
# Runs in the builder container (image/build.sh): mkosi root tree → USB installer image.
#   /src   this repo (read-only)   /work  build volume (mkosi cache, outputs)   /out  results on the host
set -euo pipefail
mkdir -p /work/out /work/cache /work/ws /out
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
# A free loop device, creating its node if the container's /dev lacks it (no udev in containers).
loop_attach() {
  local dev
  dev=$(losetup -f)
  [ -b "$dev" ] || mknod "$dev" b 7 "${dev#/dev/loop}"
  losetup -P --show "$dev" "$1"
}

step "Root filesystem (mkosi)"
if [ "${REUSE_ROOT:-0}" = 1 ] && ls /work/out/speck-os*.tar* >/dev/null 2>&1; then
  echo "reusing the last root tree"
else
  mkosi -C /src/image --output-dir /work/out --cache-dir /work/cache --workspace-dir /work/ws \
    --environment "BAKE_MODELS=${BAKE_MODELS:-0}" -f build
fi
ROOT=$(ls -t /work/out/speck-os*.tar* | head -1)
echo "$ROOT ($(du -h "$ROOT" | cut -f1))"

step "USB installer image"
BYTES=$(zstd -dc "$ROOT" | wc -c)
GIB=$(( (BYTES * 13 / 10) / 1073741824 + 4 ))
[ "$GIB" -ge 8 ] || GIB=8
IMG=/work/out/speck-os-installer.img
rm -f "$IMG"
truncate -s "${GIB}G" "$IMG"
LOOP=$(loop_attach "$IMG")
trap 'losetup -d "$LOOP" 2>/dev/null || true' EXIT
/src/image/speck-install --target "$LOOP" --from-tar "$ROOT" --removable --installer-media --yes
losetup -d "$LOOP"; trap - EXIT
echo "image: ${GIB} GiB (root tree $((BYTES / 1000000)) MB)"
[ "$GIB" -le 14 ] || echo "warning: needs a USB stick larger than 16 GB"

step "Results"
NAME=speck-os-installer-$(date -u +%Y%m%d)
if [ "${COMPRESS:-1}" = 1 ]; then
  xz -T0 -3 -c "$IMG" > "/out/$NAME.img.xz"
  ( cd /out && sha256sum "$NAME.img.xz" > "$NAME.img.xz.sha256" )
else
  cp --sparse=always "$IMG" "/out/$NAME.img"
fi
cp "$ROOT" /out/
ls -la /out
