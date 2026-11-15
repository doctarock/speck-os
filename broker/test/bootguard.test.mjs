import test from "node:test";
import assert from "node:assert/strict";
import { createBootGuard } from "../lib/bootguard.mjs";

function setup({ fallback = false, tries = "", healthy = true } = {}) {
  const calls = [];
  const entries = [];
  const reboots = [];
  const run = async (command, args = []) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "grub-editenv" && args[1] === "list") return res(tries ? `speck_try=${tries}\nspeck_good=1\n` : "speck_good=1\n");
    if (command === "mountpoint") return res("", 0);
    return res("");
  };
  const guard = createBootGuard({
    run,
    audit: { append: async (entry) => { entries.push(entry); } },
    health: async () => (healthy ? { ok: true } : { ok: false, reason: "speck.service is failed" }),
    config: { readCmdline: async () => `BOOT_IMAGE=/vmlinuz root=UUID=x ${fallback ? "speck.fallback=1" : ""}`, settleMs: 1234 },
    now: () => new Date("2026-11-10T01:02:03.000Z")
  });
  const bootOk = () => guard.bootOk({ waitMs: 0, pollMs: 1, reboot: async (reason) => { reboots.push(reason); } });
  return { guard, calls, entries, reboots, bootOk };
}
const res = (stdout, code = 0) => ({ code, stdout, stderr: "", timedOut: false, truncated: false, durationMs: 1 });

test("healthy normal boot resets the counter and asks for mark-good after settling", async () => {
  const { bootOk, calls, reboots } = setup({ tries: "1" });
  const result = await bootOk();
  assert.deepEqual(result, { action: "ok", settleMs: 1234 });
  assert.ok(calls.includes("grub-editenv /boot/grub/grubenv unset speck_try"));
  assert.equal(reboots.length, 0);
});

test("unhealthy boot reboots while GRUB still has tries left, so the counter reaches the fallback", async () => {
  for (const tries of ["1", "2"]) {
    const { bootOk, reboots } = setup({ tries, healthy: false });
    assert.equal((await bootOk()).action, "reboot");
    assert.equal(reboots.length, 1);
  }
});

test("unhealthy boot with no fallback left stays up instead of reboot-looping", async () => {
  const { bootOk, reboots } = setup({ tries: "3", healthy: false });
  assert.equal((await bootOk()).action, "stay");
  assert.equal(reboots.length, 0);
});

test("healthy fallback boot keeps the broken root, promotes @good and reboots", async () => {
  const { bootOk, calls, reboots, entries } = setup({ fallback: true, tries: "3" });
  const result = await bootOk();
  assert.equal(result.action, "promoted");
  assert.equal(result.kept, "@broken-2026-11-10T01-02-03-000Z");
  const mv = calls.findIndex((c) => c === "mv /run/speck-btrfs/@ /run/speck-btrfs/@broken-2026-11-10T01-02-03-000Z");
  const snap = calls.findIndex((c) => c === "btrfs subvolume snapshot /run/speck-btrfs/@good /run/speck-btrfs/@");
  assert.ok(mv >= 0 && snap > mv, "rename the broken root before snapshotting good into its place");
  assert.deepEqual(reboots, ["promote fallback root"]);
  assert.equal(entries.find((e) => e.op === "boot.promote-fallback").kept, result.kept);
});

test("unhealthy fallback boot stays up and promotes nothing", async () => {
  const { bootOk, calls, reboots } = setup({ fallback: true, tries: "3", healthy: false });
  assert.equal((await bootOk()).action, "stay");
  assert.equal(reboots.length, 0);
  assert.ok(!calls.some((c) => c.startsWith("mv ")));
});

test("mark-good refuses while running from the fallback root", async () => {
  const { guard } = setup({ fallback: true });
  // layout() needs btrfs on @good with a separate /boot
  const result = await guard.markGood();
  assert.equal(result.marked, false);
});

test("deliberate reboot from a healthy boot clears the counter, so it isn't counted as a failed boot", async () => {
  const { guard, calls, entries } = setup({ tries: "1" });
  assert.deepEqual(await guard.confirmBoot({ waitMs: 0, pollMs: 1 }), { confirmed: true });
  assert.ok(calls.includes("grub-editenv /boot/grub/grubenv unset speck_try"));
  assert.equal(entries.at(-1).by, "deliberate reboot");
});

test("deliberate reboot from an unhealthy or fallback boot leaves the counter alone", async () => {
  for (const options of [{ tries: "1", healthy: false }, { tries: "3", fallback: true }]) {
    const { guard, calls } = setup(options);
    assert.equal((await guard.confirmBoot({ waitMs: 0, pollMs: 1 })).confirmed, false);
    assert.ok(!calls.some((c) => c.includes("unset speck_try")));
  }
});
