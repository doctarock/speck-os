import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRecoveryServer } from "../lib/recovery.mjs";

const page = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "recovery", "index.html");

async function withServer(fn) {
  const handled = [];
  const broker = {
    handle: async (method, route, body = {}) => {
      handled.push({ method, route, body });
      if (route === "/v1/audit") return { entries: [{ op: "exec", script: "secret", description: "did a thing" }] };
      if (route === "/v1/snapshots") return { snapshots: [{ number: 4, type: "pre", description: "x" }, { number: 5, type: "post" }] };
      return { ok: true };
    }
  };
  const run = async () => ({ code: 0, stdout: "log line\n", stderr: "" });
  const server = createRecoveryServer({ broker, run, health: async () => ({ ok: false, reason: "down" }), healthUrl: "http://x/api/health", pagePath: page });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, handled); } finally { server.close(); }
}

test("serves the page and a state summary without script bodies", async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<title>Speck Recovery<\/title>/);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.speck.ok, false);
    assert.equal(state.audit[0].description, "did a thing");
    assert.equal(state.audit[0].script, undefined);
    assert.deepEqual(state.snapshots.map((s) => s.number), [4]);
  });
});

test("actions need the recovery header and come from a closed list", async () => {
  await withServer(async (base, handled) => {
    const post = (body, headers = {}) => fetch(`${base}/api/action`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ action: "restart-speck" })).status, 403);
    assert.equal((await post({ action: "exec", script: "rm -rf /" }, { "X-Speck-Recovery": "1" })).status, 400);
    const ok = await post({ action: "restart-speck" }, { "X-Speck-Recovery": "1" });
    assert.equal(ok.status, 200);
    assert.deepEqual(handled.at(-1), { method: "POST", route: "/v1/service", body: { action: "restart", unit: "speck.service" } });
  });
});
