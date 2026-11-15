#!/usr/bin/env bash
# Package Speck into dist/speck-src.tar.gz for provisioning and the image build.
#
# Default: a commit of the public Speck repository, so anyone can rebuild the same image.
#   SPECK_GIT=<url>   (default https://github.com/doctarock/Speck.git)
#   SPECK_REF=<ref>   (default main; the commit actually packaged is recorded)
#
# Development: SPECK=<dir> packages that local checkout's working tree instead, uncommitted
# work included. The version line then says so, and an image built from it isn't a release.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT="$HERE/dist"
mkdir -p "$OUT"
EXCLUDES=(--exclude=node_modules --exclude=./.git --exclude=./data --exclude=./dist
  --exclude='./failed work' --exclude=./recovery --exclude=./.eval)

if [ -n "${SPECK:-}" ]; then
  rev=$(git -C "$SPECK" rev-parse --short HEAD 2>/dev/null || echo "nogit")
  dirty=$(git -C "$SPECK" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  version="speck ${rev}$([ "$dirty" != 0 ] && echo "+dirty($dirty)") from local $(basename "$SPECK") (not a release) packaged $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tar -C "$SPECK" "${EXCLUDES[@]}" -czf "$OUT/speck-src.tar.gz" .
else
  url=${SPECK_GIT:-https://github.com/doctarock/Speck.git}
  ref=${SPECK_REF:-main}
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  git clone --quiet --filter=blob:none --no-checkout "$url" "$work/speck"
  git -C "$work/speck" checkout --quiet --detach "$ref" 2>/dev/null || git -C "$work/speck" checkout --quiet --detach "origin/$ref"
  rev=$(git -C "$work/speck" rev-parse --short HEAD)
  version="speck ${rev} (${url%.git} @ ${ref}) packaged $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Exactly the commit: git archive leaves out anything untracked or ignored.
  git -C "$work/speck" archive --format=tar.gz -o "$OUT/speck-src.tar.gz" HEAD
fi

echo "$version" > "$OUT/SPECK_VERSION"
cp "$OUT/SPECK_VERSION" "$OUT/speck-src.version"
echo "$version"
ls -lh "$OUT/speck-src.tar.gz"
