# Sourced by provision.sh and phase1.sh. Needs $REPO.
#
# The speck-os overlay (os-system plugin + speck-os profile) is applied to every Speck slot: here,
# and by the updater after each build. Refreshing it also refreshes the running slot, so new agent
# tools arrive without a Speck rebuild.
OVERLAY=/usr/lib/speck-os/overlay

install_overlay() {  # install_overlay [<slot dir to apply it to>...]
  rm -rf "$OVERLAY.new" && install -d "$OVERLAY.new/plugins/os-system" "$OVERLAY.new/profiles"
  install -m 0644 "$REPO/plugins/os-system/os-system-plugin.js" "$OVERLAY.new/plugins/os-system/"
  install -m 0644 "$REPO/config/profiles/speck-os.json" "$OVERLAY.new/profiles/"
  rm -rf "$OVERLAY" && mv "$OVERLAY.new" "$OVERLAY"
  local slot
  for slot in "$@"; do
    [ -d "$slot" ] || continue
    cp -a "$OVERLAY/." "$slot/"
    chown -R speck:speck "$slot/plugins/os-system" "$slot/profiles/speck-os.json"
  done
}

# Standing approval (System → Capabilities) for the os-system tools, so the agent administers the
# box without asking. Only fills in tools the user hasn't set either way.
seed_approvals() {
  local state=/var/lib/speck/genesis-runtime/genesis-ui-state.json
  install -d -o speck -g speck /var/lib/speck/genesis-runtime
  node --input-type=module -e '
    import fs from "node:fs";
    const file = process.argv[1];
    const { OS_SYSTEM_TOOLS: tools } = await import(process.argv[2]);
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    state.toolApprovals = { ...(state.toolApprovals || {}) };
    for (const t of tools) if (!(t in state.toolApprovals)) state.toolApprovals[t] = true;
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  ' "$state" "$OVERLAY/plugins/os-system/os-system-plugin.js"
  chown speck:speck "$state"
}
