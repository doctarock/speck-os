#!/usr/bin/env bash
# Package the Speck working tree (including uncommitted work and vendor/genesis-runtime)
# into dist/speck-src.tar.gz for provisioning. Run on the dev machine (Git Bash is fine).
set -euo pipefail

SPECK=${SPECK:-/e/AI/Speck}
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT="$HERE/dist"
mkdir -p "$OUT"

rev=$(git -C "$SPECK" rev-parse --short HEAD 2>/dev/null || echo "nogit")
dirty=$(git -C "$SPECK" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
version="speck ${rev}$([ "$dirty" != 0 ] && echo "+dirty($dirty)") packaged $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "$version" > "$OUT/SPECK_VERSION"

tar -C "$SPECK" \
  --exclude=node_modules \
  --exclude=./.git \
  --exclude=./data \
  --exclude=./dist \
  --exclude='./failed work' \
  --exclude=./recovery \
  --exclude=./.eval \
  -czf "$OUT/speck-src.tar.gz" .

cp "$OUT/SPECK_VERSION" "$OUT/speck-src.version"
echo "$version"
ls -lh "$OUT/speck-src.tar.gz"
