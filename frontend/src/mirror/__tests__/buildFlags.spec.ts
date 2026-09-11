import { describe, expect, it } from "vitest";

import { readReproUiFlag, REPRO_UI_ENABLED } from "@/mirror/buildFlags";

// The repo's first PRODUCT build flag (the two existing `import.meta.env` reads — paintOrder's
// `paintOrderAssertsOn` and canvasRenderer's `paintDumpEnabled` — are dev assertions, not shipped behaviour).
// Its whole job is to remove the repro recorder's UI from a published build, so the two things worth pinning are
// the DEFAULT (present, because the bag is absent under bare Node and unset in `vite dev`) and the one string
// that removes it.

describe("readReproUiFlag", () => {
  it("defaults to ENABLED where nothing says otherwise", () => {
    // No env bag at all: the offline tools import mirror sources straight into bare Node, which has no
    // `import.meta.env` — and that is a build that wants the tool, not one that wants it stripped.
    expect(readReproUiFlag(undefined)).toBe(true);
    expect(readReproUiFlag({})).toBe(true);
    expect(readReproUiFlag({ VITE_REPRO_UI: undefined })).toBe(true);
  });

  it("is disabled by exactly one value, case-insensitively", () => {
    expect(readReproUiFlag({ VITE_REPRO_UI: "off" })).toBe(false);
    expect(readReproUiFlag({ VITE_REPRO_UI: "OFF" })).toBe(false);
    expect(readReproUiFlag({ VITE_REPRO_UI: "Off" })).toBe(false);
  });

  it("treats anything else as enabled, including the values that LOOK like a disable", () => {
    // A build script that writes `VITE_REPRO_UI=0` has made a mistake, and the safe direction for a mistake is
    // "the tool is present" — a shipped diagnostic is a support question; a missing one is an un-diagnosable bug.
    for (const raw of ["on", "ON", "1", "0", "false", "true", "", "yes"]) {
      expect([raw, readReproUiFlag({ VITE_REPRO_UI: raw })]).toEqual([raw, raw.toLowerCase() !== "off"]);
    }
  });

  it("ignores a non-string value (an env bag only ever carries strings)", () => {
    expect(readReproUiFlag({ VITE_REPRO_UI: false })).toBe(true);
    expect(readReproUiFlag({ VITE_REPRO_UI: 0 })).toBe(true);
  });
});

describe("REPRO_UI_ENABLED", () => {
  it("is on under vitest, which is the local/dev build the recorder ships in", () => {
    expect(REPRO_UI_ENABLED).toBe(true);
  });
});
