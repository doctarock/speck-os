# Developing Speck OS

All commands run from the repository root. How the system was built up phase by phase, how to build a box by hand (which is how development and testing work), the checks for each phase, and the test suites. To install Speck OS on a machine, see the [README](../README.md); the design is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Phase 0: kiosk VM

Goal: boot straight into the Speck UI full screen, with voice, with a 4B model on the CPU. The CPU-only VM is a pessimistic stand-in for the Ryzen 9 PRO 6950H budget box.

### 1. VM

- **OS:** Ubuntu 24.04 Server.
- **Resources:** 32 GB RAM, 8 vCPUs, 80 GB disk.
- **Disk:** use the installer's custom storage layout. Phase 1 depends on it, so getting it right now saves a reinstall:
  - EFI partition, 1 GB (the installer adds it)
  - `/boot` **ext4**, 2 GB. GRUB can't write its boot counter on btrfs.
  - `/` **btrfs**, the rest. Phase 1 converts it to an `@` subvolume layout itself.
- **Hyper-V:** Generation 2, Secure Boot template *Microsoft UEFI Certificate Authority*. Give the VM a microphone if you want to test voice. Enhanced session isn't needed: the kiosk draws on the VM console.
- **Other:** VirtualBox (VMSVGA graphics) also works.

### 2. Package Speck

```bash
./tools/package-speck.sh                          # a commit of github.com/doctarock/Speck (SPECK_REF=main by default)
SPECK=../Speck ./tools/package-speck.sh           # or a local checkout's working tree, for development
```

This produces `dist/speck-src.tar.gz` (Speck with Genesis in `vendor/genesis-runtime`). The commit packaged, or `+dirty` for a local tree, is recorded in `dist/speck-src.version` and ends up in `/etc/speck-os/versions` on the box.

### 3. Provision (in the VM)

Copy this folder to the VM (scp, shared folder or git), then:

```bash
sudo ./provision/provision.sh dist/speck-src.tar.gz
```

The script:
- installs Node 22, cage, Chromium and PipeWire (`BROWSER=chrome` installs Google Chrome instead, for your own box only: its terms don't allow redistributing it);
- builds llama.cpp;
- creates the `speck`, `infer` and `speck-ui` users;
- installs Speck into `/opt/speck/slots/a`, with `current` pointing to it;
- puts state in `/var/lib/speck`;
- starts four `infer@` workers (4B worker, intake, tool caller, embedder), which download their models on first start;
- then starts Speck and the kiosk on tty1.

Re-running it is safe.

| Unit | What |
|---|---|
| `infer@worker` :8080 | Qwen3-4B Q4_K_M, 32k ctx, q8 KV |
| `infer@intake` :8081 | LFM2.5-1.2B Q8_0 |
| `infer@toolcaller` :8082 | Qwen3-0.6B-tools Q8_0 |
| `infer@embed` :8083 | nomic-embed-text v1.5 |
| `speck` :4310 | Speck + Genesis |
| `speck-kiosk` tty1 | cage → Chromium kiosk |

Ctrl+Alt+F2 opens a console (dev builds only). Logs: `journalctl -u speck -u 'infer@*' -u speck-kiosk -f`.

### Phase 0 checks

- [ ] Boots to the Speck UI with no desktop, URL bar or login.
- [ ] A conversation turn completes on the CPU 4B worker. Note tok/s with `journalctl -u infer@worker`.
- [ ] Voice in and out works in the kiosk (offline voice from phase 4; Chromium has no online speech recognition).
- [ ] Killing the browser or Speck recovers on its own (`systemctl kill speck-kiosk`, `systemctl kill speck`).
- [ ] Memory with everything idle and during a turn (`free -m`), to compare with the budget table.

Not in phase 0: the NLI checker (waits for the ONNX port).

## Phase 1: the agent administers the box

```bash
sudo ./provision/phase1.sh      # first run on a fresh install converts / to @: reboot, then run it again
```

The script:
- converts the root to a btrfs `@` subvolume, if needed;
- moves agent state, models and snapshot history onto their own subvolumes (`@speck`, `@speck-infer`, `@snapshots`), so a system rollback never touches the agent's memory;
- sets up snapper, installs the GRUB boot counter and the fallback entry;
- starts `speck-broker`;
- marks the current system as the first known-good root.

| Piece | What it does |
|---|---|
| `speck-broker` (root) | Unix socket `/run/speck-broker/broker.sock`, readable only by root and `speck`. Runs any script as root, apt, systemd, reboot, snapshots, rollback, audit log (`/var/lib/speck/.broker/audit.jsonl`). |
| `os-system` plugin | Gives the agent `os_status`, `os_exec`, `os_packages`, `os_service`, `os_power`, `os_snapshots`, `os_rollback` and `os_audit` (plus the update and hardware tools from phases 2–3). They're approved in System → Capabilities, so the agent never waits for you. The `speck-os` profile force-enables the plugin. |
| Snapshots | snapper pre/post around every root script, package change, enable/disable and rollback. A rollback is itself snapshotted, so it can be undone. |
| Last known good | 10 minutes of health after a change (or a boot) copies the running root to `@good`, along with its kernel. |
| Boot fallback | GRUB counts boots; `speck-boot-ok` resets the count once Speck is healthy. After two unhealthy boots in a row, GRUB boots `@good`. The fallback then promotes `@good` to `@`, keeps the failed root as `@broken-<time>`, and reboots. |

**Security note:** the `speck` user can reach the broker, so any code in the Speck process, including any Genesis plugin, is effectively root. That's the design, since the agent owns the box. It does mean installing a plugin is as trusted as running a root script.

### Phase 1 checks (VM)

- [ ] `speck-broker status` shows snapshots available and `goodMarked: true`.
- [ ] Ask the agent to install `htop`. It appears in `os_audit` and `snapper list`, without asking you first.
- [ ] Ask the agent to break something reversible (e.g. remove `pipewire`), then roll it back with `os_rollback`.
- [ ] **Break boot on purpose:** `sudo systemctl mask speck.service && sudo reboot`. Expect two reboots, then the fallback boot, a promotion, and a final boot into a healthy system. `@broken-*` is kept.
- [ ] Agent memory survives all of the above.

## Phase 2: Speck updates itself

No extra install step: re-run `sudo ./provision/phase1.sh` to ship the updated broker, then copy a bundle onto the box. Either you or the agent starts the update:

```bash
./tools/package-speck.sh                              # on any machine with git
scp dist/speck-src.tar.gz box:/var/tmp/               # bundle onto the box
sudo speck-broker update /var/tmp/speck-src.tar.gz    # or: the agent calls os_update
sudo speck-broker update-status
```

| Step | What happens | If it fails |
|---|---|---|
| Stage | Unpacks or clones into the **inactive** slot and applies the speck-os overlay (`/usr/lib/speck-os/overlay`: the os-system plugin and profile) | Nothing changes |
| Build | `npm ci` + build, as `speck` | Nothing changes |
| Gate | Each check in `/etc/speck-os/update.json` (default: Speck's `npm test`) | Nothing changes |
| Smoke | Starts the new build on :4311 against a reflink **copy** of the agent's state, with cron and the queue paused. It must report healthy. | Nothing changes. This catches migrations that would crash on the real data. |
| Switch | Stops Speck, takes a read-only btrfs snapshot of `@speck`, switches the `current` link, starts Speck | Previous version restored |
| Watch | Healthy within 3 min, then 5 min with no run of 3 failed checks and no restart loop | **Code and state roll back automatically** |

- **Success:** after the settle period the system becomes the new boot fallback. The last 3 state snapshots are kept.
- **Manual rollback** (`os_update_rollback`, or *Undo last update* on the recovery console) switches the code back and **keeps the agent's memory** unless `restore_state` is set.
- **Agent tools:** `os_update`, `os_update_status`, `os_update_rollback`. The update runs in the broker, so it survives Speck restarting itself in the middle of it.

### Recovery console

`http://127.0.0.1:4399/` is served by the broker, with no model involved.
- **What it shows:** whether Speck is up, machine state, version and update history, recent activity, the last system snapshots with *Undo to here*, and logs.
- **What it can do:** a fixed set of actions only: restart Speck, restart models, undo last update, undo to a snapshot, restart the machine. It can't run arbitrary commands.
- **When you see it:** the kiosk switches to it after 15 seconds of Speck being unhealthy, or 3 minutes at boot, and switches back as soon as Speck is healthy.

### Phase 2 checks (VM)

- [ ] An update from a bundle completes: `update-status` shows `succeeded`, and slot `b` is current.
- [ ] **Gate failure:** break a test in Speck, package, update. The job fails at the gate and the running Speck is untouched.
- [ ] **Watch failure:** package a Speck that exits a minute after start. It switches, fails the watch, then code and state roll back.
- [ ] `systemctl stop speck`: the kiosk shows the recovery console. *Restart Speck* brings the UI back.
- [ ] The agent updates itself through `os_update` and carries on with its task after the restart.

## Phase 3: eGPU becomes a higher tier

Re-run `sudo ./provision/phase1.sh`. It installs `speck-hwd.service` and refreshes the agent's tools. From then on, every boot sets up whatever GPU is attached, with no user steps:

| Step | What happens |
|---|---|
| Pin | Before the workers start, the 4B base workers are pinned to the iGPU. Otherwise llama.cpp's Vulkan backend would move them onto the eGPU. |
| Driver | NVIDIA: Ubuntu's signed server driver (works with Secure Boot), then an automatic reboot. AMD and Intel: in-kernel, nothing to install. |
| Build | The card serves on the Vulkan build straight away. For NVIDIA, a CUDA build follows, and the worker switches to it once it's ready. |
| Plan | The largest model in `/etc/speck-os/hwd.json` that fits the VRAM: 8 GB → 8B, 12–16 GB → 14B, 24 GB → 30B-A3B, 32 GB → 32B. |
| Serve | `infer@egpu` on :8090. The first start downloads the model. |
| Register | Processor `egpu` is added to Speck live, at tier 3 or 4. The 4B keeps every role; the eGPU is where Speck escalates to. |

- **Unplugged:** the worker stops, the processor is disabled (its history is kept), and the base workers are unpinned.
- **Agent tools:** `os_hardware` (inventory, eGPU state, job progress, workload placement) and `os_hardware_reconcile` (run it again; it never reboots on its own).
- **CLI:** `speck-broker hw`, `speck-broker hw-reconcile`.
- **Edits:** changes you or the agent make to `/etc/speck-os/workers/egpu.env` are kept while the card stays the same. A different card, or a backend switch, replans.
- **Reboots:** a deliberate reboot (the agent's, or after a driver install) no longer counts toward the boot fallback, as long as the system was healthy.

### Phase 3 checks (needs the hardware)

- [ ] **Capture fixtures:** `sudo ./hwd/probe/capture-fixture.sh no-egpu`, then again with the card attached. These turn into tests.
- [ ] **Without an eGPU:** `speck-broker hw` shows `absent`; `/run/speck-os/hw/base.env` is empty.
- [ ] **AMD or Intel card:** after one boot, `infer@egpu` is serving, `egpu` appears in System → Brains at the expected tier, and `base.env` pins the iGPU. Check with `journalctl -u infer@worker` that the 4B worker still runs on the iGPU.
- [ ] **NVIDIA card:** one automatic reboot for the driver; Vulkan serving within minutes; then CUDA once built (`os_hardware` shows `backend: cuda`).
- [ ] **Unplug and boot:** the processor is disabled and the base works alone. Plug it back in and boot: it comes back with no reinstall.
- [ ] Give the agent a hard task: Speck escalates to `egpu`.

## Phase 4: offline voice

Re-run `sudo ./provision/phase1.sh` (or just `sudo ./provision/install-voice.sh`). Voice now works without the internet: the user and Speck notice no difference except that nothing leaves the box.

| Piece | What it does |
|---|---|
| `speck-voice` :4320 | Local speech service. Streaming recognition (Kroko, punctuated) and speech synthesis (Kitten, 8 voices; Kokoro optional), from sherpa-onnx. Models in `/var/lib/speck-infer/voice`. |
| `kiosk-chrome.mjs` | Starts the kiosk browser (Chromium, or Google Chrome if installed) over a private DevTools pipe and puts local implementations of `webkitSpeechRecognition` and `speechSynthesis` into the Speck page before it loads. Speck's own voice code runs unchanged. |
| `os_voice` tool | The agent switches recognition and speech between `local` and the browser's own (`chrome`) and checks the service's health. Browser recognition needs Google Chrome; on Chromium the tool refuses it and says why. |

- **Choosing a voice:** System → Voice in Speck lists the local voices; the default is Kitten "Luna".
- **Speed:** replies start playing after about half a second on the dev machine, because speech is synthesised and streamed a sentence at a time.
- **Settings:** `/etc/speck-os/voice.json`: models, threads, which engine the browser uses. Run `install-voice.sh` after adding a model to fetch it.

### Phase 4 checks (VM or box)

- [ ] `curl -s 127.0.0.1:4320/health` is ok; `sudo -u infer node /usr/lib/speck-os/voice/server.mjs bench` prints figures for this CPU (compare with ARCHITECTURE.md §5).
- [ ] **Unplug the network.** "Hey Speck, …" is recognised and the reply is spoken.
- [ ] The words appear in the prompt while you talk, and the request submits after the pause or "thank you".
- [ ] Speck doesn't hear itself while speaking (the mic is muted for its own replies, then reopens).
- [ ] System → Voice lists the local voices; *Preview voice* plays the selected one.
- [ ] `systemctl stop speck-voice`: voice reports an error and retries calmly, and recovers when the service is back.
- [ ] Ask the agent to switch to the browser's speech output, then back (`os_voice`). On Chromium, asking for browser recognition is refused with an explanation.

## NLI checker (CPU, int8)

Speck's fact checker (DeBERTa-v3-large NLI) runs as `speck-nli` on :8765. It's a Node/ONNX Runtime drop-in for Speck's Python sidecar, about 1.2 GB instead of ~3 GB. `provision.sh`, `phase1.sh` and the image install it (`provision/install-nli.sh`).
- **The model is built, not downloaded.** `nli/tools/build-model.sh` quantizes the pinned fp32 graph (weight-only 8-bit) and refuses the result unless it agrees with fp32 on every case of Speck's qualification corpus. The int8 file published on Hugging Face doesn't (104/198): see [ARCHITECTURE.md](ARCHITECTURE.md) §5.
- **When Speck uses it:** the image's Speck config lists it as processor `nli-checker`, but Speck only uses a checker that has been measured qualified. To measure it on the box: `cd /opt/speck/current && sudo -u speck node dist/cli.js probe qualify --models nli-checker`.
- **Boxes set up before this:** add the processor in System → Brains (provider `nli`, model `MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli`, URL `http://127.0.0.1:8765`).

## Phase 5: install from a USB stick

Phases 0–4 turn a hand-installed Ubuntu into Speck OS. Phase 5 builds the same system as an image: you flash a USB stick, boot the mini PC from it, pick the disk, and the box starts into a short setup on screen.

### Build the image (dev machine, Docker)

```bash
./image/build.sh                         # packages Speck from GitHub, → image/out/speck-os-installer-<date>.img.xz
SPECK_REF=<tag or commit> ./image/build.sh   # a specific Speck release
./image/build.sh --bake-models           # same, with the workers' models (~5 GB) inside: no internet needed at first boot
./image/build.sh --no-compress --test    # raw .img, then install it onto blank disks and check the result
```

- **Where it runs:** in Docker, so Linux or Docker Desktop on Windows/macOS. mkosi builds the Ubuntu 24.04 tree, running the same install steps as `provision.sh` (`provision/lib-install.sh`). Then `image/speck-install` writes the USB image.
- **Time:** the first build takes a while, mostly the llama.cpp build. Later builds reuse the package cache in the `speck-os-build` Docker volume.
- **`--boot-test`** also boots an installed disk in QEMU with UEFI Secure Boot and Microsoft's keys, and waits for the setup page to answer. Without KVM (Docker Desktop on Windows) this is slow emulation.

### Install

1. Write the `.img.xz` to a USB stick (16 GB or larger) with any image writer (balenaEtcher, Rufus in DD mode, `xzcat … | sudo dd of=/dev/sdX bs=4M`).
2. Boot the mini PC from it. Secure Boot can stay on.
3. The screen shows **Install Speck OS** → choose the internal disk (it's erased; a second press confirms) → wait for the progress bar → remove the stick → **Restart**.
4. The box starts into first-boot setup: **network** (Wi-Fi or Ethernet), **time zone**, **voice** (with a spoken preview and a microphone test), **models** (download progress), then **Ready** → Speck.

Afterwards, the recovery console's *Network & time zone* button opens the same network and time zone screens again. `sudo speck-broker setup-reset` shows the whole setup again at the next kiosk check (handy for testing).

### Phase 5 checks (VM, then the box)

- [ ] **VM (UEFI, Secure Boot on):** attach the raw `.img` as a USB/second disk plus an empty 64 GB+ disk. It boots to the Install screen; the empty disk is offered and the stick isn't.
- [ ] After install and restart: the setup screen appears; Wi-Fi or Ethernet connects; the models download with progress; *Ready* switches to Speck.
- [ ] The first conversation turn works; `speck-broker status` shows snapshots available, and `goodMarked: true` after 10 minutes.
- [ ] **Boot fallback works on an installed system:** `sudo systemctl mask speck.service && sudo reboot` behaves as in phase 1.
- [ ] **On the 6950H:** `journalctl -u infer@worker` shows the Vulkan device (Radeon 680M) and the CPU variant llama.cpp picked; no "illegal instruction".
- [ ] Pull the power during setup, then boot: setup resumes at the step it was on.
- [ ] Say "Hey Speck" a few times in your own voice and check how often the wake word is caught (the voice bubble switches to "Listening"). The tests use synthetic voices only.

Tests:
- `node --test broker/test/*.test.mjs`: 64 tests (ops, boot fallback, updates, recovery console, hardware and eGPU, first-boot setup and installer).
- `cd voice && npm ci && npm test`: 8 tests (service protocol, origin checks, injection, browser choice).
- `node voice/test/e2e-chrome.mjs <chrome> <models dir>`: a real Chromium or Chrome and real models, using a synthesised "Hey Speck…" recording as the microphone.
- `cd nli && npm ci && npm test`: 8 tests (the sidecar API, label mapping, int8 + bounded threads, one check at a time, the self-check refusing a mis-quantized graph).
- `node nli/tools/verify.mjs <models dir> <model> <Speck's qualification.ts>`: int8 against fp32 on the qualification corpus (the model build runs it).
- `node broker/test/setup-ui.mjs <chrome> <voice models dir> [<screenshot dir>]`: every setup and installer screen in real Chrome, with offline voice injected, against a scripted machine; saves a screenshot of each screen.
- `node voice/test/e2e-turn-phase.mjs <speck dir> <chrome> <voice models dir>`: Speck's real UI with offline voice and a synthesised "Hey Speck…" microphone; checks that Speck holds background work and the queue while you speak and background work while it speaks (Speck 82ed867 or later).
- `./image/build.sh --test [--boot-test]`: installs the built image onto blank disks, from the tarball and from the USB installer itself, and checks the layout, bootloader and setup state.
