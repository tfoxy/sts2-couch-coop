// DEV ONLY: guarantee the dev server never serves stale transforms for the sibling-repo
// sources (spirectl/gsw) that vite.config.ts aliases from OUTSIDE the project root.
//
// Vite normally watches out-of-root module files lazily (`ensureWatchedFile`), but a
// long-lived server once kept serving stale sibling transforms after edits (watcher
// silently missing files — e.g. an editor/tool replacing the file's INODE, which a
// per-file inotify watch does not follow; proven live with `sed -i`). The cost of that
// failure is silent wrong measurements, so instead of trusting the watcher this plugin
// BOUNDS staleness:
//   1. logs watcher errors loudly (inotify exhaustion is otherwise swallowed),
//   2. sweeps the module graph's sibling files by mtime every `intervalMs` and, on a
//      change the watcher missed, invalidates via vite's own pipeline
//      (`moduleGraph.onFileChange` + `reloadModule` → HMR/full-reload to open tabs).
// Even with a completely dead watcher, no stale transform outlives one sweep interval.
//
// Deliberately NOT `server.watcher.add(roots)`: recursive dir watches over the whole
// sibling checkouts (19GB incl. asset caches) exploded to ~360k inotify watches and a
// runaway multi-core scan. The sweep only ever touches files already in the module
// graph (a few hundred stats per tick), which is all freshness needs.
//
// Opt out with COUCHCOOP_NO_SIBLING_SWEEP=1.

import { statSync } from "node:fs";

import type { Plugin, ViteDevServer } from "vite";

export interface FreshSiblingSourcesOptions {
  /** Absolute directory roots whose files must never be served stale. */
  roots: string[];
  /** Sweep period in ms (default 2000). */
  intervalMs?: number;
}

export function freshSiblingSources(options: FreshSiblingSourcesOptions): Plugin {
  const roots = options.roots;
  const intervalMs = options.intervalMs ?? 2000;
  const isSibling = (file: string) => roots.some((root) => file.startsWith(root));
  // file → mtimeMs the currently cached transform was built from. Recorded at TRANSFORM
  // time (not first-sweep time): an edit landing between a file's first transform and
  // its first sweep sighting would otherwise be recorded as the baseline and never
  // invalidate — serving the pre-edit transform forever.
  const seen = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    name: "couchcoop-fresh-sibling-sources",
    apply: "serve",
    transform(_code, id) {
      const file = id.split("?")[0].split("#")[0];
      if (!isSibling(file)) return;
      try {
        seen.set(file, statSync(file).mtimeMs);
      } catch {
        // unreadable now → let the sweep's stat failure path handle it
      }
    },
    // `server.httpServer` is null in middlewareMode, so also stop the sweep when the
    // dev server closes its plugin container.
    closeBundle() {
      clearInterval(timer);
    },
    configureServer(server: ViteDevServer) {
      if (process.env.COUCHCOOP_NO_SIBLING_SWEEP === "1") {
        server.config.logger.info("[couchcoop] sibling-source freshness sweep DISABLED (COUCHCOOP_NO_SIBLING_SWEEP=1)");
        return;
      }
      // Chokidar swallows nothing here — an inotify failure surfaces in the terminal
      // instead of silently freezing invalidation.
      server.watcher.on("error", (error) => {
        server.config.logger.error(
          `[couchcoop] fs watcher error — sibling-source edits may not propagate (the freshness sweep still bounds staleness to ${intervalMs}ms): ${String(error)}`
        );
      });

      // Guarantee: mtime sweep over the sibling files currently in the module graph,
      // compared against the transform-time mtimes recorded above. A file that somehow
      // reached the graph without our transform hook (first sighting) just records.
      let sweeping = false;
      const sweep = () => {
        if (sweeping) return;
        sweeping = true;
        try {
          for (const [file, mods] of server.moduleGraph.fileToModulesMap) {
            if (!isSibling(file)) continue;
            let mtime: number;
            try {
              mtime = statSync(file).mtimeMs;
            } catch {
              mtime = -1; // deleted/unreadable counts as a change
            }
            const previous = seen.get(file);
            seen.set(file, mtime);
            if (previous === undefined || previous === mtime) continue;
            // The watcher should have done this already — reaching here means it missed
            // the event, so the log line is pure signal.
            server.config.logger.warn(
              `[couchcoop] freshness sweep: ${file} changed but the fs watcher missed it — invalidating`
            );
            server.moduleGraph.onFileChange(file);
            for (const mod of mods) {
              // Pushes HMR/full-reload to connected tabs; no-op when hmr is disabled
              // (the onFileChange above already guarantees fresh serves either way).
              void server.reloadModule(mod);
            }
          }
        } finally {
          sweeping = false;
        }
      };
      timer = setInterval(sweep, intervalMs);
      timer.unref?.();
      server.httpServer?.once("close", () => clearInterval(timer));
      server.config.logger.info(
        `[couchcoop] sibling-source freshness sweep active (${intervalMs}ms): ${roots.join(", ")}`
      );
    }
  };
}
