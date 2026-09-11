import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIRROR_ROOT = join(FRONTEND_ROOT, "src/mirror");
const CANVAS_ROOT = join(MIRROR_ROOT, "canvas");
const CANVAS_RENDERER_ROOT = join(MIRROR_ROOT, "renderer/canvas");
const FACADE_PATH = join(CANVAS_ROOT, "canvasRenderer.ts");
const COMPOSER_PATH = join(CANVAS_RENDERER_ROOT, "createCanvasMirrorRenderer.ts");

const EXPECTED_FACADE_EXPORTS = [
  "CANVAS_STAGE_CLASS",
  "CanvasBackendUnavailable",
  "createCanvasMirrorRenderer",
] as const;

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function namedExports(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      continue;
    }
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
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
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
  return [...new Set([
    path,
    path + ".ts",
    path + ".tsx",
    stem + ".ts",
    stem + ".tsx",
    join(path, "index.ts"),
    join(path, "index.tsx"),
    join(stem, "index.ts"),
    join(stem, "index.tsx"),
  ])];
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
  return pathRelative !== "" && pathRelative !== ".." && !pathRelative.startsWith("../");
}

function canvasFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) return canvasFiles(entryPath);
      return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
    });
}

function canvasModuleFiles(): string[] {
  return [...canvasFiles(CANVAS_ROOT), ...canvasFiles(CANVAS_RENDERER_ROOT)].sort();
}

function isCanvasModule(path: string): boolean {
  return isWithin(CANVAS_ROOT, path) || isWithin(CANVAS_RENDERER_ROOT, path);
}

function dependencyGraph(files: readonly string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>(files.map((path): [string, string[]] => [path, []]));
  for (const path of files) {
    const dependencies = graph.get(path)!;
    for (const specifier of moduleSpecifiers(sourceFile(path))) {
      const destination = resolveModule(path, specifier);
      if (destination !== null && isCanvasModule(destination)) dependencies.push(destination);
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
        cycles.push(
          [...stack.slice(stack.indexOf(dependency)), dependency].map((item) => relative(MIRROR_ROOT, item)),
        );
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

describe("canvasRenderer compatibility facade architecture", () => {
  it("freezes its four explicit named reexports", () => {
    const names = namedExports(sourceFile(FACADE_PATH));
    expect(new Set(EXPECTED_FACADE_EXPORTS).size).toBe(EXPECTED_FACADE_EXPORTS.length);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(EXPECTED_FACADE_EXPORTS);
  });

  it("is a compact export-only facade", () => {
    const text = readFileSync(FACADE_PATH, "utf8");
    const source = sourceFile(FACADE_PATH);
    expect(text.split(/\r?\n/).filter((line) => line.trim()).length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1024);
    for (const statement of source.statements) {
      expect(ts.isExportDeclaration(statement)).toBe(true);
      if (!ts.isExportDeclaration(statement)) continue;
      expect(statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)).toBe(true);
      expect(statement.exportClause && ts.isNamedExports(statement.exportClause)).toBe(true);
    }
  });

  it("keeps the composer one-way and does not re-export facade symbols", () => {
    const composer = sourceFile(COMPOSER_PATH);
    const text = readFileSync(COMPOSER_PATH, "utf8");
    expect(exportedTopLevelNames(composer)).toEqual(["createCanvasMirrorRenderer"]);
    expect(text.split(/\r?\n/).filter((line) => line.trim()).length).toBeLessThanOrEqual(800);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(96 * 1024);
    const facadeReferences = moduleSpecifiers(composer).filter(
      (specifier) => resolveModule(COMPOSER_PATH, specifier) === FACADE_PATH,
    );
    expect(facadeReferences).toEqual([]);
  });

  it("has no facade back-imports or cycles across canvas primitives and orchestration", () => {
    const files = canvasModuleFiles();
    const implementations = files.filter((path) => path !== FACADE_PATH);
    const facadeReferences = implementations.flatMap((path) =>
      moduleSpecifiers(sourceFile(path))
        .filter((specifier) => resolveModule(path, specifier) === FACADE_PATH)
        .map((specifier) => relative(MIRROR_ROOT, path) + " -> " + specifier),
    );
    expect(files).toContain(FACADE_PATH);
    expect(files).toContain(COMPOSER_PATH);
    expect(facadeReferences).toEqual([]);
    expect(cyclesIn(dependencyGraph(files))).toEqual([]);
  });
});
