# Speck OS — Architecture (draft 0)

Speck OS is a Linux appliance where Speck (on Genesis) is the only thing the user sees. The agent runs and maintains the machine and itself. The user grows its capabilities through the Genesis plugin ecosystem, using the Speck UI.

Target: a mini PC running 4B models, with an optional OCuLink eGPU added as a stronger inference tier.

---

## 1. Layers

```text
┌──────────────────────────────────────────────────────────────┐
│  Shell: Chromium --kiosk --app=http://127.0.0.1:4310  (cage) │  only UI
├──────────────────────────────────────────────────────────────┤
│  Speck (cognition) + Genesis (plugins, profiles, UI)         │  user: speck
│   ├─ os-system plugin: admin, updates, hardware, voice tools │
│   └─ model registry / escalation tiers  ◄── worker manifests │
├──────────────────────────────────────────────────────────────┤
│  speck-broker (root daemon: exec, pkg, service, reboot, snap)│  agent's root hands
├──────────────────────────────────────────────────────────────┤
│  Inference workers: llama.cpp / Ollama per device            │  user: infer
│   cpu|igpu (4B baseline)      egpu (sized to VRAM)           │
│  speck-voice: offline STT/TTS (injected into the kiosk page) │
├──────────────────────────────────────────────────────────────┤
│  Base: Ubuntu 24.04 (HWE), btrfs + snapper, signed boot      │
└──────────────────────────────────────────────────────────────┘
```

## 2. Core principle: the agent owns the box

The agent has full administrative control. It updates and installs packages, edits system config, runs arbitrary scripts as root, manages services and reboots itself. It doesn't wait for anyone to approve system maintenance.

Safety comes from **recoverability, not restriction**:

- **speck-broker** is the root daemon that carries out the agent's system actions. It has no fixed list: it exposes `exec(script, as=root|user)`, `pkg.*` (any apt/pip/npm), `service.*`, `power.reboot`, `snapshot.*`, `speck.update`, plus helpers such as `gpu.provision`. Speck keeps its own process unprivileged so that a crash in the UI or cognition loop can't corrupt the system on its own. Root work goes to the broker.
- **Automatic snapshots.** The broker takes a btrfs snapshot before any mutating batch, and snapper keeps a rolling history. The agent may batch several ops under one snapshot.
- **Boot-level rollback.** grub-btrfs adds snapshots to the boot menu. A boot-health check (the broker and Speck come up and the UI loads) that fails twice in a row automatically boots the last good snapshot. The agent can brick the box; it can't keep it bricked.
- **Full audit trail.** Every script and op is recorded as a Speck Tool Outcome and Evidence (invariant 12). Scripts are stored verbatim, so the agent can learn from failures and successful sequences can become compiled procedures.
- The only things that still ask the user are actions with effects *outside* the box: spending money, sending messages as the user, deleting user data outside snapshots. This is a policy setting the user can relax.

## 3. Self-maintenance (the agent maintaining itself)

The update pipeline is deterministic. The agent decides *when* to update and the runtime decides *whether the update succeeded*.

1. Fetch the new Speck/Genesis/plugin ref into a staging slot (`/opt/speck/slots/{a,b}`).
2. Build, then run the gate checks in `/etc/speck-os/update.json` (Speck's tests now; the benchmark suite can be added as a gate, per invariant 14).
3. Smoke-start the new build against a reflink copy of the agent's state, with cron and the queue paused.
4. Stop Speck, snapshot `@speck` (read-only), switch the `current` symlink and start. The state snapshot exists because a new version may migrate the database one way.
5. A watchdog checks health for a settle window. If it fails, code and state roll back automatically to the previous slot and snapshot. (Still to add: a UI-load check and one cognitive smoke task.)
6. The outcome is recorded as evidence. Repeated success makes the update a compiled procedure.

A non-LLM **recovery console** is served by the broker on a separate port. The kiosk falls back to it if Speck is down, and it offers rollback, factory reset and logs.

## 4. eGPU over OCuLink

OCuLink is raw PCIe, not Thunderbolt, so there is no reliable hotplug. Treat it as **detect at boot**. The agent can re-run detection on demand (`os_hardware_reconcile`).

`speck-hwd` is part of the broker (`broker/lib/hwd.mjs` detection and planning, `broker/lib/egpu.mjs` the reconcile job). It is a **reconciler**: each run compares the machine with what it should be and fixes the difference, trusting nothing from the last run that the hardware doesn't still confirm.

**At boot, before the workers start** (`speck-hwd.service` → `speck-broker hw-boot`, about a second):
- **Base pinning.** llama.cpp's Vulkan backend prefers dedicated GPUs. Once an eGPU is attached, the 4B base workers would silently move onto it. hwd writes `/run/speck-os/hw/base.env` with `GGML_VK_VISIBLE_DEVICES=<iGPU index>`, matching the Vulkan enumeration (`vulkaninfo --summary`) to PCI IDs.
- **eGPU gate.** `infer@egpu` has an `ExecCondition`: it starts only if this boot's card is the one it was set up for, at the same device index. A stale index could otherwise land it on the iGPU or the software rasteriser.

**Then, in the background in the broker** (drivers, builds and downloads can take a long time):
1. **Detect.** sysfs gives the PCI class, IDs, bound driver, VRAM (`amdgpu`) and link speed. Integrated vs discrete:
   - Intel: integrated at `00:02.0`.
   - AMD: an APU device ID, or less than 2 GB of VRAM.
   - NVIDIA: always discrete.

   The eGPU is the discrete GPU with the most VRAM.
2. **Driver**, by vendor (`/etc/speck-os/hwd.json`):

   | Vendor | Driver | llama.cpp backend |
   |---|---|---|
   | NVIDIA | Ubuntu server driver with **Canonical-signed modules** (Secure Boot needs no MOK step), plus its Vulkan ICD | CUDA, with Vulkan used until CUDA is built |
   | AMD | in-kernel `amdgpu` (nothing to install) | Vulkan (RADV); ROCm later, for supported gfx targets |
   | Intel Arc | in-kernel `xe` / `i915` | Vulkan; SYCL later |

   - Installs go through the broker's `exec`, so they are snapshotted and audited.
   - **Reboots:** at boot, hwd reboots on its own after a driver install. When the agent asks for a reconcile, the agent picks the moment instead.
   - **Loop limit:** after two installs that never loaded, hwd reports the problem instead of rebooting again.
   - **Boot counter:** a deliberate reboot from a healthy system clears GRUB's counter first, so it never counts toward the boot fallback.
3. **Build.** **Vulkan is the universal fallback.**
   - The card serves on whatever build already works within minutes, then upgrades to the vendor backend once that builds.
   - A failed CUDA build (e.g. Ubuntu's CUDA 12.0 on Blackwell) leaves it on Vulkan. hwd doesn't retry that build at every boot.
4. **Plan.** hwd picks the first catalog model whose size fits within 92% of VRAM, counting weights, q8 KV for the context, and 0.8 GiB overhead. With the shipped catalog:

   | VRAM | eGPU worker | Speck tier |
   |---|---|---|
   | < 8 GB | none (reported as too small) | n/a |
   | 8 GB | Qwen3-8B Q4_K_M, 16k | 3 |
   | 12 GB | Qwen3-14B Q4_K_M, 16k | 3 |
   | 16 GB | Qwen3-14B Q4_K_M, 32k | 3 |
   | 24 GB | Qwen3-30B-A3B Q4_K_M, 32k | 4 |
   | 32 GB+ | Qwen3-32B Q4_K_M, 32k | 4 |

   The catalog is a config file, so the agent can retune it. Edits to `egpu.env` are kept while the card stays the same.
5. **Serve and register.** hwd starts `infer@egpu` (port 8090) and registers processor `egpu` in Speck through `POST /api/brains/config`. That's the same path System → Brains uses, applied live; if Speck is down, hwd edits `model-processors.json` instead. Roles are never touched: the 4B stays the base processor, and the eGPU is a **higher escalation tier** in `models/escalation.ts` (invariants 1 and 2).
6. **Card gone.** hwd stops and disables the worker, sets the processor to `enabled: false` (keeping its history), and unpins the base workers. Tasks just lose the tier.

hwd also writes the **placement manifest** (`/var/lib/speck/.broker/placement.json`, below) and its state (`hwd.json`) next to the audit log. Recorded hardware (`hwd/probe/capture-fixture.sh`) can be replayed in the tests.

### Accelerator placement (NPU, iGPU, eGPU, CPU)

`speck-hwd` inventories every compute device at boot and writes a **placement manifest**. Workloads are placed by what is present; nothing assumes a device exists.

| Workload | NPU present (mid/high tiers) | No NPU (budget tier) |
|---|---|---|
| 4B base LLM | iGPU (Vulkan) | iGPU (Vulkan) |
| STT | NPU (OpenVINO / XDNA) | CPU, small streaming model; runs only while the mic is open |
| TTS | NPU or CPU | CPU (Piper is light) |
| Embedder | NPU | CPU, batched during idle |
| NLI checker | NPU (ONNX int8) | CPU (`speck-nli`, weight-only int8 ONNX), loaded on the first check |
| Larger tier | eGPU if attached | eGPU if attached |

On the budget tier, a **turn-phase scheduler** in Speck orders the CPU work:

- **Listening:** STT only, and background work is paused.
- **Thinking:** LLM, embedder and NLI.
- **Speaking:** TTS, with STT kept warm for barge-in.
- **Idle:** consolidation and embedding backlog.

Each processor declares its device and phase. NPU tiers use the same scheduler but have little contention to resolve.

**Built so far** (in Speck: `src/background/turn-phase.ts`, `public/ui/voice.js`):
- **Who reports the phase.** Speck's own voice interface, which knows when the user has said the wake word and when it's reading a reply. So it works with Chrome's speech as well as the offline voice.
- **How.** The interface posts `listening` / `speaking` / `idle` to `POST /api/voice/phase` on each change, and refreshes it every 8 s while it lasts.

| Phase | Background cognition (consolidation, embeddings, …) | Queued tasks |
|---|---|---|
| listening | waits | don't start: the user's request is seconds away and gets the 4B's single slot first |
| speaking | waits (competes with TTS for the CPU) | run |
| idle / thinking | as before: slices run between requests, never during a turn's queue work | run |

- **Safety limits.** A phase is a lease that lapses after 20 s without a refresh, so a closed or crashed page can't hold work off. The queue hold also has a 2-minute ceiling, so long dictation can't starve queued tasks.
- **Status.** `GET /api/runtime/status` reports the current phase.
- **Verified** (`voice/test/e2e-turn-phase.mjs`) in real Chrome on Speck's own UI, with the offline voice injected: wake word → listening (queue and background held) → submit → idle → reply spoken → speaking (background held, queue free) → idle.
- **Not yet built:** pinning the embedder and NLI to separate cores (`CPUAffinity=`), and pausing the NLI checker mid-check.

## 5. Voice (TTS/STT) and the browser

**The kiosk browser is Chromium**, as a .deb from the xtradeb PPA (Ubuntu 24.04 only ships Chromium as a snap). The PPA is pinned so it can only supply the Chromium packages. Google Chrome can't be in a published image: its terms don't allow redistribution. A box you provision yourself can use it (`BROWSER=chrome`).

Constraint: `webkitSpeechRecognition` only works in **Google Chrome**. Chromium lacks Google's speech API keys, and Chrome's recognition is cloud-backed. So offline voice (below) is the only recognition on a standard box; Chrome's speech is a fallback only where Google Chrome is installed.

### Budget tier hardware: Ryzen 9 PRO 6950H

- **CPU:** Zen 3+, 8 cores / 16 threads, AVX2 (no AVX-512), no NPU.
- **iGPU:** Radeon 680M (RDNA2, 12 CUs, gfx1035).
  - **Use Vulkan (Mesa RADV), not ROCm.** gfx1035 isn't officially supported by ROCm.
  - The iGPU maps system RAM through GTT, which defaults to ~50% of RAM. That is enough for a 4B model at 32k context. Raise it with `amdgpu.gttsize` / `ttm.pages_limit` only if needed; the small BIOS VRAM carve-out doesn't matter.
- **Memory bandwidth:** about 77 GB/s with DDR5-4800 dual-channel; check whether the box uses LPDDR5-6400. Generation is limited by bandwidth: Q4 4B is likely 15–25 tok/s and Q8 roughly half that.
- **Prefill is the cost that matters.** Speck sends a fresh context packet each cycle, so the iGPU's prompt-processing speed counts more than its generation speed. Use llama-server prompt caching, keep stable packet sections first, and keep Speck's context budgets tight.
- **CPU split:** pin STT/TTS/NLI/embedder to 4 cores with a systemd `CPUAffinity=`. llama.cpp gets the rest for host-side work.
- **Measure** with `hwd/probe/budget-probe.sh` before trusting any number above.

### Resource budget, 32 GB unified memory (budget tier; estimates, to be measured)

| Component | Typical | Heavy case |
|---|---|---|
| OS + PipeWire + NetworkManager | 0.7 GB | 1 GB |
| cage + Chromium kiosk | 0.8 GB | 1.5 GB |
| Speck/Genesis + SQLite + plugins | 0.5 GB | 1 GB |
| 4B weights (Q4_K_M / Q8) | 2.5 GB | 4.3 GB |
| KV cache 16k / 32k (fp16; q8 KV halves it) | 2.3 GB | 4.7 GB |
| Embedder | 0.3 GB | 0.6 GB |
| NLI checker (`speck-nli`, int8 ONNX), **measured**: idle until the first check, then loaded | 1.2 GB | 1.25 GB |
| speck-voice: STT (Kroko) + TTS (Kitten), **measured** | 0.35 GB | 0.6 GB (with Kokoro) |
| **Total** | **~8.7 GB** | **~15 GB** |

The limit is shared bandwidth and compute, not capacity. Rules:
- LLM on the iGPU (Vulkan); STT/TTS/NLI on the CPU (or the NPU when present).
- While the mic is open, background workers pause (invariant 7). Turn-taking naturally serialises STT and generation.
- STT is a Speck processor like any other: it can be swapped, measured and moved to an eGPU host.

### Offline voice (phase 4)

Speck's `voice.js` only uses the standard Web Speech API: `SpeechRecognition` / `webkitSpeechRecognition` and `speechSynthesis` / `SpeechSynthesisUtterance`. Speck OS swaps in local implementations of exactly those interfaces, so Speck's wake word, end-of-request detection and listen-after-speaking logic run **unchanged**, and there's no Speck fork.

- **Injection.** `shell/kiosk-chrome.mjs` starts the browser with `--remote-debugging-pipe`, a DevTools channel on file descriptors only the launcher holds (no port).
  - Over it, every page target gets `voice/page/voice-local.js` through `Page.addScriptToEvaluateOnNewDocument`. The script runs before the page's own scripts, on every load, and only for the Speck origins.
  - `Page.enable` must come first; without it the script silently doesn't apply. The end-to-end test caught this.
- **Recognition.**
  - Path: mic (one shared AudioWorklet capture), then 100 ms int16 frames over a WebSocket to `speck-voice`, then a streaming recognizer.
  - It returns partial results as you speak and a final one at each pause, shaped like Chrome's continuous results.
  - When the service is down it reports `network` errors with back-off, so `voice.js`'s restart loop stays calm.
- **Synthesis.**
  - Each utterance is POSTed to `/v1/tts`, and the audio streams back **one sentence at a time** as framed PCM, played gaplessly through Web Audio.
  - The next queued utterance is fetched while the current one plays.
  - Local voices appear in `getVoices()`, so the user picks one in Speck's existing System → Voice tab.
- **`speck-voice`** (`voice/`, a Node service on 127.0.0.1:4320, user `infer`): built on sherpa-onnx.
  - It is pinned to 1.13.x, because 2.0 dropped the built-in espeak-ng frontend that Piper, Kokoro and Kitten depend on.
  - Only the Speck page's origins may use it.
  - It runs at `Nice=-5` with a high `CPUWeight`: speech is what the user is waiting on.
- **Settings** in `/etc/speck-os/voice.json`. `browser.stt` is `local | chrome`; `browser.tts` is `local | chrome | both`. `chrome` means the browser's own speech; recognition that way needs Google Chrome, and `os_voice` refuses it on Chromium. The agent changes this with `os_voice`.

Models, measured on the dev machine (Ryzen 7 9800X3D, 2 threads; expect about 2× slower on the 6950H). Each speech model was checked by transcribing its output back:

| Role | Model | Speed | Notes |
|---|---|---|---|
| STT (default) | Kroko streaming English, 57 MB | RTF 0.011 | Punctuated and cased; transcribed test audio word-perfect. **CC-BY-SA** (attribution) |
| STT (alternative) | Zipformer en 2023-06-26 int8 | RTF 0.024 | Apache-2.0; no punctuation or casing |
| STT (rejected) | Nemotron 0.6B int8 | RTF 0.33, 0.8 GB | Accurate but too heavy for the budget tier |
| TTS (default) | Kitten nano 0.8 int8, 8 voices | RTF 0.17; **first audio after 0.48 s** | Apache-2.0; every voice transcribed back word-perfect |
| TTS (optional) | Kokoro v0.19 fp32, 11 voices | RTF 0.24–0.32 | Apache-2.0; nicer voice. Its int8 build is 2.5× *slower* on CPU. Round-trip transcription dropped the last word, though the audio isn't cut short |
| TTS (rejected) | Piper lessac | RTF 0.12 | The Blizzard 2013 voice data is **non-commercial only** |

The whole service (Kroko plus Kitten loaded) uses about 0.35 GB RSS. Kokoro adds about 0.25 GB if the user picks one of its voices; models load on first use.

### NLI checker on the CPU

Speck checks hypotheses with an NLI cross-encoder (DeBERTa-v3-large, 435M) through its `nli` processor. The original sidecar is Python with torch fp32, about 3 GB. On the box it's replaced by `speck-nli` (`nli/`):
- **Same API, same port:** Node on ONNX Runtime with an int8 graph, serving `POST /classify` on :8765. Speck needs no change.
- **Registered, no role:** the seeded model config registers it as processor `nli-checker` with no role assigned. Speck uses a checker only once it's measured qualified, and then picks the cheapest qualified one. Until then nothing calls it, and with `preload: false` it doesn't even load.

Quantization was the hard part. Measured on Speck's qualification corpus (99 pairs, each proposition and its opposite, 198 cases) against torch fp32:

| Graph | Size | Agrees with fp32 | CPU per check (2 threads, dev box) |
|---|---|---|---|
| fp32 ONNX | 1.74 GB | 198/198 | 61 ms |
| int8 dynamic, as published on Hugging Face (`onnx/model_quantized.onnx`) | 0.64 GB | **104/198** | 34 ms |
| int8 dynamic, per-channel / constant-weight MatMuls only | 0.64–1.04 GB | 106–111/198 | 34 ms |
| **weight-only 8-bit, int8 compute on 128-value blocks (shipped)** | **1.05 GB** | **198/198** | 76 ms |
| same, embeddings fp16 | 0.78 GB | 197/198 | 75 ms |

- **Why dynamic int8 fails:** per-tensor activation quantization wrecks DeBERTa's disentangled attention. The published int8 file would have silently turned the checker into a coin toss on entailment and contradiction.
- **Shipped graph:** produced reproducibly by `nli/tools/build-model.sh`, pinned to the model's revision. It runs at image build time, and the build **fails unless the int8 graph agrees with fp32 on every qualification case**.
- **Self-check before serving.** On load, `speck-nli` runs 12 unambiguous canary pairs (4 per label). It refuses the model unless all are right, each with at least 0.9 confidence in the right answer.
  - A refused model answers every check with an error and the service's health turns 503, so Speck sees an unavailable checker, never a wrong verdict.
  - The published int8 file fails it (9/12, lowest 0.02); the shipped graph passes (12/12, lowest 0.989). This guards against anyone, the agent included, dropping in the published file or another bad quantization later.
- **Speck's own qualification probe** gives identical results for the shipped graph and torch fp32, per case and in total (169/180; negation 54/61). Neither qualifies under the current thresholds; the int8 graph changes nothing about that.
- **Cost:** 1.2 GB RSS once loaded (torch: ~3 GB), and about 60–75 ms per check on the dev CPU (expect ~2× on the 6950H). It runs at `Nice=10` with a low `CPUWeight`, one check at a time on 2 threads, so it yields to speech.

## 6. Shell / session

- `speck-kiosk.service` runs `cage` (Wayland kiosk compositor) on tty1 as `speck-ui` → `kiosk-launch.sh` → `kiosk-chrome.mjs` → Chromium `--kiosk` with offline voice injected.
- `kiosk-launch.sh` keeps one browser window on screen and switches it between three pages:
  - **first-boot setup** (`:4399/setup`) until it's completed; on the USB installer, always;
  - **Speck** (`:4310`) while it's healthy;
  - the **recovery console** (`:4399`) when Speck is down.
- Managed policies (`/etc/chromium/policies/managed/`, and `/etc/opt/chrome/…` for Google Chrome) lock it down: no URL bar escapes, no extensions, mic/camera allowlisted for localhost.
- Everything the user does happens in the Speck UI, including Wi-Fi, display, audio devices, updates and plugins. Each of these is an `os-*` plugin tab backed by broker ops.

## 7. Image, install and first boot (phase 5)

The product ships as a USB installer image. The installer is itself a complete Speck OS, booted in a mode that shows only the Install screen. It copies itself onto the internal disk, so what gets installed is exactly what booted.

**Build** (`image/build.sh`, in Docker, so it runs on Linux or Docker Desktop):
1. **Root tree.** mkosi (pinned) builds an Ubuntu 24.04 tree: HWE kernel, firmware, signed shim and GRUB, NetworkManager, cage, Chromium.
   - `mkosi.postinst.chroot` then runs `provision/lib-install.sh`, the same install steps `provision.sh` uses on a running box. One source of truth for what a Speck OS box contains.
   - llama.cpp is built **portable** (`LLAMA_PORTABLE=1`: every x86 CPU variant, picked at load time). A native build would carry the build machine's instructions (AVX-512 on the dev box) and crash on the 6950H.
   - The voice models are baked in. The workers' models (~5 GB) are optional (`--bake-models`); otherwise first boot downloads them.
2. **USB image.** `image/speck-install` writes the tree onto a loop device as installer media.

**Install** (`speck-install`). The same script runs at build time (`--from-tar`) and on the USB stick (`--from-running`, started by the Install screen). It creates the layout boot rollback needs, the one `phase1.sh` converts a hand-installed box to:

| Partition | Size | Holds |
|---|---|---|
| EFI (vfat) | 512 MiB | shim and Ubuntu-signed GRUB: **Secure Boot works with the Microsoft keys mini PCs ship with**, so there's no MOK enrolment |
| boot (ext4) | 2 GiB | kernels, grub.cfg, grubenv (GRUB can write its boot counter here, not on btrfs) |
| root (btrfs) | rest | `@` system, `@speck` agent state, `@speck-infer` models, `@snapshots` |

- **Bootloader.** GRUB is installed twice: once as the named entry, and once at the firmware's fallback path `EFI/BOOT/BOOTX64.EFI`, because mini PCs often forget NVRAM boot entries.
- **Per-machine pieces.** Each install gets its own machine-id, a snapper config for `/`, and an fstab written by UUID.
- **Copying.** From the stick, rsync copies root, agent state, models and kernels, reporting progress to the Install screen.
- **Installer mode** is a single flag file, `/etc/speck-os/installer`.
  - Speck, the workers, speck-hwd and the boot counter all have `ConditionPathExists=!` on it, so the stick runs only the broker, voice and the kiosk.
  - The copy on the internal disk has the flag removed.

**First-boot setup** (`broker/lib/setup.mjs`, page `broker/setup/index.html`).
- **Where it runs.** It's served by the broker on the recovery console's port. It needs no model and works before Speck has anything to think with. The kiosk shows it until it's completed.

| Step | What it does |
|---|---|
| Welcome | What the box is (CPU, memory, graphics, eGPU) |
| Network | Wi-Fi through NetworkManager. The password goes into a root-only keyfile, never into a command line or the audit log. Ethernet just works. Skippable. |
| Time zone | `timedatectl` |
| Voice | Pick from the offline voices with a spoken preview, and test the microphone: the setup page gets the same injected offline speech as Speck. Writes `tts.defaultVoice`, which Speck's voice picker prefers. |
| Models | Live download progress per worker, from the bytes in the model cache against the size Hugging Face reports. Coming online restarts workers that gave up while offline. "Continue anyway" is allowed: downloads carry on in the background. |
| Ready | Waits (bounded) for Speck to be healthy, marks setup complete, and the kiosk switches to Speck |

- **USB installer steps:** Welcome → Disk → Install → Restart.
  - The disk list hides the stick it's running from, puts internal disks first, refuses disks under 64 GB, and names what's on each disk (e.g. "Windows").
  - Erasing needs a second press.
- **Later use.** After setup, `/setup` stays reachable from the recovery console ("Network & time zone").
- **Not first boot.** A box built by hand with `provision.sh` + `phase1.sh` is marked set up.

**Verified in the build container** (`image/build.sh --boot-test`, 85 checks):
- **Install from the tarball:** the layout, bootloader, enabled units and setup state are all correct.
- **The stick installs itself:** its own `--from-running` copy onto a blank disk works, with progress reported.
- **Secure Boot boot:** the installed disk boots in QEMU with Secure Boot and Microsoft's keys, through shim, signed GRUB and the signed kernel. The kernel confirms Secure Boot is on, first-boot setup is served, and Speck is healthy with no models and no failed units.

Pitfalls the test caught, now guarded:
- **Root device name.** Without udev, GRUB writes the build machine's device name (`root=/dev/loopNp3`) instead of the UUID; `speck-install` now refuses to finish unless root is found by UUID.
- **mkosi presets.** `preset-all` runs after the install script and re-enables everything Ubuntu ships (networkd, apt auto-upgrades); `mkosi.finalize.chroot` puts the appliance's choices back.
- **CPU portability.** A native llama.cpp build would not run on the 6950H (see above).

## 8. Repo layout

```text
speck-os/
  image/        mkosi config, speck-install, the Docker build and installer tests
  shell/        kiosk launcher (setup / Speck / recovery) and the browser + voice-injection wrapper
  broker/       speck-broker: root ops, boot guard, updater, recovery console, first-boot setup, hwd
  hwd/          GPU driver profiles and hardware capture
  system/       systemd units, GRUB scripts, browser policy, infer-run.sh
  provision/    lib-install.sh (shared install steps), provision.sh, phase1.sh, build-llama.sh
  plugins/      os-system (agent tools: admin, updates, hardware, voice)
  voice/        speck-voice: offline STT/TTS service + the page script kiosk-chrome injects
  config/       defaults shipped to /etc/speck-os
  tools/        package-speck.sh, fetch-model.mjs
  docs/
```

## 9. Phases

| Phase | Deliverable | Proves |
|---|---|---|
| 0 | Debian VM: Speck as a service + cage/Chrome kiosk, 4B on CPU | The "UI is the OS" loop and voice in kiosk Chrome |
| 1 | speck-broker (root exec/pkg/reboot) + auto-snapshots + grub-btrfs boot rollback | The agent administers the box freely and can always recover |
| 2 | A/B update pipeline + watchdog + recovery console | Self-maintenance with rollback |
| 3 | speck-hwd + eGPU provisioning + tier registration | OCuLink card becomes an escalation tier |
| 4 | Local voice plugin | Offline operation |
| 5 | Image build (mkosi) + first-boot onboarding in the UI | Shippable mini-PC appliance |

## Open decisions

- Base distro: the image is Ubuntu 24.04. It gives Canonical-signed NVIDIA modules (Secure Boot without MOK), signed shim/GRUB and the HWE kernel. Debian 13 would need its own driver profiles and a MOK flow for NVIDIA.
- Updates of the OS itself: the agent runs apt through the broker (snapshotted), and unattended-upgrades is off. A whole-image A/B update (like Speck's slots) would make OS updates atomic too, but isn't built.
- Target card for the first eGPU test. The AMD path needs no driver install and is the most likely to work first time; the NVIDIA path (driver, reboot, CUDA build) is written but unverified.
- Speech recognition licence: Kroko's community model is CC-BY-SA (attribution in THIRD-PARTY-NOTICES.md). The Apache-2.0 zipformer is a one-line config switch if share-alike is unacceptable, at the cost of punctuation.
- Wake word with the offline recogniser: punctuated transcripts ("Hey, Speck, …") needed Speck's wake pattern to allow punctuation (fixed). In tests, one of the eight synthetic voices is consistently heard as "Spick", and hotword biasing didn't help. How real voices fare needs checking on the box. If misses are common, a dedicated keyword spotter (sherpa-onnx KWS) for the wake word is the fix, not more spellings.
- eGPU catalog: Qwen3 is a placeholder. Choose the escalation models with the benchmark suite (invariant 14).
- Model server: llama.cpp `llama-server` per device (more control, one binary per backend) vs Ollama (simpler, but less control over device pinning).
