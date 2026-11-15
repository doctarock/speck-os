#!/usr/bin/env bash
# NVIDIA eGPU driver for Ubuntu, run by speck-hwd through the broker (snapshotted).
#
# Canonical's server driver with Canonical-signed kernel modules: Secure Boot needs no MOK step.
# Compute only (the display stays on the iGPU), plus the Vulkan ICD so the card can serve on the
# Vulkan llama.cpp build while the CUDA build compiles. Takes effect after a reboot.
# NOT YET VERIFIED ON HARDWARE.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ubuntu-drivers-common
ver=$(ubuntu-drivers list --gpgpu 2>/dev/null | grep -o 'nvidia-driver-[0-9]*-server' | grep -o '[0-9]\+' | sort -n | tail -1)
[ -n "$ver" ] || { echo "ubuntu-drivers found no server driver for this card" >&2; exit 1; }
echo "installing NVIDIA ${ver}-server"
ubuntu-drivers install --gpgpu "nvidia:${ver}-server"
apt-get install -y --no-install-recommends \
  "nvidia-utils-${ver}-server" "libnvidia-compute-${ver}-server" "libnvidia-gl-${ver}-server"

# nouveau must not claim the card first.
printf 'blacklist nouveau\noptions nouveau modeset=0\n' > /etc/modprobe.d/speck-os-nouveau.conf
update-initramfs -u
