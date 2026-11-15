import { spawn } from "node:child_process";

export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Run a command; never throws. Output streams keep their last `maxOutput` characters.
 * The child gets its own process group so a timeout kills everything it started.
 */
export function run(command, args = [], { input, timeoutMs = 600_000, env, cwd, maxOutput = 65_536 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, { env: env ?? process.env, cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: 127, signal: null, stdout, stderr: String(error.message), truncated, timedOut, durationMs: 0 });
      return;
    }
    const keep = (buffer, chunk) => {
      const next = buffer + chunk.toString();
      if (next.length <= maxOutput) return next;
      truncated = true;
      return next.slice(-maxOutput);
    };
    child.stdout.on("data", (chunk) => { stdout = keep(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = keep(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, timeoutMs);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, truncated, timedOut, durationMs: Date.now() - started });
    };
    child.on("error", (error) => finish({ code: 127, signal: null, stderr: `${stderr}${error.message}` }));
    child.on("close", (code, signal) => finish({ code: code ?? 128, signal, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** Run and return trimmed stdout, or throw with stderr. For broker plumbing, not agent work. */
export async function runOk(runner, command, args, options) {
  const result = await runner(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(-500)}`);
  }
  return result.stdout.trim();
}
