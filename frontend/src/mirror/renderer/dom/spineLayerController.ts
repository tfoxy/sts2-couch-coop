// DOM layer controller for Spine clip paint. This does NOT implement Spine playback/runtime semantics:
// spineGeoclipTimeline owns playback and geoclip behavior. This leaf owns only DOM layer mechanism
// plus clip request, cache and refcount orchestration on retained records.

import type { MirrorNode } from "@/mirror/sceneTree";
import {
  isGeoclipPlaybackEnabled,
  isSpineClipNode,
  isSpineSkelRequired,
  isSpineStillMode,
  isTerminalSpineAnim,
  markSpineSkelRequired,
  spineClipUrl,
  spineStillTime,
} from "@/mirror/spineAttributes";
import { dropSpineClipCacheEntry, loadSpineClip, type LoadedSpineClip } from "@/mirror/spineClip";
import type { RenderRecord } from "@/mirror/renderer/dom/recordModel";
import type { SpineGeoclipTimeline } from "@/mirror/renderer/dom/spineGeoclipTimeline";

export interface SpineLayerControllerPorts {
  now(): number;
  schedule(): void;
  thaw(canvas: HTMLCanvasElement | null): void;
  // This getter deliberately resolves the live timeline at each use: construction precedes timeline setup.
  timeline(): SpineGeoclipTimeline;
}

export interface SpineLayerController {
  setMechanism(record: RenderRecord, mode: "canvas" | "img"): void;
  updateLayer(record: RenderRecord, node: MirrorNode, deferHiddenLayers: boolean): void;
  setClip(record: RenderRecord, clip: LoadedSpineClip | null): void;
  setShownStill(record: RenderRecord, clip: LoadedSpineClip | null): void;
  dropSeenUrls(record: RenderRecord): void;
}

export function createSpineLayerController(ports: SpineLayerControllerPorts): SpineLayerController {
  // Swap this node's spine paint element between the <canvas> (dynamic clips) and an <img> (a
  // single-frame still). The outgoing element is REPLACED in place, so paint order survives a swap that lands
  // asynchronously (a clip resolving between walks) — and `record.subLayers`, which the end-of-walk reorder pass
  // re-inserts verbatim, is patched with it so a stale element can never be re-attached. A fresh element carries
  // no placement styles and nothing painted, hence the two cache resets.
  function setMechanism(record: RenderRecord, mode: "canvas" | "img"): void {
    const current = record.spineImg ? "img" : record.spineCanvas ? "canvas" : "none";
    if (current === mode) {
      return;
    }
    // The outgoing element is about to be replaced, so a still standing in for it has to go first (its
    // `<img>` is a sibling of `prev`, and replaceChild would strand it).
    ports.thaw(record.spineCanvas);
    const prev = record.spineLayer;
    let next: HTMLElement;
    if (mode === "img") {
      const img = document.createElement("img");
      img.className = "mirror-spine-img";
      // Gated means the bytes are already decoded when the src is written, so "sync" makes the swap
      // atomic (the same reason the occlusion pass's frozen-canvas <img> uses it). Ungated keeps "async" so the
      // The decode result is applied only if it still belongs to this record.
      img.decoding = "sync";
      record.spineImg = img;
      record.spineCanvas = null;
      record.spineCtx = null;
      // The still mechanism is condition (a) of the paint-cull promotion — register the candidate and re-derive.
      ports.timeline().registerStill(record);
      next = img;
    } else {
      const canvas = document.createElement("canvas");
      canvas.className = "mirror-spine-canvas";
      record.spineCanvas = canvas;
      record.spineCtx = canvas.getContext("2d");
      record.spineImg = null;
      record.spineImgUrl = null;
      // The <img> is being replaced by this canvas — nothing displays the still any more, so release the
      // gate's retain, and cancel any decode still in flight for it (it must never commit onto the canvas path).
      record.spinePendingStillUrl = null;
      setShownStill(record, null);
      // …and the promotion goes with it (the refresh below retires it): a canvas is its own composited layer, so
      // the shape the cull needs is gone and a surviving `will-change` would be a layer paid for nothing.
      next = canvas;
    }
    record.spineLayer = next;
    record.spinePlacementKey = null;
    record.spineShownFrame = -1;
    if (prev && prev.parentNode) {
      prev.parentNode.replaceChild(next, prev);
    } else {
      record.el?.appendChild(next);
    }
    if (prev) {
      const at = record.subLayers.indexOf(prev);
      if (at >= 0) {
        record.subLayers[at] = next;
      }
    }
    // Aug-25: condition (a) just changed for this node, so re-derive its paint-cull promotion NOW rather than
    // leaving it to the end-of-walk pass — the gated still commits from a DECODE CALLBACK, with no walk behind it,
    // and on a settled screen the next walk may be a long way off (or never). Costs one querySelector per swap.
    ports.timeline().refreshPromotion(record);
  }

  // Reflect a node's CURRENT spine state onto its clip self-layer: create/tear down the layer, (re)fetch on an
  // anim change, and re-sync the playback clock to the freshly-arrived authoritative track time. Called from
  // updateSubLayers (only on a dirty node), so a clean/idle spine node is driven purely by the rAF.
  function updateLayer(record: RenderRecord, node: MirrorNode, deferHiddenLayers: boolean): void {
    const el = record.el!;
    if (!isSpineClipNode(node)) {
      // `off` (and the off quality floor) removes the spine role while this record can still be retained for
      // another reason. Invalidate an in-flight probe as well as a mounted canvas before dropping its raster
      // layer, otherwise a late upload can resurrect geometry after the node stopped being a spine.
      ports.timeline().releaseGeoclip(record);
      if (record.spineLayer) {
        record.spineLayer.remove();
        record.spineLayer = null;
        record.spineImg = null;
        record.spineImgUrl = null;
        // No clip left to be culled — drop the paint-cull promotion with it (see applySpinePromotionPass).
        ports.timeline().clearPromotion(record);
        // Same teardown contract as removeEl: cancel the pending decode, release the displayed still,
        // and only EVICT when this node was dying (a node that merely stopped being a spine node is not a corpse).
        record.spinePendingStillUrl = null;
        setShownStill(record, null);
        if (record.spineDying) {
          dropSeenUrls(record);
        }
        record.spineStillUrlsSeen = null;
        record.spineDying = false;
        record.spineCanvas = null;
        record.spineCtx = null;
        record.spineAnim = null;
        record.spineSkin = null;
        record.spineMat = null;
        record.spineSkelPath = null;
        record.spineStill = false;
        record.spineStillT = null;
        record.spineRetried = false;
        record.spineSkelRetried = false;
        setClip(record, null);
        record.spineSyncNode = null;
        record.spineShownFrame = -1;
        record.spinePlacementKey = null;
        record.spineStillPainted = false;
        record.spineAnimatedShown = false;
        ports.timeline().remove(record); // a parked clip that lost its layer must not re-arm on reveal
      }
      return;
    }

    // Under a hidden ancestor, don't stand up a spine clip that hasn't got a canvas yet —
    // the canvas, the clip fetch, the decode and the per-frame blit are all for pixels inside a display:none
    // subtree. An ALREADY-running clip is left alone (its subtree merely went hidden). Reveal cost: the clip fetch
    // starts at reveal instead of ahead of it.
    if (deferHiddenLayers && !record.spineLayer) {
      return;
    }

    // The layer starts as the CANVAS: whether the clip turns out to be a still (→ <img>, WS-4) isn't known until
    // it lands, and the canvas is the mechanism that can paint either. applySpinePlacement swaps it if needed.
    if (!record.spineLayer) {
      const canvas = document.createElement("canvas");
      canvas.className = "mirror-spine-canvas";
      record.spineCanvas = canvas;
      record.spineLayer = canvas;
      record.spineCtx = canvas.getContext("2d");
      el.appendChild(canvas);
      ports.timeline().noteDomShapeChanged(); // a composited surface appeared under an outer spine node
    }

    const anim = node.spineCurrentAnim!;
    const skin = node.spineSkin;
    const mat = node.spineMat;
    // The skeleton path is part of the identity. A runtime-injected skeleton (the boss map point, the
    // treasure chest — neither carries `skeleton_data_res` in its .tscn) reports its animation FIRST, because the
    // producer sees the animation where it is REQUESTED, and its `skelResPath` only once the late-static re-probe
    // lands. The requests for that first identity all 404 (the scene address has no skeleton offline) and the
    // `&skel=` retry can't fire yet because the path is still null — so without re-requesting on this transition,
    // that first failed request was the LAST one. The map boss never appeared at all, and the chest only showed up
    // once OPENING it changed the animation. A re-request for an unchanged url is a clip-cache hit (no network), so
    // this costs nothing for a node that already resolved.
    const skel = node.spineSkelResPath;
    // Keep the loop flag fresh on every emission: it can flip while the anim NAME is unchanged (a node's
    // looping fallback → the real one-shot flag, e.g. a weapon's "attack"). advanceSpine reads it to decide
    // loop vs freeze-on-last-frame, so syncing it here (not only on an anim change) is what stops a finished
    // one-shot from replaying forever.
    record.spineLooping = node.spineLooping;
    // Keep the paused flag (and, while paused, the authoritative track time) fresh on every emission: a freeze or
    // resume flips it with the anim NAME unchanged, and a scrub while paused must land on the streamed frame.
    record.spinePaused = node.spinePaused;
    if (node.spinePaused) {
      record.spineSyncTrackMs = Math.max(0, node.spineTrackTime * 1000);
      record.spineSyncWallMs = ports.now();
      record.spineShownFrame = -1;
      if (record.spineClip) {
        ports.timeline().advance(record, ports.now()); // repaint at the frozen time now — a paused node gets no rAF advance
      }
    }
    // Re-request on an animation, skin, material, or skeleton-path change — the full clip identity —
    // or on a still-vs-animated flip (the settings panel's manual spine mode; constant for a pure-tier session).
      // The paused still time joins the identity, so freezing or unfreezing a track re-fetches. Opening the treasure
    // chest changes NOTHING else about the node (the anim stays "animation"), so this is the whole re-fetch trigger.
    const still = isSpineStillMode();
    const stillT = spineStillTime(node);
    // Static is the shipped lane. This is intentionally outside the clip-identity branch: an explicit
    // `auto` → `static` flip can retain the same `&still=1` raster URL, but it must still tear down a live
    // geoclip immediately rather than leaving geometry over the baked still.
    const geoclipEnabled = isGeoclipPlaybackEnabled();
    if (!geoclipEnabled) {
      ports.timeline().releaseGeoclip(record);
    }
    const spineIdentityChanged =
      record.spineAnim !== anim ||
      record.spineSkin !== skin ||
      record.spineMat !== mat ||
      record.spineSkelPath !== skel ||
      record.spineStill !== still ||
      record.spineStillT !== stillT;
    if (spineIdentityChanged) {
      // The identity changed (or this is the first attach): fetch the new clip + reset the frame state.
      // Pause advancement until it resolves so we don't extrapolate against the previous clip's frames.
      record.spineAnim = anim;
      record.spineSkin = skin;
      record.spineMat = mat;
      record.spineSkelPath = skel;
      record.spineStill = still;
      record.spineStillT = stillT;
      record.spineRetried = false;
      // An address already proven to need `&skel=` (its skeleton is injected at runtime, so the scene-addressed
      // render has nothing to drive) pre-arms the retry, so the very first request carries the skeleton path instead
      // of 404ing twice through the host's single extraction slot first.
      record.spineSkelRetried = skel != null && isSpineSkelRequired(node);
      // A decode in flight for the outgoing still must not commit — the record has moved on. The
      // DISPLAYED still is deliberately NOT released here: it keeps painting (and keeps its object url alive)
      // until the incoming one has decoded, which is the whole point of the gate.
      record.spinePendingStillUrl = null;
      // A terminal identity (die/death/dead/defeat) means this creature will never play any of
      // its earlier animations again, so their decoded clips are dead weight the moment the death starts — hand
      // them back (retained clips keep painting; only the cache index goes). The corpse's OWN clips are dropped
      // later, when the element goes away, via `spineDying`.
      //
      // Retain the displayed still while terminal clips release their cached URLs so a visible image cannot lose
      // its object URL before replacement or teardown.
      if (isTerminalSpineAnim(anim)) {
        dropSeenUrls(record);
        record.spineDying = true;
      } else {
        record.spineDying = false;
      }
      setClip(record, null);
      record.spineShownFrame = -1;
      record.spinePlacementKey = null;
      record.spineStillPainted = false;
      record.spineAnimatedShown = false;
      record.spineSyncNode = node;
      ports.timeline().remove(record); // the parked clip is stale; re-arm from the fetch
      // Seed the playback clock ONCE, here at the anim change, from the freshly-arrived authoritative track time
      // (the anim just started ≈ 0, so the clip plays from its first frame). Between anim changes the rAF
      // free-runs the loop — we deliberately do NOT re-seed on every per-tick delta: the producer's track time
      // rewinds to ~0 whenever a looping anim re-fires animation_started, and re-seeding to that would restart
      // the clip every tick (the flicker). See Sts2SpineInspector — only a real switch reseeds.
      record.spineSyncTrackMs = Math.max(0, node.spineTrackTime * 1000);
      record.spineSyncWallMs = ports.now();
      // The previous animation's geometry cannot survive an identity change. The desired-state check below
      // re-arms only after the new identity is fully recorded.
      ports.timeline().releaseGeoclip(record);
      // A pre-armed skel retry (memoised address, above) goes straight to the working `&skel=` url — which also
      // skips the still-first placeholder, since that would just be another 404 for this address.
      const fetchRaster = (): void =>
        requestClip(record, node, anim, skin, record.spineSkelRetried ? { skel } : undefined);
      fetchRaster();
    }
    // This deliberately lives outside the raster-identity branch. `static` → `auto` on a still-only tier keeps
    // the same `&still=1` URL, but the explicit opt-in must still start one manifest probe; a non-null state is
    // the per-identity latch that prevents routine reconciles from duplicating it.
    if (geoclipEnabled && record.geoclipState === null && !record.geoclipDisabled) {
      ports.timeline().armGeoclip(record, node);
    }
  }

  // The ONLY place `record.spineClip` is assigned: refcounts the decoded clip so an LRU eviction can never close
  // ImageBitmaps the renderer is still painting (see LoadedSpineClip.retain/release in spineClip.ts).
  function setClip(record: RenderRecord, clip: LoadedSpineClip | null): void {
    if (record.spineClip === clip) {
      return;
    }
    record.spineClip?.release();
    record.spineClip = clip;
    clip?.retain();
  }

  // The only place `record.spineShownStill` is assigned: a second, independent retain on the clip whose
  // `stillUrl` the live <img> is displaying. `spineClip` is swapped the instant a newer clip arrives, but the url
  // on screen must outlive that: without this retain an LRU eviction could revoke an object url the element was
  // still painting (blank creature until the next identity change). Released only when those pixels are actually
  // replaced — a newer still committing, a switch to the canvas mechanism, or the layer going away.
  function setShownStill(record: RenderRecord, clip: LoadedSpineClip | null): void {
    if (record.spineShownStill === clip) {
      return;
    }
    record.spineShownStill?.release();
    record.spineShownStill = clip;
    clip?.retain();
  }

  // Remember a /spines/ REQUEST url this node has asked for, so a death can hand every one of them back to the
  // clip cache in one go. Lazily allocated: the overwhelming majority of records are not spine nodes.
  function noteRequestUrl(record: RenderRecord, url: string): void {
    let seen = record.spineStillUrlsSeen;
    if (!seen) {
      seen = new Set<string>();
      record.spineStillUrlsSeen = seen;
    }
    seen.add(url);
  }

  // Hand this node's requested clips back to the cache. Safe at any time: `dropSpineClipCacheEntry` only drops the
  // INDEX (dispose()), and the refcount keeps any clip another record — or this one — is still painting alive.
  function dropSeenUrls(record: RenderRecord): void {
    const seen = record.spineStillUrlsSeen;
    if (!seen) {
      return;
    }
    for (const url of seen) {
      dropSpineClipCacheEntry(url);
    }
    seen.clear();
  }

  // Fetch the clip for the current (anim, skin) identity + paint it. On a full-clip tier this FIRST fetches a
  // cheap 1-frame STILL (`&still=1`) and paints frame 0 in ~0.5-1s, THEN chains the full animated clip and hot-swaps
  // it in — so a spine shows immediately instead of a ~30-60s black silhouette while the whole clip bakes. Gated so it
  // doesn't double-fire on a tier that is already still-only (isSpineStillMode) and doesn't interfere with retry=1
  // / skeleton one-shot retries (retry/skeleton selectors go straight to the animated fetch). The still→clip
  // request is CHAINED, not concurrent: a concurrent clip request would lose the shared server single-slot extraction
  // gate behind the long clip bake.
  function requestClip(
    record: RenderRecord,
    node: MirrorNode,
    anim: string,
    skin: string | null,
    opts?: { skel?: string | null; retry?: boolean },
  ): void {
    // The paused-still time is part of the identity, so a still that arrives after the game unfroze the track
    // (or froze it at a new time) is STALE exactly like a switched-away anim — capture it and guard the arrivals.
    const stillT = record.spineStillT;
    if (!isSpineStillMode() && !opts?.retry && !opts?.skel) {
      const stillUrl = spineClipUrl(node, { still: true });
      if (stillUrl) {
        noteRequestUrl(record, stillUrl);
        // `stillImg` tells the loader this 1-frame answer will be painted as an <img> off its object url, so it
        // keeps the encoded bytes and skips decoding a full-size ImageBitmap nothing would ever blit.
        void loadSpineClip(stillUrl, { stillImg: true }).then(
          (still) => {
            // Drop the still if the identity switched away, the canvas is gone, OR the animated clip already swapped
            // in (a LATE-arriving still must NOT clobber the animation). The deliberate 1-frame still is painted
            // directly here — never through the animated-fetch single-frame escalation.
            if (
              record.spineAnim !== anim ||
              record.spineSkin !== skin ||
              record.spineStillT !== stillT ||
              !record.spineLayer ||
              record.spineAnimatedShown
            ) {
              return;
            }
            setClip(record, still);
            ports.timeline().applyPlacement(record, still);
            record.spineStillPainted = true;
            ports.timeline().advance(record, ports.now()); // paint frame 0 immediately — no black silhouette
            // Chain the full animated clip ONLY NOW (the still has settled), so it queues behind — not against — the
            // server's single extraction slot.
            requestAnimatedClip(record, node, anim, skin, opts);
          },
          () => {
            // The still fetch failed → fall straight through to the animated fetch (no worse than pre-fix; the node
            // just shows nothing until the clip arrives, exactly as before still-first).
            if (
              record.spineAnim === anim &&
              record.spineSkin === skin &&
              record.spineStillT === stillT &&
              record.spineLayer
            ) {
              requestAnimatedClip(record, node, anim, skin, opts);
            }
          },
        );
        return;
      }
    }

    requestAnimatedClip(record, node, anim, skin, opts);
  }

  // Fetch (or escalation-refetch) the ANIMATED clip for the current (anim, skin) identity + paint/hot-swap it in.
  // Retry and skeleton selectors are supplied only on one-shot retries. Every async arrival is
  // guarded on the identity STILL matching (anim + skin) and the canvas surviving, so a stale result for a
  // switched-away identity is dropped.
  function requestAnimatedClip(
    record: RenderRecord,
    node: MirrorNode,
    anim: string,
    skin: string | null,
    opts?: { skel?: string | null; retry?: boolean },
  ): void {
    const url = spineClipUrl(node, opts);
    if (!url) {
      return;
    }
    const stillT = record.spineStillT; // part of the identity (see requestClip)
    noteRequestUrl(record, url);
    // A still-mode tier's "animated" request IS a still (&still=1), so it takes the same encoded-bytes-only path;
    // a genuinely multi-frame answer ignores the hint and decodes every frame as before.
    void loadSpineClip(url, { stillImg: true }).then(
      (clip) => {
        if (
          record.spineAnim !== anim ||
          record.spineSkin !== skin ||
          record.spineStillT !== stillT ||
          !record.spineLayer
        ) {
          return;
        }
        // A non-still clip that came back with a single frame is the producer's oversized-
        // budget collapse (or a stale immutable HTTP blob). Drop the cache entry + refetch ONCE with &retry=1 (a distinct
        // url → a fresh render, bypassing the immutable HTTP cache). A still-mode tier legitimately renders 1 frame →
        // never retry there. Bounded via record.spineRetried.
        // A host-degraded clip is a deliberate single frame served because the machine is
        // oversubscribed. Escalating it would re-ask for the expensive bake, per spine node, exactly when the host
        // just declined the work — a request storm at the worst moment. C# twin: SpineClipEscalation.
        if (!record.spineRetried && clip.frames.length === 1 && !isSpineStillMode() && !clip.degraded) {
          record.spineRetried = true;
          dropSpineClipCacheEntry(url);
          requestAnimatedClip(record, node, anim, skin, { skel: opts?.skel ?? null, retry: true });
          return;
        }
        setClip(record, clip);
        if (clip.degraded) {
          // Retain-then-drop order matters: setClip above retained the clip, so evicting its cache entry here
          // cannot close bitmaps the renderer is about to paint (the refcount holds them until it releases). The
          // entry has to go, or the LRU would keep answering with the stand-in long after the host recovered.
          dropSpineClipCacheEntry(url);
        }
        ports.timeline().applyPlacement(record, clip);
        // Force a repaint even when the placement key is unchanged (a still-first swap into a same-sized cell keeps
        // spineShownFrame at 0, which would otherwise skip drawing the animated clip's own frame-0 bitmap).
        record.spineShownFrame = -1;
        record.spineAnimatedShown = true; // the animated clip has swapped in — a late still can't clobber it now
        // A still (1-frame clip — the low-end/mobile fallback) needs no animation loop: paint it once and
        // leave it out of the rAF set. Multi-frame clips join the rAF for playback.
        if (clip.frames.length > 1) {
          ports.timeline().add(record);
          ports.schedule(); // first clip in ⇒ arms the shared frame grid; already-armed ⇒ joins the same wakeups
        }
        ports.timeline().advance(record, ports.now()); // paint immediately — no blank gap (a still = its only frame)
      },
      () => {
        // A failed load with a producer-supplied skeleton path retries once with `&skel=`
        // (a distinct url → the extractor bakes straight from the skeleton). Otherwise the node stays blank
        // (loadSpineClip already dropped the cache entry so a later anim re-tries). Bounded via record.spineSkelRetried.
        if (
          record.spineAnim === anim &&
          record.spineSkin === skin &&
          record.spineStillT === stillT &&
          record.spineLayer &&
          !record.spineSkelRetried &&
          node.spineSkelResPath
        ) {
          record.spineSkelRetried = true;
          // Remember the address so a later identity (the chest's open animation, a re-entered map) requests the
          // working `&skel=` url first time. Marked on the RETRY, not on its success: the scene lane has already
          // permanently failed for this address, which is exactly what the memo records.
          markSpineSkelRequired(node);
          requestAnimatedClip(record, node, anim, skin, {
            skel: node.spineSkelResPath,
            retry: record.spineRetried,
          });
        }
      },
    );
  }

  return { setMechanism, updateLayer, setClip, setShownStill, dropSeenUrls };
}
