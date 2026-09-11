import { mergeConfig, defineConfig } from "vitest/config";

// Reuse the normal test config (vite aliases → ../../spirectl, ../../godot-scene-web; jsdom; globals),
// but restrict the include to the deterministic mirror replay bench so `npm test` never picks it up
// (its default `{test,spec}` include doesn't match `*.bench.ts`) and this config runs ONLY the bench.
import baseConfig from "./vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["bench/**/*.bench.ts"],
      // The replay walks a full combat recording through the real pipeline many times — give it room.
      testTimeout: 300_000,
      hookTimeout: 120_000
    }
  })
);
