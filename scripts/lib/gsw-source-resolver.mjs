// Resolve this consumer's renderer imports the same way its source-consuming dev server does:
// package exports, with Node's `node` + `development` conditions, rather than a hand-maintained
// list of files. Keeping this standalone makes the probe hook testable without installing hooks.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

const PACKAGE_PREFIX = "@godot-scene-web/";
const ACTIVE_CONDITIONS = new Set(["node", "development"]);

export function defaultGodotSceneWebRoot(repoRoot) {
  return process.env.GODOT_SCENE_WEB_SOURCE_ROOT
    ? resolve(process.env.GODOT_SCENE_WEB_SOURCE_ROOT)
    : resolve(repoRoot, "../godot-scene-web");
}

function packageAndSubpath(specifier) {
  if (!specifier.startsWith(PACKAGE_PREFIX)) {
    return null;
  }
  const rest = specifier.slice(PACKAGE_PREFIX.length);
  const [packageName, ...parts] = rest.split("/");
  if (!packageName) {
    throw new Error(`mirror-probe: invalid renderer specifier ${JSON.stringify(specifier)}`);
  }
  return { packageName, subpath: parts.length === 0 ? "." : `./${parts.join("/")}` };
}

function matchingExport(exports, subpath) {
  if (typeof exports === "string" || Array.isArray(exports) || exports == null) {
    return subpath === "." ? exports : undefined;
  }
  // `exports` may itself be the root conditional object (`{ development: ... }`),
  // rather than the more common `{ ".": { development: ... } }` subpath map.
  if (!Object.keys(exports).some((key) => key.startsWith("."))) {
    return subpath === "." ? exports : undefined;
  }
  if (Object.hasOwn(exports, subpath)) {
    return exports[subpath];
  }

  // Node permits one `*` in an export key. Choose the most-specific matching pattern,
  // which is the same precedence Node gives pattern keys.
  const pattern = Object.keys(exports)
    .filter((key) => key.includes("*") && key.startsWith("."))
    .map((key) => {
      const [before, after] = key.split("*");
      return subpath.startsWith(before) && subpath.endsWith(after)
        ? { key, star: subpath.slice(before.length, subpath.length - after.length) }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.key.length - a.key.length)[0];
  if (!pattern) {
    return undefined;
  }
  return { pattern: exports[pattern.key], star: pattern.star };
}

function conditionalTarget(entry, packageName, subpath, underDevelopment = false) {
  if (typeof entry === "string") {
    if (underDevelopment) {
      return entry;
    }
  }
  if (Array.isArray(entry)) {
    for (const alternative of entry) {
      try {
        return conditionalTarget(alternative, packageName, subpath, underDevelopment);
      } catch (error) {
        if (!String(error.message).includes("missing development export")) {
          throw error;
        }
      }
    }
  } else if (entry && typeof entry === "object") {
    // Conditional exports are declaration-order sensitive: Node considers object
    // keys in manifest order and picks the first active condition, not a caller-
    // chosen priority order. `project` therefore reaches node → development, while
    // a package that declares development first selects it directly.
    for (const [condition, nested] of Object.entries(entry)) {
      if (ACTIVE_CONDITIONS.has(condition)) {
        return conditionalTarget(nested, packageName, subpath, underDevelopment || condition === "development");
      }
    }
  }
  throw new Error(
    `mirror-probe: @godot-scene-web/${packageName}${subpath === "." ? "" : subpath.slice(1)} has no development export (looked under node + development)`
  );
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.includes("../"));
}

/**
 * Map a @godot-scene-web specifier to an existing TypeScript source target.
 *
 * `sourceRoot` is the checkout root, not its `packages/` directory. It is optional
 * solely so tests and one-off probes can point at a disposable checkout.
 */
export function resolveGodotSceneWebSpecifier(specifier, { sourceRoot } = {}) {
  const parsed = packageAndSubpath(specifier);
  if (!parsed) {
    return null;
  }
  const root = resolve(sourceRoot ?? defaultGodotSceneWebRoot(process.cwd()));
  const packageRoot = resolve(root, "packages", parsed.packageName);
  const manifestPath = resolve(packageRoot, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`mirror-probe: unknown @godot-scene-web package ${JSON.stringify(parsed.packageName)} in ${root}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`mirror-probe: could not read ${manifestPath}: ${error.message}`);
  }
  const match = matchingExport(manifest.exports, parsed.subpath);
  if (match === undefined) {
    throw new Error(
      `mirror-probe: @godot-scene-web/${parsed.packageName}${parsed.subpath === "." ? "" : parsed.subpath.slice(1)} is not exported by ${manifestPath}`
    );
  }
  const target = conditionalTarget(match.pattern ?? match, parsed.packageName, parsed.subpath);
  const expanded = match.star == null ? target : target.replaceAll("*", match.star);
  if (typeof expanded !== "string" || !expanded.startsWith(".")) {
    throw new Error(`mirror-probe: invalid development target for ${specifier}: ${JSON.stringify(expanded)}`);
  }

  const targetPath = resolve(packageRoot, expanded);
  if (!existsSync(targetPath)) {
    throw new Error(`mirror-probe: development target for ${specifier} does not exist: ${targetPath}`);
  }
  const actualPackageRoot = realpathSync(packageRoot);
  const actualTarget = realpathSync(targetPath);
  if (!inside(actualPackageRoot, actualTarget)) {
    throw new Error(`mirror-probe: development target for ${specifier} escapes its package: ${expanded}`);
  }
  return actualTarget;
}
