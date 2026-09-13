#!/usr/bin/env node
// Track F2a — BATCH DRIVER for the host-side ASTC texture transcoder.
//
// The phone client is GPU texture-fetch bound at Full render scale because streamed textures are RAW RGBA8
// (32bpp). This tool pre-encodes served PNG/WEBP blobs to GPU-native ASTC 4x4 (8bpp) once on the host, wrapped in
// the CCTX container (src/CouchCoop.MirrorProtocol/Assets/CctxContainer.cs), so the mod's /res?fmt=astc route (and
// the replay bench proxy) can serve them and the phone uploads them directly via Image.CreateFromData — no decode,
// no mipgen, ~4x less texture DRAM traffic, ~4x fewer wire bytes for typical detailed atlas pages.
//
// It walks one or more SOURCE dirs of served blobs (default: the live mod's on-disk binary cache res/ dir), sniffs
// PNG/WEBP magic (skips JSON/fonts/etc.), keys each raster by the sha256 of its SOURCE bytes, and — for entries not
// already transcoded — invokes ONE tools-editor headless process over a manifest (editor startup is expensive;
// batch many per run). Output: <astc-cache>/astc/<sha256>.cctx. Idempotent: existing outputs are skipped.
//
//   node scripts/transcode-texture-cache.mjs \
//     --source-cache ~/.local/share/SlayTheSpire2/couch-coop/cache/<branch>/assets/res \
//     --astc-cache /path/to/astc-cache
//
// It ALSO drains the mod's runtime "pending inbox" (<astc-cache>/pending/*.bin — raster bytes the /res?fmt=astc
// route recorded on a cold miss), removing each pending file once its cctx exists.
//
// Image.compress ASTC encoders are TOOLS_ENABLED-only, so this REQUIRES the tools editor binary (default below),
// never an export template.

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT } from "./lib/repo-layout.mjs";

const DEFAULT_EDITOR =
  join(homedir(), ".local/godot-4.5.1-mono/Godot_v4.5.1-stable_mono_linux_x86_64/Godot_v4.5.1-stable_mono_linux.x86_64");
const DEFAULT_PROJECT = join(REPO_ROOT, "scripts", "transcode-godot");
const DEFAULT_CACHE_ROOT = join(homedir(), ".local/share/SlayTheSpire2/couch-coop/cache");

// The cache is branch scoped — <cache>/<branch>/assets/res — and a machine may hold two branches at once
// (CouchCoopCacheRoot caps it there). Pick the most recently written one rather than guessing which the operator
// meant: the branch they last played is the branch whose blobs are worth transcoding, and transcoding the other
// one's would be pure waste. `--source-cache` names one outright when that guess is wrong.
function defaultSourceCaches() {
  try {
    return readdirSync(DEFAULT_CACHE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(DEFAULT_CACHE_ROOT, entry.name, "assets"))
      .filter((dir) => existsSync(dir))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .map((dir) => join(dir, "res"))
      .slice(0, 1);
  } catch {
    return [];
  }
}

// Track T: tiny-PNG transcode threshold. Device measurement showed CCTX averages ~2.39x the source PNG bytes on the
// wire, and tiny VFX PNGs inflate up to ~142x for ~zero GPU benefit — below this many SOURCE bytes, ASTC never pays
// off. Mirrors MinSourceBytesForAstc in src/CouchCoop.Mod/Server/AstcTranscodeCache.cs and MIN_ASTC_SOURCE_BYTES in
// scripts/replay-ws-server.mjs — keep all three in sync.
const DEFAULT_MIN_BYTES = 32768;
const ENTRY_LIMIT_BYTES = 128 * 1024 * 1024;
const MANAGED_CACHE_CEILING_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_QUOTA_PROJECT = join(REPO_ROOT, "tools", "CouchCoop.CacheQuota", "CouchCoop.CacheQuota.csproj");
const DEFAULT_QUOTA_OUTPUT = join(REPO_ROOT, ".sts2", "tools", "cache-quota");

// Same device measurement as above, used ONLY to ESTIMATE the wire-bytes saved by skipping tiny rasters — we never
// transcode them, so we never learn their real CCTX size.
const CCTX_TO_SOURCE_RATIO = 2.39;

function parseArgs(argv) {
  const a = {
    sourceCaches: [],
    astcCache: null,
    editor: DEFAULT_EDITOR,
    project: DEFAULT_PROJECT,
    mipmaps: true,
    limit: 0,
    minBytes: DEFAULT_MIN_BYTES,
    help: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--source-cache": a.sourceCaches.push(next()); break;
      case "--astc-cache": a.astcCache = next(); break;
      case "--editor": a.editor = next(); break;
      case "--project": a.project = next(); break;
      case "--no-mipmaps": a.mipmaps = false; break;
      case "--limit": a.limit = Number(next()) || 0; break;
      case "--min-bytes": {
        const n = Number(next());
        a.minBytes = Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_BYTES;
        break;
      }
      case "--help": case "-h": a.help = true; break;
      case "--self-test": a.selfTest = true; break;
      default: console.error(`Unknown argument: ${arg}`); a.help = true;
    }
  }
  if (a.sourceCaches.length === 0) a.sourceCaches.push(...defaultSourceCaches());
  return a;
}

// PNG (\x89PNG) or WEBP (RIFF....WEBP). Everything else (JSON docs, fonts, CCTX, icons) is skipped.
function isRaster(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (
    buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true;
  return false;
}

function isCctx(buf) {
  return buf.length >= 4 && buf[0] === 0x43 && buf[1] === 0x43 && buf[2] === 0x54 && buf[3] === 0x58;
}

function isValidCctxFile(path) {
  try {
    const bytes = readFileSync(path);
    return bytes.length >= 32 && isCctx(bytes)
      && bytes.readUInt32LE(4) === 1
      && bytes.readBigUInt64LE(24) === BigInt(bytes.length - 32);
  } catch {
    return false;
  }
}

function* walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else if (e.isFile()) yield full;
  }
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

const HELP = `transcode-texture-cache.mjs — batch host-side ASTC transcoder (Track F2a)

  --source-cache <dir>   dir of served PNG/WEBP blobs to transcode (repeatable;
                         default: newest locally present upstream asset-cache res/ dir)
  --astc-cache <dir>     REQUIRED output root; cctx go to <dir>/astc/<sha256>.cctx
  --editor <path>        tools editor binary (default: the 4.5.1-mono editor)
  --project <path>       transcoder godot project (default: scripts/transcode-godot)
  --no-mipmaps           skip generate_mipmaps() before compress (default: mips ON)
  --limit <n>            transcode at most n new entries (smoke testing)
  --min-bytes <n>        skip rasters whose SOURCE byte length is below this (default ${DEFAULT_MIN_BYTES};
                         Track T — tiny VFX PNGs inflate up to ~142x on the wire for ~zero GPU benefit)
  --self-test            run quota write-budget checks without Godot or game files
  --help`;

export function writeFitsBudget(encodedBytes, usedBytes, totalBudgetBytes, entryLimitBytes = ENTRY_LIMIT_BYTES) {
  const chargedBytes = Math.ceil(encodedBytes / 4096) * 4096;
  return Number.isSafeInteger(encodedBytes) && encodedBytes >= 0 && encodedBytes <= entryLimitBytes
    && usedBytes <= totalBudgetBytes - chargedBytes;
}

function runSelfTest() {
  const assert = (value, label) => { if (!value) throw new Error(`quota self-test failed: ${label}`); };
  assert(writeFitsBudget(10, 0, 4096, 10), "one allocation unit fits");
  assert(!writeFitsBudget(10, 0, 4095, 10), "allocation rounding is included");
  assert(!writeFitsBudget(4097, 0, 8191, 5000), "a partial second unit is charged in full");
  assert(!writeFitsBudget(11, 0, 20, 10), "entry overflow is refused");
  assert(writeFitsBudget(4, 4096, 8192, 10), "remaining rounded budget fits");
  assert(!writeFitsBudget(4097, 4096, 8192, 5000), "remaining rounded budget is enforced");
  console.log("transcode quota self-test: ok");
}

function ensureQuotaHelper() {
  const dll = join(DEFAULT_QUOTA_OUTPUT, "CouchCoop.CacheQuota.dll");
  const inputs = [
    DEFAULT_QUOTA_PROJECT,
    join(REPO_ROOT, "tools", "CouchCoop.CacheQuota", "Program.cs"),
    join(REPO_ROOT, "src", "CouchCoop.Mod", "Server", "ManagedCacheQuota.cs"),
    join(REPO_ROOT, "src", "CouchCoop.Mod", "Server", "ResolvedFilePath.cs"),
  ];
  const newestInput = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
  if (!existsSync(dll) || statSync(dll).mtimeMs < newestInput) {
    mkdirSync(DEFAULT_QUOTA_OUTPUT, { recursive: true });
    const scratch = process.env.COUCHCOOP_GAME_MODS_DIR ?? join(tmpdir(), "cc-cache-quota-mods");
    const built = spawnSync("dotnet", ["build", DEFAULT_QUOTA_PROJECT, "-o", DEFAULT_QUOTA_OUTPUT], {
      stdio: "inherit", env: { ...process.env, COUCHCOOP_GAME_MODS_DIR: scratch },
    });
    if (built.status !== 0) throw new Error("cache quota helper build failed");
  }
  return dll;
}

function acquireQuota(astcRoot, maximumBytes, workingDir) {
  const grantFile = join(workingDir, "quota-grant.json");
  const child = spawn("dotnet", [ensureQuotaHelper(), astcRoot, String(maximumBytes), "1", grantFile], {
    stdio: ["pipe", "ignore", "inherit"],
  });
  const deadline = Date.now() + 15000;
  while (!existsSync(grantFile) && Date.now() < deadline && child.exitCode === null) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!existsSync(grantFile)) {
    child.stdin.end();
    throw new Error("cache quota helper did not publish a grant");
  }
  const grantedBytes = Number(JSON.parse(readFileSync(grantFile, "utf8")).grantedBytes) || 0;
  return { child, grantedBytes };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) { runSelfTest(); return; }
  if (args.help) { console.log(HELP); process.exit(0); }
  if (!args.astcCache) {
    console.error("--astc-cache <dir> is required");
    process.exit(2);
  }
  if (!existsSync(args.editor)) {
    console.error(`tools editor not found: ${args.editor} (Image.compress ASTC needs the editor build)`);
    process.exit(2);
  }

  const astcRoot = resolve(args.astcCache);
  const outDir = join(astcRoot, "astc");
  const pendingDir = join(astcRoot, "pending");
  mkdirSync(outDir, { recursive: true });

  // Scan the source caches + the mod's pending inbox. Content-address by sha256(source bytes); dedup so identical
  // bytes under multiple asset keys transcode once. Track which pending files fed each hash so we can drain them.
  const sources = args.sourceCaches.map((p) => resolve(p));
  if (existsSync(pendingDir)) sources.push(pendingDir);

  let scanned = 0;
  let rasters = 0;
  let alreadyDone = 0;
  let skippedTiny = 0;
  let skippedTinyBytes = 0;
  let pendingTinyDrained = 0;
  const byHash = new Map(); // hash -> { src, out }
  const pendingByHash = new Map(); // hash -> [pending file paths]

  for (const root of sources) {
    const inPending = root === pendingDir;
    for (const file of walkFiles(root)) {
      // The binary cache pairs <hash>.bin with <hash>.meta; only read the payload files.
      if (file.endsWith(".meta") || file.endsWith(".tmp")) continue;
      scanned++;
      let buf;
      try {
        buf = readFileSync(file);
      } catch {
        continue;
      }
      if (buf.length === 0 || isCctx(buf) || !isRaster(buf)) continue;
      rasters++;
      // Track T: below --min-bytes, ASTC never pays off — skip entirely (never encoded, never queued).
      if (buf.length < args.minBytes) {
        skippedTiny++;
        skippedTinyBytes += buf.length;
        if (inPending) {
          // A tiny source shouldn't be sitting in the pending inbox at all (RecordPending now guards the same
          // threshold), but drain any pre-existing entry from before this change so the inbox self-cleans.
          try { rmSync(file, { force: true }); pendingTinyDrained++; } catch { /* best effort */ }
        }
        continue;
      }
      const hash = sha256Hex(buf);
      if (inPending) {
        if (!pendingByHash.has(hash)) pendingByHash.set(hash, []);
        pendingByHash.get(hash).push(file);
      }
      const out = join(outDir, `${hash}.cctx`);
      if (isValidCctxFile(out)) { alreadyDone++; continue; }
      if (!byHash.has(hash)) byHash.set(hash, { src: file, out });
    }
  }

  let entries = [...byHash.values()];
  if (args.limit > 0 && entries.length > args.limit) entries = entries.slice(0, args.limit);

  console.log(
    `[transcode] scanned=${scanned} rasters=${rasters} distinct-new=${byHash.size} ` +
    `already-transcoded=${alreadyDone} to-encode=${entries.length}`,
  );

  // Track T: report what --min-bytes kept out of the pipeline, and estimate the wire-bytes this avoided (skipped
  // source bytes * (CCTX_TO_SOURCE_RATIO - 1) — the CCTX inflation these tiny rasters would have added on the wire
  // had we transcoded them; we never transcode them, so this is an estimate, not a measurement).
  const wireBytesSavedEstimate = Math.round(skippedTinyBytes * (CCTX_TO_SOURCE_RATIO - 1));
  console.log(
    `[transcode] skipped-tiny=${skippedTiny} (<${args.minBytes}B) skipped-tiny-bytes=${skippedTinyBytes} ` +
    `pending-tiny-drained=${pendingTinyDrained} estimated-wire-bytes-saved=${wireBytesSavedEstimate} ` +
    `(skippedTinyBytes * (${CCTX_TO_SOURCE_RATIO} - 1))`,
  );

  let bytesIn = 0;
  let bytesOut = 0;
  let ok = 0;
  let fail = 0;

  if (entries.length > 0) {
    const tmp = mkdtempSync(join(tmpdir(), "cctx-manifest-"));
    const manifestPath = join(tmp, "manifest.json");
    const maximumBatchBytes = Math.min(MANAGED_CACHE_CEILING_BYTES, entries.length * ENTRY_LIMIT_BYTES);
    let quota;
    try {
      quota = acquireQuota(astcRoot, maximumBatchBytes, tmp);
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      throw error;
    }
    if (quota.grantedBytes === 0) {
      quota.child.stdin.end();
      rmSync(tmp, { recursive: true, force: true });
      console.log(`[transcode] quota unavailable; bypassing ${entries.length} entries (existing CCTX hits remain served)`);
      entries = [];
    } else {
      writeFileSync(manifestPath, JSON.stringify({
        mipmaps: args.mipmaps, entries,
        totalBudgetBytes: quota.grantedBytes,
        entryLimitBytes: ENTRY_LIMIT_BYTES,
        allocationUnitBytes: 4096,
      }));

      console.log(`[transcode] invoking editor over ${entries.length} entries (one process, quota=${quota.grantedBytes})…`);
      let stdout = "";
      try {
        const result = spawnSync(
          args.editor,
          ["--headless", "--path", resolve(args.project), "--script", "res://transcode.gd", "--", "--manifest", manifestPath],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, XDG_DATA_HOME: tmp } },
        );
        stdout = (result.stdout ?? "").toString() + (result.stderr ?? "").toString();
      } finally {
        quota.child.stdin.end();
        rmSync(tmp, { recursive: true, force: true });
      }

      const line = stdout.split("\n").find((l) => l.includes("TRANSCODE_RESULT"));
      if (line) {
        try {
          const r = JSON.parse(line.slice(line.indexOf("{")));
          ok = r.ok; fail = r.fail; bytesIn = r.bytesIn; bytesOut = r.bytesOut;
        } catch {
          console.error("[transcode] could not parse TRANSCODE_RESULT line");
        }
      } else {
        fail = entries.length;
        console.error("[transcode] editor produced no TRANSCODE_RESULT line — see output above");
        process.stderr.write(stdout.split("\n").filter((l) => /error|ERROR|transcode:/.test(l)).join("\n") + "\n");
      }
    }
  }

  // Drain the pending inbox for every hash that now has a cctx (whether we just made it or it pre-existed).
  let pendingDrained = 0;
  for (const [hash, files] of pendingByHash) {
    if (!isValidCctxFile(join(outDir, `${hash}.cctx`))) continue;
    for (const f of files) {
      try { rmSync(f, { force: true }); pendingDrained++; } catch { /* best effort */ }
    }
  }

  const reduction = bytesIn > 0 ? (100 * (1 - bytesOut / bytesIn)).toFixed(1) : "0.0";
  console.log(
    `[transcode] DONE ok=${ok} fail=${fail} pending-drained=${pendingDrained} ` +
    `bytesIn=${bytesIn} bytesOut=${bytesOut} sizeDelta=${reduction}% (positive = ASTC smaller on the wire)`,
  );
  console.log(`[transcode] cache dir: ${outDir}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
