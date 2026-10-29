/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Bench fixtures may override the bundled modules; normal builds leave both unset.
  readonly VITE_RUST_PROTOTYPE_MODULE_URL?: string;
  readonly VITE_RUST_SCENE_SERIALIZER_URL?: string;
}

declare module "@couchcoop/rust-prototype-glue" {
  const init: () => Promise<{ memory?: WebAssembly.Memory }>;
  export default init;
  export const RustRenderer: { create(canvas: HTMLCanvasElement): Promise<unknown> };
}

// The new renderer's core build status, stated by vite-plugins/renderStreamClientAssets.ts (see renderStreamCore.ts).
declare module "virtual:couch-render-stream-core" {
  const status: {
    /** The `rs_core_tree` of the aliased godot-scene-web sources, or null when it could not be computed. */
    readonly expectedTree: string | null;
    /** Why the served build is unusable, or null when it matches `expectedTree`. */
    readonly problem: "missing" | "stale" | "unverified" | null;
  };
  export default status;
}
