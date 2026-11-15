#!/usr/bin/env bash
# Record what speck-hwd reads on this machine, as a fixture the broker tests can replay
# (paths.sysfs / paths.proc point into it; the tool outputs feed the parsers).
#
#   sudo ./hwd/probe/capture-fixture.sh [name]     → hwd-fixture-<name>.tar.gz
#
# Run it on the budget box with and without the eGPU attached, and on any card you test.
set -euo pipefail
name=${1:-$(hostname)-$(date +%Y%m%d-%H%M)}
out=$(mktemp -d)/hwd-fixture-$name
mkdir -p "$out/sys/bus/pci/devices" "$out/proc" "$out/tools"

for dev in /sys/bus/pci/devices/*; do
  class=$(cat "$dev/class")
  case "$class" in 0x03*|0x1180*|0x1200*) ;; *) continue ;; esac
  d="$out/sys/bus/pci/devices/$(basename "$dev")"
  mkdir -p "$d"
  for f in uevent class vendor device boot_vga mem_info_vram_total mem_info_gtt_total current_link_speed current_link_width max_link_speed max_link_width; do
    [ -r "$dev/$f" ] && cat "$dev/$f" > "$d/$f" 2>/dev/null || true
  done
done
cp /proc/cpuinfo /proc/meminfo "$out/proc/"

run() { local file=$1; shift; { "$@" || echo "exit $?"; } > "$out/tools/$file" 2>&1 || true; }
run lspci.txt lspci -nnk
run vulkaninfo-summary.txt vulkaninfo --summary
run nvidia-smi.csv nvidia-smi --query-gpu=uuid,pci.bus_id,memory.total --format=csv,noheader,nounits
run llama-list-devices.txt llama-server --list-devices
for b in /opt/llama.cpp/build-*/bin/llama-server; do
  [ -x "$b" ] && run "llama-list-devices-$(basename "$(dirname "$(dirname "$b")")").txt" "$b" --list-devices
done
run uname.txt uname -a
[ -r /etc/os-release ] && cp /etc/os-release "$out/tools/"

tar -czf "hwd-fixture-$name.tar.gz" -C "$(dirname "$out")" "$(basename "$out")"
echo "wrote hwd-fixture-$name.tar.gz"
