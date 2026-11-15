import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPciDevices, classifyGpus, findNpus, pickEgpu, readCpu, parseVulkanSummary, parseNvidiaSmi,
  parseLlamaDevices, deviceEnv, planWorker, GiB
} from "../lib/hwd.mjs";
import { createHwd } from "../lib/egpu.mjs";
import { createSpeckModels } from "../lib/speck-models.mjs";

const MiB = 1024 ** 2;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED = JSON.parse(await fs.readFile(path.join(HERE, "..", "..", "config", "hwd.json"), "utf8"));
const res = (code = 0, stdout = "", stderr = "") => ({ code, stdout, stderr, timedOut: false, truncated: false, durationMs: 1 });

// ---------------------------------------------------------------- fixtures (6950H budget box)

const IGPU = { dir: "c5-00.0", slot: "0000:c5:00.0", id: "1002:1681", cls: "30000", driver: "amdgpu", vram: 512 * MiB, bootVga: "1" };
const XTX = { dir: "03-00.0", slot: "0000:03:00.0", id: "1002:744c", cls: "30000", driver: "amdgpu", vram: 24 * GiB, link: ["16.0 GT/s PCIe", "4"] };
const RTX = { dir: "03-00.0", slot: "0000:03:00.0", id: "10de:2786", cls: "30000", driver: "nouveau" };
const XDNA = { dir: "c6-00.1", slot: "0000:c6:00.1", id: "1022:1502", cls: "118000", driver: "amdxdna" };
const CPUINFO = "processor\t: 0\nmodel name\t: AMD Ryzen 9 PRO 6950H with Radeon Graphics\ncpu cores\t: 8\nflags\t\t: fpu sse2 avx avx2 fma\n\n"
  + Array.from({ length: 15 }, (_, i) => `processor\t: ${i + 1}\n`).join("\n");

const vkSummary = (devices) => `==========\nVULKANINFO\n==========\n\nDevices:\n========\n${devices.map(([vendor, device, type, name], i) =>
  `GPU${i}:\n\tapiVersion         = 1.3.274\n\tvendorID           = 0x${vendor}\n\tdeviceID           = 0x${device}\n\tdeviceType         = PHYSICAL_DEVICE_TYPE_${type}\n\tdeviceName         = ${name}\n`).join("")}`;
const VK_XTX = vkSummary([["1002", "744c", "DISCRETE_GPU", "AMD Radeon RX 7900 XTX (RADV NAVI31)"], ["1002", "1681", "INTEGRATED_GPU", "AMD Radeon Graphics (RADV REMBRANDT)"], ["10005", "0000", "CPU", "llvmpipe"]]);
const VK_IGPU = vkSummary([["1002", "1681", "INTEGRATED_GPU", "AMD Radeon Graphics (RADV REMBRANDT)"], ["10005", "0000", "CPU", "llvmpipe"]]);
const VK_RTX = vkSummary([["1002", "1681", "INTEGRATED_GPU", "AMD Radeon Graphics (RADV REMBRANDT)"], ["10de", "2786", "DISCRETE_GPU", "NVIDIA GeForce RTX 4070"], ["10005", "0000", "CPU", "llvmpipe"]]);

async function writeDevices(root, devices) {
  const base = path.join(root, "sys", "bus", "pci", "devices");
  await fs.rm(base, { recursive: true, force: true });
  for (const d of devices) {
    // Directory names avoid ":" (Windows); the slot comes from uevent as on Linux.
    const dir = path.join(base, d.dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "uevent"), `${d.driver ? `DRIVER=${d.driver}\n` : ""}PCI_CLASS=${d.cls}\nPCI_ID=${d.id.toUpperCase()}\nPCI_SLOT_NAME=${d.slot}\n`);
    if (d.vram != null) await fs.writeFile(path.join(dir, "mem_info_vram_total"), `${d.vram}\n`);
    if (d.bootVga != null) await fs.writeFile(path.join(dir, "boot_vga"), `${d.bootVga}\n`);
    if (d.link) {
      await fs.writeFile(path.join(dir, "current_link_speed"), `${d.link[0]}\n`);
      await fs.writeFile(path.join(dir, "current_link_width"), `${d.link[1]}\n`);
    }
  }
}

async function makeRoot(devices) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hwd-"));
  await writeDevices(root, devices);
  await fs.mkdir(path.join(root, "proc"));
  await fs.writeFile(path.join(root, "proc", "cpuinfo"), CPUINFO);
  await fs.writeFile(path.join(root, "proc", "meminfo"), "MemTotal:       32000000 kB\nMemAvailable:   20000000 kB\n");
  await fs.mkdir(path.join(root, "etc", "workers"), { recursive: true });
  await fs.writeFile(path.join(root, "etc", "llama-backend"), "vulkan\n");
  await addBuild(root, "vulkan");
  return root;
}

async function addBuild(root, backend) {
  const bin = path.join(root, "llama", `build-${backend}`, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "llama-server"), "");
}

/** A machine: fake commands, broker ops and Speck, around a real hwd on a temp root. */
async function machine(devices, { vk, nvidia = () => "", nvidiaOk = () => false } = {}) {
  const root = await makeRoot(devices);
  const box = { root, calls: [], ops: [], registered: [], disabled: [], audit: [], units: { enabled: false, active: false }, vk, nvidia, nvidiaOk };
  const run = async (command, args = []) => {
    box.calls.push([command, ...args].join(" "));
    if (command === "vulkaninfo") return res(0, box.vk());
    if (command === "nvidia-smi") return box.nvidia() ? res(0, box.nvidia()) : res(127, "", "not found");
    if (command === "bash" && args[1] === "nvidia-smi -L") return res(box.nvidiaOk() ? 0 : 9);
    if (command === "systemctl") {
      const [action, unit] = args;
      if (action === "is-enabled") return res(0, box.units.enabled ? "enabled\n" : "disabled\n");
      if (action === "is-active") return res(0, box.units.active ? "active\n" : "inactive\n");
      if (action === "show") return res(0, "0\n");
      if (action === "is-failed") return res(1);
      if (action === "list-units") return res(0, "infer@worker.service loaded active running a\ninfer@embed.service loaded active running b\ninfer@egpu.service loaded active running c\n");
      if (action === "restart" && unit === "infer@egpu.service") box.units.active = true;
      if (action === "stop" && unit === "infer@egpu.service") box.units.active = false;
      return res(0);
    }
    return res(0);
  };
  const ops = {
    exec: async (body) => {
      box.ops.push(`exec ${body.script.trim()}`);
      const build = body.script.match(/build-llama\.sh (\w+)/);
      if (build && !box.failBuild?.includes(build[1])) await addBuild(root, build[1]);
      return build && box.failBuild?.includes(build[1]) ? { ok: false, stderr: "nvcc fatal" } : { ok: true, stdout: "", stderr: "" };
    },
    service: async (body) => {
      box.ops.push(`service ${body.action} ${body.unit}`);
      if (body.action === "enable") box.units.enabled = true;
      if (body.action === "disable") box.units.enabled = false;
      return { ok: true };
    },
    power: async (body) => { box.ops.push(`power ${body.action}`); return { ok: true }; }
  };
  box.hwd = createHwd({
    run, ops,
    speck: {
      upsert: async (p) => { box.registered.push(p); return { via: "speck", changed: true }; },
      disable: async (id) => { box.disabled.push(id); return { via: "speck", changed: true }; }
    },
    audit: { append: async (e) => { box.audit.push(e); } },
    probeHealth: async () => ({ ok: true }),
    sleep: async () => {},
    config: {
      ...SHIPPED,
      paths: {
        sysfs: path.join(root, "sys"), proc: path.join(root, "proc"),
        workersDir: path.join(root, "etc", "workers"), runDir: path.join(root, "run"),
        stateFile: path.join(root, "state", "hwd.json"), placementFile: path.join(root, "state", "placement.json"),
        llamaRoot: path.join(root, "llama"), baseBackendFile: path.join(root, "etc", "llama-backend"),
        buildScript: "/usr/lib/speck-os/build-llama.sh"
      }
    }
  });
  box.reconcile = async (opts) => {
    box.hwd.start(opts);
    await box.hwd.job().promise;
    return box.hwd.job();
  };
  box.read = (...p) => fs.readFile(path.join(root, ...p), "utf8").catch(() => null);
  box.state = async () => JSON.parse(await box.read("state", "hwd.json"));
  return box;
}

// ---------------------------------------------------------------- detection + parsing

test("detects the 6950H iGPU, an OCuLink 7900 XTX and the XDNA NPU", async () => {
  const root = await makeRoot([IGPU, XTX, XDNA]);
  const pci = await readPciDevices(path.join(root, "sys"));
  const gpus = classifyGpus(pci);
  assert.deepEqual(gpus.map((g) => [g.slot, g.vendor, g.kind]), [["0000:03:00.0", "amd", "discrete"], ["0000:c5:00.0", "amd", "integrated"]]);
  assert.equal(pickEgpu(gpus).deviceId, "744c");
  assert.deepEqual(pickEgpu(gpus).link, { speed: "16.0 GT/s PCIe", width: "4" });
  const npus = findNpus(pci);
  assert.equal(npus.length, 1);
  assert.equal(npus[0].ready, true);
  const cpu = await readCpu(path.join(root, "proc"));
  assert.match(cpu.model, /6950H/);
  assert.deepEqual([cpu.cores, cpu.threads, cpu.avx2, cpu.avx512], [8, 16, true, false]);
});

test("Intel iGPU at 00:02.0 is integrated, an Arc card is discrete, VM adapters are ignored", async () => {
  const root = await makeRoot([
    { dir: "a", slot: "0000:00:02.0", id: "8086:a7a0", cls: "30000", driver: "i915" },
    { dir: "b", slot: "0000:03:00.0", id: "8086:56a0", cls: "30000", driver: "i915" },
    { dir: "c", slot: "0000:00:01.0", id: "1af4:1050", cls: "30000", driver: "virtio-pci" },
    { dir: "d", slot: "0000:00:1f.0", id: "8086:7a06", cls: "60100", driver: null }
  ]);
  const gpus = classifyGpus(await readPciDevices(path.join(root, "sys")));
  assert.deepEqual(gpus.map((g) => [g.slot, g.kind]), [["0000:00:01.0", "other"], ["0000:00:02.0", "integrated"], ["0000:03:00.0", "discrete"]]);
  assert.equal(pickEgpu(gpus).slot, "0000:03:00.0");
});

test("parsers: vulkaninfo order → device pinning, nvidia-smi, llama-server --list-devices", () => {
  const vk = parseVulkanSummary(VK_XTX);
  assert.deepEqual(vk.map((d) => [d.index, d.vendorId, d.deviceId, d.type]), [[0, "1002", "744c", "discrete"], [1, "1002", "1681", "integrated"], [2, "10005", "0000", "cpu"]]);
  const gpus = [{ ...IGPU, vendorId: "1002", deviceId: "1681" }, { ...XTX, vendorId: "1002", deviceId: "744c" }];
  assert.deepEqual(deviceEnv("vulkan", gpus[0], { vk, gpus }), { GGML_VK_VISIBLE_DEVICES: "1" });
  assert.deepEqual(deviceEnv("vulkan", gpus[1], { vk, gpus }), { GGML_VK_VISIBLE_DEVICES: "0" });

  const nvidia = parseNvidiaSmi("GPU-1234-abcd, 00000000:03:00.0, 12282\n");
  assert.deepEqual(nvidia, [{ uuid: "GPU-1234-abcd", slot: "0000:03:00.0", memoryBytes: 12282 * MiB }]);
  assert.deepEqual(deviceEnv("cuda", { slot: "0000:03:00.0" }, { nvidia }), { CUDA_VISIBLE_DEVICES: "GPU-1234-abcd" });
  assert.equal(deviceEnv("cuda", { slot: "0000:04:00.0" }, { nvidia }), null);

  const listed = parseLlamaDevices("ggml_vulkan: Found 1 Vulkan devices:\nAvailable devices:\n  Vulkan0: Intel(R) Arc(tm) A770 Graphics (DG2) (16288 MiB, 15900 MiB free)\n");
  assert.deepEqual(listed.map((d) => [d.id, d.totalBytes]), [["Vulkan0", 16288 * MiB]]);
});

test("planWorker: the largest model whose weights + q8 KV + overhead fit the VRAM", () => {
  const plan = (gib) => { const p = planWorker(gib * GiB, SHIPPED.catalog, SHIPPED.egpu); return p && `${p.model}@${p.ctx / 1024}k/t${p.tier}`; };
  assert.equal(plan(6), null);
  assert.equal(plan(8), "qwen3-8b-q4_k_m@16k/t3");
  assert.equal(plan(12), "qwen3-14b-q4_k_m@16k/t3");
  assert.equal(plan(16), "qwen3-14b-q4_k_m@32k/t3");
  assert.equal(plan(24), "qwen3-30b-a3b-q4_k_m@32k/t4");
  assert.equal(plan(32), "qwen3-32b-q4_k_m@32k/t4");
});

// ---------------------------------------------------------------- reconcile

test("AMD eGPU: base workers pinned to the iGPU, eGPU worker planned, started and registered as tier 4", async () => {
  const box = await machine([IGPU, XTX], { vk: () => VK_XTX });
  const job = await box.reconcile({ trigger: "boot", reboot: "auto" });
  assert.equal(job.result, "ready", job.message);

  assert.match(await box.read("run", "base.env"), /^GGML_VK_VISIBLE_DEVICES=1$/m);
  const env = await box.read("etc", "workers", "egpu.env");
  assert.match(env, /^MODEL_HF=Qwen\/Qwen3-30B-A3B-GGUF:Q4_K_M$/m);
  assert.match(env, /^CTX=32768$/m);
  assert.match(env, /^LLAMA_BACKEND=vulkan$/m);
  assert.match(env, /^GGML_VK_VISIBLE_DEVICES=0$/m);
  assert.match(env, /^EXTRA_ARGS="--jinja -ngl 99 -fa on/m);
  assert.ok(await box.read("run", "egpu.ok"));

  assert.ok(box.ops.includes("service enable infer@egpu.service"));
  assert.ok(box.calls.includes("systemctl restart infer@egpu.service"));
  assert.ok(!box.ops.some((o) => o.startsWith("exec")), "no driver or build needed");
  assert.equal(box.registered.length, 1);
  assert.deepEqual(
    (({ id, provider, model, baseUrl, tier, contextSize }) => ({ id, provider, model, baseUrl, tier, contextSize }))(box.registered[0]),
    { id: "egpu", provider: "llama.cpp", model: "qwen3-30b-a3b-q4_k_m", baseUrl: "http://127.0.0.1:8090", tier: 4, contextSize: 32768 }
  );
  const placement = JSON.parse(await box.read("state", "placement.json"));
  assert.equal(placement.tier, "budget");
  assert.equal(placement.workloads.llmEscalation.processor, "egpu");
  assert.equal(placement.workloads.llmBase.device, "igpu");

  // Same hardware again: nothing restarts, nothing is re-registered as changed.
  box.calls.length = 0;
  const again = await box.reconcile({ trigger: "boot", reboot: "auto" });
  assert.equal(again.result, "ready");
  assert.ok(!box.calls.includes("systemctl restart infer@egpu.service"));
  assert.ok(!box.calls.some((c) => c.startsWith("systemctl restart infer@worker")));
});

test("NVIDIA eGPU: driver install + reboot, then Vulkan at once, then CUDA once built", async () => {
  let driver = false;
  const box = await machine([IGPU, RTX], {
    vk: () => VK_RTX,
    nvidia: () => (driver ? "GPU-aaaa-bbbb, 00000000:03:00.0, 12282\n" : ""),
    nvidiaOk: () => driver
  });
  const first = await box.reconcile({ trigger: "boot", reboot: "auto" });
  assert.equal(first.result, "rebooting");
  assert.deepEqual(box.ops, ["exec bash /usr/lib/speck-os/hwd/drivers/nvidia.sh", "power reboot"]);
  assert.equal((await box.state()).egpu.driverAttempts, 1);

  // After the reboot: nvidia bound, the driver works.
  driver = true;
  await writeDevices(box.root, [IGPU, { ...RTX, driver: "nvidia" }]);
  box.ops.length = 0;
  const second = await box.reconcile({ trigger: "boot", reboot: "auto" });
  assert.equal(second.result, "ready", second.message);
  assert.deepEqual(box.ops, ["service enable infer@egpu.service", "exec bash /usr/lib/speck-os/build-llama.sh cuda"]);
  assert.equal(box.registered.length, 2, "registered on vulkan, then again on cuda");
  const env = await box.read("etc", "workers", "egpu.env");
  assert.match(env, /^LLAMA_BACKEND=cuda$/m);
  assert.match(env, /^CUDA_VISIBLE_DEVICES=GPU-aaaa-bbbb$/m);
  assert.match(env, /^MODEL_HF=Qwen\/Qwen3-14B-GGUF:Q4_K_M$/m);   // 12 GB card
  const state = await box.state();
  assert.equal(state.egpu.backend, "cuda");
  assert.equal(state.egpu.driverAttempts, 0);
  assert.match(second.log.map((l) => l.message).join("\n"), /serves on vulkan meanwhile/);
});

test("a failed CUDA build leaves the card serving on Vulkan, and isn't retried every boot", async () => {
  const box = await machine([IGPU, { ...RTX, driver: "nvidia" }], {
    vk: () => VK_RTX, nvidia: () => "GPU-aaaa, 00000000:03:00.0, 16376\n", nvidiaOk: () => true
  });
  box.failBuild = ["cuda"];
  const job = await box.reconcile({ trigger: "boot", reboot: "auto" });
  assert.equal(job.result, "ready");
  assert.match(await box.read("etc", "workers", "egpu.env"), /^LLAMA_BACKEND=vulkan$/m);
  assert.ok((await box.state()).egpu.failedBuilds.cuda);
  box.ops.length = 0;
  await box.reconcile({ trigger: "boot", reboot: "auto" });
  assert.ok(!box.ops.some((o) => o.includes("build-llama.sh cuda")), "not retried at boot");
  await box.reconcile({ trigger: "agent" });
  assert.ok(box.ops.some((o) => o.includes("build-llama.sh cuda")), "retried when asked");
});

test("a driver that never loads is tried twice, then reported instead of looping reboots", async () => {
  const box = await machine([IGPU, RTX], { vk: () => VK_RTX });
  assert.equal((await box.reconcile({ reboot: "auto" })).result, "rebooting");
  assert.equal((await box.reconcile({ reboot: "auto" })).result, "rebooting");
  box.ops.length = 0;
  const third = await box.reconcile({ reboot: "auto" });
  assert.equal(third.result, "failed");
  assert.match(third.message, /already ran 2 times/);
  assert.deepEqual(box.ops, []);
});

test("without auto reboot (agent or CLI) a new driver waits for the agent to reboot", async () => {
  const box = await machine([IGPU, RTX], { vk: () => VK_RTX });
  const job = await box.reconcile({ trigger: "agent" });
  assert.equal(job.result, "reboot-required");
  assert.ok(!box.ops.includes("power reboot"));
});

test("eGPU unplugged: worker stopped and disabled, processor taken out of routing, base unpinned", async () => {
  const box = await machine([IGPU, XTX], { vk: () => VK_XTX });
  await box.reconcile({ reboot: "auto" });
  await writeDevices(box.root, [IGPU]);
  box.vk = () => VK_IGPU;
  box.calls.length = 0;
  box.ops.length = 0;
  const job = await box.reconcile({ reboot: "auto" });
  assert.equal(job.result, "absent");
  assert.ok(box.calls.includes("systemctl stop infer@egpu.service"));
  assert.ok(box.ops.includes("service disable infer@egpu.service"));
  assert.deepEqual(box.disabled, ["egpu"]);
  assert.equal(await box.read("run", "base.env"), "");
  assert.ok(box.calls.includes("systemctl restart infer@worker.service infer@embed.service"), "base workers pick up the unpinning");
  assert.equal(await box.read("run", "egpu.ok"), null);
  const placement = JSON.parse(await box.read("state", "placement.json"));
  assert.equal(placement.workloads.llmEscalation, null);
});

test("edits to egpu.env are kept while the card is unchanged", async () => {
  const box = await machine([IGPU, XTX], { vk: () => VK_XTX });
  await box.reconcile({ reboot: "auto" });
  const file = path.join(box.root, "etc", "workers", "egpu.env");
  const edited = (await fs.readFile(file, "utf8")).replace(/^MODEL_HF=.*$/m, "MODEL_HF=Qwen/Qwen3-14B-GGUF:Q4_K_M");
  await fs.writeFile(file, edited);
  const job = await box.reconcile({ trigger: "agent" });
  assert.equal(job.result, "ready");
  assert.equal(await fs.readFile(file, "utf8"), edited);
  const last = box.registered.at(-1);
  assert.deepEqual([last.model, last.tier], ["qwen3-14b-q4_k_m", 3]);
});

test("boot gate: infer@egpu may start only on the same card at the same device index", async () => {
  const box = await machine([IGPU, XTX], { vk: () => VK_XTX });
  await box.reconcile({ reboot: "auto" });
  assert.equal((await box.hwd.boot()).egpuWorkerAllowed, true);
  assert.ok(await box.read("run", "egpu.ok"));
  // Vulkan enumeration changed (index 0 is now the iGPU): stale index → don't start until reconciled.
  box.vk = () => vkSummary([["1002", "1681", "INTEGRATED_GPU", "iGPU"], ["1002", "744c", "DISCRETE_GPU", "XTX"]]);
  assert.equal((await box.hwd.boot()).egpuWorkerAllowed, false);
  assert.equal(await box.read("run", "egpu.ok"), null);
  assert.match(await box.read("run", "base.env"), /^GGML_VK_VISIBLE_DEVICES=0$/m);
  const job = await box.reconcile({ reboot: "auto" });
  assert.equal(job.result, "ready");
  assert.match(await box.read("etc", "workers", "egpu.env"), /^GGML_VK_VISIBLE_DEVICES=1$/m);
});

test("a second reconcile while one runs is refused", async () => {
  const box = await machine([IGPU, XTX], { vk: () => VK_XTX });
  box.hwd.start({});
  assert.throws(() => box.hwd.start({}), (error) => error.status === 409);
  await box.hwd.job().promise;
});

test("a card too small for the catalog is reported, not registered", async () => {
  const box = await machine([IGPU, { ...XTX, id: "1002:7480", vram: 6 * GiB }], { vk: () => VK_XTX.replace("744c", "7480") });
  const job = await box.reconcile({ reboot: "auto" });
  assert.equal(job.result, "failed");
  assert.match(job.message, /too small/);
  assert.equal(box.registered.length, 0);
});

// ---------------------------------------------------------------- Speck registration

test("speck-models: live through Speck's config API, file when Speck is down, rejections surface", async () => {
  const posted = [];
  let processors = [{ id: "qwen3-4b", provider: "llama.cpp", model: "qwen3-4b-q4_k_m", baseUrl: "http://127.0.0.1:8080", tier: 2, contextSize: 32768, hardware: "budget-local", specialties: ["general"], enabled: true }];
  const roles = { intake: "qwen3-4b", planner: "qwen3-4b", worker: "qwen3-4b", toolCaller: "qwen3-4b", specialists: {} };
  let up = true;
  let reject = false;
  const fetch = async (url, init = {}) => {
    if (!up) throw new Error("ECONNREFUSED");
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      posted.push(body);
      if (reject) return { ok: false, status: 400, json: async () => ({ error: "processor egpu tier must be 1 through 4" }) };
      processors = body.processors;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ brains: { processors, roles } }) };
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "speck-models-"));
  const file = path.join(dir, "model-processors.json");
  await fs.writeFile(file, JSON.stringify({ processors, roles, embedding: { enabled: true } }));
  const models = createSpeckModels({ file, fetch });
  const egpu = { id: "egpu", provider: "llama.cpp", model: "qwen3-14b-q4_k_m", baseUrl: "http://127.0.0.1:8090", tier: 3, contextSize: 32768, hardware: "egpu", specialties: ["general"], enabled: true };

  assert.deepEqual(await models.upsert(egpu), { via: "speck", changed: true });
  assert.deepEqual(posted[0].roles, roles, "roles untouched");
  assert.deepEqual(posted[0].processors.map((p) => p.id), ["qwen3-4b", "egpu"]);
  // Same processor with keys in another order: no re-save.
  const reordered = Object.fromEntries(Object.entries(egpu).reverse());
  assert.deepEqual(await models.upsert(reordered), { via: "speck", changed: false });
  assert.equal(posted.length, 1);

  reject = true;
  await assert.rejects(models.upsert({ ...egpu, tier: 3, contextSize: 16384 }), /rejected/);

  up = false;
  // Speck down: the saved file (which never got the live-only egpu entry) is edited instead.
  assert.deepEqual(await models.disable("egpu"), { via: "file", changed: false });
  assert.deepEqual(await models.upsert(egpu), { via: "file", changed: true });
  assert.deepEqual(await models.disable("egpu"), { via: "file", changed: true });
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(saved.embedding, { enabled: true }, "rest of the file kept");
  assert.deepEqual(saved.processors.map((p) => [p.id, p.enabled]), [["qwen3-4b", true], ["egpu", false]]);
});
