import { mergeConfig, defineConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: ["e2e/**", "node_modules/**", "dist/**"],
      environment: "jsdom",
      globals: true
    }
  })
);
