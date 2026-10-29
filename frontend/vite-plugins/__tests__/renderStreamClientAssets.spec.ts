// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RENDER_STREAM_CORE_FILES,
  renderStreamClientAssets,
  renderStreamCoreStatus
} from "../renderStreamClientAssets";

// The new renderer's core is usable only when all three files exist and `build.json`'s tree is the aliased GSW
// sources' tree: a stale core paired with newer TS is a silent protocol mismatch, so it must never mount.

const dirs: string[] = [];
function buildDir(tree: string | null, files: readonly string[] = RENDER_STREAM_CORE_FILES): string {
  const dir = mkdtempSync(join(tmpdir(), "couch-rs-core-"));
  dirs.push(dir);
  for (const name of files) {
    writeFileSync(join(dir, name), name === "build.json" ? JSON.stringify({ rs_core_tree: tree }) : "x");
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("renderStreamCoreStatus", () => {
  it("accepts a build of the expected tree, dirty suffix included", () => {
    expect(renderStreamCoreStatus(buildDir("0ccb21bb561c"), "0ccb21bb561c")).toEqual({ expectedTree: "0ccb21bb561c", problem: null });
    expect(renderStreamCoreStatus(buildDir("0ccb21bb561c-dirty"), "0ccb21bb561c-dirty").problem).toBeNull();
  });

  it("refuses a missing file, another tree, or an unknown expected tree", () => {
    expect(renderStreamCoreStatus(buildDir("a", ["build.json"]), "a").problem).toBe("missing");
    expect(renderStreamCoreStatus(join(tmpdir(), "couch-rs-core-none"), "a").problem).toBe("missing");
    expect(renderStreamCoreStatus(buildDir("0ccb21bb561c"), "111111111111").problem).toBe("stale");
    expect(renderStreamCoreStatus(buildDir("0ccb21bb561c"), null).problem).toBe("unverified");
  });

  it("states the verdict through the virtual module", async () => {
    const plugin = renderStreamClientAssets({ dir: buildDir("abc"), gswRoot: "/gsw", coreTree: () => "abc" });
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;
    const id = resolveId("virtual:couch-render-stream-core");
    expect(id).toBeDefined();
    expect(load(id!)).toBe('export default {"expectedTree":"abc","problem":null};\n');
    expect(resolveId("@/mirror/renderStreamCore")).toBeUndefined();
  });
});
