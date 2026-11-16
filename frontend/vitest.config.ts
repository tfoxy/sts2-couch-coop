import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mergeConfig, defineConfig } from "vitest/config";

import viteConfig from "./vite.config";

const gswRoot = process.env.COUCHCOOP_GSW_ROOT
  ?? fileURLToPath(new URL("../../godot-scene-web", import.meta.url));
const streamClientTestSource = (path: string) => resolve(gswRoot, "packages/render-stream-client", path);

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      alias: {
        "@render-stream-test/loop": streamClientTestSource("src/loop.ts"),
        "@render-stream-test/fakes": streamClientTestSource("test/fakes.ts")
      }
    },
    test: {
      exclude: ["e2e/**", "iphone-webkit/**/*.e2e.spec.ts", "node_modules/**", "dist/**"],
      environment: "jsdom",
      globals: true
    }
  })
);
