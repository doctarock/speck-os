#!/usr/bin/env bash
# Build the Speck OS USB installer image, in Docker (Linux or Docker Desktop).
#
#   image/build.sh [--bake-models] [--no-compress] [--out <dir>] [--test] [--boot-test]
#
#   --bake-models   put the workers' models (~5 GB) in the image, so the first boot needs no internet
#   --no-compress   write a raw .img instead of .img.xz
#   --out <dir>     where results go (default image/out)
#   --test          then install the result onto blank disks and check them (image/test-install.sh)
#   --boot-test     also boot an installed disk in QEMU with Secure Boot (slow without KVM)
#   --reuse-root    skip mkosi and reuse the last root tree (when only the installer changed)
#
# Results: speck-os-installer-<date>.img.xz (flash it to a USB stick with any image writer) and the
# root tarball. Packages Speck first if dist/speck-src.tar.gz is missing.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=$REPO/image/out BAKE=0 COMPRESS=1 TEST=0 BOOT_TEST=0 REUSE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bake-models) BAKE=1; shift ;;
    --no-compress) COMPRESS=0; shift ;;
    --out) OUT=$2; shift 2 ;;
    --test) TEST=1; shift ;;
    --boot-test) TEST=1; BOOT_TEST=1; shift ;;
    --reuse-root) REUSE=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -f "$REPO/dist/speck-src.tar.gz" ] || "$REPO/tools/package-speck.sh"
mkdir -p "$OUT"

# Docker Desktop on Windows (Git Bash): give docker Windows paths and stop MSYS rewriting /src.
host() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
export MSYS_NO_PATHCONV=1

docker build -t speck-os-builder "$(host "$REPO/image/builder")"
docker volume create speck-os-build >/dev/null
docker run --rm --privileged \
  -v "$(host "$REPO"):/src:ro" -v speck-os-build:/work -v "$(host "$OUT"):/out" \
  -e BAKE_MODELS="$BAKE" -e COMPRESS="$COMPRESS" -e TEST="$TEST" -e BOOT_TEST="$BOOT_TEST" -e REUSE_ROOT="$REUSE" \
  speck-os-builder bash -c 'bash /src/image/build-inside.sh && { [ "$TEST" = 0 ] || bash /src/image/test-install.sh; }'
