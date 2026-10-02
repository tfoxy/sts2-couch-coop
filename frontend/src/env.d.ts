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
