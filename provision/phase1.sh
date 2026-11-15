#!/usr/bin/env bash
# Speck OS phase 1: give the agent root (speck-broker), snapshots before every change, and
# boot-level fallback to the last known good root. Run after provision.sh. Idempotent.
# Re-running it also ships the rest of the speck-os layer: the broker, self-update and recovery
# console (phase 2), speck-hwd (phase 3), offline voice (phase 4), the first-boot setup and installer
# pages (phase 5), and the os-system plugin's agent tools.
#
#   sudo ./provision/phase1.sh
#
# Disk requirements (choose these in the Ubuntu installer):
#   - root filesystem btrfs
#   - separate /boot on ext4 (GRUB must be able to write its boot counter)
# If root sits on the btrfs top level, the first run converts it to subvolume @ and asks
# for a reboot; run this script again afterwards.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
. "$REPO/provision/lib-install.sh"
TOP=/run/speck-btrfs
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

# ---------------------------------------------------------------- preconditions
step "Checking disk layout"
[ "$(findmnt -no FSTYPE /)" = btrfs ] || die "root is $(findmnt -no FSTYPE /), not btrfs. Reinstall with a btrfs root (see README)."
mountpoint -q /boot || die "/boot is not a separate partition. GRUB cannot write its boot counter on btrfs; reinstall with an ext4 /boot (see README)."
case "$(findmnt -no FSTYPE /boot)" in ext2|ext3|ext4) ;; *) die "/boot must be ext2/3/4";; esac

apt-get install -y --no-install-recommends btrfs-progs snapper rsync pciutils
ROOT_DEV=$(findmnt -no SOURCE / | sed 's/\[.*\]$//')
ROOT_UUID=$(findmnt -no UUID /)
mkdir -p "$TOP"
mountpoint -q "$TOP" || mount -o subvolid=5 "$ROOT_DEV" "$TOP"
SUBVOL=$(findmnt -no OPTIONS / | sed -n 's/.*subvol=\/\{0,1\}\([^,]*\).*/\1/p')

# ---------------------------------------------------------------- convert top-level root to @
if [ -z "$SUBVOL" ]; then
  if [ -d "$TOP/@" ]; then
    die "root is still the top level but @ exists: reboot first so the system starts from @, then re-run"
  fi
  step "Converting root to subvolume @ (one-time)"
  btrfs subvolume snapshot / "$TOP/@"
  # Root is chosen by the kernel's rootflags (GRUB adds subvol=@); fstab must not pin a subvolume.
  sed -i -E '/[[:space:]]\/[[:space:]]+btrfs[[:space:]]/ s/(,)?subvol(id)?=[^,[:space:]]*//g' "$TOP/@/etc/fstab"
  ID=$(btrfs subvolume list "$TOP" | awk '$NF=="@"{print $2}')
  btrfs subvolume set-default "$ID" "$TOP"
  echo
  echo "Root converted. Reboot now (sudo reboot), then run this script again."
  echo "The old top-level files stay until then; phase1 frees them on the next run."
  exit 0
fi
[ "$SUBVOL" = "@" ] || die "root is on subvolume '$SUBVOL'; expected @"

step "Finishing root on @"
# Stage B of the conversion: make GRUB pass rootflags=subvol=@, then return the default subvolume
# to the top level so names, not IDs, decide what boots (needed to promote @good later).
inst_grub
[ -f /boot/grub/grubenv ] || grub-editenv /boot/grub/grubenv create
update-grub
grep -q 'rootflags=subvol=@' /boot/grub/grub.cfg || die "update-grub did not add rootflags=subvol=@; not changing the default subvolume"
btrfs subvolume set-default 5 "$TOP"

# Leftover pre-conversion root files on the top level (everything not named @*).
LEFTOVER=$(find "$TOP" -mindepth 1 -maxdepth 1 ! -name '@*' | head -50)
if [ -n "$LEFTOVER" ]; then
  echo "Pre-conversion root files remain on the btrfs top level ($(echo "$LEFTOVER" | wc -l) entries)."
  if [ "${FREE_OLD_ROOT:-0}" = 1 ]; then
    find "$TOP" -mindepth 1 -maxdepth 1 ! -name '@*' -exec rm -rf {} +
    echo "Freed."
  else
    echo "Run again with FREE_OLD_ROOT=1 to delete them once you're happy the system boots from @."
  fi
fi

# ---------------------------------------------------------------- state subvolumes
# Agent state, models and snapshots live outside @, so rolling back the system never rolls back
# the agent's memory, re-downloads models, or loses snapshot history.
step "State subvolumes"
systemctl stop speck-kiosk.service speck.service 'infer@*.service' 2>/dev/null || true

migrate() {  # migrate <subvol> <mountpoint> <owner>
  local sv=$1 mp=$2 owner=$3
  if ! grep -q "subvol=$sv[,[:space:]]" /etc/fstab; then
    [ -d "$TOP/$sv" ] || btrfs subvolume create "$TOP/$sv"
    if [ -d "$mp" ] && [ -n "$(ls -A "$mp" 2>/dev/null)" ]; then
      rsync -aHAX "$mp/" "$TOP/$sv/"
      mv "$mp" "$mp.pre-subvol"
    fi
    mkdir -p "$mp"
    echo "UUID=$ROOT_UUID $mp btrfs subvol=$sv,defaults,noatime 0 0" >> /etc/fstab
  fi
  mountpoint -q "$mp" || mount "$mp"
  [ -n "$owner" ] && chown "$owner" "$mp"
  rm -rf "$mp.pre-subvol"
}
migrate @speck /var/lib/speck speck:speck
migrate @speck-infer /var/lib/speck-infer infer:infer
chattr +C /var/lib/speck-infer/models 2>/dev/null || true   # no COW for multi-GB model files

# ---------------------------------------------------------------- snapper
step "Snapper"
if ! snapper --jsonout list-configs | grep -q '"config": *"root"'; then
  # create-config makes /.snapshots a nested subvolume inside @; replace it with @snapshots so
  # snapshot history survives promoting @good to @.
  snapper -c root create-config /
  btrfs subvolume delete /.snapshots
  mkdir /.snapshots
fi
if ! grep -q "subvol=@snapshots[,[:space:]]" /etc/fstab; then
  [ -d "$TOP/@snapshots" ] || btrfs subvolume create "$TOP/@snapshots"
  echo "UUID=$ROOT_UUID /.snapshots btrfs subvol=@snapshots,defaults,noatime 0 0" >> /etc/fstab
fi
mountpoint -q /.snapshots || mount /.snapshots
chmod 750 /.snapshots
snapper -c root set-config NUMBER_LIMIT=60 NUMBER_LIMIT_IMPORTANT=10 TIMELINE_CREATE=no
systemctl disable --now snapper-timeline.timer 2>/dev/null || true
systemctl enable --now snapper-cleanup.timer

# ---------------------------------------------------------------- broker, speck-hwd, setup (phases 1–3, 5)
step "speck-broker"
# The kiosk side (launcher, Chrome policy, health units) only on boxes that have the kiosk.
KIOSK=0; systemctl is-enabled --quiet speck-kiosk.service 2>/dev/null && KIOSK=1
export KIOSK
inst_broker
inst_runtime_units
# Files the agent tunes: ship ours only once.
[ -f /etc/speck-os/update.json ] || install -m 0644 "$REPO/config/update.json" /etc/speck-os/update.json
[ -f /etc/speck-os/hwd.json ] || install -m 0644 "$REPO/config/hwd.json" /etc/speck-os/hwd.json
[ -f /etc/speck-os/llama-backend ] || readlink -f /usr/local/bin/llama-server | sed -n 's|.*/build-\([a-z]*\)/bin/.*|\1|p' > /etc/speck-os/llama-backend
# First-boot setup is for new installs from the image; a box provisioned by hand is already set up.
[ -f /var/lib/speck/.broker/setup.json ] || printf '{ "completedAt": "%s", "by": "phase1.sh" }\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /var/lib/speck/.broker/setup.json

# ---------------------------------------------------------------- agent tools
# Refresh the os-system plugin in the overlay and the running slot, and approve any new tools.
# Speck is stopped at this point (state subvolumes step), so it can't overwrite the approvals.
step "Agent tools (os-system plugin)"
. "$REPO/provision/lib-overlay.sh"
install_overlay "$(readlink -f /opt/speck/current)"
seed_approvals

systemctl daemon-reload
systemctl enable speck-broker.service speck-boot-ok.service speck-hwd.service
systemctl restart speck-broker.service
speck-broker hw-boot || echo "hw-boot failed; see journalctl -u speck-broker"

# ---------------------------------------------------------------- offline voice (phase 4)
if systemctl is-enabled --quiet speck-kiosk.service 2>/dev/null; then
  step "Offline voice"
  "$REPO/provision/install-voice.sh"
fi

# ---------------------------------------------------------------- NLI checker
step "NLI checker (speck-nli, int8 ONNX)"
"$REPO/provision/install-nli.sh" || echo "speck-nli install failed; Speck's checks stay void (as they are while no checker qualifies)"

# ---------------------------------------------------------------- bring it up
step "Starting services"
systemctl start 'infer@worker.service' 'infer@intake.service' 'infer@toolcaller.service' 'infer@embed.service'
systemctl restart speck.service
systemctl is-enabled --quiet speck-kiosk.service 2>/dev/null && systemctl restart speck-kiosk.service
for _ in $(seq 1 120); do curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:4310/api/health && break; sleep 1; done

step "First known-good root"
speck-broker mark-good || echo "mark-good failed; boot fallback is not armed yet (see above)"

echo "phase1 $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /etc/speck-os/versions
step "Done"
speck-broker status | head -60
