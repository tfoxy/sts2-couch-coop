// Build for the PUBLIC origin (Cloudflare Pages) — a separate, tiny artifact from the app build.
//
// Separate config rather than a second entry in vite.config.ts because the two outputs have nothing in
// common: this one ships no application code, no assets and no game knowledge, it has its own outDir, and
// crucially its outDir must NOT be the installed mod directory that the app build writes to (and wipes).
//
// The bootstrap is written in TypeScript under `src/boot/` and built here, rather than hand-written as a
// static file, so it type-checks, unit-tests, and reuses the very same host-parsing rules the app itself
// uses (`@/join/hostStore`) instead of a second copy that can drift.

import { cp, readdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Pages and the host-served SPA deliberately have different workers, but they share
// the install icons and localized manifests. Keep that set in `public/`, then emit
// it into the Pages artifact here so it cannot drift as a tracked second copy.
const sharedPwaAssets = {
  name: "couchcoop-pages-shared-pwa-assets",
  async writeBundle() {
    const publicRoot = fromHere("./public");
    const outputRoot = fromHere("./pages-dist");
    await cp(fromHere("./public/icons"), `${outputRoot}/icons`, { recursive: true });
    const entries = await readdir(publicRoot);
    await Promise.all(
      entries
        .filter((entry) => /^manifest(?:\..+)?\.webmanifest$/.test(entry))
        .map((entry) => cp(`${publicRoot}/${entry}`, `${outputRoot}/${entry}`)),
    );
  },
};

export default defineConfig({
  root: fromHere("./pages"),
  // Absolute: this origin serves exactly one document at exactly one path, so there is no ambiguity to
  // solve with a relative base (unlike the app build, which has to work under both topologies).
  base: "/",
  build: {
    outDir: fromHere("./pages-dist"),
    emptyOutDir: true,
    // A bootstrap whose job is to run before anything else has no business shipping a source map the
    // phone might fetch, and nothing here is minified past readability anyway.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Stable, unhashed names: `index.html` references `/boot.js` literally, `_headers` names it, and
        // the service worker precaches it by path. Hashing would buy cache-busting we explicitly do not
        // want here — `_headers` sets `no-cache` on exactly these files for the same reason.
        entryFileNames: "boot.js",
        chunkFileNames: "boot-[name].js",
        assetFileNames: "[name][extname]"
      }
    }
  },
  resolve: {
    alias: {
      "@": fromHere("./src")
    }
  },
  plugins: [sharedPwaAssets]
});
