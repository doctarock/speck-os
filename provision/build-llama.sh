#!/usr/bin/env bash
# Build llama.cpp for one backend into /opt/llama.cpp/build-<backend>, from the source checkout
# provision.sh made (every backend builds the same commit). Used by provision.sh for the base
# workers and by speck-hwd for an eGPU.
#
#   build-llama.sh cpu|vulkan|cuda [--link]
#     --link  make this the base workers' build (/usr/local/bin + /etc/speck-os/llama-backend)
#
# LLAMA_PORTABLE=1 (image builds): no -march=native; every x86 CPU variant is built and the
# best one for the machine it runs on is picked at load time. A native build on the build host
# (e.g. with AVX-512) would die with "illegal instruction" on the 6950H.
set -euo pipefail
backend=${1:?usage: build-llama.sh cpu|vulkan|cuda [--link]}
SRC=/opt/llama.cpp/src
BUILD=/opt/llama.cpp/build-$backend
export DEBIAN_FRONTEND=noninteractive
[ -d "$SRC/.git" ] || { echo "no llama.cpp checkout at $SRC (run provision.sh first)" >&2; exit 1; }

flags=(-DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_TESTS=OFF)
if [ "${LLAMA_PORTABLE:-0}" = 1 ]; then
  flags+=(-DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON)
fi
case "$backend" in
  cpu) ;;
  vulkan)
    apt-get install -y --no-install-recommends libvulkan-dev glslc spirv-headers mesa-vulkan-drivers vulkan-tools
    flags+=(-DGGML_VULKAN=ON)
    ;;
  cuda)
    # Ubuntu 24.04's toolkit is CUDA 12.0: host compiler must be gcc <= 12, and it predates
    # Blackwell (RTX 50), where this build fails and the card stays on Vulkan.
    # NOT YET VERIFIED ON HARDWARE.
    apt-get install -y --no-install-recommends nvidia-cuda-toolkit g++-12
    flags+=(-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=native -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-12)
    ;;
  *) echo "unsupported backend: $backend" >&2; exit 2 ;;
esac

cmake -S "$SRC" -B "$BUILD" "${flags[@]}"
cmake --build "$BUILD" -j"$(nproc)" --target llama-server llama-bench llama-cli
"$BUILD/bin/llama-server" --version 2>&1 | head -3

if [ "${2:-}" = --link ]; then
  for bin in llama-server llama-bench llama-cli; do ln -sf "$BUILD/bin/$bin" "/usr/local/bin/$bin"; done
  install -d /etc/speck-os
  echo "$backend" > /etc/speck-os/llama-backend
fi
