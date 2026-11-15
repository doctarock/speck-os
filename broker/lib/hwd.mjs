// Hardware detection and planning for speck-hwd. Pure functions over sysfs, /proc and tool output,
// so everything here is testable from recorded fixtures (hwd/probe/capture-fixture.sh).
import fs from "node:fs/promises";
import path from "node:path";

export const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const VENDORS = { "10de": "nvidia", "1002": "amd", "1022": "amd", "8086": "intel" };
// AMD APU graphics: Raven/Picasso, Renoir, Cezanne, Lucienne, Raphael, Barcelo, Rembrandt (6950H),
// Phoenix/Hawk Point, Strix Point, Strix Halo, Van Gogh, Mendocino, Krackan.
const AMD_APU_IDS = new Set(["15dd", "15d8", "1636", "1638", "164c", "164e", "15e7", "1681", "15bf", "15c8", "150e", "1586", "163f", "1506", "1114"]);

/** Every PCI function, from /sys/bus/pci/devices/<slot>/uevent and a few attribute files. */
export async function readPciDevices(sysfsRoot = "/sys") {
  const base = path.join(sysfsRoot, "bus", "pci", "devices");
  const slots = await fs.readdir(base).catch(() => []);
  const devices = [];
  for (const slot of slots.sort()) {
    const dir = path.join(base, slot);
    const uevent = parseKeyValues(await fs.readFile(path.join(dir, "uevent"), "utf8").catch(() => ""));
    if (!uevent.PCI_ID) continue;
    const [vendorId, deviceId] = uevent.PCI_ID.toLowerCase().split(":");
    const attr = (name) => fs.readFile(path.join(dir, name), "utf8").then((text) => text.trim(), () => null);
    const vram = await attr("mem_info_vram_total");
    devices.push({
      slot: uevent.PCI_SLOT_NAME || slot,
      vendorId, deviceId,
      classCode: (uevent.PCI_CLASS || "").toLowerCase().padStart(6, "0"),
      driver: uevent.DRIVER || null,
      bootVga: (await attr("boot_vga")) === "1",
      vramBytes: vram != null && /^\d+$/.test(vram) ? Number(vram) : null,
      link: { speed: await attr("current_link_speed"), width: await attr("current_link_width") }
    });
  }
  return devices.sort((a, b) => a.slot.localeCompare(b.slot));
}

/** GPUs, each marked integrated or discrete. Virtual display adapters (VM) are kind "other". */
export function classifyGpus(devices) {
  return devices.filter((d) => d.classCode.startsWith("03")).map((d) => {
    const vendor = VENDORS[d.vendorId] ?? "other";
    let kind;
    if (vendor === "intel") kind = d.slot.endsWith(":00:02.0") ? "integrated" : "discrete";
    else if (vendor === "amd") kind = AMD_APU_IDS.has(d.deviceId) || (d.vramBytes != null && d.vramBytes < 2 * GiB) ? "integrated" : "discrete";
    else if (vendor === "nvidia") kind = "discrete";
    else kind = "other";
    return { ...d, vendor, kind };
  });
}

/** NPUs: AMD XDNA (signal processing class 1180) and Intel NPU (processing accelerator 1200). */
export function findNpus(devices) {
  return devices
    .filter((d) => (d.vendorId === "1022" && d.classCode.startsWith("1180")) || (d.vendorId === "8086" && d.classCode.startsWith("1200")))
    .map((d) => ({ ...d, vendor: VENDORS[d.vendorId], ready: ["amdxdna", "intel_vpu"].includes(d.driver) }));
}

/** The eGPU to use: the discrete GPU with the most known VRAM (first by slot when unknown). */
export function pickEgpu(gpus) {
  const discrete = gpus.filter((g) => g.kind === "discrete");
  return discrete.sort((a, b) => (b.vramBytes ?? 0) - (a.vramBytes ?? 0) || a.slot.localeCompare(b.slot))[0] ?? null;
}

export const fingerprint = (gpu) => `${gpu.vendorId}:${gpu.deviceId}@${gpu.slot}`;

export async function readCpu(procRoot = "/proc") {
  const cpuinfo = await fs.readFile(path.join(procRoot, "cpuinfo"), "utf8").catch(() => "");
  const meminfo = await fs.readFile(path.join(procRoot, "meminfo"), "utf8").catch(() => "");
  const first = parseKeyValues(cpuinfo.split(/\n\s*\n/)[0] ?? "", ":");
  const flags = new Set((first.flags ?? "").split(/\s+/));
  const memKb = Number.parseInt(parseKeyValues(meminfo, ":").MemTotal ?? "0", 10);
  return {
    model: first["model name"] ?? "unknown",
    cores: Number(first["cpu cores"] ?? 0) || null,
    threads: (cpuinfo.match(/^processor\s*:/gm) ?? []).length || null,
    avx2: flags.has("avx2"),
    avx512: flags.has("avx512f"),
    memoryBytes: memKb * 1024
  };
}

/** `vulkaninfo --summary`: devices in enumeration order, which is what GGML_VK_VISIBLE_DEVICES indexes. */
export function parseVulkanSummary(text) {
  const devices = [];
  for (const block of String(text).split(/^GPU(?=\d+:)/m).slice(1)) {
    const index = Number.parseInt(block, 10);
    const kv = parseKeyValues(block, "=");
    const type = (kv.deviceType ?? "").replace("PHYSICAL_DEVICE_TYPE_", "");
    devices.push({
      index,
      vendorId: hex4(kv.vendorID),
      deviceId: hex4(kv.deviceID),
      type: { INTEGRATED_GPU: "integrated", DISCRETE_GPU: "discrete", CPU: "cpu", VIRTUAL_GPU: "virtual" }[type] ?? "other",
      name: kv.deviceName ?? ""
    });
  }
  return devices;
}

/** `nvidia-smi --query-gpu=uuid,pci.bus_id,memory.total --format=csv,noheader,nounits` */
export function parseNvidiaSmi(text) {
  return String(text).trim().split("\n").filter(Boolean).map((line) => {
    const [uuid, busId, memoryMiB] = line.split(",").map((s) => s.trim());
    const [domain, bus, devfn] = busId.split(":");   // "00000000:01:00.0" → "0000:01:00.0"
    return { uuid, slot: `${domain.slice(-4)}:${bus}:${devfn}`.toLowerCase(), memoryBytes: Number(memoryMiB) * MiB };
  });
}

/** `llama-server --list-devices`: "  Vulkan0: NAME (TOTAL MiB, FREE MiB free)". */
export function parseLlamaDevices(text) {
  const devices = [];
  for (const m of String(text).matchAll(/^\s*([A-Za-z]+?)(\d+): (.+?) \((\d+) MiB, (\d+) MiB free\)\s*$/gm)) {
    devices.push({ id: `${m[1]}${m[2]}`, backend: m[1], name: m[3], totalBytes: Number(m[4]) * MiB, freeBytes: Number(m[5]) * MiB });
  }
  return devices;
}

/** The Vulkan enumeration index of a PCI GPU (matched on IDs and integrated/discrete), or null. */
export function vulkanIndexFor(vkDevices, gpu, gpus = [gpu]) {
  const same = gpus.filter((g) => g.vendorId === gpu.vendorId && g.deviceId === gpu.deviceId).sort((a, b) => a.slot.localeCompare(b.slot));
  const matches = vkDevices.filter((v) => v.vendorId === gpu.vendorId && v.deviceId === gpu.deviceId);
  const nth = Math.max(0, same.findIndex((g) => g.slot === gpu.slot));
  return matches[nth]?.index ?? null;
}

/**
 * Environment that confines one llama-server to one device. Returns null when the device isn't
 * visible to that backend yet (driver missing).
 */
export function deviceEnv(backend, gpu, { vk = [], nvidia = [], gpus = [gpu] } = {}) {
  if (backend === "cuda") {
    const card = nvidia.find((n) => n.slot === gpu.slot);
    return card ? { CUDA_VISIBLE_DEVICES: card.uuid } : null;
  }
  if (backend === "vulkan") {
    const index = vulkanIndexFor(vk, gpu, gpus);
    return index == null ? null : { GGML_VK_VISIBLE_DEVICES: String(index) };
  }
  return null;
}

/**
 * Pick the best catalog model that fits in VRAM. Catalog entries are ordered best first; each is
 * tried at its contexts (largest first). Estimate = weights + KV (q8) per token × ctx + overhead.
 */
export function planWorker(vramBytes, catalog, { headroom = 0.92, overheadBytes = 0.8 * GiB } = {}) {
  if (!vramBytes) return null;
  const budget = vramBytes * headroom;
  for (const entry of catalog) {
    for (const ctx of [...entry.contexts].sort((a, b) => b - a)) {
      const estimate = entry.weightsGB * 1e9 + entry.kvBytesPerToken * ctx + overheadBytes;
      if (estimate <= budget) return { ...entry, ctx, estimateBytes: Math.round(estimate), model: modelIdFromHf(entry.hf) };
    }
  }
  return null;
}

/** "Qwen/Qwen3-14B-GGUF:Q4_K_M" → "qwen3-14b-q4_k_m" */
export function modelIdFromHf(hf) {
  return String(hf).split("/").pop().replace(/-gguf/i, "").replace(":", "-").toLowerCase();
}

/** Recommended device per workload (ARCHITECTURE.md, Accelerator placement). */
export function placement({ gpus, npus }, egpu) {
  const igpu = gpus.find((g) => g.kind === "integrated");
  const npu = npus.find((n) => n.ready) ?? null;
  const onNpuOrCpu = npu ? { device: "npu", slot: npu.slot } : { device: "cpu" };
  return {
    tier: npu ? "npu" : "budget",
    workloads: {
      llmBase: igpu ? { device: "igpu", slot: igpu.slot, backend: "vulkan" } : { device: "cpu" },
      stt: npu ? onNpuOrCpu : { device: "cpu", when: "mic-open" },
      tts: onNpuOrCpu,
      embedder: npu ? onNpuOrCpu : { device: "cpu", when: "idle-batched" },
      nli: npu ? onNpuOrCpu : { device: "cpu", when: "check-due" },
      llmEscalation: egpu?.phase === "ready" ? { device: "egpu", slot: egpu.slot, processor: "egpu", tier: egpu.tier, model: egpu.model } : null
    }
  };
}

function parseKeyValues(text, separator = "=") {
  const out = {};
  for (const line of String(text).split("\n")) {
    const at = line.indexOf(separator);
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key && !(key in out)) out[key] = line.slice(at + separator.length).trim();
  }
  return out;
}

function hex4(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 16);
  return Number.isFinite(n) ? n.toString(16).padStart(4, "0") : null;
}
