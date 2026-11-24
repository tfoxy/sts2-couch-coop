import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "../../frontend/node_modules/vitest/dist/config.js";
import frontendConfig from "../../frontend/vitest.config.ts";

export default mergeConfig(frontendConfig, defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../build/vite", import.meta.url)),
  resolve: {
    alias: { vitest: fileURLToPath(new URL("../../frontend/node_modules/vitest/dist/index.js", import.meta.url)) }
  },
  test: {
    include: ["tests/input-parity.spec.ts"],
    env: { COUCH_PACK_INPUTS: fileURLToPath(new URL("../build/inputs.json", import.meta.url)) }
  }
}));
