// The explicit installer survives the GSW canvas package's sideEffects:false tree shaking.
import { installMsdfGeneratorWorker } from "@godot-scene-web/canvas/msdf-worker-runtime";

installMsdfGeneratorWorker();
