import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.env.COUCHCOOP_IPHONE_TEMP_ROOT ?? await mkdtemp(join(tmpdir(), "couchcoop-iphone-webkit-"));
const frontendOutput = join(root, "frontend");
const artifactDir = join(root, "stage");
const modsDir = process.env.COUCHCOOP_GAME_MODS_DIR ?? join(root, "mods");
const referenceSdkDir = join(root, "reference-sdk");
await Promise.all([
  mkdir(frontendOutput, { recursive: true }),
  mkdir(artifactDir, { recursive: true }),
  mkdir(modsDir, { recursive: true }),
  mkdir(referenceSdkDir, { recursive: true })
]);

const sharedEnv = {
  ...process.env,
  COUCHCOOP_FRONTEND_OUT_DIR: frontendOutput,
  COUCHCOOP_IPHONE_ARTIFACT_DIR: artifactDir,
  // The harness is a dotnet build-sensitive command. This is deliberately a per-run scratch location.
  COUCHCOOP_GAME_MODS_DIR: modsDir,
  // Ignore any developer sts2.local.yaml: this suite compiles only against the pinned stable declaration SDK.
  CouchCoopLocalConfigPath: join(root, "no-local-game-config.yaml"),
  DOTNET_ROLL_FORWARD: "Major"
};

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}.`));
    });
  });
}

let harness;
let cleaned = false;
async function cleanup(exitCode) {
  if (cleaned) return;
  cleaned = true;
  harness?.kill("SIGTERM");
  if (!process.env.COUCHCOOP_IPHONE_TEMP_ROOT) await rm(root, { recursive: true, force: true });
  process.exit(exitCode);
}

process.once("SIGINT", () => void cleanup(130));
process.once("SIGTERM", () => void cleanup(143));

try {
  await run("npm", ["run", "build"], { cwd: new URL("..", import.meta.url), env: sharedEnv });
  await run(
    "dotnet",
    [
      "build", "../eng/Sts2.ReferenceSdk/stable/Sts2.ReferenceSdk.stable.csproj",
      "-c", "Release",
      "-o", referenceSdkDir,
      "-p:RestoreLockedMode=true",
      "-p:ContinuousIntegrationBuild=true"
    ],
    { cwd: new URL("..", import.meta.url), env: sharedEnv }
  );
  harness = spawn(
    "dotnet",
    [
      "run", "--project", "../tests/CouchCoop.HostedServerHarness/CouchCoop.HostedServerHarness.csproj",
      "-p:Sts2GameApi=v107", "-p:CouchCoopBuildToLocalMods=false", "-p:CouchCoopEnableHotReload=false", "--",
      "--static-root", frontendOutput,
      "--port", "23339",
      "--mode", "iphone-burst",
      "--artifact-dir", artifactDir
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...sharedEnv, STS2_ASSEMBLIES_DIR: referenceSdkDir },
      stdio: "inherit"
    }
  );
  harness.once("exit", (code) => void cleanup(code ?? 1));
  harness.once("error", () => void cleanup(1));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await cleanup(1);
}
