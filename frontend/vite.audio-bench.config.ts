// Dev-only Vite config for the WP-D audio bench (frontend/e2e/audio-bench). Reuses the real app config
// unchanged — the bench must resolve `@/audio/audioEngine` exactly like MirrorApp.vue does — and adds
// exactly one override: `bench.test` on the allowed-hosts list.
//
// WHY. Vite 8's dev server rejects any request whose Host header is not localhost/*.localhost/an IP
// literal unless it is in `server.allowedHosts` (host-validation-middleware; see
// node_modules/vite/dist/node/chunks/node.js `isHostAllowedInternal`). The bench needs a page origin that
// Chromium treats as an INSECURE context (`isSecureContext === false`) to exercise the worklet path's
// secure-context gate once it lands (audioPath.ts's `concretize`), and `127.0.0.1`/`localhost` are always
// secure in Chromium regardless of scheme — so the insecure leg has to be a different hostname, resolved to
// 127.0.0.1 only via the browser's own `--host-resolver-rules` (see playwright.audio-bench.config.ts),
// never a DNS entry. Without this override Vite answers that request with "This host is not allowed."
// instead of the bench page.
//
// Never used by `npm run dev`/`npm run build` — only `playwright.audio-bench.config.ts`'s webServer passes
// `--config vite.audio-bench.config.ts`.
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

export default defineConfig(mergeConfig(base, {
  server: { allowedHosts: ["bench.test"] }
}));
