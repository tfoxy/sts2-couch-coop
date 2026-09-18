import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import {
  INTERNAL_ARTIFACT_ENV,
  IPHONE_ARTIFACT_ENV,
  IPHONE_HARNESS_ORIGIN,
  resolveHermeticArtifactExport,
  resolveIphoneRunPlan
} from "./iphone-webkit/support";

const plan = resolveIphoneRunPlan(process.env);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceOutput = join(repoRoot, ".sts2", "research", "playwright-iphone-webkit");
const hermetic = plan.kind === "hermetic" ? createHermeticLayout() : null;

function createHermeticLayout() {
  const tempRoot = mkdtempSync(join(tmpdir(), "couchcoop-iphone-webkit-"));
  const stageDir = join(tempRoot, "stage");
  const modsDir = join(tempRoot, "mods");
  mkdirSync(stageDir);
  mkdirSync(modsDir);
  return {
    tempRoot,
    stageDir,
    modsDir,
    outputDir: join(tempRoot, "playwright-results"),
    exportDir: resolveHermeticArtifactExport(repoRoot, process.env[IPHONE_ARTIFACT_ENV])
  };
}

export default defineConfig({
  testDir: "./iphone-webkit",
  testMatch: "**/*.e2e.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: plan.kind === "hermetic"
    ? [["list"], ["./iphone-webkit/artifact-reporter.mjs", {
        stageDir: hermetic!.stageDir,
        exportDir: hermetic!.exportDir,
        tempRoot: hermetic!.tempRoot
      }]]
    : [["list"]],
  outputDir: plan.kind === "hermetic"
    ? hermetic!.outputDir
    : plan.evidenceEnabled ? evidenceOutput : join(tmpdir(), "couchcoop-iphone-webkit-real-output"),
  preserveOutput: plan.kind === "real" && plan.evidenceEnabled ? "always" : "never",
  use: {
    ...devices["iPhone 13"],
    browserName: "webkit",
    baseURL: plan.baseURL,
    trace: "off",
    screenshot: "off",
    video: "off"
  },
  webServer: plan.kind === "hermetic"
    ? [{
        command: "node ./iphone-webkit/start-hermetic.mjs",
        url: `${IPHONE_HARNESS_ORIGIN}/`,
        reuseExistingServer: false,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
        env: {
          ...process.env,
          COUCHCOOP_IPHONE_TEMP_ROOT: hermetic!.tempRoot,
          COUCHCOOP_IPHONE_ARTIFACT_DIR: hermetic!.stageDir,
          [INTERNAL_ARTIFACT_ENV]: hermetic!.stageDir,
          COUCHCOOP_GAME_MODS_DIR: hermetic!.modsDir
        }
      }]
    : undefined,
  // Project metadata is serialized from the coordinator into the test worker. Do not use a process.env mutation
  // here: Playwright may evaluate the config in more than one process, and each evaluation would mint a different
  // private temp root while the web server and artifact reporter remain bound to the coordinator's root.
  projects: [{
    name: "iphone-13-webkit",
    metadata: plan.kind === "hermetic" ? { [INTERNAL_ARTIFACT_ENV]: hermetic!.stageDir } : {}
  }]
});
