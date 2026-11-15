# Third-party notices

Speck OS itself (this repository) is licensed under the GNU Affero General Public License v3.0; see [LICENSE](LICENSE).

A Speck OS image is an aggregate: it bundles other software and models, each under its own license. None of them is relicensed by Speck OS. This file lists them and says where to find their terms and source.

## Software in the image

| Component | License | Notes |
|---|---|---|
| Speck | MIT | The UI and agent. Copyright (c) 2026 Speck. |
| Genesis runtime | GPL-3.0 | The runtime Speck runs on. |
| Ubuntu 24.04 LTS packages (Linux kernel, GRUB, shim, systemd, NetworkManager, PipeWire, cage, Mesa, firmware, …) | Various: GPL-2.0, GPL-3.0, LGPL, MIT, BSD and others | Each package's terms are in `/usr/share/doc/<package>/copyright` on the installed system. |
| [Chromium](https://www.chromium.org/) (from the [xtradeb PPA](https://launchpad.net/~xtradeb/+archive/ubuntu/apps)) | BSD-3-Clause and others | The kiosk browser. Its full credits are at `chrome://credits`. |
| [Node.js 22](https://nodejs.org/) (NodeSource packages) | MIT and others | Bundled licenses in `/usr/share/doc/nodejs/`. |
| [llama.cpp / ggml](https://github.com/ggml-org/llama.cpp) | MIT | Built from source during the image build. |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node`) | Apache-2.0 | Offline speech recognition and synthesis. |
| [ws](https://github.com/websockets/ws) | MIT | |
| [transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`) | Apache-2.0 | Runs the NLI checker. |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-node`, `onnxruntime-web`) | MIT | |
| [sharp](https://github.com/lovell/sharp) / libvips | Apache-2.0 / LGPL-3.0-or-later | Dependency of transformers.js; libvips is dynamically linked. |
| Other npm dependencies of `voice/` and `nli/` | MIT, Apache-2.0, BSD-3-Clause, ISC, 0BSD | Exact versions are in `voice/package-lock.json` and `nli/package-lock.json`; each package's license is in its `node_modules` folder on the installed system. |

### Source code for GPL and LGPL components

Everything installed from the Ubuntu archive has its corresponding source in the same archive (`apt-get source <package>`, or <https://launchpad.net/ubuntu/+source/>). The exact package versions in an image are recorded in `/var/lib/dpkg/status` on that image. llama.cpp is built from its public Git repository at the commit recorded in `/etc/speck-os/versions`. Chromium's source is published with each xtradeb build on Launchpad.

If you got a Speck OS image and can't get the source of a GPL or LGPL component it contains, open an issue on this repository and we will provide it, for at least three years after the image's release.

## Models in the image

| Model | License | Notes |
|---|---|---|
| [Kroko streaming English](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) (`sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06`) | CC-BY-SA-4.0 | Speech recognition. **Attribution:** Kroko ASR by Banafo. Changes: none (repackaged by the sherpa-onnx project). |
| [Kitten TTS nano 0.8](https://github.com/KittenML/KittenTTS) (int8) | Apache-2.0 | Speech synthesis. |
| [Kokoro 82M v0.19](https://huggingface.co/hexgrad/Kokoro-82M) | Apache-2.0 | Speech synthesis. |
| espeak-ng data (`espeak-ng-data`, shipped inside the TTS models) | GPL-3.0-or-later | Phonemisation data from [eSpeak NG](https://github.com/espeak-ng/espeak-ng). |
| [DeBERTa-v3-large-mnli-fever-anli-ling-wanli](https://huggingface.co/MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli) | MIT | The NLI checker. Speck OS ships a weight-only 8-bit conversion of its fp32 ONNX export (see `nli/tools/`). |

## Models downloaded on the device

The base language models are not in the image unless it was built with `--bake-models`; first-boot setup downloads them from Hugging Face. Their licenses apply to whoever downloads and uses them:

| Model | License |
|---|---|
| Qwen3 (0.6B, 4B, 8B, 14B, 30B-A3B, 32B) GGUF | Apache-2.0 |
| [iromu/Qwen3-0.6B-tools](https://huggingface.co/iromu/Qwen3-0.6B-tools-GGUF) | Apache-2.0 |
| [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF) | Apache-2.0 |
| [LiquidAI LFM2.5-1.2B-Instruct](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF) | LFM Open License v1.0 (not an OSI license; includes limits on commercial use) |

An image built with `--bake-models` contains these files, and its distributor must comply with their licenses too.

## Trademarks

Ubuntu is a trademark of Canonical Ltd. Chromium and Google Chrome are trademarks of Google LLC. Speck OS is not affiliated with or endorsed by either.
