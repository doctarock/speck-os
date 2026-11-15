import fs from "node:fs/promises";
import { runOk } from "./run.mjs";

/**
 * Boot-level recovery.
 *
 * Layout (btrfs top level):  @ (root)  @good (last known good, writable)  @snapshots  @speck  @speck-infer
 * GRUB (/etc/grub.d/09_speck-bootcount) increments speck_try in /boot/grub/grubenv every boot and
 * boots the "speck-good" entry once two boots in a row never reached bootOk(). A fallback boot
 * carries speck.fallback=1 on the kernel command line; bootOk() then promotes @good to @ (keeping
 * the failed root as @broken-<time>) and reboots into it.
 */
export function createBootGuard({ run, audit, health, config = {}, now = () => new Date() }) {
  const top = config.topLevelMount ?? "/run/speck-btrfs";
  const grubenv = config.grubenv ?? "/boot/grub/grubenv";
  const goodBootDir = config.goodBootDir ?? "/boot/speck-good";
  const settleMs = config.settleMs ?? 10 * 60_000;
  let markTimer = null;

  async function cmdline() {
    return config.readCmdline ? config.readCmdline() : fs.readFile("/proc/cmdline", "utf8").catch(() => "");
  }

  async function isFallbackBoot() {
    return /\bspeck\.fallback=1\b/.test(await cmdline());
  }

  async function env() {
    const result = await run("grub-editenv", [grubenv, "list"]);
    if (result.code !== 0) return {};
    return Object.fromEntries(result.stdout.trim().split("\n").filter(Boolean).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
  }

  async function mountTop() {
    if ((await run("mountpoint", ["-q", top])).code === 0) return top;
    const source = (await runOk(run, "findmnt", ["-no", "SOURCE", "/"])).replace(/\[.*\]$/, "");
    await fs.mkdir(top, { recursive: true });
    await runOk(run, "mount", ["-o", "subvolid=5", source, top]);
    return top;
  }

  async function layout() {
    const options = await runOk(run, "findmnt", ["-no", "OPTIONS", "/"]).catch(() => "");
    const fstype = await runOk(run, "findmnt", ["-no", "FSTYPE", "/"]).catch(() => "");
    const subvol = /subvol=\/?([^,]*)/.exec(options)?.[1] ?? "";
    const bootSeparate = (await run("mountpoint", ["-q", "/boot"])).code === 0;
    const ok = fstype === "btrfs" && (subvol === "@" || subvol === "@good") && bootSeparate;
    return { ok, fstype, subvol, bootSeparate,
      reason: ok ? "" : "boot rollback needs btrfs root on subvolume @ and a separate ext4 /boot (provision/phase1.sh sets this up)" };
  }

  /** Make the running root the fallback target. Called once the system has stayed healthy. */
  async function markGood(reason = "settled healthy") {
    const state = await layout();
    if (!state.ok) return { marked: false, reason: state.reason };
    if (await isFallbackBoot()) return { marked: false, reason: "running from the fallback root; promote first" };
    const check = await health();
    if (!check.ok) return { marked: false, reason: `not healthy: ${check.reason}` };

    const mnt = await mountTop();
    if ((await run("btrfs", ["subvolume", "show", `${mnt}/@good`])).code === 0) {
      await runOk(run, "btrfs", ["subvolume", "delete", `${mnt}/@good`]);
    }
    await runOk(run, "btrfs", ["subvolume", "snapshot", `${mnt}/@`, `${mnt}/@good`]);

    // The fallback boots the kernel that was running when it was marked good, so a bad kernel
    // upgrade cannot take the fallback down with it.
    const release = (await runOk(run, "uname", ["-r"]));
    await fs.mkdir(goodBootDir, { recursive: true });
    await fs.copyFile(`/boot/vmlinuz-${release}`, `${goodBootDir}/vmlinuz`);
    await fs.copyFile(`/boot/initrd.img-${release}`, `${goodBootDir}/initrd.img`);
    await runOk(run, "grub-editenv", [grubenv, "set", "speck_good=1"]);
    const grubCfg = await fs.readFile("/boot/grub/grub.cfg", "utf8").catch(() => "");
    if (!grubCfg.includes("--id speck-good")) await runOk(run, "update-grub", [], { timeoutMs: 300_000 });

    await audit.append({ op: "boot.mark-good", reason, kernel: release });
    return { marked: true, kernel: release };
  }

  /** After a mutating op: mark good once the system has stayed healthy for the settle period. */
  function scheduleMarkGood(reason) {
    if (markTimer) clearTimeout(markTimer);
    markTimer = setTimeout(() => {
      markTimer = null;
      markGood(`settled after: ${reason}`).catch((error) => audit.append({ op: "boot.mark-good", error: error.message }));
    }, settleMs);
    markTimer.unref?.();
  }

  async function promoteFallback() {
    const mnt = await mountTop();
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    await runOk(run, "mv", [`${mnt}/@`, `${mnt}/@broken-${stamp}`]);
    await runOk(run, "btrfs", ["subvolume", "snapshot", `${mnt}/@good`, `${mnt}/@`]);
    await runOk(run, "grub-editenv", [grubenv, "unset", "speck_try"]);
    await audit.append({ op: "boot.promote-fallback", kept: `@broken-${stamp}` });
    return { promoted: true, kept: `@broken-${stamp}` };
  }

  /**
   * Run once per boot (speck-boot-ok.service). Healthy normal boot: reset the counter and mark
   * good after settling. Unhealthy normal boot: reboot so GRUB's counter advances toward the
   * fallback. Fallback boot: promote @good and reboot into it.
   */
  async function bootOk({ waitMs = 10 * 60_000, pollMs = 5_000, reboot }) {
    const deadline = Date.now() + waitMs;
    let check = await health();
    while (!check.ok && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      check = await health();
    }
    const fallback = await isFallbackBoot();
    const vars = await env();

    if (fallback) {
      if (!check.ok) {
        await audit.append({ op: "boot.fallback-unhealthy", reason: check.reason });
        return { action: "stay", reason: "fallback root is unhealthy too; staying up for recovery" };
      }
      const promoted = await promoteFallback();
      await reboot("promote fallback root");
      return { action: "promoted", ...promoted };
    }

    if (check.ok) {
      await runOk(run, "grub-editenv", [grubenv, "unset", "speck_try"]).catch(() => {});
      await audit.append({ op: "boot.ok", try: vars.speck_try ?? "" });
      // The caller asks the daemon to mark good after settleMs, so marking is serialised with ops.
      return { action: "ok", settleMs };
    }

    await audit.append({ op: "boot.unhealthy", try: vars.speck_try ?? "", reason: check.reason });
    if (vars.speck_try === "1" || vars.speck_try === "2") {
      await reboot(`unhealthy boot (try ${vars.speck_try})`);
      return { action: "reboot" };
    }
    return { action: "stay", reason: "no fallback left to try; staying up for recovery" };
  }

  /**
   * Before a deliberate reboot (the agent's, or speck-hwd's after a driver install): if this boot
   * is healthy, clear GRUB's counter so the reboot isn't counted as a failed boot. Without this,
   * two quick reboots before speck-boot-ok confirms would send GRUB to the fallback root.
   */
  async function confirmBoot({ waitMs = 5 * 60_000, pollMs = 5_000 } = {}) {
    if (await isFallbackBoot()) return { confirmed: false, reason: "fallback boot" };
    const vars = await env();
    if (!vars.speck_try) return { confirmed: true, already: true };
    const deadline = Date.now() + waitMs;
    let check = await health();
    while (!check.ok && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      check = await health();
    }
    if (!check.ok) return { confirmed: false, reason: check.reason };
    await runOk(run, "grub-editenv", [grubenv, "unset", "speck_try"]).catch(() => {});
    await audit.append({ op: "boot.ok", try: vars.speck_try, by: "deliberate reboot" });
    return { confirmed: true };
  }

  async function status() {
    const state = await layout().catch((error) => ({ ok: false, reason: error.message }));
    const vars = await env();
    return {
      available: state.ok, reason: state.reason || undefined,
      fallbackBoot: await isFallbackBoot(),
      goodMarked: vars.speck_good === "1",
      failedBootsInARow: Math.max(0, Number(vars.speck_try || 0) - 1),
      markGoodPending: markTimer != null
    };
  }

  return { markGood, scheduleMarkGood, bootOk, confirmBoot, status, isFallbackBoot, mountTop };
}
