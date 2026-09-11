import { defineConfig, devices } from "@playwright/test";

import { DEV_ORIGIN, DEV_ORIGIN_PORT, LOBBY_BASE_URL, LOBBY_HARNESS_PORT, RUN_HARNESS_ORIGIN, RUN_HARNESS_PORT } from "./e2e/ports";

const harnessMode = process.env.COUCH_COOP_HARNESS_MODE ?? process.env.HARNESS_MODE;
const harnessModeArg = harnessMode ? ` --mode ${JSON.stringify(harnessMode)}` : "";
const harnessCommand =
  `COUCHCOOP_FRONTEND_OUT_DIR=dist npm run build && DOTNET_ROLL_FORWARD=Major dotnet run --project ../tests/CouchCoop.HostedServerHarness/CouchCoop.HostedServerHarness.csproj -- --static-root ./dist --port ${RUN_HARNESS_PORT}${harnessModeArg}`;
const lobbyHarnessCommand =
  `DOTNET_ROLL_FORWARD=Major dotnet run --project ../tests/CouchCoop.HostedServerHarness/CouchCoop.HostedServerHarness.csproj -- --static-root ./dist --port ${LOBBY_HARNESS_PORT} --mode lobby`;
// The e2e dev origin must proxy /ws, /res, /models to the e2e RUN harness — not the
// real game bridge default (13337), which may be a live game.
const devOriginCommand =
  `COUCHCOOP_DEV_PROXY_TARGET=${RUN_HARNESS_ORIGIN} npm run dev -- --port ${DEV_ORIGIN_PORT} --strictPort`;

export default defineConfig({
  // Everything under e2e/ is hermetic: it runs against the fake HostedServerHarness and the Vite dev origin
  // started by `webServer` below, never against a real game.
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: RUN_HARNESS_ORIGIN,
    trace: "on-first-retry"
  },
  webServer: [
    {
      command: harnessCommand,
      url: `${RUN_HARNESS_ORIGIN}/`,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000
    },
    {
      command: devOriginCommand,
      url: `${DEV_ORIGIN}/`,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000
    },
    {
      command: lobbyHarnessCommand,
      url: `${LOBBY_BASE_URL}/`,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000
    }
  ],
  projects: [
    {
      name: "smoke",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: "viewport-1280x720",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: "viewport-640x360",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 640, height: 360 },
        isMobile: false
      }
    }
  ]
});
