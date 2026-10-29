// Where the new renderer's core (godot-scene-web's render-stream client wasm) is served, and whether the build
// this page would load is usable.
//
// The three files (`rs_gsw_wasm_client.js`, `rs_gsw_wasm_bg.wasm`, `build.json`) are built by
// scripts/build-render-stream-client.sh into ignored `.sts2/render-stream-client-web/` and served side by side by
// the `renderStreamClientAssets()` Vite plugin (vite-plugins/renderStreamClientAssets.ts): under `/app/render-stream/`
// in dev, and as emitted assets beside the app's chunks in a build. They are never imported through an alias or
// bundled — the client imports the glue by URL so each mount gets its own instance (and gives its heap back).
//
// The plugin also states, through `virtual:couch-render-stream-core`, the source tree the aliased godot-scene-web
// TypeScript was taken from (`expectedTree`) and whether the build is missing or stale. A stale core paired with
// newer TS is a silent protocol mismatch, so it must never mount: availability reports `core-build` instead, and
// the client itself refuses a `build.json` whose tree differs from `expectedTree`.

import type { RenderStreamCore } from "@godot-scene-web/render-stream-client";
import coreStatus from "virtual:couch-render-stream-core";

/** Why the core cannot be used: no build, a build from other sources, or a tree the plugin could not identify. */
export type RenderStreamCoreProblem = "missing" | "stale" | "unverified";

export interface RenderStreamCoreConfig {
  core: RenderStreamCore | null;
  problem: RenderStreamCoreProblem | null;
}

/** The core URLs for this page, or the reason there is no usable core. */
export function renderStreamCoreConfig(): RenderStreamCoreConfig {
  if (coreStatus.problem !== null || !coreStatus.expectedTree) {
    return { core: null, problem: coreStatus.problem ?? "unverified" };
  }
  // Dev serves the files at the root's /app/render-stream/; a build emits them beside the app's own chunks (every
  // chunk lives in `app/`), so they resolve against this module's URL — on the host for the remote-hosted boot too.
  const base = import.meta.env.DEV
    ? new URL("/app/render-stream/", window.location.href)
    : new URL(/* @vite-ignore */ "./render-stream/", import.meta.url);
  return {
    core: {
      glueUrl: new URL("rs_gsw_wasm_client.js", base).href,
      wasmUrl: new URL("rs_gsw_wasm_bg.wasm", base).href,
      buildUrl: new URL("build.json", base).href,
      expectedTree: coreStatus.expectedTree
    },
    problem: null
  };
}
