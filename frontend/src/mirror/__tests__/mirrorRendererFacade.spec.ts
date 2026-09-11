import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIRROR_ROOT = join(FRONTEND_ROOT, "src/mirror");
const RENDERER_ROOT = join(MIRROR_ROOT, "renderer");
const FACADE_PATH = join(MIRROR_ROOT, "mirrorRenderer.ts");
const COMPOSER_PATH = join(RENDERER_ROOT, "dom/createDomMirrorRenderer.ts");

// This is a compatibility contract, not a snapshot: additions and removals need an intentional review.
const EXPECTED_EXPORTED_NAMES = [
  "CREATURE_HUD_NAMES",
  "CREATURE_INTENT_GAP",
  "CREATURE_POWER_ROW_H",
  "CREATURE_POWER_TOP_FALLBACK",
  "CREATURE_RETICLE_TOP_FALLBACK",
  "CREATURE_SCENE_FILE_SUFFIX",
  "CanvasHandRaiseChrome",
  "CanvasSnapshotSource",
  "FlightAnimFailReason",
  "FlightRetireReason",
  "FullWalkCause",
  "HAND_CHOICE_NAMES",
  "HAND_CHOICE_TYPES",
  "HAND_CONTAINER_NAME",
  "HAND_HOLDER_TYPE",
  "HAND_RAISE_PX",
  "HAND_RAISE_RAMP_END_Y",
  "HAND_RAISE_RAMP_START_Y",
  "HAND_ROOT_TYPE",
  "HandRaiseUiLayer",
  "InteractiveRect",
  "MirrorRenderer",
  "MirrorStaticStillCounters",
  "MirrorWalkStats",
  "PAINT_ANCHOR_EXCLUDED_NAMES",
  "PAINT_ANCHOR_EXCLUDED_TYPES",
  "PROCEED_BUTTON_SCENE_FILE_SUFFIX",
  "REMOTE_FOLLOWER_TYPES",
  "ReconcilePull",
  "SpreadPainter",
  "TARGETING_TYPES",
  "TOUCH_TARGET_TYPES",
  "TouchBlockKind",
  "TouchStack",
  "__resetAtlasDecodeGateForTest",
  "__setCanvasSnapshotSourceForTest",
  "__setFlightLogForTest",
  "backstopCoverPath",
  "confirmTapEligible",
  "createMirrorRenderer",
  "domSpreadPainterAt",
  "domTouchStackAt",
  "intentFrameIndex",
  "isBlockingButtonType",
  "isCombatBackgroundScenePath",
  "isCombatBackgroundSceneRoot",
  "isCombatPileContainer",
  "isDecorativeOverlay",
  "isEchoContainer",
  "isEventBackgroundSceneRoot",
  "isHitTestExcluded",
  "isLineEraser",
  "isMapStrokeNode",
  "isRoomBackgroundSubtreeRoot",
  "isScrollbarBlockType",
  "isStaticBackgroundSuppressibleRoot",
  "mapPointElementIdAt",
  "mirrorWalkStats",
  "nodeTypeLeaf",
  "scrollbarBlockKind",
  "setStaticStillCountersGauge",
  "setStaticStillGauge",
  "spreadSceneIdentityEnv",
  "staticBgCoversScenePath",
  "staticBgTargetPathOf",
  "tryParseEventBackgroundSceneId",
  "tryParseRoomBackgroundSceneId",
  "viewScaleOn",
  "viewScaleSharedEnv"
] as const;

function sourceFile(path: string): ts.SourceFile {
  const text = readFileSync(path, "utf8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function namedExports(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    names.push(...statement.exportClause.elements.map((specifier) => specifier.name.text));
  }
  return names.sort();
}

function exportedTopLevelNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        names.push(...statement.exportClause.elements.map((specifier) => specifier.name.text));
      } else {
        names.push("*");
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      names.push("default");
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      names.push(...statement.declarationList.declarations.map((declaration) => declaration.name.getText(source)));
    } else if (
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isModuleDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      const name = statement.name;
      if (name && ts.isIdentifier(name)) names.push(name.text);
    }
  }
  return names.sort();
}

function moduleSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function candidateModulePaths(path: string): string[] {
  const extension = extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  return [...new Set([path, `${path}.ts`, `${stem}.ts`, join(path, "index.ts"), join(stem, "index.ts")])];
}

function resolveModule(fromPath: string, specifier: string): string | null {
  let candidate: string;
  if (specifier.startsWith(".")) {
    candidate = resolve(dirname(fromPath), specifier);
  } else if (specifier === "@" || specifier.startsWith("@/")) {
    candidate = resolve(FRONTEND_ROOT, "src", specifier.slice(2));
  } else {
    return null;
  }
  return candidateModulePaths(candidate).find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

function isWithin(root: string, path: string): boolean {
  const pathRelative = relative(root, path);
  return pathRelative !== "" && !pathRelative.startsWith("../") && pathRelative !== "..";
}

function rendererFiles(path = RENDERER_ROOT): string[] {
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) return rendererFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    });
}

function dependencyGraph(): Map<string, string[]> {
  const files = rendererFiles();
  const graph = new Map<string, string[]>(files.map((path): [string, string[]] => [path, []]));
  for (const path of files) {
    const dependencies = graph.get(path)!;
    for (const specifier of moduleSpecifiers(sourceFile(path))) {
      const destination = resolveModule(path, specifier);
      if (destination && isWithin(RENDERER_ROOT, destination)) dependencies.push(destination);
    }
    dependencies.sort();
  }
  return graph;
}

function cyclesIn(graph: Map<string, string[]>): string[][] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (path: string): void => {
    visited.add(path);
    active.add(path);
    stack.push(path);
    for (const dependency of graph.get(path) ?? []) {
      if (active.has(dependency)) {
        cycles.push([...stack.slice(stack.indexOf(dependency)), dependency].map((item) => relative(RENDERER_ROOT, item)));
      } else if (!visited.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    active.delete(path);
  };
  for (const path of [...graph.keys()].sort()) if (!visited.has(path)) visit(path);
  return cycles;
}

describe("mirrorRenderer compatibility facade architecture", () => {
  it("freezes its 69 explicit named exports, including type exports", () => {
    const names = namedExports(sourceFile(FACADE_PATH));
    expect(EXPECTED_EXPORTED_NAMES).toHaveLength(69);
    expect(new Set(EXPECTED_EXPORTED_NAMES).size).toBe(EXPECTED_EXPORTED_NAMES.length);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(EXPECTED_EXPORTED_NAMES);
  });

  it("is a compact named-re-export facade with the factory compatibility alias", () => {
    const bytes = Buffer.byteLength(readFileSync(FACADE_PATH, "utf8"), "utf8");
    const nonblankLines = readFileSync(FACADE_PATH, "utf8").split(/\r?\n/).filter((line) => line.trim()).length;
    const source = sourceFile(FACADE_PATH);
    expect(nonblankLines).toBeLessThanOrEqual(350);
    expect(bytes).toBeLessThanOrEqual(48 * 1024);
    for (const statement of source.statements) {
      expect(ts.isExportDeclaration(statement)).toBe(true);
      if (!ts.isExportDeclaration(statement)) continue;
      expect(statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)).toBe(true);
      expect(statement.exportClause && ts.isNamedExports(statement.exportClause)).toBe(true);
    }
    const factory = source.statements.find(
      (statement): statement is ts.ExportDeclaration =>
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "@/mirror/renderer/dom/createDomMirrorRenderer"
    );
    expect(factory?.exportClause && ts.isNamedExports(factory.exportClause) ? factory.exportClause.elements.map((specifier) => [specifier.propertyName?.text, specifier.name.text]) : []).toEqual([
      ["createDomMirrorRenderer", "createMirrorRenderer"]
    ]);
  });

  it("keeps the DOM composer one-way and free of facade references", () => {
    const composer = sourceFile(COMPOSER_PATH);
    expect(exportedTopLevelNames(composer)).toEqual(["createDomMirrorRenderer"]);
    const facadeReferences = moduleSpecifiers(composer).filter(
      (specifier) => specifier === "@/mirror/mirrorRenderer" || resolveModule(COMPOSER_PATH, specifier) === FACADE_PATH
    );
    expect(facadeReferences).toEqual([]);
  });

  it("has no renderer-subtree dependency cycles or implementation back-imports", () => {
    const files = rendererFiles();
    const facadeReferences = files.flatMap((path) =>
      moduleSpecifiers(sourceFile(path))
        .filter((specifier) => specifier === "@/mirror/mirrorRenderer" || resolveModule(path, specifier) === FACADE_PATH)
        .map((specifier) => `${relative(RENDERER_ROOT, path)} -> ${specifier}`)
    );
    expect(files).toContain(COMPOSER_PATH);
    expect(facadeReferences).toEqual([]);
    expect(cyclesIn(dependencyGraph())).toEqual([]);
  });
});
