// Registers model processors with Speck. Live through Speck's own config API (applied without a
// restart, exactly as System → Brains saves), or, when Speck isn't running, by editing the saved
// model-processors.json it reads at start.
import fs from "node:fs/promises";

export function createSpeckModels({ baseUrl = "http://127.0.0.1:4310", file, owner = "speck:speck", run, fetch = globalThis.fetch }) {
  async function mutate(change) {
    let current;
    try {
      const response = await fetch(`${baseUrl}/api/brains/config`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) current = (await response.json()).brains;
    } catch {
      current = undefined;
    }
    if (current) {
      const processors = change(current.processors.map((p) => ({ ...p })));
      if (!processors) return { via: "speck", changed: false };
      const response = await fetch(`${baseUrl}/api/brains/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processors, roles: current.roles }),
        signal: AbortSignal.timeout(30_000)
      });
      const body = await response.json().catch(() => ({}));
      // Speck rejected the configuration: a real error, not a reason to bypass it via the file.
      if (!response.ok) throw new Error(`Speck rejected the processor configuration: ${body.error ?? response.status}`);
      return { via: "speck", changed: true };
    }
    const saved = JSON.parse(await fs.readFile(file, "utf8").catch(() => '{"processors":[],"roles":{}}'));
    const processors = change((saved.processors ?? []).map((p) => ({ ...p })));
    if (!processors) return { via: "file", changed: false };
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ ...saved, processors }, null, 2)}\n`, "utf8");
    if (run) await run("chown", [owner, temporary]);
    await fs.rename(temporary, file);
    return { via: "file", changed: true };
  }

  /** Add or replace a processor by id. Roles are never touched: the base model keeps its roles. */
  function upsert(processor) {
    return mutate((processors) => {
      const at = processors.findIndex((p) => p.id === processor.id);
      // Saving re-creates every processor in Speck, so skip it when nothing changed.
      if (at >= 0 && canonical(processors[at]) === canonical(processor)) return null;
      if (at >= 0) processors[at] = processor; else processors.push(processor);
      return processors;
    });
  }

  /** Keep the entry (its history stays meaningful) but take it out of routing. */
  function disable(id) {
    return mutate((processors) => {
      const entry = processors.find((p) => p.id === id);
      if (!entry || entry.enabled === false) return null;
      entry.enabled = false;
      return processors;
    });
  }

  return { upsert, disable };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
