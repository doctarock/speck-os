#!/usr/bin/env node
// Download the GGUF file(s) that `llama-server -hf <owner/repo:QUANT>` would use, into
// <dest>/<owner_repo_QUANT>/. infer-run.sh loads a model from there with -m when it exists, so a
// box (or an image) with the files baked in never needs the internet to start its workers.
//
//   fetch-model.mjs <owner/repo:QUANT> <dest dir>
//
// Resumes partial downloads, checks size and SHA-256 against Hugging Face's LFS metadata, and
// does nothing when the files are already there.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ggufFilesFor } from "../broker/lib/setup.mjs";

export const localDirName = (modelHf) => modelHf.replace(/[/:]/g, "_");

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

export async function fetchModel(modelHf, destRoot, { fetch = globalThis.fetch, log = console.log } = {}) {
  const [repo, quant = ""] = modelHf.split(":");
  const listing = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`);
  if (!listing.ok) throw new Error(`${repo}: Hugging Face listing failed (${listing.status})`);
  const files = ggufFilesFor(await listing.json(), quant);
  if (!files.length) throw new Error(`${modelHf}: no GGUF file for quant ${quant}`);
  const dir = path.join(destRoot, localDirName(modelHf));
  await fsp.mkdir(dir, { recursive: true });
  for (const entry of files) {
    const size = Number(entry.lfs?.size ?? entry.size);
    const oid = entry.lfs?.oid;
    const target = path.join(dir, path.basename(entry.path));
    const have = await fsp.stat(target).catch(() => null);
    if (have?.size === size) { log(`${path.basename(target)}: present`); continue; }
    const part = `${target}.part`;
    const partial = (await fsp.stat(part).catch(() => null))?.size ?? 0;
    const url = `https://huggingface.co/${repo}/resolve/main/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
    log(`${path.basename(target)}: ${(size / 1e9).toFixed(2)} GB${partial ? ` (resuming at ${(partial / 1e9).toFixed(2)})` : ""}`);
    const response = await fetch(url, { headers: partial ? { Range: `bytes=${partial}-` } : {}, redirect: "follow" });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const append = partial > 0 && response.status === 206;
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(part, { flags: append ? "a" : "w" }));
    const got = (await fsp.stat(part)).size;
    if (got !== size) throw new Error(`${path.basename(target)}: got ${got} bytes, expected ${size}`);
    if (oid && (await sha256(part)) !== oid) {
      await fsp.rm(part, { force: true });
      throw new Error(`${path.basename(target)}: checksum mismatch (removed; run again)`);
    }
    await fsp.rename(part, target);
  }
  return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [modelHf, dest] = process.argv.slice(2);
  if (!modelHf || !dest) { console.error("usage: fetch-model.mjs <owner/repo:QUANT> <dest dir>"); process.exit(2); }
  fetchModel(modelHf, dest).then((dir) => console.log(dir), (error) => { console.error(error.message); process.exit(1); });
}
