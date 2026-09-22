import { fileURLToPath, URL } from "node:url";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";

import { freshSiblingSources } from "./vite-plugins/freshSiblingSources";

function yamlValue(text: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([^#\\r\\n]+))\\s*(?:#.*)?$`, "m");
  const match = pattern.exec(text);
  return match?.[1]?.trim() || match?.[2]?.trim() || match?.[3]?.trim();
}

function defaultOutDir(): string {
  if (process.env.COUCHCOOP_FRONTEND_OUT_DIR) {
    return process.env.COUCHCOOP_FRONTEND_OUT_DIR;
  }

  const localConfigPath = fileURLToPath(new URL("../sts2.local.yaml", import.meta.url));
  if (!existsSync(localConfigPath)) {
    return "dist";
  }

  const localConfig = readFileSync(localConfigPath, "utf8");
  const modsDir = yamlValue(localConfig, "modsDir");
  const gamePath = yamlValue(localConfig, "path");
  const localModsDir = modsDir ?? (gamePath ? resolve(gamePath, "mods") : undefined);
  return localModsDir ? resolve(localModsDir, "couchcoop/frontend") : "dist";
}

function devProxyTarget(): string {
  const target = process.env.COUCHCOOP_DEV_PROXY_TARGET ?? "http://127.0.0.1:13337";
  const url = new URL(target);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

  if (!["http:", "https:"].includes(url.protocol) || !loopbackHosts.has(url.hostname)) {
    throw new Error(
      "COUCHCOOP_DEV_PROXY_TARGET must be an http(s) loopback URL, such as http://127.0.0.1:13337"
    );
  }

  return url.toString();
}

// A proxy entry that won't take the whole dev server down. The live game can reset connections or
// send empty/partial responses mid-run (heavy /res asset extraction, abrupt /ws closes); without an
// `error` handler http-proxy re-emits those as uncaught exceptions that crash the Vite process,
// killing the auto-player's connection. Swallow proxy errors (best-effort 502) and keep serving.
function resilientProxy(extra: Record<string, unknown> = {}) {
  return {
    target: devProxyTarget(),
    ...extra,
    configure: (proxy: { on: (event: string, cb: (...args: unknown[]) => void) => void }) => {
      proxy.on("error", (_err: unknown, _req: unknown, res: unknown) => {
        const socket = res as { writableEnded?: boolean; writeHead?: (code: number) => void; end?: () => void } | undefined;
        try {
          if (socket && !socket.writableEnded && typeof socket.writeHead === "function") {
            socket.writeHead(502);
            socket.end?.();
          } else {
            (socket as { destroy?: () => void } | undefined)?.destroy?.();
          }
        } catch {
          // ignore — the point is only to not crash the dev server
        }
      });
    }
  };
}

// Sibling source checkouts of the shipped renderer, aliased to TS source so library edits
// hot-reload with no build (mirrors spirectl's own dev app). Resolved relative to this
// config file (frontend/vite.config.ts): ../../ is the parent directory containing the
// sibling ../../spirectl and ../../godot-scene-web checkouts.
const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const spirectlRoot = fromHere("../../spirectl");
const godotSceneWebRoot = fromHere("../../godot-scene-web");
const spirectl = (p: string) => fromHere(`../../spirectl/presentation/web/src/${p}`);
const gsw = (p: string) => fromHere(`../../godot-scene-web/packages/${p}`);

// R12 DEV ONLY — the host-rendered static combat background (`/bg/<id>.png`). Without an entry for it a dev server
// (and therefore the CDP replay bench, which drives one) falls through to the SPA's index.html: the decode rejects,
// StaticBackground.vue leaves the scenery blank, so the session cannot establish visual parity. With a live game
// up, `/bg` proxies to
// the real producer like `/res`; with no game up, point COUCHCOOP_DEV_BG_FIXTURE at a directory of PNGs instead.
//
// ARTIFACT POLICY: a `/bg/` PNG is official STS2 art. Fixtures live OUTSIDE the repo tree (`.sts2/` is gitignored,
// e.g. `.sts2/bench/bg/`), exactly like the bench recordings — never add one to the repo.
const devBgFixtureDir = process.env.COUCHCOOP_DEV_BG_FIXTURE
  ? resolve(process.env.COUCHCOOP_DEV_BG_FIXTURE)
  : null;
const releaseBuild = process.env.COUCHCOOP_RELEASE_BUILD === "1";

function devBgFromFs(dir: string): Plugin {
  return {
    name: "couchcoop-dev-bg-fixture",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/bg", (req, res, next) => {
        if (req.method && req.method !== "GET" && req.method !== "HEAD") {
          next();
          return;
        }
        // Production URLs are extensionless; older recordings use .png. Fixtures are PNG files.
        // The query is a cache key, never part of the file name.
        const name = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\//, "");
        if (!/^[a-z0-9_]+(?:\.png)?$/i.test(name)) {
          next();
          return;
        }
        let bytes: Buffer;
        try {
          bytes = readFileSync(resolve(dir, name.endsWith(".png") ? name : `${name}.png`));
        } catch {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "image/png");
        res.setHeader("cache-control", "no-store");
        res.end(bytes);
      });
      // Provenance: a bench log should always say where its background pixels came from.
      server.config.logger.info(`[couchcoop] serving /bg from ${dir} (dev fixture)`);
    }
  };
}

// `/app-boot.json` — what the public-origin bootstrap needs in order to load THIS build of the app off
// the host: the hashed entry module, the CSS the entry pulls in, and a build id.
//
// The URL is `/app-boot.json`, but the file emitted to disk is `app-boot` (NO extension). The build's
// outDir is the installed mod's `frontend/` dir, and STS2's ModManager recurses that tree and reads every
// name ending in `.json` as a candidate mod manifest, logging an `[ERROR]` for each one missing an `id`.
// A dot-directory is NOT an escape hatch: Godot's hidden-file test is a dot prefix on Unix but
// FILE_ATTRIBUTE_HIDDEN on Windows, which a zip-extracted or Workshop-synced directory never carries, so
// on Windows the scan reaches everything. Dropping the extension is the only escape hatch. The mod's
// browser server owns the `/app-boot.json` route and re-emits this file field by field
// (CouchCoopBrowserServer.HandleBootManifestRequestAsync), reading `StaticSpaFileProvider.BootManifestDiskName`.
//
// This is the mechanism that makes version skew structurally impossible in the remote-hosted mode. The
// public origin ships no application code at all; it asks the host what to load and loads exactly that.
// So a player whose mod is three releases old gets the app that shipped with their mod, not a newer one
// that speaks a protocol their host does not — no compatibility banner, no forced update, nothing to
// explain. The price is one extra round trip on boot, which the permission prompt dwarfs anyway.
//
// The build id is the entry's content hash: it changes on exactly the builds that change the app, which
// is also the signal `public/sw.js` already uses to drop its asset cache.
function couchCoopBootManifest(): Plugin {
  return {
    name: "couchcoop-boot-manifest",
    apply: "build",
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (chunk): chunk is typeof chunk & { isEntry: boolean; fileName: string; viteMetadata?: { importedCss?: Set<string> } } =>
          chunk.type === "chunk" && chunk.isEntry
      );
      if (!entry) {
        // Never fail the build over this: the host-served path does not use the manifest at all, and a
        // missing one degrades to "the web-link QR cannot boot", not to "no SPA exists".
        this.warn("no entry chunk found — app-boot manifest not emitted, the web-link QR will not boot");
        return;
      }
      const css = [...(entry.viteMetadata?.importedCss ?? [])];
      const buildId = /-([A-Za-z0-9_-]{8,})\.js$/.exec(entry.fileName)?.[1] ?? entry.fileName;
      this.emitFile({
        type: "asset",
        // Extensionless on purpose — see the header comment. Served under the URL `/app-boot.json`.
        fileName: "app-boot",
        source: `${JSON.stringify({
          entry: `/${entry.fileName}`,
          css: css.map((file) => `/${file}`),
          buildId,
          // Bumped only when the bootstrap's own contract changes (field names/semantics), NOT per build.
          bootProtocol: 1
        }, null, 2)}\n`
      });
    }
  };
}

export default defineConfig({
  // RELATIVE, so one build serves both topologies.
  //
  // Host-served (the default): `index.html` at the host's root resolves `./app/index-<hash>.js` to
  // `/app/…` exactly as an absolute base would — unchanged.
  //
  // Remote-hosted (the public-origin bootstrap): the entry chunk is injected with an ABSOLUTE host URL,
  // and every chunk/CSS/asset below it resolves relative to the importing module's own URL — i.e. also on
  // the host. An absolute `/app/…` base would instead resolve against the PUBLIC origin and 404, which is
  // the single change that makes the thin bootstrap possible at all.
  base: "./",
  build: {
    assetsDir: "app",
    emptyOutDir: true,
    // Vite's own manifest stays OFF. `couchCoopBootManifest` below reads the entry chunk straight off
    // `generateBundle`'s bundle object, so nothing needs the file — and `build.manifest: true` would write
    // it to `.vite/manifest.json` INSIDE the payload, where STS2's mod-manifest scan finds it and every
    // Windows player gets `Mod manifest …/frontend/.vite/manifest.json is missing the 'id' field! … The
    // mod will not be loaded.` in their log on every launch (reported from the field, game v0.107.1). The
    // dot-dir does not hide it there; see the `couchCoopBootManifest` header. If a future build ever does
    // need the manifest, emit it EXTENSIONLESS the way `app-boot` is.
    // Keep source maps for local/live QA, but never place embedded sibling/dependency source in a release payload.
    sourcemap: !releaseBuild,
    outDir: defaultOutDir()
  },
  plugins: [
    vue(),
    couchCoopBootManifest(),
    // Opt-in only; when set it TAKES PRECEDENCE over the `/bg` proxy entry below (which is omitted in that case).
    ...(devBgFixtureDir ? [devBgFromFs(devBgFixtureDir)] : []),
    // The aliased sibling sources below live OUTSIDE this root; never serve them stale
    // (bounded by the sweep even if the fs watcher silently fails on a long-lived server).
    freshSiblingSources({ roots: [spirectlRoot, godotSceneWebRoot] })
  ],
  resolve: {
    alias: {
      // Force a SINGLE Vue instance for every importer. `dedupe` alone does not override the
      // nested `vue` copies the sibling checkouts carry (godot-scene-web/node_modules/vue@3.5.35
      // and packages/vue/node_modules/vue), so @godot-scene-web/vue's `ref`/`computed` would bind
      // to a different reactivity instance than the mounted component — the live render then mounts
      // the scene root but never re-renders as lazy scenes/resources settle (symptom: frozen at the
      // single root node). Explicit absolute aliases win regardless of which source tree imports.
      vue: fromHere("./node_modules/vue"),
      "@vue/reactivity": fromHere("./node_modules/@vue/reactivity"),
      "@vue/runtime-core": fromHere("./node_modules/@vue/runtime-core"),
      "@vue/runtime-dom": fromHere("./node_modules/@vue/runtime-dom"),
      "@vue/shared": fromHere("./node_modules/@vue/shared"),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The mirror's ONLY entry point into the shipped renderer: the STS2 render vocabulary
      // (animation bindings, the BBCode tag table, the play-zone threshold).
      "@spirectl/presentation/render": spirectl("render/index.ts"),
      // DOM-free Spine/geoclip parsing and sampling. The stage owns I/O, decode and GPU residency.
      "@spirectl/presentation/spine": spirectl("spine/index.ts"),
      // M0 — the single-canvas stage's draw-list package. Aliased to gsw source like every sibling above, so a
      // draw-list edit hot-reloads with no build. Nothing imports it yet (the canvas backend is scaffold only).
      //
      // …and the GPU GLYPH PATH beside it, which is THREE more entries and every one of them a subpath, so they
      // all sit above their bare siblings per the rule at the top of this block:
      //
      //   canvas/glyphs — gsw keeps the hb-gpu-backed `GlyphPass` OFF the canvas barrel on purpose, so that a
      //                   scene with no text does not pull a glyph renderer and its wasm into the bundle.
      //   hb-gpu/webgl  — the borrowed-context renderer `canvas/glyphs` imports. Never imported by this app
      //                   directly; the alias exists because the aliased SOURCE above imports it by name.
      //   hb-gpu/vendor — the committed emscripten glue + `.wasm`. A DIRECTORY alias, deliberately: the wasm is
      //                   loaded as `…/hb-gpu.wasm?url`, and a per-file alias key would not match an id with a
      //                   query on it (Vite matches `find` or `find + "/"` prefixes, never a substring).
      //
      // `server.fs.allow` below already covers the gsw root, which is what lets DEV serve those two vendor files
      // from outside this project. That is not enough on its own: `?url` is what also makes a production `vite
      // build` emit the 417 KB binary as an asset instead of leaving a dangling absolute path in the bundle.
      "@godot-scene-web/canvas/glyphs": gsw("canvas/src/glyph-pass-hbgpu.ts"),
      "@godot-scene-web/canvas-effects/webgl": gsw("canvas-effects/src/webgl.ts"),
      "@godot-scene-web/canvas-effects/webgpu": gsw("canvas-effects/src/webgpu.ts"),
      "@godot-scene-web/canvas": gsw("canvas/src/index.ts"),
      "@godot-scene-web/hb-gpu/webgl": gsw("hb-gpu/src/webgl.ts"),
      "@godot-scene-web/hb-gpu/vendor": gsw("hb-gpu/vendor"),
      "@godot-scene-web/hb-gpu": gsw("hb-gpu/src/index.ts"),
      "@godot-scene-web/effects/shaders": gsw("effects/src/shaders/index.ts"),
      "@godot-scene-web/effects/particles": gsw("effects/src/particles/index.ts"),
      "@godot-scene-web/effects/easing": gsw("effects/src/easing/index.ts"),
      "@godot-scene-web/effects": gsw("effects/src/index.ts"),
      "@godot-scene-web/core": gsw("core/src/index.ts"),
      "@godot-scene-web/tscn-parser": gsw("tscn-parser/src/index.ts"),
      "@godot-scene-web/layout": gsw("layout/src/index.ts"),
      "@godot-scene-web/scene-graph": gsw("scene-graph/src/index.ts"),
      "@godot-scene-web/html/runtime": gsw("html/src/runtime.ts"),
      "@godot-scene-web/html": gsw("html/src/index.ts"),
      // The project package's package exports distinguish the two explicit environments.
      // Keep subpaths above the bare alias: Vite resolves an exact subpath to its source,
      // while a browser bundle gets fetch-backed project loading by default.
      "@godot-scene-web/project/node": gsw("project/src/node.ts"),
      "@godot-scene-web/project/fetch": gsw("project/src/fetch.ts"),
      "@godot-scene-web/project": gsw("project/src/fetch.ts"),
      "@godot-scene-web/vue": gsw("vue/src/index.ts")
    },
    // Footgun: the aliased sibling source trees each carry their OWN copies of the Vue
    // packages (gsw has `vue`; spirectl/web has `@vue/reactivity`), so without deduping the
    // live render would bind to a SECOND reactivity instance and never re-render when a lazy
    // scene/resource settles (symptom: frozen at the single root node). Force a single copy —
    // this app's own — for every importer regardless of source tree.
    dedupe: ["vue", "@vue/reactivity"]
  },
  // The aliased source packages are linked TS (not registry installs); don't pre-bundle them.
  optimizeDeps: {
    exclude: [
      "@godot-scene-web/vue",
      "@godot-scene-web/canvas"
    ]
  },
  server: {
    fs: {
      strict: true,
      // Allow importing the sibling renderer source (outside the frontend project root).
      // Vite resolves the worktree's renderer symlink before enforcing this
      // allow-list; retain both identities so hb-gpu's `?url` wasm import is
      // admitted in source-alias tests as well as the dev server.
      allow: [fromHere("./"), spirectlRoot, godotSceneWebRoot, realpathSync(godotSceneWebRoot)]
    },
    host: "127.0.0.1",
    proxy: {
      "/favicon.ico": resilientProxy(),
      // NOTE: `/bg` (the host-rendered static combat background) proxies to the game like `/res` —
      // unless COUCHCOOP_DEV_BG_FIXTURE is set, in which case `devBgFromFs()` serves it from disk
      // and this entry is omitted so the middleware wins. See that plugin for why dev needs either.
      ...(devBgFixtureDir ? {} : { "/bg": resilientProxy() }),
      // `/models/<model-asset-path>` — the seat picker's character icons (joinModel.seatCharacterIconUrl
      // → modelAssetRoute). Live game data like `/res`, so it proxies rather than being served from disk.
      "/models": resilientProxy(),
      "/res": resilientProxy(),
      "/spines": resilientProxy(),
      "/ws": resilientProxy({ ws: true })
    }
  }
});
