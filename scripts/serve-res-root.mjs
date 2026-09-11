#!/usr/bin/env node
// Serve recovered project files at /res/** for replay benches. An optional *read-only* production asset-cache
// fallback answers PNG resource renditions that are intentionally absent from
// a recovered tree. It never extracts, rasterizes, copies, or writes game assets.
//
//   node scripts/serve-res-root.mjs --port 5195 --asset-cache-root /path/to/couchcoop-asset-cache-v13
//
// `--asset-cache-root` is SpirectlAssetBinaryCache.RootPath: the directory that contains `res/<sha256>.bin` and
// its paired `.meta`. The cache key is exactly the shipped CachedSpirectlAssetHttpAdapter convention:
// `res://path|format=png` for the generated variant.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RECOVERED_RESOURCE_ROOT } from "./lib/repo-layout.mjs";

const DEFAULT_ROOT = RECOVERED_RESOURCE_ROOT;
const TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".json": "application/json", ".atlas": "text/plain", ".txt": "text/plain",
  ".gdshader": "text/plain", ".tres": "text/plain", ".ogg": "audio/ogg", ".svg": "image/svg+xml"
};
const SPINE_CLIP_CONTENT_TYPE = "application/vnd.couchcoop.spine-clip";
const SPINE_CLIP_SIZE_POLICY = "codec=webp&fps=15&q=85";
const SPINE_STILL_SELECTOR = "&still=1&sf=1";

function under(root, path) {
  return path === root || path.startsWith(root + sep);
}

function contentTypeFor(path) {
  return TYPES[extname(path).toLowerCase()] || "application/octet-stream";
}

function lastQueryValues(url) {
  const values = new Map();
  for (const [key, value] of url.searchParams) values.set(key, value);
  return values;
}

// Keep this in lockstep with CouchCoopBrowserServer's /res contract. The standalone server has no producer: raw
// requests read recovered Godot text, while the sole generated variant is a production-cached PNG rendition.
function resourceFormat(url) {
  const format = lastQueryValues(url).get("format");
  if (format === undefined || format.toLowerCase() === "raw") return "raw";
  if (format.toLowerCase() === "png") return "png";
  return null;
}

function invalidResourceFormat(value) {
  return {
    status: 400,
    source: "invalid",
    contentType: "application/json",
    body: JSON.stringify({
      type: "error",
      requestId: "bench",
      code: "invalid-resource-format",
      message: "Resource format must be raw or png.",
      field: "format",
      value
    })
  };
}

function invalidSubresourceFormat() {
  return {
    status: 400,
    source: "invalid",
    contentType: "application/json",
    body: JSON.stringify({
      type: "error",
      requestId: "bench",
      code: "invalid-resource-route",
      message: "?format is not supported for a ::-qualified sub-resource; it is served as raw text."
    })
  };
}

function tryParseRouteInteger(value) {
  const trimmed = value?.trim();
  if (!trimmed || !/^[+-]?\d+$/.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647 && parsed > 1 ? parsed : 0;
}

function formatStillTime(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) return null;
  const scaled = seconds * 100;
  const lower = Math.floor(scaled);
  // `Math.Round(value, 2)` in BuildSpineKey uses MidpointRounding.ToEven. The cache key carries this text, so
  // Math.round's half-up behavior would make an otherwise identical paused-still request miss its production blob.
  const rounded = scaled - lower === 0.5 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(scaled);
  return (rounded / 100).toFixed(2);
}

// CouchCoopBrowserServer.TryMintSpineClipKey + CouchCoopSpineClipProvider.BuildSpineKey.  `/spines` addresses a
// rendered SpineClipWire cache artifact, not the recovered Godot scene it happens to name. Keep the selector order
// and static-host policy here so a replay uses exactly the cache entry a production host would serve.
function canonicalSpineAssetKey(rel, url) {
  const scene = rel.trim().replace(/^\/+|\/+$/g, "");
  if (!scene || scene.includes("://")) return null;
  const query = lastQueryValues(url);
  const node = query.get("node")?.trim() || "";
  const anim = query.get("anim")?.trim() || "";
  let still = query.has("still") && ["", "1", "true", "on", "yes"].includes(query.get("still"));
  if (process.env.COUCHCOOP_DYNAMIC_SPINES !== "1") still = true;
  if (!anim && !still) return null;

  const skin = query.get("skin")?.trim() || "";
  let mat = query.get("mat")?.trim() || "";
  if (!mat || mat.length > 32 || !/^[A-Za-z0-9]+$/.test(mat)) mat = "";
  let skel = query.get("skel")?.trim() || "";
  if (skel && !skel.startsWith("res://")) skel = "";
  const version = tryParseRouteInteger(query.get("v"));
  const stillTime = still ? formatStillTime(query.get("t")) : null;

  const selectors = [];
  if (node) selectors.push(`node=${node}`);
  if (anim) selectors.push(`anim=${anim}`);
  if (skin) selectors.push(`skin=${skin}`);
  if (mat) selectors.push(`mat=${mat}`);
  if (skel) selectors.push(`skel=${skel}`);
  selectors.push(SPINE_CLIP_SIZE_POLICY);
  if (version) selectors.push(`v=${version}`);
  return `spine://${scene}?${selectors.join("&")}${still ? `${SPINE_STILL_SELECTOR}${stillTime ? `&t=${stillTime}` : ""}` : ""}`;
}

// CacheKey() in CachedSpirectlAssetHttpAdapter. Other query params are transport/cache control only and do not
// alter the production asset identity. `::` resources cannot have format in the shipped route, so their bare key
// remains the cache identity.
export function canonicalAssetKey(prefix, rel, url) {
  if (prefix === "/spines/") return canonicalSpineAssetKey(rel, url);
  const scheme = prefix === "/res/" ? "res" : prefix === "/models/" ? "model" : null;
  if (!scheme) return null;
  let key = `${scheme}://${rel}`;
  if (scheme === "res") {
    const format = resourceFormat(url);
    if (format === null) return null;
    if (rel.includes("::")) return lastQueryValues(url).has("format") ? null : key;
    if (format === "png") key += "|format=png";
  }
  return key;
}

export function cachePaths(cacheRoot, assetKey) {
  if (!cacheRoot || !assetKey) return null;
  const scheme = assetKey.slice(0, assetKey.indexOf("://"));
  if (!scheme) return null;
  const digest = createHash("sha256").update(assetKey, "utf8").digest("hex");
  const base = join(cacheRoot, scheme, digest);
  return { bin: `${base}.bin`, meta: `${base}.meta`, assetKey, digest };
}

function readCachedAsset(cacheRoot, assetKey) {
  const paths = cachePaths(cacheRoot, assetKey);
  if (!paths || !existsSync(paths.bin) || !existsSync(paths.meta)) return null;
  try {
    const st = statSync(paths.bin);
    if (!st.isFile()) return null;
    const mime = readFileSync(paths.meta, "utf8").trim();
    // A paired but blank .meta is a production cache hit with octet-stream, not an opportunity to guess MIME.
    return { ...paths, size: st.size, mime: mime || "application/octet-stream" };
  } catch {
    return null;
  }
}

function shaderSubresource(root, rel) {
  const subMark = rel.lastIndexOf("::");
  if (subMark < 0) return null;
  const subId = rel.slice(subMark + 2);
  const parent = resolve(join(root, rel.slice(0, subMark)));
  if (!subId || !under(root, parent)) return null;
  let body = null;
  try { body = readFileSync(parent, "utf8"); } catch { return null; }
  const escaped = subId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = body.match(new RegExp(`\\[sub_resource type="Shader" id="${escaped}"\\][^]*?code = "([^]*?)"\\s*(?:\\n\\[|$)`));
  return header ? header[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : null;
}

// One resolver for the standalone asset origin, launch-mode Playwright route, and connect-mode bench server.
// Returning a file path keeps callers streaming/fulfilling exact source bytes without copying cached game assets.
export function resolveAssetRequest({ root = DEFAULT_ROOT, assetCacheRoot = null, url }) {
  const requestUrl = url instanceof URL ? url : new URL(url, "http://127.0.0.1");
  const recoveredRoot = resolve(root);
  const cacheRoot = assetCacheRoot ? resolve(assetCacheRoot) : null;
  let prefix = null;
  for (const candidate of ["/res/", "/models/", "/spines/"]) {
    if (requestUrl.pathname.startsWith(candidate)) { prefix = candidate; break; }
  }
  if (!prefix) return { status: 404, source: "missing", contentType: "text/plain", body: "not found" };
  let rel;
  try { rel = decodeURIComponent(requestUrl.pathname.slice(prefix.length)); } catch {
    return { status: 400, source: "invalid", contentType: "text/plain", body: "invalid path" };
  }
  if (!rel || rel.startsWith("/")) return { status: 404, source: "missing", contentType: "text/plain", body: "not found" };
  const parentRel = rel.includes("::") ? rel.slice(0, rel.lastIndexOf("::")) : rel;
  if (!under(recoveredRoot, resolve(join(recoveredRoot, parentRel)))) {
    return { status: 403, source: "forbidden", contentType: "text/plain", body: "forbidden" };
  }
  if (prefix === "/res/" && rel.includes("::") && lastQueryValues(requestUrl).has("format")) {
    return invalidSubresourceFormat();
  }
  const format = prefix === "/res/" ? resourceFormat(requestUrl) : "raw";
  if (format === null) return invalidResourceFormat(lastQueryValues(requestUrl).get("format"));
  const assetKey = canonicalAssetKey(prefix, rel, requestUrl);
  if (!assetKey) return { status: 404, source: "missing", contentType: "text/plain", body: "not found" };
  // /spines is a cache-only rendition route. A recovered .tscn is source material for a producer, never a valid
  // browser clip: serving it would turn a cache miss into a 200 response that the SpineClipWire decoder rejects.
  if (prefix === "/spines/") {
    const cachedSpine = readCachedAsset(cacheRoot, assetKey);
    if (cachedSpine?.mime === SPINE_CLIP_CONTENT_TYPE) {
      return { status: 200, source: "cache", contentType: cachedSpine.mime, filePath: cachedSpine.bin, size: cachedSpine.size, assetKey };
    }
    return { status: 404, source: "missing", contentType: "text/plain", body: "not found", assetKey };
  }
  const wantsGenerated = prefix === "/res/" && !rel.includes("::") && format === "png";

  // Raw requests only serve recovered source bytes. PNG requests deliberately do not fall through to a raw
  // `.tres`: text presented as a PNG is a silent blank-page measurement.
  if (!wantsGenerated && rel.includes("::")) {
    const shader = shaderSubresource(recoveredRoot, rel);
    if (shader !== null) {
      return { status: 200, source: "recovered", contentType: "text/plain", body: shader, size: Buffer.byteLength(shader) };
    }
  }
  if (!wantsGenerated && !rel.includes("::")) {
    const recovered = resolve(join(recoveredRoot, rel));
    try {
      const st = statSync(recovered);
      if (st.isFile()) return { status: 200, source: "recovered", contentType: contentTypeFor(recovered), filePath: recovered, size: st.size };
    } catch { /* missing recovered source */ }
  }

  if (wantsGenerated) {
    const cached = readCachedAsset(cacheRoot, assetKey);
    if (cached) return { status: 200, source: "cache", contentType: cached.mime, filePath: cached.bin, size: cached.size, assetKey };
  }
  return { status: 404, source: "missing", contentType: "text/plain", body: "not found", assetKey };
}

export function createResRootServer({ root = DEFAULT_ROOT, assetCacheRoot = null } = {}) {
  const stats = { served: 0, servedRecovered: 0, servedCache: 0, missing: 0 };
  const server = createServer((req, res) => {
    const answer = resolveAssetRequest({ root, assetCacheRoot, url: new URL(req.url, "http://127.0.0.1") });
    if (answer.status === 200) {
      stats.served++;
      if (answer.source === "cache") stats.servedCache++; else stats.servedRecovered++;
      res.writeHead(200, {
        "content-type": answer.contentType,
        "content-length": answer.size,
        "access-control-allow-origin": "*",
        "cache-control": answer.source === "cache" ? "public, max-age=31536000, immutable" : "public, max-age=3600",
        ...(answer.source === "cache" ? { "x-cache": "HIT" } : {})
      });
      if (answer.filePath) createReadStream(answer.filePath).pipe(res); else res.end(answer.body);
      return;
    }
    stats.missing++;
    res.writeHead(answer.status, { "content-type": answer.contentType, "access-control-allow-origin": "*" }).end(answer.body);
  });
  server.benchStats = stats;
  return server;
}

function parseArgs(argv) {
  const args = { port: 5195, root: DEFAULT_ROOT, assetCacheRoot: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") args.port = Number(argv[++i]);
    else if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--asset-cache-root") args.assetCacheRoot = argv[++i];
    else if (argv[i] === "--quiet") args.quiet = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("serve-res-root.mjs [--port 5195] [--root <resource-root>] [--asset-cache-root <SpirectlAssetBinaryCache.RootPath>] [--quiet]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error("--port must be 1..65535");
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const server = createResRootServer(args);
  server.listen(args.port, "127.0.0.1", () => {
    console.log(`serve-res-root: http://127.0.0.1:${args.port}  ->  ${resolve(args.root)}${args.assetCacheRoot ? `  + cache ${resolve(args.assetCacheRoot)}` : ""}`);
    if (!args.quiet) setInterval(() => {
      const s = server.benchStats;
      console.log(`serve-res-root: ${s.served} served (${s.servedRecovered} recovered, ${s.servedCache} cache), ${s.missing} missing`);
    }, 15000).unref?.();
  });
}
