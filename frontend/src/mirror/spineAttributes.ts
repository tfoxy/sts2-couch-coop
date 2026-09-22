// Gate + URL helper for the live-tree MIRROR's SpineSprite animation-clip playback. A SpineSprite is a Node2D
// with NO localRect/texture in the mirror (ReadLocalRect returns null — it's neither Control nor Sprite2D), so
// the streamed clip (a frame sequence from `/spines/…`) is its SOLE visual; the reconciler treats a playing
// spine node like a particle node (a zero-box element at the node origin carrying the node transform, with the
// clip painted in a self-layer). This module decides WHEN that happens and builds the clip URL.
//
// Self-contained per the mirror decoupling rule (@/mirror/* + gsw only): the `/spines/` URL is built LOCALLY
// here — exactly like `mirrorResourceUrl` in sceneTree.ts builds `/res/…` — rather than importing
// `spineClipRoute` from @/protocol.

import { renderQuality } from "@/render/quality";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import type { MirrorNode } from "@/mirror/sceneTree";
import { assetVersionSuffix } from "@/join/assetVersion";
import { hostUrl } from "@/join/hostBase";

// True when a node should fetch + play a Spine clip: it's a SpineSprite (static scene/node metadata present),
// the game is currently playing an anim on it, AND this device renders spines at all. The tier gate is the
// fetch-or-flat degrade — a weak/mobile tier returns false here so the client requests NOTHING (the character
// renders blank rather than the device hammering wifi for a multi-MB clip). renderQuality() is memoized per
// session, so this is a cheap field read after the first call.
//
// `spineMode` OVERLAYS the tier (it never mutates the memoized tier):
//   off     — false for every spine node, which nodeStyles' shared use of this same gate turns into "no zero-box
//             element either", so Off leaves no phantom placeholders.
//   dynamic — the DEV escape hatch (`?spineMode=dynamic`): renders on any tier, floor included, because the only
//             way to ask for it is to type it.
//   static  — the PRODUCT DEFAULT, so it must not quietly promote the floor tier into rendering spines: it renders
//             a still on every tier EXCEPT `minimum` (WebGL-unavailable / the ?debug auto-player), which is
//             exactly what `auto` answered there when `auto` was the default.
export function isSpineClipNode(node: MirrorNode): boolean {
  if (node.spineSceneResPath == null || !node.spineCurrentAnim) {
    return false;
  }
  const mode = mirrorSettings.spineMode;
  if (mode === "off") {
    return false;
  }
  if (mode === "dynamic") {
    return true;
  }
  if (mode === "static") {
    return renderQuality().tier !== "minimum";
  }
  // auto (dev-only now): high/medium fetch the full animated clip. low/very-low (and any tier with clips
  // force-disabled) still fetch ONE STATIC frame (spineClipUrl appends &still=1) — so a weak/mobile device shows
  // the character as a single cheap image (the "something is here" indicator the recon view gives) rather than
  // NOTHING. Only the `minimum` floor (WebGL-unavailable / the ?debug auto-player) fetches nothing at all.
  const q = renderQuality();
  return q.spineClipsEnabled || q.tier !== "minimum";
}

// True when this device should request a STILL (single frame) rather than the animated clip. That is the DEFAULT
// (`spineMode` static) — and also what a tier that renders spines without full clips (low/very-low) asks for
// under `auto`. Drives the &still=1 query + the no-rAF paint. `?spineMode=dynamic` pins it false even on a still-mode
// tier (the dev asked for the animation); Off is moot (isSpineClipNode already returned false) but answers false
// for a well-defined value.
export function isSpineStillMode(): boolean {
  const mode = mirrorSettings.spineMode;
  if (mode !== "auto") {
    return mode === "static";
  }
  const q = renderQuality();
  return !q.spineClipsEnabled && q.tier !== "minimum";
}

// Geometry clips are an explicit developer/benchmark experiment, not an enhancement to the product still lane.
// `auto` is included because it is itself reachable only through `?spineMode=auto`; it preserves the old
// tier-driven experiment without making ordinary viewers touch `/geoclips/`. Keeping this gate next to the spine
// mode gates means both renderers make the same decision before a manifest probe can ask the host to bake one.
export function isGeoclipPlaybackEnabled(): boolean {
  const mode = mirrorSettings.spineMode;
  return mode === "dynamic" || mode === "auto";
}

// The `/spines/<scene-no-res>?node=<rel>&anim=<name>` URL for a node's CURRENT anim, or null when the node
// isn't a playable spine node. Byte-identical to @/protocol's spineClipRoute (the host mints the same
// canonical spine:// key from either), but built here to keep the mirror self-contained.
//
// Optional WS-spine selectors (contract order node → anim → skin → mat → skel → v; the host appends the size policy
// + still): `skin` (the node's runtime skin, #3) and `mat` (the node's shader-material signature, #8) are appended
// whenever present; `skel` and `retry` are supplied by the caller only on a recovery retry. ABSENT selectors
// (the common request) yield a
// BYTE-IDENTICAL url to before — the browser HTTP + clip caches stay valid (zero invalidation).
//
// `&b=` (the host's game build, @/join/assetVersion) goes LAST, after every selector including `still`/`t`, so
// the selector contract above reads unchanged and a host that sends no token still mints the historic url. It
// is not a clip selector — the host ignores it and it never enters the server-side clip key — it is what stops
// one build's rendered clip being served out of the browser's HTTP cache on another build.
//
// FIX 2b first-frame-immediate: `still` FORCES `&still=1` (a cheap single-frame render) independent of the tier's
// own isSpineStillMode() detection, so a full-clip (high/low) tier can fetch a still-first placeholder ahead of the
// full animated clip. It composes with the tier's own still-mode (either forces the still), so a still-mode tier is
// byte-identical whether or not the caller sets it.
export function spineClipUrl(node: MirrorNode, opts?: { skel?: string | null; retry?: boolean; still?: boolean }): string | null {
  const scene = node.spineSceneResPath;
  const anim = node.spineCurrentAnim;
  if (!scene || !anim || !scene.startsWith("res://")) {
    return null;
  }
  const scenePath = scene.slice("res://".length).split("/").map(encodeURIComponent).join("/");
  const selectors: string[] = [];
  if (node.spineNodePath) {
    selectors.push(`node=${encodeURIComponent(node.spineNodePath)}`);
  }
  selectors.push(`anim=${encodeURIComponent(anim)}`);
  if (node.spineSkin) {
    selectors.push(`skin=${encodeURIComponent(node.spineSkin)}`);
  }
  if (node.spineMat) {
    selectors.push(`mat=${encodeURIComponent(node.spineMat)}`);
  }
  if (opts?.skel) {
    selectors.push(`skel=${encodeURIComponent(opts.skel)}`);
  }
  if (opts?.retry) {
    selectors.push("retry=1");
  }
  // A still-mode tier (or an explicit opts.still request) asks the host to render a SINGLE frame (cheap one-image
  // placeholder) instead of the full clip. R10: a still of a PAUSED track additionally pins the sampled time
  // (`&t=`) to the game's own frozen track time — see spineStillTime.
  // `hostUrl` is a no-op in host-served mode, so the "BYTE-IDENTICAL url" property above still holds
  // there — clip identity and the HTTP cache are untouched. Under the public-origin bootstrap it gains
  // the host's origin, consistently for both branches so the two never disagree.
  const wantsStill = opts?.still === true || isSpineStillMode();
  if (!wantsStill) {
    return hostUrl(`/spines/${scenePath}?${selectors.join("&")}${assetVersionSuffix(true)}`);
  }
  const stillTime = spineStillTime(node);
  return hostUrl(
    `/spines/${scenePath}?${selectors.join("&")}&still=1${stillTime != null ? `&t=${stillTime}` : ""}`
      + assetVersionSuffix(true)
  );
}

// The geoclip artifact url for a node's CURRENT anim (see mirror/geoclipPlayer.ts), or null when the node isn't
// a playable spine node. Same readable selectors as `spineClipUrl` above and for the same
// reason: the canonical `spine://…` key is minted SERVER-SIDE by BuildSpineKey, so the browser never spells one
// itself and the two routes cannot drift apart.
//
// Three deliberate differences from the clip url. There is no `&still=` — a geoclip IS an animation, so the key is
// always the animated form. There is no `skin`/`mat`/`skel`/`v` — a geoclip bake is per (scene, node, anim), and
// folding in selectors it does not vary by would just address a directory nobody baked. And the artifact FILE
// rides the query rather than the path, because the scene path itself contains slashes: `?file=` is what tells the
// host this is the scene-addressed form and not `/geoclips/<key>/<file>`.
//
// `&b=` rides here for the same reason it rides the clip url: a bake is derived from the game's content, so a
// build change must re-address it rather than re-use whatever the browser cached. It is not a bake selector.
export function geoclipUrl(node: MirrorNode, file: string): string | null {
  const scene = node.spineSceneResPath;
  const anim = node.spineCurrentAnim;
  if (!scene || !anim || !scene.startsWith("res://")) {
    return null;
  }
  const scenePath = scene.slice("res://".length).split("/").map(encodeURIComponent).join("/");
  const selectors: string[] = [];
  if (node.spineNodePath) {
    selectors.push(`node=${encodeURIComponent(node.spineNodePath)}`);
  }
  selectors.push(`anim=${encodeURIComponent(anim)}`);
  selectors.push(`file=${encodeURIComponent(file)}`);
  return hostUrl(`/geoclips/${scenePath}?${selectors.join("&")}${assetVersionSuffix(true)}`);
}

// The `&t=` seconds a STILL of `node` should sample, or null when the host's own still-frame heuristic should pick.
//
// Only a track the GAME has PAUSED (`spinePaused`, i.e. SetTimeScale(0)) pins a time: the frozen `spineTrackTime`
// IS that node's authoritative resting pose, whereas the host's default guess is the MIDDLE of the clip. The
// treasure chest is the case this exists for — its sole clip is named "animation" (the lid opening) and the room
// freezes it at t=0 for a CLOSED chest, so the mid-clip still rendered a half-open lid on a chest nobody had
// touched. Unpausing drops the `t` again, which is ALSO why this belongs in the clip identity: without it, opening
// the chest only flips `spinePaused` — the url is unchanged, nothing re-fetches, and the lid never moves.
//
// Quantized to 2 decimals (the host re-quantizes identically) because the value is part of the clip CACHE key: an
// unrounded track time would mint a fresh server-side bake per millisecond of drift. A paused track's time is
// constant by construction (the producer freezes the elapsed value at the pause point), so this is stable.
export function spineStillTime(node: MirrorNode): string | null {
  if (!node.spinePaused) {
    return null;
  }
  const t = node.spineTrackTime;
  if (!Number.isFinite(t) || t < 0) {
    return null;
  }
  return t.toFixed(2);
}

// R11 WS-F — TERMINAL (one-way) animation names: die / death / dead / defeat. Client port of the host's
// `Sts2SpineStillFrame.IsTerminalAnimation` (spirectl bridge-mod) — KEEP THE TWO IN LOCKSTEP: the host uses it to
// sample a still's LAST frame (the corpse pose) instead of the mid frame, and the mirror uses it as the "this
// creature is dying" signal for spine-clip cache eviction (a corpse never replays its idle/attack clips, so their
// decoded entries are dead weight from the moment the death animation starts).
//
// Matched per NAME TOKEN (split on `_-. /`), not as a bare substring, so an unrelated clip that merely contains
// the letters (the host's example: "audience_idle") is never treated as terminal.
const TERMINAL_ANIM_PREFIXES = ["die", "death", "dead", "defeat"];
const TERMINAL_ANIM_SEPARATORS = /[_\-. /]+/;

export function isTerminalSpineAnim(animationName: string | null | undefined): boolean {
  if (!animationName) {
    return false;
  }
  for (const token of animationName.split(TERMINAL_ANIM_SEPARATORS)) {
    if (token === "") {
      continue; // RemoveEmptyEntries: repeated/leading/trailing separators
    }
    const lower = token.toLowerCase();
    for (const prefix of TERMINAL_ANIM_PREFIXES) {
      if (lower.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

// #13 SKEL-REQUIRED MEMO. Scene addresses (`scene|nodePath`) whose scene-addressed clip render is known to fail on
// the host because the game injects the skeleton at RUNTIME — the treasure chest, the boss map point (their .tscn
// carries no `skeleton_data_res`, so the extractor finds no skeleton to drive). Learned the first time a `&skel=`
// retry fires for that address, then reused so every LATER request for it (including the cheap still-first
// placeholder) goes straight to the working url instead of burning two failed round-trips through the host's single
// extraction slot first. Module-scoped + never cleared: the answer is a property of the .tscn, not of the session.
const skelRequiredAddresses = new Set<string>();

function spineAddressKey(node: MirrorNode): string {
  return `${node.spineSceneResPath}|${node.spineNodePath ?? ""}`;
}

export function markSpineSkelRequired(node: MirrorNode): void {
  if (node.spineSceneResPath) {
    skelRequiredAddresses.add(spineAddressKey(node));
  }
}

export function isSpineSkelRequired(node: MirrorNode): boolean {
  return node.spineSceneResPath != null && skelRequiredAddresses.has(spineAddressKey(node));
}

// TEST-ONLY: forget every learned skel-required address so a test starts clean.
export function __clearSpineSkelRequiredForTest(): void {
  skelRequiredAddresses.clear();
}
