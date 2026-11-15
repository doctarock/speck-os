import fs from "node:fs/promises";
import path from "node:path";

const ROTATE_BYTES = 10 * 1024 * 1024;

/** Append-only JSONL audit log. Lives on the @speck subvolume, so system rollbacks never erase it. */
export function createAudit(file, { now = () => new Date() } = {}) {
  let chain = Promise.resolve();

  async function append(entry) {
    const line = `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`;
    chain = chain.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const size = await fs.stat(file).then((s) => s.size, () => 0);
      if (size > ROTATE_BYTES) await fs.rename(file, `${file}.1`).catch(() => {});
      await fs.appendFile(file, line, { mode: 0o640 });
    }).catch((error) => console.error(`[broker] audit write failed: ${error.message}`));
    return chain;
  }

  async function tail(limit = 50) {
    await chain;
    const text = await fs.readFile(file, "utf8").catch(() => "");
    return text.trim().split("\n").filter(Boolean).slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return { unparsable: line }; }
    });
  }

  return { append, tail };
}
