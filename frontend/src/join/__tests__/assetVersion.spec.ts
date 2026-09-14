import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assetVersion,
  assetVersionSuffix,
  publishAssetVersion,
  whenAssetVersion,
  __resetAssetVersionForTest
} from "@/join/assetVersion";
import { modelAssetRoute, resourceRoute, spineClipRoute } from "@/protocol/browserResources";
import { mirrorResourceUrl, type MirrorNode } from "@/mirror/sceneTree";
import { geoclipUrl, spineClipUrl } from "@/mirror/spineAttributes";
import { mirrorSettings } from "@/mirror/mirrorSettings";

// THE BUG THIS EXISTS TO PIN. `res://images/atlases/relic_atlas.png` names the same file on every build of the
// game, and two builds render different pixels from it (the public-beta branch repacked several atlases). The
// host serves it `public, max-age=31536000, immutable`, so without a build qualifier a phone that joined a beta
// host keeps painting the beta's relics on a stable one — for a year, and with no service worker involved at all
// on the plain-HTTP LAN path where one never registers.
//
// So the invariant here is not "the token is forwarded somewhere". It is: EVERY ASSET URL THIS APP MINTS NAMES
// THE BUILD. That is what the HTTP cache, Cache Storage, `force-cache` and the mirror's own Map keys all key on.

const A = "cc-aaaaaaaaaaaaaaaa";
const B = "cc-bbbbbbbbbbbbbbbb";

beforeEach(() => {
  __resetAssetVersionForTest();
});

afterEach(() => {
  __resetAssetVersionForTest();
});

describe("the asset version latch", () => {
  it("starts unknown and latches the first real token", () => {
    expect(assetVersion()).toBeNull();
    publishAssetVersion(A);
    expect(assetVersion()).toBe(A);
  });

  // Forgetting is strictly worse than keeping the last real answer: every connection a page makes is the same
  // game build (the host, then the headless seat it redirects to), so an envelope that happens to arrive without
  // the field must not un-version every url the renderer is about to mint.
  it.each([null, undefined, ""])("ignores %p rather than clearing", (value) => {
    publishAssetVersion(A);
    publishAssetVersion(value as string | null | undefined);
    expect(assetVersion()).toBe(A);
  });

  it("takes a genuinely different token", () => {
    publishAssetVersion(A);
    publishAssetVersion(B);
    expect(assetVersion()).toBe(B);
  });
});

describe("assetVersionSuffix", () => {
  // NO TOKEN => NO SUFFIX. An older host, a unit test, SSR: all mint exactly the url they always did, which is
  // what keeps `spineClipUrl`'s documented "absent selectors yield a byte-identical url" property true.
  it("is empty while the build is unknown", () => {
    expect(assetVersionSuffix(false)).toBe("");
    expect(assetVersionSuffix(true)).toBe("");
  });

  it("opens a query or extends one, per the route's own grammar", () => {
    publishAssetVersion(A);
    expect(assetVersionSuffix(false)).toBe(`?b=${A}`);
    expect(assetVersionSuffix(true)).toBe(`&b=${A}`);
  });

  it("escapes a token that is not already url-safe", () => {
    publishAssetVersion("cc /?&=");
    expect(assetVersionSuffix(false)).toBe("?b=cc%20%2F%3F%26%3D");
  });
});

describe("whenAssetVersion", () => {
  it("runs immediately when a build is already known", () => {
    publishAssetVersion(A);
    const fn = vi.fn();
    whenAssetVersion(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("defers until one lands, and runs each waiter exactly once", () => {
    const first = vi.fn();
    const second = vi.fn();
    whenAssetVersion(first);
    whenAssetVersion(second);
    expect(first).not.toHaveBeenCalled();

    publishAssetVersion(A);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // A second, different token is an invalidation for the url minters, not a reason to re-run a one-shot gate.
    publishAssetVersion(B);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("a throwing waiter does not strand the ones behind it", () => {
    const after = vi.fn();
    whenAssetVersion(() => {
      throw new Error("prefetch blew up");
    });
    whenAssetVersion(after);

    expect(() => publishAssetVersion(A)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

// The four minters. All are memoized on hot paths (the renderer resolves every node's asset url each frame), so
// the property that actually matters is that the memo cannot outlive the build it baked in.
describe("asset routes carry the build", () => {
  it("mints the historic, unqualified url while the build is unknown", () => {
    expect(mirrorResourceUrl("res://images/cards/strike.png")).toBe("/res/images/cards/strike.png");
    expect(resourceRoute("res://images/cards/strike.png")).toBe("/res/images/cards/strike.png");
    expect(modelAssetRoute("model://characters/ironclad/icon")).toBe("/models/characters/ironclad/icon");
    expect(spineClipRoute("res://scenes/enemy.tscn", "Spine", "idle")).toBe(
      "/spines/scenes/enemy.tscn?node=Spine&anim=idle"
    );
  });

  it("opens the query on a path-only route and extends it on one that has selectors", () => {
    publishAssetVersion(A);
    expect(mirrorResourceUrl("res://images/cards/strike.png")).toBe(`/res/images/cards/strike.png?b=${A}`);
    expect(resourceRoute("res://images/cards/strike.png")).toBe(`/res/images/cards/strike.png?b=${A}`);
    expect(modelAssetRoute("model://characters/ironclad/icon")).toBe(`/models/characters/ironclad/icon?b=${A}`);
    // LAST, after every clip selector, so the WS-spine contract order reads unchanged.
    expect(spineClipRoute("res://scenes/enemy.tscn", "Spine", "idle")).toBe(
      `/spines/scenes/enemy.tscn?node=Spine&anim=idle&b=${A}`
    );
  });

  // THE MEMO IS THE RISK. Each of these caches by resource path and would otherwise keep serving a url with the
  // previous build baked into it — which is the original bug wearing a different hat.
  it("re-mints a path already cached under the previous build", () => {
    const path = "res://images/atlases/relic_atlas.png";

    expect(mirrorResourceUrl(path)).toBe("/res/images/atlases/relic_atlas.png");
    expect(resourceRoute(path)).toBe("/res/images/atlases/relic_atlas.png");

    publishAssetVersion(A);
    expect(mirrorResourceUrl(path)).toBe(`/res/images/atlases/relic_atlas.png?b=${A}`);
    expect(resourceRoute(path)).toBe(`/res/images/atlases/relic_atlas.png?b=${A}`);

    publishAssetVersion(B);
    expect(mirrorResourceUrl(path)).toBe(`/res/images/atlases/relic_atlas.png?b=${B}`);
    expect(resourceRoute(path)).toBe(`/res/images/atlases/relic_atlas.png?b=${B}`);
    expect(spineClipRoute("res://scenes/enemy.tscn", null, "idle")).toBe(
      `/spines/scenes/enemy.tscn?anim=idle&b=${B}`
    );
  });

  // The whole point, stated as the thing a phone actually does: the same resource on two builds is two urls, so
  // nothing that caches by url can serve one for the other.
  it("gives two builds two different urls for the same resource", () => {
    const path = "res://images/atlases/relic_atlas.png";
    publishAssetVersion(A);
    const onBeta = mirrorResourceUrl(path);
    publishAssetVersion(B);
    const onStable = mirrorResourceUrl(path);

    expect(onBeta).not.toBe(onStable);
  });
});

// The mirror mints `/spines/` and `/geoclips/` itself rather than importing the protocol builders (it stays
// self-contained), so the qualifier has to be pinned on both spellings or they drift apart.
describe("the mirror's own spine + geoclip routes carry the build", () => {
  const node = (over: Record<string, unknown> = {}): MirrorNode =>
    ({
      spineSceneResPath: "res://scenes/x.tscn",
      spineNodePath: "Vis/Spine",
      spineCurrentAnim: "idle",
      ...over
    }) as unknown as MirrorNode;

  afterEach(() => {
    mirrorSettings.spineMode = "static";
  });

  it("appends it LAST on a still — after every clip selector, including &t=", () => {
    mirrorSettings.spineMode = "static";
    publishAssetVersion(A);
    expect(spineClipUrl(node())).toBe(`/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle&still=1&b=${A}`);
    // A PAUSED track pins its sampled time; the build still lands after it.
    expect(spineClipUrl(node({ spinePaused: true, spineTrackTime: 0 }))).toBe(
      `/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle&still=1&t=0.00&b=${A}`
    );
  });

  it("appends it on the animated-clip branch too", () => {
    mirrorSettings.spineMode = "dynamic";
    publishAssetVersion(A);
    expect(spineClipUrl(node())).toBe(`/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle&b=${A}`);
  });

  it("appends it to a geoclip artifact", () => {
    publishAssetVersion(A);
    expect(geoclipUrl(node(), "manifest.json")).toBe(
      `/geoclips/scenes/x.tscn?node=Vis%2FSpine&anim=idle&file=manifest.json&b=${A}`
    );
  });

  it("leaves both byte-identical to the historic url while the build is unknown", () => {
    mirrorSettings.spineMode = "dynamic";
    expect(spineClipUrl(node())).toBe("/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle");
    expect(geoclipUrl(node(), "verts.bin")).toBe(
      "/geoclips/scenes/x.tscn?node=Vis%2FSpine&anim=idle&file=verts.bin"
    );
  });
});
