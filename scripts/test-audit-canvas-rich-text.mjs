import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

test("audits authored card and Ancient text with the shipped Canvas parser", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "canvas-rich-text-audit-"));
  try {
    writeFileSync(resolve(dir, "cards.json"), JSON.stringify({
      "STRIKE.description": "Deal [red]6[/red] damage.",
      "CHOICE.description": "[gold]{count}[/gold] cards"
    }));
    writeFileSync(resolve(dir, "ancients.json"), JSON.stringify({
      "SAGE.talk.ANY.0-0.ancient": "[font_size=28]Hello[/font_size]",
      "SAGE.title": "Sage"
    }));
    writeFileSync(resolve(dir, "events.json"), JSON.stringify({
      "SAGE.pages.start.options.take.title": "[b]Take it[/b]"
    }));
    const out = resolve(dir, "report.json");
    execFileSync(process.execPath, [resolve(repoRoot, "scripts/audit-canvas-rich-text.mjs"),
      "--dir", dir, "--out", out], { cwd: repoRoot, stdio: "pipe" });
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.summary.entries, 5);
    assert.deepEqual(report.summary.categories, { ancientText: 2, cardDescription: 2, eventOption: 1 });
    assert.equal(report.summary.emptyAfterParse, 0);
    assert.equal(report.summary.withLosses, 1);
    assert.equal(report.findings[0].key, "SAGE.talk.ANY.0-0.ancient");
    assert.equal(report.findings[0].losses[0].feature, "style");
    assert.equal(report.summary.authoredTemplates, 1);
    assert.ok(report.tables.every((table) => /^[a-f0-9]{64}$/.test(table.sha256)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
