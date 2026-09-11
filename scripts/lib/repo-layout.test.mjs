import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  PRIMARY_REPO_ROOT,
  primaryCheckoutRoot,
  RECOVERED_RESOURCE_ROOT,
  REPO_ROOT,
  SPIRECTL_ROOT
} from "./repo-layout.mjs";

test("derives sibling and recovered-resource paths from this checkout", () => {
  assert.equal(SPIRECTL_ROOT, resolve(REPO_ROOT, "..", "spirectl"));
  assert.equal(RECOVERED_RESOURCE_ROOT, resolve(SPIRECTL_ROOT, ".sts2", "toolchain", "recovered-project"));
});

test("finds the primary checkout from a linked worktree", () => {
  const commonDir = execFileSync(
    "git",
    ["-C", REPO_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" }
  ).trim();
  assert.equal(primaryCheckoutRoot(), dirname(commonDir));
  assert.equal(PRIMARY_REPO_ROOT, dirname(commonDir));
});
