import http from "node:http";
import fs from "node:fs/promises";
import { setupRoutes } from "./setup.mjs";

/**
 * Recovery console: a page with no model in it that works when Speck doesn't. Localhost only.
 * The kiosk switches to it whenever Speck is down. It offers a closed set of actions (no
 * arbitrary exec); POSTs need the X-Speck-Recovery header, which a cross-site form can't send.
 */
export function createRecoveryServer({ broker, run, health, healthUrl, pagePath, setup, setupPagePath }) {
  const setupHandler = setup ? setupRoutes(setup, setupPagePath) : null;
  const ACTIONS = {
    "restart-speck": () => broker.handle("POST", "/v1/service", { action: "restart", unit: "speck.service" }),
    "restart-workers": async () => {
      const results = [];
      for (const unit of ["infer@worker.service", "infer@intake.service", "infer@toolcaller.service", "infer@embed.service"]) {
        results.push(await broker.handle("POST", "/v1/service", { action: "restart", unit }));
      }
      return { ok: results.every((r) => r.ok), results: results.map((r) => ({ unit: r.unit, active: r.active })) };
    },
    "rollback-update": (body) => broker.handle("POST", "/v1/update/rollback", { reason: "recovery console", restoreState: body.restoreState === true }),
    "rollback-snapshot": (body) => broker.handle("POST", "/v1/rollback", { snapshot: body.snapshot, reason: "recovery console" }),
    "reboot": () => broker.handle("POST", "/v1/power", { action: "reboot", reason: "recovery console", delaySec: 3 })
  };

  async function state() {
    const [speck, status, update, audit, snapshots, logs] = await Promise.all([
      health(healthUrl),
      broker.handle("GET", "/v1/status").catch((e) => ({ error: e.message })),
      broker.handle("GET", "/v1/update").catch((e) => ({ error: e.message })),
      broker.handle("GET", "/v1/audit", {}, new URLSearchParams("limit=25")).catch(() => ({ entries: [] })),
      broker.handle("GET", "/v1/snapshots").catch(() => ({ snapshots: [] })),
      run("journalctl", ["-u", "speck.service", "-u", "infer@worker.service", "-n", "120", "--no-pager", "-o", "short-iso"])
    ]);
    return {
      speck, status, update,
      audit: audit.entries.map(({ script, ...rest }) => rest).reverse(),
      snapshots: (snapshots.snapshots || []).filter((s) => s.type === "pre").slice(-15).reverse(),
      logs: logs.stdout.slice(-20000)
    };
  }

  return http.createServer(async (req, res) => {
    const send = (status, body, type = "application/json") => {
      const text = type === "application/json" ? JSON.stringify(body) : body;
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(text);
    };
    try {
      const url = new URL(req.url, "http://recovery");
      // First-boot setup (and the USB installer) live on the same port: see setup.mjs.
      if (setupHandler && await setupHandler(req, res, url, send)) return;
      if (req.method === "GET" && url.pathname === "/") return send(200, await fs.readFile(pagePath, "utf8"), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/state") return send(200, await state());
      if (req.method === "GET" && url.pathname === "/api/speck") return send(200, await health(healthUrl));
      if (req.method === "POST" && url.pathname === "/api/action") {
        if (req.headers["x-speck-recovery"] !== "1") return send(403, { ok: false, error: "missing X-Speck-Recovery header" });
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) return send(413, { ok: false, error: "too large" }); }
        const body = raw ? JSON.parse(raw) : {};
        const action = ACTIONS[body.action];
        if (!action) return send(400, { ok: false, error: `unknown action ${body.action}` });
        return send(200, await action(body));
      }
      return send(404, { ok: false, error: "not found" });
    } catch (error) {
      return send(error.status || 500, { ok: false, error: error.message });
    }
  });
}
