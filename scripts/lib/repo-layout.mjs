import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SPIRECTL_ROOT = resolve(REPO_ROOT, "..", "spirectl");
export const RECOVERED_RESOURCE_ROOT = resolve(SPIRECTL_ROOT, ".sts2", "toolchain", "recovered-project");

/** Return the primary checkout for this Git worktree, or the current root outside Git. */
export function primaryCheckoutRoot(repoRoot = REPO_ROOT) {
  try {
    const commonDir = execFileSync(
      "git",
      ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return dirname(commonDir);
  } catch {
    return repoRoot;
  }
}

export const PRIMARY_REPO_ROOT = primaryCheckoutRoot();
