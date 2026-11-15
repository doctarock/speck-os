# Sourced by provision.sh, phase1.sh, install-voice.sh and the image build (image/mkosi.postinst.chroot).
# Needs $REPO. Every function here only installs packages and files: none of them starts,
# stops or waits for a service, so they work the same on a running box and in an image chroot.
# (`systemctl enable` works offline: it only writes symlinks.)
export DEBIAN_FRONTEND=noninteractive
. "$REPO/provision/lib-overlay.sh"

inst_packages() {  # base packages; KIOSK=0 leaves out the screen side
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git jq build-essential cmake pkg-config python3 psmisc rsync \
    libcurl4-openssl-dev libssl-dev libsecret-1-dev pciutils bzip2 zstd python3-venv \
    btrfs-progs snapper \
    fonts-noto-core fonts-noto-color-emoji
  if [ "${KIOSK:-1}" = 1 ]; then
    apt-get install -y --no-install-recommends cage pipewire pipewire-pulse wireplumber
  fi
}

inst_node() {  # Node.js 22 from NodeSource
  node --version 2>/dev/null | grep -q '^v22\.' && return 0
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
}

XTRADEB_KEY=5301FA4FD93244FBC6F6149982BB6851C64F6880

inst_browser() {  # the kiosk browser. BROWSER=chromium (default) | chrome
  # Chromium as a .deb: Ubuntu 24.04 only ships it as a snap, which doesn't suit an image.
  # It comes from the xtradeb PPA, built for 24.04. The pin limits that PPA to the Chromium
  # packages, so it can never replace anything else on the box.
  #
  # BROWSER=chrome installs Google Chrome instead, which adds Google's online speech
  # recognition as a fallback. Google's terms don't allow redistributing Chrome, so only use
  # it on a box you provision for yourself, never in an image you publish.
  if [ "${BROWSER:-chromium}" = chrome ]; then
    if [ ! -f /usr/share/keyrings/google-chrome.gpg ]; then
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
    fi
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list
    apt-get update
    apt-get install -y google-chrome-stable
    return
  fi
  if [ ! -f /usr/share/keyrings/xtradeb.gpg ]; then
    curl -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x$XTRADEB_KEY" | gpg --dearmor -o /usr/share/keyrings/xtradeb.gpg
    gpg --show-keys --with-colons /usr/share/keyrings/xtradeb.gpg | grep -q "^fpr:*$XTRADEB_KEY:" \
      || { echo "xtradeb key fingerprint mismatch" >&2; rm -f /usr/share/keyrings/xtradeb.gpg; return 1; }
  fi
  echo "deb [signed-by=/usr/share/keyrings/xtradeb.gpg] https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu noble main" \
    > /etc/apt/sources.list.d/xtradeb.list
  cat > /etc/apt/preferences.d/xtradeb-chromium <<'EOF'
Package: *
Pin: release o=LP-PPA-xtradeb-apps
Pin-Priority: 1

Package: chromium chromium-common chromium-sandbox chromium-l10n chromium-driver
Pin: release o=LP-PPA-xtradeb-apps
Pin-Priority: 700
EOF
  apt-get update
  apt-get install -y --no-install-recommends chromium
}

browser_version() {
  chromium --version 2>/dev/null || google-chrome-stable --version 2>/dev/null || echo none
}

inst_users() {
  id speck >/dev/null 2>&1 || useradd --system --home-dir /var/lib/speck --create-home --shell /usr/sbin/nologin speck
  id infer >/dev/null 2>&1 || useradd --system --home-dir /var/lib/speck-infer --create-home --shell /usr/sbin/nologin infer
  usermod -aG video,render infer
  if [ "${KIOSK:-1}" = 1 ]; then
    id speck-ui >/dev/null 2>&1 || useradd --home-dir /var/lib/speck-ui --create-home --shell /bin/bash speck-ui
    usermod -aG video,render,audio,input speck-ui
  fi
}

inst_llama() {  # inst_llama <cpu|vulkan> [<git ref>]: checkout + build, linked as the base workers' build
  local backend=$1 ref=${2:-master}
  install -d /opt/llama.cpp /usr/lib/speck-os
  # A large repo over a long-lived connection: retry, so one dropped transfer doesn't fail the build.
  local try
  for try in 1 2 3; do
    [ -d /opt/llama.cpp/src/.git ] || git clone https://github.com/ggml-org/llama.cpp /opt/llama.cpp/src || { rm -rf /opt/llama.cpp/src; sleep 10; continue; }
    git -C /opt/llama.cpp/src fetch --tags origin && break
    sleep 10
  done
  [ -d /opt/llama.cpp/src/.git ] || { echo "llama.cpp clone failed 3 times" >&2; return 1; }
  git -C /opt/llama.cpp/src checkout --detach "$ref" 2>/dev/null || git -C /opt/llama.cpp/src checkout --detach "origin/$ref"
  # Same script speck-hwd uses to build an eGPU backend later.
  install -m 0755 "$REPO/provision/build-llama.sh" /usr/lib/speck-os/build-llama.sh
  /usr/lib/speck-os/build-llama.sh "$backend" --link
  install -d -o infer -g infer /var/lib/speck-infer /var/lib/speck-infer/models
}

inst_speck_slot() {  # inst_speck_slot <speck-src.tar.gz>: build Speck into slot a, make it current
  local tarball=$1 slot=/opt/speck/slots/a
  rm -rf "$slot.new" && mkdir -p "$slot.new"
  tar -xzf "$tarball" -C "$slot.new"
  ( cd "$slot.new/vendor/genesis-runtime" && npm install --omit=dev --no-audit --no-fund )
  ( cd "$slot.new" && npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund )
  # Speck OS additions travel with every slot (the updater applies the same overlay).
  install_overlay "$slot.new"
  rm -rf "$slot" && mv "$slot.new" "$slot"
  mkdir -p /opt/speck/slots/b
  ln -sfn "$slot" /opt/speck/current
  chown -R speck:speck /opt/speck/slots
}

inst_config() {  # /etc/speck-os; files the agent or user tunes are shipped only once
  install -d /etc/speck-os /etc/speck-os/workers
  install -m 0644 "$REPO/config/speck.env" /etc/speck-os/speck.env
  install -m 0644 "$REPO"/config/workers/*.env /etc/speck-os/workers/
  [ -f /etc/speck-os/update.json ] || install -m 0644 "$REPO/config/update.json" /etc/speck-os/update.json
  [ -f /etc/speck-os/hwd.json ] || install -m 0644 "$REPO/config/hwd.json" /etc/speck-os/hwd.json
  install -d -o speck -g speck /var/lib/speck /var/lib/speck/genesis-runtime
  # Seed the model configuration once; afterwards Speck (System → Brains) owns it.
  if [ ! -f /var/lib/speck/genesis-runtime/model-processors.json ]; then
    install -o speck -g speck -m 0644 "$REPO/config/model-processors.json" /var/lib/speck/genesis-runtime/model-processors.json
  fi
}

inst_runtime_units() {  # Speck + workers (+ kiosk session when KIOSK=1)
  install -d /usr/lib/speck-os
  install -m 0644 "$REPO/system/systemd/speck.service" "$REPO/system/systemd/infer@.service" /etc/systemd/system/
  install -m 0755 "$REPO/system/infer-run.sh" /usr/lib/speck-os/infer-run.sh
  if [ "${KIOSK:-1}" = 1 ]; then
    install -m 0644 "$REPO/system/systemd/speck-kiosk.service" /etc/systemd/system/
    install -m 0644 "$REPO/system/pam.d/speck-kiosk" /etc/pam.d/speck-kiosk
    install -m 0755 "$REPO/shell/kiosk-launch.sh" /usr/lib/speck-os/kiosk-launch.sh
    install -m 0755 "$REPO/shell/kiosk-chrome.mjs" /usr/lib/speck-os/kiosk-chrome.mjs
    # Same policy for either browser: Chromium reads /etc/chromium, Google Chrome /etc/opt/chrome.
    for dir in /etc/chromium/policies/managed /etc/opt/chrome/policies/managed; do
      install -d "$dir"
      install -m 0644 "$REPO/system/chrome/speck-os.json" "$dir/speck-os.json"
    done
  fi
}

inst_broker() {  # speck-broker: root ops, boot guard, updater, recovery console, first-boot setup, hwd
  install -d /usr/lib/speck-os/broker/lib /usr/lib/speck-os/broker/recovery /usr/lib/speck-os/broker/setup
  install -m 0755 "$REPO/broker/speck-broker.mjs" /usr/lib/speck-os/broker/
  install -m 0644 "$REPO"/broker/lib/*.mjs /usr/lib/speck-os/broker/lib/
  install -m 0644 "$REPO/broker/recovery/index.html" /usr/lib/speck-os/broker/recovery/
  install -m 0644 "$REPO/broker/setup/index.html" /usr/lib/speck-os/broker/setup/
  ln -sf /usr/lib/speck-os/broker/speck-broker.mjs /usr/local/bin/speck-broker
  install -d /etc/speck-os
  install -m 0644 "$REPO/config/broker.env" /etc/speck-os/broker.env
  if [ "${KIOSK:-1}" = 1 ]; then
    sed -i 's/^SPECK_HEALTH_UNITS=.*/SPECK_HEALTH_UNITS="speck-broker.service speck.service speck-kiosk.service"/' /etc/speck-os/broker.env
  fi
  install -d -o root -g speck -m 0750 /var/lib/speck/.broker
  install -m 0644 "$REPO/system/systemd/speck-broker.service" "$REPO/system/systemd/speck-boot-ok.service" \
    "$REPO/system/systemd/speck-hwd.service" /etc/systemd/system/
  # Speck starts after the broker and knows where to reach it.
  install -d /etc/systemd/system/speck.service.d
  cat > /etc/systemd/system/speck.service.d/broker.conf <<'EOF'
[Unit]
After=speck-broker.service
Wants=speck-broker.service
[Service]
Environment=SPECK_BROKER_SOCKET=/run/speck-broker/broker.sock
EOF
  # speck-hwd: driver profiles and the build script it calls.
  install -d /usr/lib/speck-os/hwd/drivers
  install -m 0755 "$REPO"/hwd/drivers/*.sh /usr/lib/speck-os/hwd/drivers/
  install -m 0755 "$REPO/provision/build-llama.sh" /usr/lib/speck-os/build-llama.sh
  install -m 0755 "$REPO/image/speck-install" /usr/lib/speck-os/speck-install
}

inst_grub() {  # boot counter + last-known-good entry (needs a separate ext4 /boot at runtime)
  install -d /etc/default/grub.d /etc/grub.d
  install -m 0644 "$REPO/system/grub/speck-os.cfg" /etc/default/grub.d/speck-os.cfg
  install -m 0755 "$REPO/system/grub/09_speck-bootcount" /etc/grub.d/09_speck-bootcount
  install -m 0755 "$REPO/system/grub/42_speck-good" /etc/grub.d/42_speck-good
}

inst_voice() {  # speck-voice service, its settings, and the page script the kiosk injects
  local dest=/usr/lib/speck-os/voice
  install -d "$dest/lib" "$dest/page"
  install -m 0644 "$REPO/voice/package.json" "$REPO/voice/package-lock.json" "$REPO/voice/models.json" "$REPO/voice/server.mjs" "$dest/"
  install -m 0644 "$REPO"/voice/lib/*.mjs "$dest/lib/"
  install -m 0644 "$REPO/voice/page/voice-local.js" "$dest/page/"
  ( cd "$dest" && npm ci --omit=dev --no-audit --no-fund )
  install -d /etc/speck-os
  [ -f /etc/speck-os/voice.json ] || install -m 0644 "$REPO/config/voice.json" /etc/speck-os/voice.json
  # Boxes set up before phase 5: the setup page (recovery console origin) uses voice too.
  node -e 'const fs = require("fs"); const f = "/etc/speck-os/voice.json"; const c = JSON.parse(fs.readFileSync(f, "utf8"));
    const o = "http://127.0.0.1:4399"; if (!(c.allowedOrigins ??= []).includes(o)) { c.allowedOrigins.push(o); fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n"); }'
  install -m 0644 "$REPO/system/systemd/speck-voice.service" /etc/systemd/system/
}

inst_voice_models() {  # every model voice.json names; a voice model loads on first use, so extras cost disk only
  local dest=/usr/lib/speck-os/voice models id url dir
  models=$(node -p 'require("/etc/speck-os/voice.json").modelsDir')
  install -d -o infer -g infer "$models"
  for id in $(node -p 'const c = require("/etc/speck-os/voice.json"); [c.stt?.model, ...(c.tts?.models ?? [])].filter(Boolean).join(" ")'); do
    read -r url dir < <(node -p 'const m = require(process.argv[1])[process.argv[2]]; m ? `${m.url} ${m.dir}` : ""' "$dest/models.json" "$id")
    [ -n "$url" ] || { echo "warning: voice model $id is not in models.json"; continue; }
    if [ ! -d "$models/$dir" ]; then
      echo "downloading voice model $id"
      curl -fsSL "$url" | runuser -u infer -- tar -xjf - -C "$models"
    fi
  done
}

inst_nli() {  # speck-nli: Speck's NLI checker as int8 ONNX on the CPU (replaces the torch sidecar)
  local dest=/usr/lib/speck-os/nli
  install -d "$dest/lib" "$dest/tools"
  install -m 0644 "$REPO/nli/package.json" "$REPO/nli/package-lock.json" "$REPO/nli/server.mjs" "$dest/"
  install -m 0644 "$REPO"/nli/lib/*.mjs "$dest/lib/"
  install -m 0644 "$REPO/nli/tools/quantize.py" "$REPO/nli/tools/verify.mjs" "$dest/tools/"
  install -m 0755 "$REPO/nli/tools/build-model.sh" "$dest/tools/"
  ( cd "$dest" && npm ci --omit=dev --no-audit --no-fund )
  # onnxruntime-node ships every platform's binary, and Node never uses onnxruntime-web: ~300 MB.
  rm -rf "$dest/node_modules/onnxruntime-web" "$dest/node_modules/onnxruntime-node/bin/napi-v6/darwin"     "$dest/node_modules/onnxruntime-node/bin/napi-v6/win32" "$dest/node_modules/onnxruntime-node/bin/napi-v6/linux/arm64"
  install -d /etc/speck-os
  [ -f /etc/speck-os/nli.json ] || install -m 0644 "$REPO/config/nli.json" /etc/speck-os/nli.json
  install -m 0644 "$REPO/system/systemd/speck-nli.service" /etc/systemd/system/
}

inst_nli_model() {  # build, verify and install the int8 checker model (downloads ~1.8 GB, keeps ~1.05 GB)
  local models
  models=$(node -p 'require("/etc/speck-os/nli.json").modelsDir')
  install -d -o infer -g infer "$models"
  /usr/lib/speck-os/nli/tools/build-model.sh "$models"
  chown -R infer:infer "$models"
}

inst_bake_models() {  # inst_bake_models: the workers' GGUFs, so the first boot needs no internet
  local env model
  install -d -o infer -g infer /var/lib/speck-infer/models/local
  chattr +C /var/lib/speck-infer/models 2>/dev/null || true
  for env in /etc/speck-os/workers/*.env; do
    model=$(. "$env"; echo "${MODEL_HF:-}")
    [ -n "$model" ] || continue
    runuser -u infer -- node "$REPO/tools/fetch-model.mjs" "$model" /var/lib/speck-infer/models/local
  done
}

inst_enable() {  # enable everything a booted box runs (no starting)
  systemctl enable speck-broker.service speck-boot-ok.service speck-hwd.service speck.service speck-nli.service
  local w
  for w in worker intake toolcaller embed; do systemctl enable "infer@$w.service"; done
  if [ "${KIOSK:-1}" = 1 ]; then
    systemctl enable speck-kiosk.service speck-voice.service
    systemctl set-default graphical.target
    # The kiosk owns tty1; a desktop display manager would fight it.
    local dm
    for dm in gdm3 gdm lightdm sddm; do systemctl disable "$dm" 2>/dev/null || true; done
  fi
}
