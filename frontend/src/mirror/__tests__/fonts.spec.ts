import { afterEach, describe, expect, it } from "vitest";

import { ensureFontFace, mirrorFontRegistration } from "@/mirror/fonts";

// `corpusDiagnosticEnabled` (R2-P3) is cached on `location.search` itself — this covers both halves of that
// cache's contract: it answers correctly for a `search` it has already seen (not just the first time), and it
// notices a NAVIGATION (the only way `search` ever changes) rather than sticking to a stale verdict.

describe("ensureFontFace corpus diagnostics (location.search cache)", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("records nothing while the query carries no rustTextInkCorpus=1, across repeated calls", () => {
    window.history.replaceState(null, "", "/?other=1");
    ensureFontFace("p3-off-a", "/res/off-a.ttf");
    ensureFontFace("p3-off-b", "/res/off-b.ttf");
    expect(mirrorFontRegistration("p3-off-a")).toBeNull();
    expect(mirrorFontRegistration("p3-off-b")).toBeNull();
  });

  it("records once the query carries rustTextInkCorpus=1", () => {
    window.history.replaceState(null, "", "/?rustTextInkCorpus=1");
    ensureFontFace("p3-on-a", "/res/on-a.ttf", "700", "italic");
    const row = mirrorFontRegistration("p3-on-a");
    expect(row).toEqual(expect.objectContaining({ family: "p3-on-a", url: "/res/on-a.ttf", weight: "700", style: "italic" }));
    expect(row!.attempts).toEqual([{ url: "/res/on-a.ttf", weight: "700", style: "italic" }]);
  });

  it("picks up a mid-test navigation instead of sticking to the verdict it cached first", () => {
    window.history.replaceState(null, "", "/?rustTextInkCorpus=1");
    ensureFontFace("p3-nav-a", "/res/nav-a.ttf");
    expect(mirrorFontRegistration("p3-nav-a")).not.toBeNull();

    // Same page, a later navigation drops the flag — the cache must not keep answering "enabled" for `search`
    // values it has already seen turn it off, which is exactly what a cache keyed on anything OTHER than
    // `search` itself (a boolean latch, a revision counter) could get wrong.
    window.history.replaceState(null, "", "/?other=1");
    ensureFontFace("p3-nav-b", "/res/nav-b.ttf");
    expect(mirrorFontRegistration("p3-nav-b")).toBeNull();

    // …and back on, a third distinct family, proving the cache re-reads rather than toggling once.
    window.history.replaceState(null, "", "/?rustTextInkCorpus=1");
    ensureFontFace("p3-nav-c", "/res/nav-c.ttf");
    expect(mirrorFontRegistration("p3-nav-c")).not.toBeNull();
  });

  it("a deduped second call for an already-injected family still appends an attempt once recording is on", () => {
    window.history.replaceState(null, "", "/?rustTextInkCorpus=1");
    ensureFontFace("p3-dedup", "/res/dedup.ttf");
    ensureFontFace("p3-dedup", "/res/dedup-again.ttf"); // same family: the SECOND url is dropped on the floor (FILED, not fixed — see the docstring), but the attempt is still logged
    const row = mirrorFontRegistration("p3-dedup");
    expect(row!.attempts.map((a) => a.url)).toEqual(["/res/dedup.ttf", "/res/dedup-again.ttf"]);
  });
});
