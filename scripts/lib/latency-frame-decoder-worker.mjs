// Decode one pending CDP PNG off the orchestration thread. The parent keeps only one
// in-flight task and one replaceable pending frame, so the decoder cannot create an
// unbounded CPU or memory queue while the browser is drawing at its natural cadence.
import { parentPort } from "node:worker_threads";
import { decodePng } from "./png.mjs";
import { readMarker } from "./input-response-latency.mjs";

parentPort.on("message", ({ data, targetId }) => {
  try {
    const png = Buffer.from(data, "base64");
    const decoded = decodePng(png);
    const markerId = readMarker({ width: decoded.width, height: decoded.height, pixels: decoded.data });
    parentPort.postMessage({ targetId, markerId, matched: markerId === targetId });
  } catch (error) {
    parentPort.postMessage({ targetId, error: String(error) });
  }
});
