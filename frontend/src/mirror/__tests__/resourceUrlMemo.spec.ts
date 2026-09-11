import { afterEach, describe, expect, it } from "vitest";

import { hostBase } from "@/join/hostBase";
import { mirrorResourceUrl } from "@/mirror/sceneTree";

// THE ASSET-URL MEMO. `mirrorResourceUrl` is called per textured node per delta (normalizeTextureUrl, the atlas
// and mask paths, nodeStyles, the shader/prefetch modules), and each call split/encoded/joined the path and ran
// `hostUrl` — which itself calls `hostBase()` twice. A phone trace of combat attributed ~93ms to that pair, so
// both are now memoized.
//
// The rule the memo must not break is that the OUTPUT IS A CACHE KEY, not merely a fetch target (see the
// `hostUrl` doc comment): the reflow cache, atlas residency, the still cache and the image prefetcher all key off
// these exact strings. So the expectations below are the pre-memo strings, byte for byte — including the ones
// that look wrong (a `?` inside a resource path IS encoded, and an already-percent-encoded path IS re-encoded),
// because "correct" here means "identical to what every one of those caches was keyed on yesterday".

function setHostBase(value: string | undefined): void {
  if (value === undefined) {
    delete (globalThis as { __couchCoopHostBase?: string }).__couchCoopHostBase;
  } else {
    (globalThis as { __couchCoopHostBase?: string }).__couchCoopHostBase = value;
  }
}

afterEach(() => setHostBase(undefined));

const CASES: Array<[label: string, path: string, url: string]> = [
  ["a plain path", "res://images/cards/strike.png", "/res/images/cards/strike.png"],
  [
    "a path needing encoding (spaces, non-ASCII, #)",
    "res://images/packed/card frames/Común #2.png",
    "/res/images/packed/card%20frames/Com%C3%BAn%20%232.png"
  ],
  ["a query-carrying path", "res://spines/a.tscn?anim=idle", "/res/spines/a.tscn%3Fanim%3Didle"],
  ["an already-percent-encoded path", "res://a/b/c%20d.png", "/res/a/b/c%2520d.png"],
  ["a path with no res:// prefix", "images/bare/path.png", "/res/images/bare/path.png"]
];

describe("mirrorResourceUrl — memoized, byte-identical", () => {
  it.each(CASES)("maps %s exactly as it did before the memo", (_label, path, url) => {
    expect(mirrorResourceUrl(path)).toBe(url);
  });

  it("returns the same string on a repeat call (the memo hit is not a new spelling)", () => {
    const first = mirrorResourceUrl("res://images/cards/strike.png");
    const second = mirrorResourceUrl("res://images/cards/strike.png");
    expect(second).toBe(first);
    // Identity, not just equality: a cache keyed on this string must not be handed a fresh instance per node.
    expect(Object.is(first, second)).toBe(true);
  });

  it("invalidates when the host base changes, in BOTH directions", () => {
    // Host-served: the route is bare, which is the whole point of hostUrl's no-op path.
    expect(mirrorResourceUrl("res://images/cards/strike.png")).toBe("/res/images/cards/strike.png");

    // The public-origin bootstrap injects a base — every previously cached entry is now wrong and must not be
    // served. (A stale hit here is the bug this test exists for: a remote-hosted viewer fetching /res/… against
    // the PAGE origin, which 404s.)
    setHostBase("http://192.168.1.5:13337");
    expect(mirrorResourceUrl("res://images/cards/strike.png"))
      .toBe("http://192.168.1.5:13337/res/images/cards/strike.png");
    expect(mirrorResourceUrl("res://images/packed/card frames/Común #2.png"))
      .toBe("http://192.168.1.5:13337/res/images/packed/card%20frames/Com%C3%BAn%20%232.png");

    // A different host (a re-scan onto another lease) re-bases again...
    setHostBase("http://192.168.1.9:13337");
    expect(mirrorResourceUrl("res://images/cards/strike.png"))
      .toBe("http://192.168.1.9:13337/res/images/cards/strike.png");

    // ...and dropping the injected base returns the bare route.
    setHostBase(undefined);
    expect(mirrorResourceUrl("res://images/cards/strike.png")).toBe("/res/images/cards/strike.png");
  });
});

describe("hostBase — memoized on the RAW injected global", () => {
  it("answers the page origin in host-served mode, repeatedly", () => {
    expect(hostBase()).toBe(location.origin);
    expect(hostBase()).toBe(location.origin);
  });

  it("picks up an injected base set AFTER the first call (the boot bundle's ordering)", () => {
    expect(hostBase()).toBe(location.origin);
    setHostBase("192.168.1.5:13337");
    expect(hostBase()).toBe("http://192.168.1.5:13337");
    setHostBase("https://192-168-1-5.my.local-ip.co:8443");
    expect(hostBase()).toBe("https://192-168-1-5.my.local-ip.co:8443");
    setHostBase(undefined);
    expect(hostBase()).toBe(location.origin);
  });

  it("still refuses an injected base that is not a usable origin, memo or not", () => {
    setHostBase("not a url");
    expect(hostBase()).toBe(location.origin);
    expect(hostBase()).toBe(location.origin);
  });
});
