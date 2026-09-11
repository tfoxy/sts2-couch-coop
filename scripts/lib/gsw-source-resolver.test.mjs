import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { REPO_ROOT, benchDir, loadSceneTree, replayRecording } from "./mirror-probe.mjs";
import { defaultGodotSceneWebRoot, resolveGodotSceneWebSpecifier } from "./gsw-source-resolver.mjs";

const SOURCE_ROOT = defaultGodotSceneWebRoot(REPO_ROOT);

test("resolves a bare renderer package to its development source", () => {
  const target = resolveGodotSceneWebSpecifier("@godot-scene-web/canvas", { sourceRoot: SOURCE_ROOT });
  assert.match(target, /packages\/canvas\/src\/index\.ts$/);
});

test("resolves explicit and ordinary exported subpaths", () => {
  assert.match(
    resolveGodotSceneWebSpecifier("@godot-scene-web/project/node", { sourceRoot: SOURCE_ROOT }),
    /packages\/project\/src\/node\.ts$/
  );
  assert.match(
    resolveGodotSceneWebSpecifier("@godot-scene-web/project/fetch", { sourceRoot: SOURCE_ROOT }),
    /packages\/project\/src\/fetch\.ts$/
  );
  assert.match(
    resolveGodotSceneWebSpecifier("@godot-scene-web/hb-gpu/webgl", { sourceRoot: SOURCE_ROOT }),
    /packages\/hb-gpu\/src\/webgl\.ts$/
  );
});

test("selects nested node then development conditions in the project manifest", () => {
  const target = resolveGodotSceneWebSpecifier("@godot-scene-web/project", { sourceRoot: SOURCE_ROOT });
  assert.match(target, /packages\/project\/src\/node\.ts$/);
});

test("rejects unknown packages and exports clearly", () => {
  assert.throws(
    () => resolveGodotSceneWebSpecifier("@godot-scene-web/no-such-package", { sourceRoot: SOURCE_ROOT }),
    /unknown @godot-scene-web package/
  );
  assert.throws(
    () => resolveGodotSceneWebSpecifier("@godot-scene-web/canvas/no-such-export", { sourceRoot: SOURCE_ROOT }),
    /is not exported/
  );
});

test("uses declaration order for active conditional exports", () => {
  const root = join(tmpdir(), `mirror-probe-condition-order-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(join(root, "packages", "order-sensitive", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "order-sensitive", "src", "development.ts"), "export default {};\n");
    writeFileSync(join(root, "packages", "order-sensitive", "src", "node.ts"), "export default {};\n");
    writeFileSync(
      join(root, "packages", "order-sensitive", "package.json"),
      JSON.stringify({
        exports: {
          ".": {
            development: "./src/development.ts",
            node: { development: "./src/node.ts" }
          }
        }
      })
    );
    assert.match(
      resolveGodotSceneWebSpecifier("@godot-scene-web/order-sensitive", { sourceRoot: root }),
      /packages\/order-sensitive\/src\/development\.ts$/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing development branches, production strings, and targets outside the package", () => {
  const root = join(tmpdir(), `mirror-probe-resolver-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(join(root, "packages", "missing-dev"), { recursive: true });
    writeFileSync(
      join(root, "packages", "missing-dev", "package.json"),
      JSON.stringify({ exports: { ".": { import: "./dist/index.js" } } })
    );
    assert.throws(
      () => resolveGodotSceneWebSpecifier("@godot-scene-web/missing-dev", { sourceRoot: root }),
      /has no development export/
    );

    mkdirSync(join(root, "packages", "production-only", "dist"), { recursive: true });
    writeFileSync(join(root, "packages", "production-only", "dist", "index.js"), "export default {};\n");
    writeFileSync(
      join(root, "packages", "production-only", "package.json"),
      JSON.stringify({ exports: { ".": "./dist/index.js" } })
    );
    assert.throws(
      () => resolveGodotSceneWebSpecifier("@godot-scene-web/production-only", { sourceRoot: root }),
      /has no development export/
    );

    mkdirSync(join(root, "packages", "escape"), { recursive: true });
    writeFileSync(join(root, "packages", "outside.ts"), "export const outside = true;\n");
    writeFileSync(
      join(root, "packages", "escape", "package.json"),
      JSON.stringify({ exports: { ".": { development: "../outside.ts" } } })
    );
    assert.throws(
      () => resolveGodotSceneWebSpecifier("@godot-scene-web/escape", { sourceRoot: root }),
      /escapes its package/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loads and replays the real scene tree under the probe hooks", async () => {
  const recording = join(benchDir(), "combat-modern-2026-08-06.ndjson");
  assert.equal(existsSync(recording), true, `fixture recording missing: ${recording}`);
  const sceneTree = await loadSceneTree();
  assert.equal(typeof sceneTree.createMirrorState, "function");
  const replay = await replayRecording(recording);
  assert.ok(replay.deltas > 0, `expected replay deltas from ${basename(recording)}`);
  assert.ok(replay.state.nodes.size > 0, "expected replayed scene nodes");
});
