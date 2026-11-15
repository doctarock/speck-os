#!/usr/bin/env node
// Launch the kiosk Chrome and put offline voice into every page before the page's own scripts.
//
//   kiosk-chrome.mjs <url>
//
// Chrome gets --remote-debugging-pipe: a DevTools channel on file descriptors only this process
// holds (no port, so nothing else on the box can drive the kiosk). Over it, each page target gets
// voice/page/voice-local.js via Page.addScriptToEvaluateOnNewDocument, which then also applies
// to every reload and navigation. New targets are paused until the script is in place.
// Chrome exits when this process does, and vice versa.
//
// Env: SPECK_CHROME (binary), SPECK_CHROME_FLAGS (replaces the kiosk flags), SPECK_CHROME_EXTRA
// (added to them), SPECK_VOICE_CONFIG, SPECK_VOICE_PAGE.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const url = process.argv[2] || "http://127.0.0.1:4310/";
const CHROME = process.env.SPECK_CHROME || "/usr/bin/google-chrome-stable";
const KIOSK_FLAGS = [
  "--ozone-platform=wayland", "--kiosk", "--no-first-run", "--noerrdialogs", "--disable-session-crashed-bubble",
  "--disable-infobars", "--password-store=basic", "--autoplay-policy=no-user-gesture-required",
  `--user-data-dir=${process.env.HOME}/.config/speck-kiosk`
];
const split = (value) => String(value || "").split(/\s+/).filter(Boolean);
const flags = [...(process.env.SPECK_CHROME_FLAGS != null ? split(process.env.SPECK_CHROME_FLAGS) : KIOSK_FLAGS), ...split(process.env.SPECK_CHROME_EXTRA)];
const log = (message) => console.error(`[kiosk-chrome] ${message}`);

/** The voice script with this box's settings, or null when both directions use Chrome's own speech. */
export function voiceSource({ configPath = process.env.SPECK_VOICE_CONFIG || "/etc/speck-os/voice.json", pagePath = process.env.SPECK_VOICE_PAGE || "/usr/lib/speck-os/voice/page/voice-local.js" } = {}) {
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return null; }
  const browser = config.browser ?? {};
  if (browser.stt === "chrome" && browser.tts === "chrome") return null;
  const settings = {
    base: `http://127.0.0.1:${config.port ?? 4320}`,
    origins: config.allowedOrigins ?? ["http://127.0.0.1:4310", "http://localhost:4310"],
    stt: browser.stt ?? "local",
    tts: browser.tts ?? "local"
  };
  const page = fs.readFileSync(pagePath, "utf8");
  return page.replace(/\/\*CONFIG\*\/[\s\S]*?\/\*END\*\//, JSON.stringify(settings));
}

/** Minimal CDP client over Chrome's pipe: NUL-terminated JSON messages, flat sessions. */
export function cdpOverPipe(toChrome, fromChrome, onEvent) {
  let nextId = 0;
  const pending = new Map();
  let buffer = "";
  fromChrome.setEncoding("utf8");
  fromChrome.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      } else if (message.method) {
        onEvent(message);
      }
    }
  });
  return function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  };
}

async function main() {
  const source = voiceSource();
  const child = spawn(CHROME, [...flags, "--remote-debugging-pipe", "about:blank"], { stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"] });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill("SIGTERM"));

  let navigated = false;
  const send = cdpOverPipe(child.stdio[3], child.stdio[4], async ({ method, params }) => {
    if (method !== "Target.attachedToTarget") return;
    const { sessionId, targetInfo, waitingForDebugger } = params;
    try {
      if (targetInfo.type === "page" && source) {
        await send("Page.enable", {}, sessionId);
        const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true }, sessionId);
        if (process.env.SPECK_KIOSK_DEBUG) log(`injected into ${targetInfo.targetId} (${targetInfo.url}) as script ${identifier}`);
      }
      if (waitingForDebugger) await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
      if (targetInfo.type === "page" && !navigated) {
        navigated = true;
        await send("Page.navigate", { url }, sessionId);
      }
    } catch (error) {
      log(`target ${targetInfo.type} ${targetInfo.url}: ${error.message}`);
    }
  });
  // Attach to the first tab and to every target created later (paused until injected).
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  log(`${source ? "local voice injected" : "Chrome speech (no injection)"} → ${url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { log(error.stack || error.message); process.exit(1); });
}
