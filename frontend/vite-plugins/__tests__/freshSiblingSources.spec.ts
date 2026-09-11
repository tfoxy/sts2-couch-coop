// @vitest-environment node
//
// The freshness-sweep plugin must bound staleness for out-of-root "sibling" sources even
// when vite's fs watcher is COMPLETELY DEAD — the exact historical failure mode (a
// long-lived dev server silently missing sibling edits). `server.watch: null` officially
// disables watching, so without the sweep the second transform below would stay stale.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { freshSiblingSources } from "../freshSiblingSources";

const SWEEP_MS = 50;

let server: ViteDevServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// Write `content` and force a DIFFERENT mtime than the previous write — same-ms writes
// would otherwise be invisible to an mtime-based sweep on coarse-timestamp filesystems.
function writeWithFreshMtime(file: string, content: string, epochSeconds: number): void {
  writeFileSync(file, content);
  utimesSync(file, epochSeconds, epochSeconds);
}

async function startServer(sibling: string, root: string, withSweep: boolean): Promise<ViteDevServer> {
  return createServer({
    configFile: false,
    logLevel: "silent",
    root,
    server: {
      watch: null, // dead watcher — the failure mode under test
      middlewareMode: true,
      hmr: false,
      fs: { allow: [sibling, root] } // the sibling lives outside the server root, like the real aliases
    },
    plugins: withSweep ? [freshSiblingSources({ roots: [sibling], intervalMs: SWEEP_MS })] : []
  });
}

async function transformed(srv: ViteDevServer, file: string): Promise<string> {
  const result = await srv.transformRequest(`/@fs/${file}`);
  expect(result).toBeTruthy();
  return result!.code;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("freshSiblingSources sweep", () => {
  it("serves an out-of-root edit fresh within one sweep interval despite a dead watcher", async () => {
    dir = mkdtempSync(join(tmpdir(), "couchcoop-fresh-"));
    const sibling = join(dir, "sibling");
    const root = join(dir, "approot");
    mkdirSync(sibling, { recursive: true });
    mkdirSync(root, { recursive: true });
    const file = join(sibling, "mod.ts");
    const base = Math.floor(Date.now() / 1000) - 10;
    writeWithFreshMtime(file, "export const marker = \"v1\";\n", base);

    server = await startServer(sibling, root, true);
    expect(await transformed(server, file)).toContain("v1");

    writeWithFreshMtime(file, "export const marker = \"v2\";\n", base + 5);
    await sleep(SWEEP_MS * 6);
    expect(await transformed(server, file)).toContain("v2");
  });

  it("control: without the sweep, the dead watcher serves the edit STALE", async () => {
    dir = mkdtempSync(join(tmpdir(), "couchcoop-stale-"));
    const sibling = join(dir, "sibling");
    const root = join(dir, "approot");
    mkdirSync(sibling, { recursive: true });
    mkdirSync(root, { recursive: true });
    const file = join(sibling, "mod.ts");
    const base = Math.floor(Date.now() / 1000) - 10;
    writeWithFreshMtime(file, "export const marker = \"v1\";\n", base);

    server = await startServer(sibling, root, false);
    expect(await transformed(server, file)).toContain("v1");

    writeWithFreshMtime(file, "export const marker = \"v2\";\n", base + 5);
    await sleep(SWEEP_MS * 6);
    // Confirms the test setup really models the failure mode (and that the first test's
    // pass is attributable to the sweep, not to some other invalidation path).
    expect(await transformed(server, file)).toContain("v1");
  });
});
