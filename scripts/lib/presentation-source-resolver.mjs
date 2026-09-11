// Resolve @spirectl/presentation from the sibling TypeScript checkout rather than
// Node's installed-package lookup. The mirror probes must exercise the same source
// exports that Vite aliases for the browser client.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

const PACKAGE_PREFIX = "@spirectl/presentation/";
const ACTIVE_CONDITIONS = new Set(["node", "development", "import"]);

export function defaultPresentationWebRoot(repoRoot) {
  return process.env.SPIRECTL_PRESENTATION_WEB_SOURCE_ROOT
    ? resolve(process.env.SPIRECTL_PRESENTATION_WEB_SOURCE_ROOT)
    : resolve(repoRoot, "../spirectl/presentation/web");
}

function subpathOf(specifier) {
  if (!specifier.startsWith(PACKAGE_PREFIX)) return null;
  const rest = specifier.slice(PACKAGE_PREFIX.length);
  if (!rest) throw new Error(`mirror-probe: invalid presentation specifier ${JSON.stringify(specifier)}`);
  return `./${rest}`;
}

function matchingExport(exports, subpath) {
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return undefined;
  if (Object.hasOwn(exports, subpath)) return exports[subpath];
  const pattern = Object.keys(exports)
    .filter((key) => key.startsWith(".") && key.includes("*"))
    .map((key) => {
      const [before, after] = key.split("*");
      return subpath.startsWith(before) && subpath.endsWith(after)
        ? { entry: exports[key], star: subpath.slice(before.length, subpath.length - after.length), key }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.key.length - a.key.length)[0];
  return pattern ?? undefined;
}

function conditionalTarget(entry, specifier) {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) {
    for (const alternative of entry) {
      try {
        return conditionalTarget(alternative, specifier);
      } catch (error) {
        if (!String(error.message).includes("has no active source export")) throw error;
      }
    }
  } else if (entry && typeof entry === "object") {
    // Conditional exports are declaration-order sensitive, just as Node resolves them.
    for (const [condition, nested] of Object.entries(entry)) {
      if (ACTIVE_CONDITIONS.has(condition)) return conditionalTarget(nested, specifier);
    }
  }
  throw new Error(`mirror-probe: ${specifier} has no active source export (looked under node + development + import)`);
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.includes("../"));
}

/** Map a presentation export to a confined TypeScript source file in presentation/web/src. */
export function resolvePresentationSpecifier(specifier, { sourceRoot } = {}) {
  const subpath = subpathOf(specifier);
  if (subpath === null) return null;
  const root = resolve(sourceRoot ?? defaultPresentationWebRoot(process.cwd()));
  const manifestPath = resolve(root, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`mirror-probe: presentation source root has no package.json: ${root}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`mirror-probe: could not read ${manifestPath}: ${error.message}`);
  }
  const match = matchingExport(manifest.exports, subpath);
  if (match === undefined) {
    throw new Error(`mirror-probe: ${specifier} is not exported by ${manifestPath}`);
  }
  const target = conditionalTarget(match.entry ?? match, specifier);
  const expanded = match.star == null ? target : target.replaceAll("*", match.star);
  if (typeof expanded !== "string" || !expanded.startsWith(".")) {
    throw new Error(`mirror-probe: invalid source target for ${specifier}: ${JSON.stringify(expanded)}`);
  }
  const targetPath = resolve(root, expanded);
  if (!existsSync(targetPath)) {
    throw new Error(`mirror-probe: source target for ${specifier} does not exist: ${targetPath}`);
  }
  const actualRoot = realpathSync(root);
  const actualTarget = realpathSync(targetPath);
  const sourceDir = resolve(actualRoot, "src");
  if (!inside(actualRoot, actualTarget)) {
    throw new Error(`mirror-probe: source target for ${specifier} escapes its package: ${expanded}`);
  }
  if (!inside(sourceDir, actualTarget)) {
    throw new Error(`mirror-probe: source target for ${specifier} is not under src/: ${expanded}`);
  }
  return actualTarget;
}
