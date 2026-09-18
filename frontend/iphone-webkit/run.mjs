import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const real = Boolean(process.env.COUCHCOOP_E2E_REAL_URL || process.env.COUCHCOOP_ALLOW_REAL_GAME);
const parent = process.env.COUCHCOOP_IPHONE_ARTIFACT_DIR;
const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
if (parent && parent !== join(repoRoot, ".ci-artifacts", "iphone-webkit")) throw new Error("COUCHCOOP_IPHONE_ARTIFACT_DIR must name the reviewed WebKit parent root.");
const run = (env) => new Promise((resolveRun, reject) => {
  const child = spawn("playwright", ["test", "--config", "playwright.iphone-webkit.config.ts", ...process.argv.slice(2)], { stdio: "inherit", cwd: new URL("..", import.meta.url), env });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolveRun() : reject(new Error(`playwright exited ${code}`)));
});
if (real) {
  await run(process.env);
} else {
  for (const profile of ["baseline", "field-repro"]) {
    const env = { ...process.env, COUCHCOOP_IPHONE_PROFILE: profile };
    if (parent) env.COUCHCOOP_IPHONE_ARTIFACT_DIR = join(parent, profile);
    await run(env);
  }
}
