import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("real iPhone WebKit config", () => {
  it("derives paths in-process and leaves process/server/temp setup in the hermetic branch", async () => {
    const source = await readFile(resolve(process.cwd(), "playwright.iphone-webkit.config.ts"), "utf8");
    expect(source).not.toContain("execFileSync");
    expect(source).not.toContain("spawn(");
    expect(source).toContain('const hermetic = plan.kind === "hermetic" ? createHermeticLayout() : null;');
    expect(source).toContain('webServer: plan.kind === "hermetic"');
    expect(source).toContain('fileURLToPath(import.meta.url)');
    expect(source).toContain('".sts2", "research", "playwright-iphone-webkit"');
  });
});
