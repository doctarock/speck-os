import { runOk } from "./run.mjs";

/**
 * Snapper wrapper for the root config. Every mutating broker op runs between a pre and a
 * post snapshot; `undo` reverts files changed since a snapshot (live rollback, no reboot).
 * When snapper or the btrfs layout is missing (dev machines), it reports itself unavailable
 * and ops run unprotected, with the reason in every result.
 */
export function createSnapshots({ run, mode = "auto", config = "root" }) {
  let availability;

  async function available() {
    if (mode === "off") return { ok: false, reason: "snapshots disabled (SPECK_BROKER_SNAPSHOTS=off)" };
    if (availability) return availability;
    const result = await run("snapper", ["--jsonout", "list-configs"]);
    if (result.code !== 0) {
      availability = { ok: false, reason: `snapper unavailable: ${(result.stderr || "exit " + result.code).trim().slice(0, 200)}` };
    } else {
      let configs = [];
      try { configs = JSON.parse(result.stdout).configs ?? []; } catch { /* fall through */ }
      availability = configs.some((entry) => entry.config === config)
        ? { ok: true }
        : { ok: false, reason: `snapper config "${config}" missing` };
    }
    return availability;
  }

  async function pre(description) {
    if (!(await available()).ok) return null;
    const out = await runOk(run, "snapper", ["-c", config, "create", "--type", "pre", "--print-number",
      "--cleanup-algorithm", "number", "--userdata", "actor=speck", "--description", clip(description)]);
    return Number(out);
  }

  async function post(preNumber, description) {
    if (preNumber == null) return null;
    const out = await runOk(run, "snapper", ["-c", config, "create", "--type", "post", "--pre-number", String(preNumber),
      "--print-number", "--cleanup-algorithm", "number", "--userdata", "actor=speck", "--description", clip(description)]);
    return Number(out);
  }

  async function single(description) {
    const state = await available();
    if (!state.ok) throw new Error(state.reason);
    const out = await runOk(run, "snapper", ["-c", config, "create", "--type", "single", "--print-number",
      "--cleanup-algorithm", "number", "--userdata", "actor=speck", "--description", clip(description)]);
    return Number(out);
  }

  async function list() {
    const state = await available();
    if (!state.ok) return { available: false, reason: state.reason, snapshots: [] };
    const out = await runOk(run, "snapper", ["--jsonout", "-c", config, "list"]);
    const rows = JSON.parse(out)[config] ?? [];
    return {
      available: true,
      snapshots: rows.filter((row) => row.number !== 0).map((row) => ({
        number: row.number, type: row.type, preNumber: row["pre-number"] ?? null,
        date: row.date, description: row.description, userdata: row.userdata ?? {}
      }))
    };
  }

  /** Revert every file changed since `number` back to that snapshot's state. */
  async function undo(number) {
    const state = await available();
    if (!state.ok) throw new Error(state.reason);
    return runOk(run, "snapper", ["-c", config, "undochange", `${number}..0`], { timeoutMs: 1_800_000 });
  }

  return { available, pre, post, single, list, undo };
}

function clip(text) {
  return `speck: ${String(text || "unspecified").replace(/\s+/g, " ").slice(0, 200)}`;
}
