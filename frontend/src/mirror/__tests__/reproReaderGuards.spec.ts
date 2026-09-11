import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// EVERY reader of an ndjson mirror recording must drop the repro format's OUTBOUND half.
//
// A repro file (frontend/src/mirror/reproRecorder.ts, "repro/1") is deliberately a SUPERSET of a passive
// recording: its `dir:"in"` lines are byte-identical in shape to what scripts/record-mirror-stream.mjs writes,
// which is what lets the replay server, the bench and the state comparator eat one without a new code path. The
// price of that reuse is exactly one rule, and it is the rule this spec exists to keep: a line the CLIENT sent
// is not a line the HOST sent. Replay one and the mirror is handed its own `input` envelope as if it had come
// down the wire — a self-driving recording that reproduces nothing.
//
// Checked as SOURCE rather than by running each reader because two of these are not importable at all: the bench
// loader inside bench-mirror-replay.mjs lives in a string that is evaluated in the browser page, and
// mirrorReplay.bench.ts loads at import time from a file the bench config points at. The behavioural twin of
// this spec, for the one reader that can be driven in-process, is `replay-ws-server.mjs --self-test` (Test D).

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// Each entry: the reader file, and every place in it that turns a recording line into a replayable message.
// `anchor` is the line that reader already had (its "is this a data line" test); the guard has to come BEFORE it,
// because after a `typeof data !== "string"` check an outbound line is still a string.
const READERS: { file: string; anchors: string[] }[] = [
  {
    file: "scripts/replay-ws-server.mjs",
    anchors: ['if (typeof obj.data !== "string") continue;']
  },
  {
    file: "scripts/compare-replay-final-state.mjs",
    anchors: ['if (typeof obj?.data !== "string") continue;']
  },
  {
    // Three separate loaders: the meta/discard scan, buildRevealMessage, and the in-page fake socket.
    file: "scripts/bench-mirror-replay.mjs",
    anchors: [
      'if (typeof obj.data !== "string") continue;',
      'if (obj.meta || typeof obj.data !== "string") continue;',
      'if (typeof obj.data !== "string") continue;'
    ]
  },
  {
    file: "frontend/bench/mirrorReplay.bench.ts",
    anchors: ['const data = typeof obj.data === "string" ? obj.data : null;']
  }
];

const GUARD = /if \(obj\??\.dir === "out"\)/g;

describe("repro/1 outbound guard", () => {
  for (const reader of READERS) {
    it(`${reader.file} drops the client's own sends`, () => {
      const text = readFileSync(resolve(REPO_ROOT, reader.file), "utf8");
      const guards = text.match(GUARD) ?? [];
      // One guard per loader in the file — a second loader added without one is the regression this catches.
      expect(guards.length).toBeGreaterThanOrEqual(reader.anchors.length);
    });

    it(`${reader.file} guards BEFORE it decides a line is data`, () => {
      const text = readFileSync(resolve(REPO_ROOT, reader.file), "utf8");
      let cursor = 0;
      for (const anchor of reader.anchors) {
        const anchorAt = text.indexOf(anchor, cursor);
        expect([reader.file, anchor, anchorAt >= 0]).toEqual([reader.file, anchor, true]);
        const guardAt = text.lastIndexOf('.dir === "out"', anchorAt);
        // The guard must be the nearest thing above this anchor, not one belonging to an earlier loader.
        expect([reader.file, anchor, guardAt > cursor - 1 && guardAt < anchorAt]).toEqual([
          reader.file,
          anchor,
          true
        ]);
        cursor = anchorAt + anchor.length;
      }
    });
  }
});
