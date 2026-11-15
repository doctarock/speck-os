# Speck OS

Speck OS turns a small PC into an AI appliance. There is no desktop, no login and no settings app: the screen *is* [Speck](https://github.com/doctarock/Speck), an AI agent you talk to or type to. Speck runs entirely on the machine, and it looks after the machine too. It installs software, applies updates, sets up new hardware and fixes problems, and every change it makes can be undone.

- **Local:** the language models, speech recognition and voices all run on the box. After setup it works without the internet.
- **Self-maintaining:** you ask, Speck does it. It administers the box as root, with a snapshot before every change.
- **Hard to break:** a failed update rolls itself back, two failed boots return to the last working system, and a recovery screen with plain buttons is always one step away.
- **Voice:** say "Hey Speck, …" and it answers out loud. Speech is processed on the box.

> **Status: pre-release.** Every build is installed and booted in a virtual machine with Secure Boot, and that passes. It has **not yet been run on real hardware**. Expect rough edges, and please [report what you find](https://github.com/doctarock/speck-os/issues).

## What you need

| | |
|---|---|
| **Computer** | A 64-bit (x86-64) PC that boots with UEFI. Secure Boot can stay on. Speck OS is designed around mini PCs like those with a Ryzen 9 PRO 6950H: 8 cores, Radeon 680M graphics. |
| **Memory** | 32 GB recommended. The system uses about 9 GB idle and up to about 15 GB while thinking, so 16 GB is the bare minimum. |
| **Disk** | The whole internal disk, **which is erased**. At least 24 GB; 64 GB or more is better. |
| **USB stick** | 16 GB or larger, for the installer (also erased). |
| **Network** | Wi-Fi or Ethernet for setup, which downloads the AI models (about 5 GB). |
| **Optional** | A microphone and speakers for voice. An external GPU (eGPU) for bigger models; see [More power: an eGPU](#more-power-an-egpu). |

The machine becomes a dedicated Speck OS box. It doesn't dual-boot with Windows or another Linux.

## 1. Get the installer image

There's no ready-made download yet, so for now you build the image yourself. It's one command, and it runs in Docker, so it works on Linux, Windows or macOS.

You need [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows or macOS), [git](https://git-scm.com/), about 40 GB of free disk space, and time: the first build can take an hour or more.

```bash
git clone https://github.com/doctarock/speck-os.git
cd speck-os
./image/build.sh
```

On Windows, run these in **Git Bash** (installed with git for Windows), with Docker Desktop running.

The result is `image/out/speck-os-installer-<date>.img.xz`, with a `.sha256` checksum next to it.

## 2. Write it to a USB stick

Use any image writer. They all erase the stick.

- **[balenaEtcher](https://etcher.balena.io/)** (Windows, macOS, Linux): choose the `.img.xz` file, choose the stick, *Flash*.
- **[Rufus](https://rufus.ie/)** (Windows): choose the file, and pick **DD mode** if it asks.
- **Linux:** `xzcat speck-os-installer-<date>.img.xz | sudo dd of=/dev/sdX bs=4M status=progress`, where `/dev/sdX` is the stick. Double-check it: `dd` overwrites whatever you name.

## 3. Install

1. Plug the stick into the PC and turn it on. Open the boot menu (usually **F7**, **F11**, **F12** or **Esc** at power-on; it depends on the maker) and choose the USB stick.
2. The screen shows **Install Speck OS**. Choose the internal disk. **Everything on it will be erased**, so it asks you to press a second time to confirm.
3. Wait for the progress bar to finish (a few minutes).
4. Remove the stick and press **Restart**.

## 4. First start

The box starts into a short setup:

1. **Network:** choose your Wi-Fi and enter its password, or plug in Ethernet.
2. **Time zone.**
3. **Voice:** pick a voice and hear it. You can also test the microphone.
4. **Models:** the AI models download, with progress. This is the long step, depending on your connection.
5. **Ready:** the screen switches to Speck.

If the power goes out during setup, it picks up at the step it was on.

## Using Speck OS

Talk to it: say **"Hey Speck"**, then what you want. Or type it. Some things to try:

- "What can you do?"
- "Install htop." or "Check for system updates and install them."
- "How much disk space is left?"
- "What hardware do you have?"
- "Remind me every morning to …"

Speck acts on the box without asking you first; that's the point of it. Before every change it takes a snapshot, so anything it does can be undone. You can ask it to undo, or use the recovery screen below. The **System** tab shows its settings, its models, its voice and the plugins it has.

### Updates

Nothing updates behind your back: automatic updates are off. Speck updates when you, or it, decide to.

- **The system (Ubuntu packages):** ask Speck to check for updates and install them.
- **Speck itself:** ask Speck to *update itself from https://github.com/doctarock/Speck*. The new version is built and tested on the side, then switched in. If it isn't healthy within a few minutes, the old version and its memory come back automatically.

### When something goes wrong

- **The recovery screen.** If Speck stops responding, the screen switches by itself to a plain recovery page with no AI involved. It shows what's wrong and has buttons: *Restart Speck*, *Restart models*, *Undo last update*, *Undo system changes* and *Undo to here* (back to any recent snapshot), *Restart machine*, and *Network & time zone*. As soon as Speck is healthy again, the screen switches back.
- **If the box won't start properly** twice in a row, it automatically starts the last version that worked, and keeps the broken one aside so nothing is lost.
- **Speck's memory is kept separately** from the system, so undoing a system change never erases what Speck has learned.

## More power: an eGPU

Plug a graphics card in over OCuLink or Thunderbolt and restart. Speck OS sets it up by itself: it installs the driver if needed (NVIDIA needs one extra automatic restart; AMD and Intel need none), picks the largest model that fits the card's memory, and makes it the model Speck turns to for harder work. Unplug it and the box carries on with its built-in models. *Not yet tested on real hardware.*

## Privacy and security

- The models, speech recognition and voices run on the box. Once the models are downloaded, what you say and type isn't sent anywhere.
- The internet is used to download models during setup, and for updates when you or Speck ask for them.
- **Speck has full control of the machine.** That's the design, but it means anything running inside Speck, **including plugins, is as trusted as the administrator**. Only install plugins you trust.
- Found a security problem? Please report it privately through [GitHub's security advisories](https://github.com/doctarock/speck-os/security/advisories/new).

## Known limitations

- Not yet tested on real hardware (see the status note at the top).
- The wake word has only been tested with synthetic voices. If "Hey Speck" is often missed in your voice, please say so in an issue.
- English only, for now.
- Speech recognition always runs on the box; the browser's built-in online recognition isn't available, because the kiosk runs Chromium.

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works and why.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): building a box by hand, image build options, per-phase checks and the test suites.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute.

## License

Speck OS is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License](LICENSE), version 3 or (at your option) any later version (`AGPL-3.0-or-later`). Copyright (C) 2026 Derek Robertson and Speck OS contributors.

An image bundles other software and models under their own licenses, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
