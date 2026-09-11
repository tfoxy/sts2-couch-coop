import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REPO_ROOT } from "./mirror-probe.mjs";
import { defaultPresentationWebRoot, resolvePresentationSpecifier } from "./presentation-source-resolver.mjs";

const SOURCE_ROOT = defaultPresentationWebRoot(REPO_ROOT);

test("resolves presentation exports to sibling TypeScript sources", () => {
  assert.match(resolvePresentationSpecifier("@spirectl/presentation/render", { sourceRoot: SOURCE_ROOT }), /presentation\/web\/src\/render\/index\.ts$/);
  assert.match(resolvePresentationSpecifier("@spirectl/presentation/spine", { sourceRoot: SOURCE_ROOT }), /presentation\/web\/src\/spine\/index\.ts$/);
});

test("rejects unknown exports and targets outside source", () => {
  assert.throws(
    () => resolvePresentationSpecifier("@spirectl/presentation/no-such-export", { sourceRoot: SOURCE_ROOT }),
    /is not exported/
  );
  const root = join(tmpdir(), `mirror-probe-presentation-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "outside.ts"), "export default {};\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ exports: { "./escape": { import: "./outside.ts" } } }));
    assert.throws(
      () => resolvePresentationSpecifier("@spirectl/presentation/escape", { sourceRoot: root }),
      /not under src\//
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
