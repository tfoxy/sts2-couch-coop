import { beforeEach, describe, expect, it } from "vitest";

import { parseVisitId, readVisitId, resetVisitIdCache, VISIT_META_NAME } from "@/join/visitId";

// THE PRE-WEBSOCKET IDENTITY. The host injects this tag into the SPA document it serves (on a `no-store`
// response, so two devices can never be handed the same id) and records the `GET /` that carried it. The
// client's only job is to read it back faithfully — and to refuse anything that is not in the minted shape,
// because whatever this returns is sent to the host and quoted into diagnostics.

const VALID = "0123456789abcdef0123456789abcdef";

function documentWith(content: string | null): Document {
  const doc = new DOMParser().parseFromString("<html><head></head><body></body></html>", "text/html");
  if (content !== null) {
    const meta = doc.createElement("meta");
    meta.setAttribute("name", VISIT_META_NAME);
    meta.setAttribute("content", content);
    doc.head.appendChild(meta);
  }
  return doc;
}

beforeEach(() => {
  resetVisitIdCache();
  document.querySelector(`meta[name="${VISIT_META_NAME}"]`)?.remove();
});

describe("visit id", () => {
  it("reads the id the host embedded", () => {
    expect(parseVisitId(documentWith(VALID))).toBe(VALID);
  });

  it("returns null when the document carries none", () => {
    // The dev server, an older host, or a shell the host declined to rewrite. Joining must work regardless.
    expect(parseVisitId(documentWith(null))).toBeNull();
    expect(parseVisitId(undefined)).toBeNull();
  });

  it("refuses anything outside the minted shape", () => {
    for (const rejected of ["", "short", VALID.toUpperCase(), `${VALID}0`, VALID.slice(0, 31) + "g", "<script>"]) {
      expect(parseVisitId(documentWith(rejected))).toBeNull();
    }
  });

  it("memoises the document's own id", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", VISIT_META_NAME);
    meta.setAttribute("content", VALID);
    document.head.appendChild(meta);
    expect(readVisitId()).toBe(VALID);
    meta.setAttribute("content", "ffffffffffffffffffffffffffffffff");
    expect(readVisitId()).toBe(VALID);
    resetVisitIdCache();
    expect(readVisitId()).toBe("ffffffffffffffffffffffffffffffff");
  });
});
