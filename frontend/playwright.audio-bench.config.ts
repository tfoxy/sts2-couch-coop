import { defineConfig, devices } from "@playwright/test";

// Off the app's real default (5173) and off the main e2e suite's dev origin (25173, see e2e/ports.ts) so
// this bench can run alongside either.
export const AUDIO_BENCH_DEV_PORT = Number(process.env.AUDIO_BENCH_DEV_PORT ?? 25473);
export const AUDIO_BENCH_DEV_ORIGIN = `http://127.0.0.1:${AUDIO_BENCH_DEV_PORT}`;
export const AUDIO_BENCH_INSECURE_ORIGIN = `http://bench.test:${AUDIO_BENCH_DEV_PORT}`;

export default defineConfig({
  // Hermetic: the only server this bench talks to is the fake Node host each test starts for itself
  // (fakeAudioHost.ts) plus this Vite dev origin — never a real game or a live mod install.
  testDir: "./e2e/audio-bench",
  fullyParallel: false,
  workers: 1,
  timeout: 10 * 60_000,
  reporter: [["list"]],
  use: {
    baseURL: AUDIO_BENCH_DEV_ORIGIN,
    // `--host-resolver-rules` only ever maps a hostname at the browser's network layer, never via real DNS;
    // `bench.test` resolves to 127.0.0.1 for Chromium but is still a different HOST STRING than
    // "127.0.0.1"/"localhost", which is exactly what makes Chromium treat it as an insecure context.
    launchOptions: { args: ["--host-resolver-rules=MAP bench.test 127.0.0.1"] }
  },
  webServer: {
    command: `node_modules/.bin/vite --config vite.audio-bench.config.ts --host 127.0.0.1 --port ${AUDIO_BENCH_DEV_PORT} --strictPort`,
    url: `${AUDIO_BENCH_DEV_ORIGIN}/e2e/audio-bench/bench.html`,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ]
});
