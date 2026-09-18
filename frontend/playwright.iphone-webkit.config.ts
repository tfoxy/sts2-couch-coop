import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import {
  INTERNAL_ARTIFACT_ENV,
  IPHONE_ARTIFACT_ENV,
  IPHONE_PROFILE_ENV,
  IPHONE_HARNESS_ORIGIN,
  resolveHermeticArtifactExport,
  resolveIphoneRunPlan
} from "./iphone-webkit/support";

const plan = resolveIphoneRunPlan(process.env);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceOutput = join(repoRoot, ".sts2", "research", "playwright-iphone-webkit");
const internalLayoutRootEnv = "COUCHCOOP_IPHONE_PLAYWRIGHT_TEMP_ROOT";
const hermetic = plan.kind === "hermetic" ? createHermeticLayout() : null;

function createHermeticLayout() {
  // Playwright evaluates the config in both its coordinator and worker processes. Pin the private
  // layout in the coordinator environment so every evaluation writes into the reporter-owned stage.
  const inheritedRoot = process.env[internalLayoutRootEnv];
  const tempRoot = inheritedRoot ? resolve(inheritedRoot) : mkdtempSync(join(tmpdir(), "couchcoop-iphone-webkit-"));
  const temporaryParent = resolve(tmpdir());
  const fromTemporaryParent = relative(temporaryParent, tempRoot);
  if (fromTemporaryParent.startsWith("..") || fromTemporaryParent.includes("../")
    || !basename(tempRoot).startsWith("couchcoop-iphone-webkit-")) {
    throw new Error("Refusing an iPhone WebKit layout outside its bounded temporary root.");
  }
  process.env[internalLayoutRootEnv] = tempRoot;
  const stageDir = join(tempRoot, "stage");
  const modsDir = join(tempRoot, "mods");
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(modsDir, { recursive: true });
  return {
    tempRoot,
    stageDir,
    modsDir,
    outputDir: join(tempRoot, "playwright-results"),
    exportDir: resolveHermeticArtifactExport(repoRoot, process.env[IPHONE_ARTIFACT_ENV], plan.profile)
  };
}

export default defineConfig({
  testDir: "./iphone-webkit",
  testMatch: "**/*.e2e.spec.ts",
  timeout: plan.kind === "hermetic" && plan.profile === "field-repro" ? 120_000 : 60_000,
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
          COUCHCOOP_GAME_MODS_DIR: hermetic!.modsDir,
          [IPHONE_PROFILE_ENV]: plan.profile
        }
      }]
    : undefined,
  // Project metadata points the test at the same coordinator-pinned private layout as the web server and reporter.
  projects: [{
    name: "iphone-13-webkit",
    metadata: plan.kind === "hermetic" ? { [INTERNAL_ARTIFACT_ENV]: hermetic!.stageDir } : {}
  }]
});
