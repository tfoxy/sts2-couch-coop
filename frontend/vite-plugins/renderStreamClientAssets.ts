// The new renderer's core: serve godot-scene-web's render-stream client wasm as three static files side by side,
// and tell the page whether that build matches the godot-scene-web sources this frontend aliases.
//
// Modelled on `msdfGeneratorAssets()` (vite.config.ts). The files come from scripts/build-render-stream-client.sh
// (GSW `packages/render-stream-client/scripts/build-web.sh`), written to ignored `.sts2/render-stream-client-web/`:
//
//   rs_gsw_wasm_client.js   the wasm-bindgen glue, wrapped in a factory so every mount gets a fresh instance
//   rs_gsw_wasm_bg.wasm     the module
//   build.json              `rs_core_tree` (the source tree it was built from), the wasm's sha256, …
//
// Dev serves them under `/app/render-stream/`; a build emits them as `app/render-stream/<name>` — except that
// `build.json` is served and emitted as the EXTENSIONLESS `core-build` (RENDER_STREAM_CORE_SERVED). A built frontend
// lives inside the mod's folder, and the game reads every `*.json` under `mods/` as a mod manifest: a `build.json`
// there logs "Mod manifest … is missing the 'id' field!" on every launch (the same reason `app-boot` has no
// extension). The client is told the URL (`core.buildUrl`). They are never
// imported through an alias or the bundler: the client imports the glue BY URL, which is what lets each mount's
// 0.5 GB heap be given back when it is disposed.
//
// STALENESS. `virtual:couch-render-stream-core` exports `{ expectedTree, problem }`: the tree id
// `core-tree.sh` computes for the aliased GSW checkout, and why the served build cannot be used — `missing`,
// `stale` (built from other sources) or `unverified` (the tree id could not be computed). The page treats any
// problem as "unavailable: core-build" and keeps running; the client independently refuses a `build.json`
// whose tree differs from `expectedTree`. Dev re-evaluates on every page load, so a rebuild needs no restart.
//
// A build with no usable core still succeeds (the beta is then unavailable, with its reason): scripts/build-local-mod.sh
// (through scripts/build-render-stream.sh, only when stale) and scripts/package-release.sh build this core before the
// frontend, and scripts/verify-release-archive.sh requires its three files.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Plugin, ViteDevServer } from "vite";

export const RENDER_STREAM_CORE_FILES = ["rs_gsw_wasm_client.js", "rs_gsw_wasm_bg.wasm", "build.json"] as const;
/** The name each file is served (dev) and emitted (build) under, beside the app's chunks. */
export const RENDER_STREAM_CORE_SERVED: Readonly<Record<string, (typeof RENDER_STREAM_CORE_FILES)[number]>> = {
  "rs_gsw_wasm_client.js": "rs_gsw_wasm_client.js",
  "rs_gsw_wasm_bg.wasm": "rs_gsw_wasm_bg.wasm",
  "core-build": "build.json"
};
export const RENDER_STREAM_CORE_MODULE = "virtual:couch-render-stream-core";
const RESOLVED_MODULE = `\0${RENDER_STREAM_CORE_MODULE}`;

export type RenderStreamCoreProblem = "missing" | "stale" | "unverified";

export interface RenderStreamCoreStatus {
  expectedTree: string | null;
  problem: RenderStreamCoreProblem | null;
}

export interface RenderStreamClientAssetsOptions {
  /** The build output directory (`.sts2/render-stream-client-web`). */
  dir: string;
  /** The godot-scene-web checkout whose sources are aliased. */
  gswRoot: string;
  /** Injectable for tests: the tree id of `gswRoot`, or null when it cannot be computed. */
  coreTree?: (gswRoot: string) => string | null;
}

/** `core-tree.sh` on the GSW checkout: its 12-hex id (+`-dirty`), or null when the script or git is unavailable. */
export function gswCoreTree(gswRoot: string): string | null {
  const script = resolve(gswRoot, "packages/render-stream-client/scripts/core-tree.sh");
  if (!existsSync(script)) return null;
  try {
    const out = execFileSync("bash", [script, gswRoot], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{12}(-dirty)?$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Judge the build in `dir` against the expected tree. */
export function renderStreamCoreStatus(dir: string, expectedTree: string | null): RenderStreamCoreStatus {
  if (!RENDER_STREAM_CORE_FILES.every((name) => existsSync(resolve(dir, name)))) {
    return { expectedTree, problem: "missing" };
  }
  if (expectedTree === null) return { expectedTree, problem: "unverified" };
  let built: unknown;
  try {
    built = (JSON.parse(readFileSync(resolve(dir, "build.json"), "utf8")) as { rs_core_tree?: unknown }).rs_core_tree;
  } catch {
    return { expectedTree, problem: "missing" };
  }
  // The client's own rule (and build-rs-core.sh's): equal ids, a `-dirty` suffix included, are the same core.
  return { expectedTree, problem: built === expectedTree ? null : "stale" };
}

export function renderStreamClientAssets(options: RenderStreamClientAssetsOptions): Plugin {
  const coreTree = options.coreTree ?? gswCoreTree;
  const status = () => renderStreamCoreStatus(options.dir, coreTree(options.gswRoot));
  let server: ViteDevServer | null = null;
  return {
    name: "couch-render-stream-client-assets",
    resolveId(id) {
      return id === RENDER_STREAM_CORE_MODULE ? RESOLVED_MODULE : undefined;
    },
    load(id) {
      if (id !== RESOLVED_MODULE) return undefined;
      return `export default ${JSON.stringify(status())};\n`;
    },
    configureServer(dev) {
      server = dev;
      dev.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const match = /^\/app\/render-stream\/([^/]+)$/.exec(path);
        const served = match?.[1];
        const name = served !== undefined && Object.hasOwn(RENDER_STREAM_CORE_SERVED, served)
          ? RENDER_STREAM_CORE_SERVED[served] : undefined;
        if (!name) return next();
        const file = resolve(options.dir, name);
        if (!existsSync(file)) { res.statusCode = 404; res.end(served); return; }
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm"
          : name.endsWith(".json") ? "application/json" : "text/javascript");
        // A rebuild replaces all three at once; never let the browser pair a cached glue with a new build.json.
        res.setHeader("Cache-Control", "no-store");
        res.end(readFileSync(file));
      });
    },
    // Dev: re-judge the build on every page load, so a rebuild (or a GSW checkout that moved) is seen without a
    // restart. Invalidating the virtual module makes the page's next import of it run `load` again.
    transformIndexHtml() {
      const mod = server?.moduleGraph.getModuleById(RESOLVED_MODULE);
      if (mod) server?.moduleGraph.invalidateModule(mod);
    },
    generateBundle() {
      const judged = status();
      if (judged.problem !== null) {
        this.warn(`render-stream client core ${judged.problem} in ${options.dir}: the new renderer (Beta) is unavailable `
          + "in this build (scripts/build-local-mod.sh builds it when stale; scripts/build-render-stream.sh alone)");
        return;
      }
      for (const [served, name] of Object.entries(RENDER_STREAM_CORE_SERVED)) {
        this.emitFile({ type: "asset", fileName: `app/render-stream/${served}`, source: readFileSync(resolve(options.dir, name)) });
      }
    }
  };
}
