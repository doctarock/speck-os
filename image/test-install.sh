#!/usr/bin/env bash
# Installer test, in the builder container after build-inside.sh (image/build.sh --test):
#
#   1. tar → disk     speck-install --from-tar onto an empty disk, as an internal install
#   2. USB → disk     run the USB installer's own speck-install --from-running inside the built
#                     installer image, exactly as its Install screen does, onto another empty disk
#   3. boot (BOOT_TEST=1)  boot disk 2 in QEMU with UEFI Secure Boot (Microsoft keys enrolled):
#                     shim → signed GRUB → signed kernel → systemd → the setup page answers
#
# Each installed disk is checked for the layout boot rollback and setup depend on.
set -uo pipefail
OUT=/work/out
ROOT=$(ls -t $OUT/speck-os*.tar* | head -1)
MEDIA=$OUT/speck-os-installer.img
T=/work/test
mkdir -p "$T"
FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
expect() { local name=$1; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
LOOPS=()
# A free loop device, creating its node if the container's /dev lacks it (no udev in containers).
loop_attach() {
  local dev
  dev=$(losetup -f)
  [ -b "$dev" ] || mknod "$dev" b 7 "${dev#/dev/loop}"
  losetup -P --show "$dev" "$1"
}
cleanup() {
  for m in $(findmnt -rn -o TARGET | grep "^$T/" | sort -r); do umount -l "$m" 2>/dev/null; done
  for l in "${LOOPS[@]}"; do losetup -d "$l" 2>/dev/null; done
}
trap cleanup EXIT
newdisk() {  # newdisk <file> <GiB> → loop device
  rm -f "$1"; truncate -s "${2}G" "$1"
  local l; l=$(loop_attach "$1"); LOOPS+=("$l"); echo "$l"
}
node_for() {  # partition device nodes (no udev in containers)
  local l=$1 n
  for n in 1 2 3; do
    [ -b "${l}p$n" ] || mknod "${l}p$n" b "$(cut -d: -f1 /sys/class/block/$(basename "$l")p$n/dev)" "$(cut -d: -f2 /sys/class/block/$(basename "$l")p$n/dev)"
  done
}
mount_disk() {  # mount_disk <loop> <dir>: the installed layout, read-write
  local l=$1 d=$2
  node_for "$l"
  mkdir -p "$d/top" "$d/root"
  mount -o subvolid=5 "${l}p3" "$d/top"
  mount -o subvol=@ "${l}p3" "$d/root"
  mount "${l}p2" "$d/root/boot"
  mount "${l}p1" "$d/root/boot/efi"
  mount -o subvol=@speck "${l}p3" "$d/root/var/lib/speck"
  mount -o subvol=@speck-infer "${l}p3" "$d/root/var/lib/speck-infer"
}
umount_disk() { for m in $(findmnt -rn -o TARGET | grep "^$1/" | sort -r); do umount -l "$m"; done; }

verify() {  # verify <dir> <label> <media 0|1>
  local d=$1 label=$2 media=$3 r=$1/root
  echo "-- $label"
  for sv in @ @speck @speck-infer @snapshots; do expect "$label: subvolume $sv" btrfs subvolume show "$d/top/$sv"; done
  expect "$label: fstab mounts @speck by UUID" grep -q "subvol=@speck," "$r/etc/fstab"
  expect "$label: root has no pinned subvolume (GRUB picks @ or @good)" bash -c "! grep -E '\s/\s+btrfs' '$r/etc/fstab' | grep -q subvol="
  expect "$label: grub.cfg boots subvolume @" grep -q "rootflags=subvol=@" "$r/boot/grub/grub.cfg"
  expect "$label: grub.cfg finds root by UUID, not a device name" bash -c "grep -q 'root=UUID=' '$r/boot/grub/grub.cfg' && ! grep -q 'root=/dev/' '$r/boot/grub/grub.cfg'"
  grep -n 'root=/dev/' "$r/boot/grub/grub.cfg" | head -5
  expect "$label: kernel and initrd on /boot" bash -c "ls '$r'/boot/vmlinuz-* && ls '$r'/boot/initrd.img-*"
  expect "$label: grubenv on ext4 /boot" test -f "$r/boot/grub/grubenv"
  expect "$label: shim at the firmware fallback path" test -f "$r/boot/efi/EFI/BOOT/BOOTX64.EFI"
  expect "$label: signed GRUB + config stub under EFI/ubuntu" bash -c "test -f '$r/boot/efi/EFI/ubuntu/grubx64.efi' && test -f '$r/boot/efi/EFI/ubuntu/grub.cfg'"
  expect "$label: fresh machine-id" test ! -s "$r/etc/machine-id"
  expect "$label: snapper config for /" grep -q '^SUBVOLUME="/"' "$r/etc/snapper/configs/root"
  expect "$label: broker, setup page and installer present" bash -c "test -f '$r/usr/lib/speck-os/broker/setup/index.html' && test -x '$r/usr/lib/speck-os/speck-install'"
  # current and /usr/local/bin links are absolute: resolve them inside the installed tree.
  expect "$label: Speck slot built and current" bash -c "test -f '$r/opt/speck/slots/a/dist/server.js' && [ \"\$(readlink '$r/opt/speck/current')\" = /opt/speck/slots/a ]"
  expect "$label: llama-server built and linked" bash -c "test -x '$r/opt/llama.cpp/build-vulkan/bin/llama-server' && [ \"\$(readlink '$r/usr/local/bin/llama-server')\" = /opt/llama.cpp/build-vulkan/bin/llama-server ]"
  expect "$label: voice models in @speck-infer" bash -c "ls '$r'/var/lib/speck-infer/voice/ | grep -q kroko"
  expect "$label: kiosk + broker + workers enabled" bash -c "test -L '$r/etc/systemd/system/graphical.target.wants/speck-kiosk.service' && test -L '$r/etc/systemd/system/multi-user.target.wants/speck-broker.service' && test -L '$r/etc/systemd/system/multi-user.target.wants/infer@worker.service'"
  expect "$label: NetworkManager owns the network" bash -c "test -L '$r/etc/systemd/system/multi-user.target.wants/NetworkManager.service' && test ! -e '$r/etc/systemd/system/multi-user.target.wants/systemd-networkd.service' && test ! -e '$r/etc/systemd/system/network-online.target.wants/systemd-networkd-wait-online.service'"
  expect "$label: NLI checker model built and verified against fp32" bash -c "test -f '$r/var/lib/speck-infer/nli/MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli/onnx/model_quantized.onnx' && test -f '$r/var/lib/speck-infer/nli/MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli/.verified' && test ! -e '$r/var/lib/speck-infer/nli/MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli/onnx/model.onnx'"
  expect "$label: speck-nli enabled" test -L "$r/etc/systemd/system/multi-user.target.wants/speck-nli.service"
  expect "$label: no unattended apt upgrades" test ! -e "$r/etc/systemd/system/timers.target.wants/apt-daily-upgrade.timer"
  expect "$label: llama.cpp built portable (CPU variants)" bash -c "ls '$r'/opt/llama.cpp/build-vulkan/bin/libggml-cpu-*.so | grep -q haswell"
  expect "$label: kiosk browser is Chromium, locked down by policy" bash -c "test -x '$r/usr/lib/chromium/chromium' && test -f '$r/etc/chromium/policies/managed/speck-os.json'"
  expect "$label: no Google Chrome (not redistributable)" bash -c "test ! -e '$r/opt/google/chrome' && test ! -e '$r/etc/apt/sources.list.d/google-chrome.list'"
  expect "$label: xtradeb PPA limited to Chromium" grep -q "Pin-Priority: 1$" "$r/etc/apt/preferences.d/xtradeb-chromium"
  expect "$label: Vulkan backend built" bash -c "ls '$r'/opt/llama.cpp/build-vulkan/bin/ | grep -q ggml-vulkan"
  if [ "$media" = 1 ]; then
    expect "$label: installer flag set" test -f "$r/etc/speck-os/installer"
    expect "$label: no boot counter on the stick" test ! -x "$r/etc/grub.d/09_speck-bootcount"
  else
    expect "$label: not in installer mode" test ! -e "$r/etc/speck-os/installer"
    expect "$label: boot counter in grub.cfg" grep -q speck_try "$r/boot/grub/grub.cfg"
    expect "$label: setup will run at first boot" test ! -e "$r/var/lib/speck/.broker/setup.json"
  fi
}

# ---------------------------------------------------------------- 1. tar → disk
echo "== 1. speck-install --from-tar"
D1=$(newdisk "$T/disk1.img" 32)
/src/image/speck-install --target "$D1" --from-tar "$ROOT" --yes > "$T/install1.log" 2>&1 && pass "install from tar" || { fail "install from tar"; tail -30 "$T/install1.log"; }
mount_disk "$D1" "$T/d1" && verify "$T/d1" "tar install" 0
umount_disk "$T/d1"

# ---------------------------------------------------------------- 2. USB → disk
echo "== 2. the USB installer installs itself (--from-running)"
M=$(loop_attach "$MEDIA"); LOOPS+=("$M")
mount_disk "$M" "$T/media"
mount -o subvol=@snapshots "${M}p3" "$T/media/root/.snapshots"
verify "$T/media" "installer media" 1
D2=$(newdisk "$T/disk2.img" 32)
node_for "$D2" 2>/dev/null || true
for x in dev proc sys run; do mount --rbind "/$x" "$T/media/root/$x"; mount --make-rslave "$T/media/root/$x"; done
chroot "$T/media/root" /usr/lib/speck-os/speck-install --from-running --target "$D2" --yes > "$T/install2.log" 2>&1 \
  && pass "install from the running installer" || { fail "install from the running installer"; tail -30 "$T/install2.log"; }
expect "progress reported for the setup page" grep -q "^@@ 100 Installed" "$T/install2.log"
expect "progress climbs while copying" bash -c "grep -c '^@@ [0-9]* Copying' '$T/install2.log' | awk '\$1 > 5 {ok=1} END {exit !ok}'"
umount_disk "$T/media"
mount_disk "$D2" "$T/d2" && verify "$T/d2" "USB install" 0
umount_disk "$T/d2"

# ---------------------------------------------------------------- 3. Secure Boot
if [ "${BOOT_TEST:-0}" = 1 ]; then
  echo "== 3. boot the USB-installed disk: UEFI Secure Boot, Microsoft keys"
  # Serial console for the test only, so the boot can be followed.
  mount_disk "$D2" "$T/d2"
  echo 'GRUB_CMDLINE_LINUX="$GRUB_CMDLINE_LINUX console=ttyS0,115200 ignore_loglevel"' > "$T/d2/root/etc/default/grub.d/zz-test-serial.cfg"
  # The broker listens on the VM's loopback only (as it should), out of QEMU's port forwarding's
  # reach; a test-only unit reports what it serves over the serial console instead.
  cat > "$T/d2/root/etc/systemd/system/speck-test-probe.service" <<'UNIT'
[Unit]
Description=Installer test probe (test images only)
After=speck-broker.service
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'for i in $(seq 1 600); do s=$(curl -fsS --max-time 3 http://127.0.0.1:4399/api/setup/needed) && break; sleep 2; done; h=down; for i in $(seq 1 300); do h=$(curl -fsS --max-time 3 http://127.0.0.1:4310/api/health) && break; h=down; sleep 2; done; f=$(systemctl --failed --no-legend --plain | cut -d" " -f1 | tr "\\n" " "); n=down; for i in $(seq 1 60); do curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:8765/health && { n=up; break; }; sleep 2; done; k=down; for i in $(seq 1 60); do pgrep -u speck-ui -f "/usr/lib/chromium/chromium .*--kiosk" >/dev/null && { k=up; break; }; sleep 2; done; echo "SPECK-TEST setup=$s speck=$h nli=$n kiosk=$k failed=[$f]" > /dev/ttyS0'
[Install]
WantedBy=multi-user.target
UNIT
  ln -sf /etc/systemd/system/speck-test-probe.service "$T/d2/root/etc/systemd/system/multi-user.target.wants/speck-test-probe.service"
  for x in dev proc sys run; do mount --rbind "/$x" "$T/d2/root/$x"; mount --make-rslave "$T/d2/root/$x"; done
  # As speck-install does: without udev, GRUB only writes root=UUID= if the by-uuid link exists.
  mkdir -p /dev/disk/by-uuid
  ln -sf "${D2}p3" "/dev/disk/by-uuid/$(blkid -s UUID -o value "${D2}p3")"
  chroot "$T/d2/root" update-grub >/dev/null 2>&1
  umount_disk "$T/d2"
  losetup -d "$D2"
  cp /usr/share/OVMF/OVMF_VARS_4M.ms.fd "$T/vars.fd"
  timeout "${BOOT_TIMEOUT:-1500}" qemu-system-x86_64 -machine q35,smm=on -m 6144 -smp 4 -nographic \
    -global driver=cfi.pflash01,property=secure,value=on \
    -drive if=pflash,format=raw,unit=0,file=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd,readonly=on \
    -drive if=pflash,format=raw,unit=1,file="$T/vars.fd" \
    -drive file="$T/disk2.img",format=raw,if=virtio \
    -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
    > "$T/boot.log" 2>&1 &
  QEMU=$!
  ok=0
  for _ in $(seq 1 "${BOOT_TIMEOUT:-1500}"); do
    if grep -q "SPECK-TEST setup=" "$T/boot.log"; then ok=1; break; fi
    kill -0 $QEMU 2>/dev/null || break
    sleep 1
  done
  grep -q "Secure boot enabled" "$T/boot.log" && pass "kernel reports Secure Boot enabled" || fail "kernel reports Secure Boot enabled"
  probe=$(grep -a "SPECK-TEST" "$T/boot.log" | tail -1)
  echo "  $probe"
  [ "$ok" = 1 ] || { fail "booted far enough to report"; tail -40 "$T/boot.log"; }
  echo "$probe" | grep -q '"needed":true' && pass "booted; first-boot setup is waiting on :4399" || fail "first-boot setup served"
  echo "$probe" | grep -q 'speck={"ok":true}' && pass "Speck is up and healthy (no models yet)" || fail "Speck healthy"
  echo "$probe" | grep -qE 'failed=\[ *\]' && pass "no failed units" || fail "no failed units"
  echo "$probe" | grep -q 'nli=up' && pass "NLI checker service up" || fail "NLI checker service up"
  echo "$probe" | grep -q 'kiosk=up' && pass "Chromium kiosk running" || fail "Chromium kiosk running"
  kill $QEMU 2>/dev/null; wait $QEMU 2>/dev/null
fi

echo
[ "$FAILS" = 0 ] && echo "all installer checks passed" || echo "$FAILS installer checks failed"
exit "$FAILS"
