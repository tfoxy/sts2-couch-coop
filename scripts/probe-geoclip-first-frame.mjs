#!/usr/bin/env node
// Current-code browser first-frame probe.  This starts a local Vite middleware
// server so the browser imports the checkout's TypeScript source, while only
// /geoclips and /spines are forwarded to the explicitly supplied instance.
import { createRequire } from "node:module";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline as pipelineCallback } from "node:stream/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("playwright");
const { createServer: createViteServer } = require("vite");
const HARNESS = resolve(ROOT, "scripts/geoclip-first-frame-harness.ts");

function usage() {
  console.log(`probe-geoclip-first-frame.mjs --origin <instance-base> --identity <dataset id> --lane raster|geoclip --out <dir> [--headed] [--renderer default|software|gpu-vulkan] [--port-file file] [--compare-with result.json] [--dataset file] [--artifact dir] [--make-synthetic|--make-synthetic-bad-geometry]

--artifact is offline mode. A live run requires --dataset and --port-file: its live pid and port must match --origin before any request. --renderer default uses Chromium defaults, which on a virtual X display means SwiftShader; software explicitly requests SwiftShader; gpu-vulkan names ANGLE's Vulkan backend, which reaches the real adapter from a virtual display. For headed runs, follow the live owner's approved display protocol. --compare-with rejects a placement mismatch before a visual comparison.`);
}
function args(argv) {
  const options = { origin: null, identity: null, lane: null, out: null, dataset: null, artifact: null, makeSynthetic: false, badGeometry: false, portFile: null, compareWith: null, headed: false, renderer: "default" };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split(/=(.*)/s);
    const value = () => inline ?? argv[++index];
    if (flag === "--origin") options.origin = value();
    else if (flag === "--identity") options.identity = value();
    else if (flag === "--lane") options.lane = value();
    else if (flag === "--out") options.out = value();
    else if (flag === "--dataset") options.dataset = value();
    else if (flag === "--artifact") options.artifact = value();
    else if (flag === "--make-synthetic") options.makeSynthetic = true;
    else if (flag === "--make-synthetic-bad-geometry") { options.makeSynthetic = true; options.badGeometry = true; }
    else if (flag === "--port-file") options.portFile = value();
    else if (flag === "--compare-with") options.compareWith = value();
    else if (flag === "--headed") options.headed = true;
    else if (flag === "--renderer") options.renderer = value();
    else if (flag === "--help" || flag === "-h") { usage(); process.exit(0); }
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  const valid = options.origin && options.identity && options.out && ["raster", "geoclip"].includes(options.lane) && ["default", "software", "gpu-vulkan"].includes(options.renderer) && (!options.makeSynthetic || options.artifact) && (options.artifact || (options.portFile && options.dataset));
  if (!valid) throw new Error("--origin, --identity, --lane raster|geoclip, and --out are required; live runs also require --dataset and --port-file");
  return options;
}
function identity(a) {
  if (a.artifact) return { scene: "offline", node: "offline", anim: "offline", artifact: resolve(a.artifact) };
  const dataset = JSON.parse(readFileSync(a.dataset, "utf8"));
  const item = dataset.identities.find((candidate) => candidate.id === a.identity);
  if (!item) throw new Error(`identity ${a.identity} absent from ${a.dataset}`);
  return item;
}

function route(item) {
  const selectors = new URLSearchParams({ node: item.node, anim: item.anim });
  const scene = item.scene.replace(/^res:\/\//, "").split("/").map(encodeURIComponent).join("/");
  return {
    manifest: `/geoclips/${scene}?${selectors}&file=manifest.json`,
    spine: `/spines/${scene}?${selectors}&still=1`
  };
}

function contentType(file) {
  if (extname(file) === ".json") return "application/json";
  if (extname(file) === ".png") return "image/png";
  if (extname(file) === ".webp") return "image/webp";
  return "application/octet-stream";
}

function verifyPortFile(file, origin) {
  const document = JSON.parse(readFileSync(file, "utf8"));
  const port = Number(document.port);
  const pid = Number(document.pid);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid < 1) throw new Error(`invalid port/pid record ${file}`);
  try { process.kill(pid, 0); } catch { throw new Error(`expected instance pid ${pid} from ${file} is not alive`); }
  const actualPort = Number(origin.port || (origin.protocol === "https:" ? 443 : 80));
  if (actualPort !== port) throw new Error(`origin port ${actualPort} does not match expected instance port ${port} from ${file}`);
  return { file: resolve(file), port, pid };
}

function comparePlacement(result, otherFile) {
  const other = JSON.parse(readFileSync(otherFile, "utf8"));
  const keys = ["canvasWidth", "canvasHeight", "localX", "localY", "localWidth", "localHeight"];
  if (!other.placement || !result.placement || keys.some((key) => other.placement[key] !== result.placement[key])) throw new Error(`placement mismatch against ${otherFile}; visual comparison is void`);
  return resolve(otherFile);
}
async function makeSynthetic(dir, badGeometry) {
  const { writePackedGeoclipFixture } = await import("./make-geoclip-fixture.mjs");
  const made = writePackedGeoclipFixture(dir);
  // Add the production placement
  // contract here so this probe exercises the geoclip-present branch, not its
  // intentionally valid default fallback branch.
  const manifestPath = resolve(dir, "manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.meta.placement = { canvasWidth: 256, canvasHeight: 256, localX: 0, localY: 0, localWidth: 256, localHeight: 256, fitScale: 1 };
  if (badGeometry) manifest.frames[0].slots["0"].part = "missing-part";
  writeFileSync(manifestPath, JSON.stringify(manifest) + "\n");
  // Raster truth is deliberately a real 40-byte SpineClipWire/1 one-frame payload, using
  // the authored fixture page. It proves the current loadSpineClip decode+draw path,
  // while it does not pretend this synthetic page is a visual parity oracle.
  const png = readFileSync(resolve(dir, manifest.pages[0].file)); const bytes = Buffer.alloc(40 + 28 + png.length);
  bytes.write("SPCL"); bytes.writeUInt8(1,4); bytes.writeUInt32LE(1,8); bytes.writeUInt32LE(256,12); bytes.writeUInt32LE(256,16); bytes.writeUInt32LE(100,20); bytes.writeFloatLE(0,24); bytes.writeFloatLE(0,28); bytes.writeFloatLE(256,32); bytes.writeFloatLE(256,36);
  bytes.writeUInt32LE(0,40); bytes.writeInt32LE(0,44); bytes.writeInt32LE(0,48); bytes.writeUInt32LE(128,52); bytes.writeUInt32LE(128,56); bytes.writeUInt32LE(100,60); bytes.writeUInt32LE(png.length,64); png.copy(bytes,68); writeFileSync(resolve(dir,"raster.spcl"),bytes);
  return made;
}
function artifactFile(root, requestPath) {
  const name = decodeURIComponent(requestPath.slice("/__artifact/".length));
  const file = resolve(root, name);
  const relativePath = relative(root, file);
  const escapesRoot = relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`);
  return relativePath && !escapesRoot ? file : null;
}

async function forwardUpstream(request, response, origin) {
  // Keep bytes and headers coherent while streaming: Node fetch otherwise may
  // transparently decompress gzip while leaving the upstream encoding metadata.
  const upstream = await fetch(new URL(request.url, origin), { headers: { "accept-encoding": "identity" } });
  response.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => response.setHeader(key, value));
  if (!upstream.body) return response.end();
  await pipelineCallback(Readable.fromWeb(upstream.body), response);
}

function makeProbeServer(options, item, origin, vite) {
  return createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://probe");
    if (url.pathname === "/__geoclip-first-frame.html") {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><script type="module" src="/@fs/${HARNESS}"></script>`);
      return;
    }
    if (options.artifact && url.pathname.startsWith("/__artifact/")) {
      const file = artifactFile(item.artifact, url.pathname);
      if (!file || !existsSync(file) || !statSync(file).isFile()) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("content-type", contentType(file));
      response.end(readFileSync(file));
      return;
    }
    if (!options.artifact && (url.pathname.startsWith("/geoclips/") || url.pathname.startsWith("/spines/"))) {
      try {
        await forwardUpstream(request, response, origin);
      } catch (error) {
        response.statusCode = 502;
        response.end(String(error));
      }
      return;
    }
    vite.middlewares(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    });
  });
}

function urlsFor(options, base, routes) {
  if (options.artifact) return { manifest: `${base}/__artifact/manifest.json`, spine: `${base}/__artifact/raster.spcl`, fileTemplate: `${base}/__artifact/{file}` };
  return { manifest: `${base}${routes.manifest}`, spine: `${base}${routes.spine}`, fileTemplate: `${base}${routes.manifest.replace("manifest.json", "{file}")}` };
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => server.listen(0, "127.0.0.1", resolveListen).once("error", rejectListen));
  return `http://127.0.0.1:${server.address().port}`;
}

async function captureResult(page, options, urls, origin, instance) {
  await page.goto(`${urls.base}/__geoclip-first-frame.html`, { waitUntil: "networkidle" });
  const result = await page.evaluate(async (request) => window.__geoclipFirstFrameRun(request), { lane: options.lane, manifestUrl: urls.manifest, fileUrlTemplate: urls.fileTemplate, spineUrl: urls.spine });
  mkdirSync(options.out, { recursive: true });
  const pageShot = resolve(options.out, `${options.identity}-${options.lane}.png`);
  const canvasShot = resolve(options.out, `${options.identity}-${options.lane}-canvas.png`);
  await page.screenshot({ path: pageShot, omitBackground: true });
  const dataUrl = await page.evaluate(() => document.querySelector("canvas")?.toDataURL("image/png") ?? null);
  if (!dataUrl) throw new Error("presented canvas vanished before evidence capture");
  writeFileSync(canvasShot, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
  result.screenshot = pageShot;
  result.canvasScreenshot = canvasShot;
  result.target = { origin, identity: options.identity, offline: !!options.artifact, instance, harnessHop: "asset responses pass through a local Vite/proxy hop; request timing is browser-observed at that hop" };
  result.environment = { headless: !options.headed, rendererRequested: options.renderer, gpuWrapperExpected: options.headed };
  if (options.compareWith) result.placementMatched = comparePlacement(result, options.compareWith);
  writeFileSync(resolve(options.out, `${options.identity}-${options.lane}.json`), JSON.stringify(result, null, 2) + "\n");
  return result;
}

function softwareLaunchArgs(renderer) {
  // `default` leaves Chromium to pick. On a virtual X display (xvfb-run, scripts/run-gpu.sh) that pick is
  // SwiftShader, because Xvfb offers no hardware GLX — measured on this box: default => "ANGLE (Google, Vulkan
  // 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)". `gpu-vulkan` names ANGLE's Vulkan backend
  // explicitly, which binds the Vulkan ICD rather than the X display's GLX and therefore reaches the real
  // adapter from any display: same box, same xvfb-run => "ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA GeForce RTX
  // 2060), NVIDIA)". A cross-lane gate that prices WebGL uploads needs this; `default` silently voids it.
  if (renderer === "software") return ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  if (renderer === "gpu-vulkan") return ["--use-gl=angle", "--use-angle=vulkan"];
  return [];
}

async function closeProbeResources(browser, vite, server) {
  await browser?.close();
  await vite.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function main() {
  let options;
  try {
    options = args(process.argv.slice(2));
  } catch (error) {
    console.error(`first-frame: ${error.message}`);
    usage();
    process.exit(2);
  }

  if (options.makeSynthetic) await makeSynthetic(resolve(options.artifact), options.badGeometry);
  const item = identity(options);
  const routes = route(item);
  const originUrl = new URL(options.origin);
  const origin = originUrl.origin;
  const instance = options.artifact ? null : verifyPortFile(options.portFile, originUrl);
  const vite = await createViteServer({ root: resolve(ROOT, "frontend"), server: { middlewareMode: true, fs: { allow: [ROOT] } }, appType: "spa" });
  const server = makeProbeServer(options, item, origin, vite);
  const base = await listen(server);
  const urls = { base, ...urlsFor(options, base, routes) };
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: !options.headed,
      args: softwareLaunchArgs(options.renderer)
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const result = await captureResult(page, options, urls, origin, instance);
    console.log(`GEOCLIP_FIRST_FRAME_RESULT ${JSON.stringify(result)}`);
  } finally {
    await closeProbeResources(browser, vite, server);
  }
}
main().catch((error) => {
  console.error(`first-frame: ${error.stack || error}`);
  process.exit(1);
});
