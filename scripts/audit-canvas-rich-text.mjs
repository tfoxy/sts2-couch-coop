#!/usr/bin/env node
// Audit authored localization against the rich-text parser used by the Rust Canvas stage.
// The report contains keys and diagnostics, never copied game prose. Raw localization is
// supplied at run time and the default report stays under ignored .sts2/.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRequire = createRequire(resolve(repoRoot, "frontend/package.json"));
const defaultLocalizationRoot = resolve(repoRoot, "../spirectl/.sts2/toolchain/recovered-project/localization");
const defaultOut = resolve(repoRoot, ".sts2/artifacts/canvas-rich-text-audit.json");
const hostTables = ["cards", "ancients", "events", "modifiers"];

const help = `Audit raw game localization with the shipped Rust Canvas rich-text parser.

  node scripts/audit-canvas-rich-text.mjs [--dir PATH] [--lang eng] [--out PATH]
  node scripts/audit-canvas-rich-text.mjs --host http://127.0.0.1:13337 [--lang eng] [--out PATH]

--dir    A localization language directory containing JSON tables. Defaults to the
         sibling spirectl recovered-project English directory. All tables are read.
--host   Fetch cards, ancients, events and modifiers from the running host's /res/ route.
         Use this to audit the installed beta rather than an older recovered project.
--lang   Language code for the host route and report (default eng).
--out    JSON report path (default .sts2/artifacts/canvas-rich-text-audit.json).

The audit checks markup parsing and loss of styling. It cannot prove live text layout,
font/resource readiness, clipping, or option labels generated for a particular run.`;

export function parseArgs(args) {
  const options = { dir: null, host: null, lang: "eng", out: defaultOut };
  let explicitDir = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!["--dir", "--host", "--lang", "--out"].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--dir") { options.dir = resolve(value); explicitDir = true; }
    if (flag === "--host") options.host = value;
    if (flag === "--lang") options.lang = value;
    if (flag === "--out") options.out = resolve(value);
  }
  if (options.host && explicitDir) throw new Error("Choose either --dir or --host");
  if (!/^[a-z]{3}$/.test(options.lang)) throw new Error("--lang must be a three-letter language code");
  if (!options.host && !explicitDir) options.dir = resolve(defaultLocalizationRoot, options.lang);
  if (options.host) {
    const url = new URL(options.host);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("--host must be an http(s) URL without credentials");
    options.host = url.origin;
  }
  return options;
}

function readTable(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`${label}: invalid JSON: ${error.message}`); }
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      Object.values(value).some((entry) => typeof entry !== "string"))
    throw new Error(`${label}: expected a flat object of string values`);
  return value;
}

async function loadTables(options) {
  const tables = [];
  if (options.host) {
    for (const name of hostTables) {
      const url = `${options.host}/res/localization/${options.lang}/${name}.json`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      tables.push({ name, entries: readTable(bytes, url), sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  } else {
    if (!existsSync(options.dir)) throw new Error(`Localization directory does not exist: ${options.dir}`);
    const names = readdirSync(options.dir).filter((name) => name.endsWith(".json")).sort();
    if (!names.length) throw new Error(`No JSON localization tables found in ${options.dir}`);
    for (const file of names) {
      const bytes = readFileSync(resolve(options.dir, file));
      tables.push({ name: file.slice(0, -5), entries: readTable(bytes, file),
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  return tables;
}

function category(table, key) {
  if (table === "cards" && key.endsWith(".description")) return "cardDescription";
  if (table === "ancients") return "ancientText";
  if (table === "events" && /\.pages\..*\.options\..*\.(?:title|description)$/.test(key)) return "eventOption";
  return "other";
}

/** `parse` is the real parseSimpleRich in production and a small seam in the unit test. */
export function auditTables(tables, parse, source) {
  const report = {
    schemaVersion: "couch.canvas-rich-text-audit/v1",
    source,
    parser: "parseSimpleRich(fontRoles=true,inlineImages=true,unsupported=plain)",
    tables: [],
    summary: { entries: 0, tagged: 0, withLosses: 0, emptyAfterParse: 0, authoredTemplates: 0,
      categories: {}, losses: {}, tags: {} },
    findings: []
  };
  for (const table of tables) {
    const keys = Object.keys(table.entries).sort();
    report.tables.push({ name: table.name, entries: keys.length, sha256: table.sha256 });
    for (const key of keys) {
      const raw = table.entries[key];
      const kind = category(table.name, key);
      const tagNames = [...new Set([...raw.matchAll(/\[\/?([a-zA-Z_][\w-]*)(?=[=\s\]])/g)]
        .map((match) => match[1].toLowerCase()))].sort();
      const parsed = parse(raw, { fontRoles: true, inlineImages: true, unsupported: "plain" });
      const losses = parsed.ok ? (parsed.value.losses ?? []) : [{ feature: "parser-refusal", detail: parsed.detail }];
      const plain = parsed.ok ? parsed.value.text : "";
      const emptyAfterParse = raw.trim().length > 0 && plain.trim().length === 0;
      const authoredTemplate = /\{[^{}]+\}/.test(raw);
      report.summary.entries++;
      report.summary.categories[kind] = (report.summary.categories[kind] ?? 0) + 1;
      if (tagNames.length) report.summary.tagged++;
      if (losses.length) report.summary.withLosses++;
      if (emptyAfterParse) report.summary.emptyAfterParse++;
      if (authoredTemplate) report.summary.authoredTemplates++;
      for (const name of tagNames) report.summary.tags[name] = (report.summary.tags[name] ?? 0) + 1;
      for (const feature of new Set(losses.map((loss) => loss.feature)))
        report.summary.losses[feature] = (report.summary.losses[feature] ?? 0) + 1;
      if (losses.length || emptyAfterParse) report.findings.push({ table: table.name, key, category: kind,
        tags: tagNames, losses, rawLength: raw.length, plainLength: plain.length,
        authoredTemplate, emptyAfterParse });
    }
  }
  return report;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { console.log(help); return; }
  let server;
  try {
    const tables = await loadTables(options);
    // Vite's SSR loader resolves the same @spirectl and @godot-scene-web source aliases as the app.
    // No frontend build or live install is touched.
    const { createServer } = await import(pathToFileURL(frontendRequire.resolve("vite")));
    server = await createServer({ root: resolve(repoRoot, "frontend"),
      configFile: resolve(repoRoot, "frontend/vite.config.ts"),
      cacheDir: resolve(repoRoot, ".sts2/vite-canvas-rich-text-audit"),
      server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
    const { parseSimpleRich } = await server.ssrLoadModule("/src/mirror/canvas/richSimple.ts");
    const report = auditTables(tables, parseSimpleRich,
      options.host ? { kind: "host", origin: options.host, language: options.lang }
        : { kind: "directory", path: options.dir, language: options.lang });
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ report: options.out, source: report.source, tables: report.tables.length,
      ...report.summary, findings: report.findings.length }, null, 2));
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  } finally { await server?.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
