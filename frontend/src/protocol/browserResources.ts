// The resource ROUTES the client fetches game assets over. Pure string transforms, no I/O: each mints the
// path the host serves a `res://` / `model://` / spine clip key at, and the caller does the fetching.

// Asset routes carry the resource path readably (/res/images/icon.png); the server mints the
// scheme back. Encode per segment so `/` separators stay literal while anything else unusual
// (spaces, colons) still escapes cleanly.
//
// Memoized by key: these are pure string transforms recomputed per-resource per-render (the
// renderer resolves every node's asset URL each frame), and a combat scene reuses a small set
// of resource keys across hundreds of nodes. Keys are scheme-prefixed so res:// and model://
// never collide in the shared cache; the set is bounded by the game's asset roster.
const routeCache = new Map<string, string>();
export function resourceRoute(resourceKey: string): string {
  let route = routeCache.get(resourceKey);
  if (route === undefined) {
    route = `/res/${schemelessPath(resourceKey, "res://")}`;
    routeCache.set(resourceKey, route);
  }
  return route;
}

export function modelAssetRoute(modelKey: string): string {
  let route = routeCache.get(modelKey);
  if (route === undefined) {
    route = `/models/${schemelessPath(modelKey, "model://")}`;
    routeCache.set(modelKey, route);
  }
  return route;
}

// A SpineSprite animation-clip stream: `/spines/<scene-path>?node=<rel>&anim=<name>` (the host mints the
// canonical spine:// key and streams the rendered clip — see CouchCoopSpineClipProvider). The scene path is a
// res:// resource path with the scheme dropped (parallels /res); `node` (the scene-relative SpineSprite path,
// optional) + `anim` ride as query selectors. The server decodes + canonicalizes them, so a clip key is stable.
export function spineClipRoute(sceneResPath: string, nodePath: string | null, anim: string): string {
  const cacheKey = `spine|${sceneResPath}|${nodePath ?? ""}|${anim}`;
  let route = routeCache.get(cacheKey);
  if (route === undefined) {
    const scene = schemelessPath(sceneResPath, "res://");
    const selectors = nodePath
      ? `node=${encodeURIComponent(nodePath)}&anim=${encodeURIComponent(anim)}`
      : `anim=${encodeURIComponent(anim)}`;
    route = `/spines/${scene}?${selectors}`;
    routeCache.set(cacheKey, route);
  }
  return route;
}

function schemelessPath(key: string, scheme: string): string {
  if (!key.startsWith(scheme)) {
    throw new Error(`Resource URLs must use ${scheme} keys.`);
  }
  return key.slice(scheme.length).split("/").map(encodeSegment).join("/");
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}
