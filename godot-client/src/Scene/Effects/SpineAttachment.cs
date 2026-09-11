// M1d effect seam — SPINE attachment (WS-I real body; replaces the M1c stub). MirrorNodeView.Apply calls Sync on
// every node update. A SpineSprite mirror node has NO texture; its sole visual is a baked animation CLIP streamed
// from `/spines/…` (SPCL v1). This builds a self-ticking "__spine" child (end-appended + ShowBehindParent, so the
// clip draws in the SpineSprite view's z-order) that:
//   - fetches the clip via SpineClipStore (live-host-polite, decode-once),
//   - plays frames off a WALL-CLOCK reseeded ONLY on an anim-NAME change (volatile track-time echoes while the
//     name is unchanged do NOT reseed — the clock free-runs; otherwise a looping anim's per-tick track-time rewind
//     would restart the clip every tick = flicker),
//   - freezes a one-shot on its last frame (FrameIndexAt clamp) and keeps showing the PREVIOUS clip's last frame
//     until a newly-selected anim's clip arrives (matches mirrorRenderer.ts updateSpineLayer + advanceSpine).
//
// Placement (applySpinePlacement L1318-1337 + advanceSpine L1342-1361): the clip's shared canvas maps into
// node-local by translate(localX, localY)·scale(localWidth/canvasWidth). The __spine layer draws with identity
// transform in the view's local space, so DrawSetTransform applies that placement and DrawTexture blits the
// current tight-cropped frame at (offsetX, offsetY) — the owner view's own matrix then maps node-local → screen.

using System;
using CouchCoop.GodotClient.Scene;
using CouchCoop.MirrorProtocol.Assets;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Effects;

public static class SpineAttachment
{
    private const string ChildName = "__spine";

    // WS-B: build-once NodePath for the child probes (GetNodeOrNull(string) marshals a fresh NodePath per call).
    private static readonly NodePath ChildPath = ChildName;

    public static void Sync(MirrorNodeView owner, MirrorNode node, RenderContext ctx)
    {
        // R9 item 10: the manual spine mode overlays the streamed answer. Off ⇒ this is NOT a spine node for the
        // render layer, so the flow below takes the existing teardown branch (the layer is removed + freed) and a
        // node that never had one is skipped by the WS-P2 gate. The reconciler's Generation poll re-Applies every
        // view on a flip, so Off/On takes effect live without a reconnect. Web twin: isSpineClipNode's Off arm.
        bool isSpine = node.SpineSceneResPath is not null
            && !string.IsNullOrEmpty(node.SpineCurrentAnim)
            && ClientEffectSettings.SpineRenders;

        // WS-P2 gate: not a spine clip now AND none ever attached → skip the marshalled child probe entirely.
        if (!isSpine && !owner.HasSpineChild)
        {
            return;
        }

        var layer = owner.GetNodeOrNull<SpineLayer>(ChildPath);

        if (!isSpine)
        {
            if (layer is not null)
            {
                owner.RemoveChild(layer);
                layer.QueueFree();
            }

            owner.HasSpineChild = false;
            return;
        }

        if (layer is null)
        {
            layer = new SpineLayer { Name = ChildName, ShowBehindParent = true };
            owner.AddChild(layer); // end-appended; the reconciler's MoveChild pass keeps non-view children at the tail
            owner.HasSpineChild = true;
        }

        layer.Configure(node);
    }

    // Track I: freeze/unfreeze this view's spine clip (idle-suspend sweep). Returns true iff a live "__spine" layer
    // was toggled — the controller gates the call on owner.HasSpineChild, and this re-confirms the child exists.
    public static bool SetSuspended(MirrorNodeView owner, bool suspend)
    {
        var layer = owner.GetNodeOrNull<SpineLayer>(ChildPath);
        if (layer is null)
        {
            return false;
        }

        if (suspend)
        {
            layer.Suspend();
        }
        else
        {
            layer.Resume();
        }

        return true;
    }
}

// The self-ticking clip player. One per playing SpineSprite view. Holds the playback clock + the currently-drawn
// decoded clip; _Process advances the frame off the wall clock, _Draw blits it at the clip's placement.
public sealed partial class SpineLayer : Node2D
{
    private SpineClipStore? _store;

    private string? _anim;                       // current anim NAME (clock reseeds only when this changes)
    private string? _skin;                        // current runtime SKIN (folded into the identity → re-request on change)
    private string? _mat;                         // current shader-MATERIAL signature (#8; same deal as _skin)
    private bool _paused;                         // the game froze this track (#13) → Advance holds _syncTrackMs
    // Clip-identity fields captured at the last (re)request, so the escalation retries can rebuild the url without
    // holding the (pooled/mutable) node reference. #8 skel-fallback + #4 retry=1 escalation are each ONE-SHOT per identity.
    private string? _scene;
    private string? _nodePath;
    private string? _skelResPath;
    private bool _retried;                         // already refetched with &retry=1 for this (anim,skin)
    private bool _skelRetried;                     // #8: already retried with &skel= for this (anim,skin)
    private string? _wantUrl;                     // url requested for the current identity (drops stale async arrivals)
    // FIX 2b first-frame-immediate: the still url requested for the current identity (drops a stale/late still
    // arrival independently of the animated _wantUrl); `_stillPainted` = the cheap 1-frame still has painted;
    // `_animatedShown` = the full animated clip has swapped in (a late still must NOT clobber it). All reset on an
    // identity change (Configure).
    private string? _wantStillUrl;
    private bool _stillPainted;
    private bool _animatedShown;
    // R9 item 10: the resolved STILL-ONLY answer (ClientEffectSettings.SpineStillOnly, i.e. the panel's Static) the
    // current clip was requested under. Part of the CLIP IDENTITY — a live Dynamic↔Static flip leaves the streamed
    // anim/skin/mat/skel untouched, so without this the layer would keep playing the clip it already has. In Static
    // the primary request path builds the `&still=1` url directly (no still→animated chain) and _Process stops
    // advancing. Web twin: RenderRecord.spineStill in mirrorRenderer.ts.
    private bool _stillOnly;
    private SpineClipStore.LoadedClip? _clip;     // currently-DRAWN clip (kept while a new one loads → freeze)
    private bool _awaiting;                        // true while a newly-selected anim's clip hasn't arrived yet

    private double _syncTrackMs;                   // clock anchor: authoritative track ms at reseed
    private double _syncWallMs;                    // wall ms at reseed (Time.GetTicksMsec)
    private bool _looping = true;                  // refreshed EVERY Configure (can flip while name unchanged)
    private int _shownFrame = -1;                  // last drawn frame index (-1 = none yet)

    // Track I (idle-animation suspend): while _suspended the layer is SetProcess(false) so the clip clock does not
    // free-run. Suspend captures the extrapolated playMs; Resume RE-ANCHORS (_syncTrackMs=capturedPlayMs,
    // _syncWallMs=now) so the clip continues from the exact frozen frame with NO phase jump. _frozenFrame + the
    // one-shot verify flag drive the re-anchor DEBUG proof (first drawn frame after resume == frozen frame).
    private bool _suspended;
    private double _suspendedPlayMs;
    private int _frozenFrame = -1;

    // Test-only determinism lever (COUCHCOOP_MIRROR_SPINE_FREEZE=1, default OFF, never ships). Pins the drawn frame to
    // the clip's reseed anchor (no wall-clock advance), so a --replay --shot AE run captures the SAME spine pose
    // regardless of how long the capture takes to settle. Needed for a FAIR static-bake ON-vs-OFF comparison: the ON
    // leg settles LATER (waits for the bake to reach Active), and off the wall clock that later capture would otherwise
    // freeze the creatures at a different pose — a harness confound, not a bake difference. Read ONCE.
    private static readonly bool FreezeAtSeed =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_SPINE_FREEZE") == "1";

    // On a fresh identity request the layer fetches a cheap 1-frame still first (paints frame 0 in ~0.5-1s),
    // then CHAINS the full animated clip and hot-swaps it in. The swap is seamless — placement is cell-invariant, so
    // still-frame-0 and clip-frame-0 land at the same node-local position.

    // Placement derived from the current clip's header (node-local rect + uniform fit scale).
    private float _localX;
    private float _localY;
    private float _scale = 1f;

    public void Configure(MirrorNode node)
    {
        // Track I defensive self-resume — now CONSULTS the controller. A Configure reaching a still-suspended layer
        // un-freezes ONLY if the controller is NOT frozen (a genuine wake already happened and the sweep missed this
        // layer). If it IS still frozen (a late re-Apply that did not ride a drain), stay frozen — never resume behind
        // the controller's back. Spine is Mark-based (no continuous), so the low-cadence re-sweep re-freezes any
        // latecomer; this just stops a stray re-Configure from un-freezing it early.
        if (_suspended && !IdleSuspend.Suspended)
        {
            Resume();
        }

        _store ??= SpineClipStore.For(this); // self-mount on first use (finds the tree's TextureStore for BaseUrl)

        // Loop flag refreshed every emission — it can flip (looping fallback → real one-shot flag) while the anim
        // NAME is unchanged; advance reads it to choose wrap vs freeze-on-last-frame.
        _looping = node.SpineLooping;
        // Paused flips with the anim NAME unchanged (a freeze/resume), and while paused the streamed track time is
        // authoritative for the shown frame — so refresh both on every emission, like the loop flag above.
        _paused = node.SpinePaused;
        if (_paused)
        {
            _syncTrackMs = Math.Max(0, node.SpineTrackTime * 1000.0);
            _syncWallMs = Time.GetTicksMsec();
            _shownFrame = -1;
        }

        var anim = node.SpineCurrentAnim!;
        var skin = node.SpineSkin;
        var mat = node.SpineMat;
        // #9/#13 SKEL RE-ARM: `skelResPath` is part of the clip identity too. A RUNTIME-injected skeleton (the boss
        // map point, the treasure chest) reports its animation FIRST — the producer learns the clip where the
        // animation is REQUESTED — and its skeleton path only once the late-static re-probe lands. Both
        // requests for that first identity 404 (the scene address has no skeleton offline) and the `&skel=` retry
        // can't fire yet because the path is still null; without this the node then waits for an ANIM change to
        // re-request, so the chest stayed blank until it opened and the map boss never appeared at all.
        var skel = node.SpineSkelResPath;
        // R9 item 10: the still-vs-animated answer is part of the identity too (see _stillOnly) — a Static↔Dynamic
        // flip must re-request the other url even though every streamed field is unchanged.
        bool stillOnly = ClientEffectSettings.SpineStillOnly;
        if (_anim == anim
            && string.Equals(_skin, skin, StringComparison.Ordinal)
            && string.Equals(_mat, mat, StringComparison.Ordinal)
            && string.Equals(_skelResPath, skel, StringComparison.Ordinal)
            && _stillOnly == stillOnly)
        {
            return; // same identity: free-run the clock (no reseed on volatile track-time echoes)
        }

        // Anim (or skin/material/skeleton) switched, or first attach: reseed the clock ONCE from the freshly-arrived
        // authoritative track time, capture the clip-identity fields for the escalation retries, reset the one-shot
        // escalation flags, and pause advancement (freeze the previous clip's last-painted frame) until the new clip
        // arrives. A re-request for an UNCHANGED url is a store cache hit (no network), so the skel/mat re-arm costs
        // nothing for a node that already resolved.
        _anim = anim;
        _skin = skin;
        _mat = mat;
        _scene = node.SpineSceneResPath;
        _nodePath = node.SpineNodePath;
        _skelResPath = skel;
        _stillOnly = stillOnly;
        _retried = false;
        // #13: an address already PROVEN to need `&skel=` (its skeleton is injected at runtime, so the scene-addressed
        // render has nothing to drive) pre-arms the retry, so the very first request carries the skeleton path
        // instead of 404ing twice through the host's single extraction slot first.
        _skelRetried = !string.IsNullOrEmpty(_skelResPath) && SpineClipStore.IsSkelRequired(_scene, _nodePath);
        _stillPainted = false;    // FIX 2b: a new identity re-runs the still→clip chain
        _animatedShown = false;
        _wantStillUrl = null;
        _syncTrackMs = Math.Max(0, node.SpineTrackTime * 1000.0);
        _syncWallMs = Time.GetTicksMsec();
        _awaiting = true;

        RequestClip();
    }

    // Request the clip for the CURRENT identity. FIX 2b: on a FRESH identity request (not a #4 retry=1 / #8 skel
    // escalation) fetch a cheap 1-frame STILL first (paint frame 0 in ~0.5-1s), then CHAIN the full animated clip and
    // hot-swap it in — so a spine shows immediately instead of a ~30-60s black silhouette while the whole clip bakes.
    // The still→clip request is CHAINED, not concurrent (a concurrent clip request would lose the host's single
    // extraction slot behind the long bake).
    private void RequestClip()
    {
        // R9 item 10 Static (_stillOnly): the single still IS the whole clip, so skip the still→animated CHAIN and go
        // straight down the primary request path — which builds a `&still=1` url in this mode and therefore keeps the
        // one-shot #8 skel fallback (a runtime-skeleton address needs `&skel=` even for its still).
        if (!_stillOnly && !_retried && !_skelRetried && _store is not null)
        {
            _wantStillUrl = SpineClipStore.BuildClipUrl(_scene, _nodePath, _anim, _skin, null, retry: false, still: true, mat: _mat);
            if (_wantStillUrl is not null)
            {
                var capturedStill = _wantStillUrl;
                var cachedStill = _store.Request(
                    capturedStill,
                    loaded => OnStillArrived(capturedStill, loaded),
                    () => OnStillFailed(capturedStill));
                if (cachedStill is not null)
                {
                    OnStillArrived(capturedStill, cachedStill); // synchronous cache hit
                }

                return;
            }
        }

        RequestAnimatedClip();
    }

    // (Re)request the PRIMARY clip for the CURRENT identity + escalation state. Reused for the chained first fetch and
    // both one-shot escalations (#4 retry=1, #8 skel), so _wantUrl always reflects the url whose arrival/failure we're
    // waiting on. R9 item 10: in Static (_stillOnly) the primary clip IS a single still frame — the `&still=1` url is
    // requested here (not through the still→animated chain), so the escalation/retry bookkeeping below covers it too.
    private void RequestAnimatedClip()
    {
        _wantUrl = SpineClipStore.BuildClipUrl(
            _scene, _nodePath, _anim, _skin,
            _skelRetried ? _skelResPath : null,
            _retried,
            still: _stillOnly,
            mat: _mat);
        if (_wantUrl is null || _store is null)
        {
            return;
        }

        var captured = _wantUrl;
        var cached = _store.Request(captured, loaded => OnClipArrived(captured, loaded), () => OnClipFailed(captured));
        if (cached is not null)
        {
            OnClipArrived(captured, cached); // synchronous cache hit (Request doesn't fire onReady for a hit)
        }
    }

    // FIX 2b: paint the cheap 1-frame STILL, then chain the full animated clip. NO #4 single-frame escalation (that
    // guards only the animated fetch — a 1-frame still is legitimate). Dropped if the identity switched away
    // (url != _wantStillUrl) or the animated clip already swapped in (a late still must NOT clobber it).
    private void OnStillArrived(string url, SpineClipStore.LoadedClip loaded)
    {
        if (!GodotObject.IsInstanceValid(this) || url != _wantStillUrl || _animatedShown)
        {
            return;
        }

        _clip = loaded;
        _awaiting = false;

        var clip = loaded.Clip;
        _scale = clip.CanvasWidth > 0 ? clip.LocalWidth / clip.CanvasWidth : 1f;
        _localX = clip.LocalX;
        _localY = clip.LocalY;
        _shownFrame = -1;         // force a repaint at the still's placement
        _stillPainted = true;

        Advance(); // paint frame 0 immediately — no black silhouette

        // FIX 2b verify hook: the `SPINE:` line the cold-cache verification greps to prove first-frame-immediate — the
        // still resolves (with a concrete node-local placement) BEFORE the animated clip's own "SPINE: clip loaded".
        GD.Print($"SPINE: still painted {url} local=({_localX:F0},{_localY:F0},{clip.LocalWidth:F0},{clip.LocalHeight:F0}) stillPainted={_stillPainted}");

        // Chain the full animated clip now that the still settled (queues behind the single extraction slot).
        RequestAnimatedClip();
    }

    // FIX 2b: the still fetch/decode failed → go straight to the animated fetch (no worse than pre-fix; the node just
    // stays blank until the clip arrives, exactly as before still-first).
    private void OnStillFailed(string url)
    {
        if (!GodotObject.IsInstanceValid(this) || url != _wantStillUrl || _animatedShown)
        {
            return;
        }

        RequestAnimatedClip();
    }

    private void OnClipArrived(string url, SpineClipStore.LoadedClip loaded)
    {
        // Drop a stale result: the identity changed (so _wantUrl changed) while this was loading.
        if (!GodotObject.IsInstanceValid(this) || url != _wantUrl)
        {
            return;
        }

        // #4 one-shot escalation: a clip that came back with a SINGLE frame is the producer's old oversized-budget
        // collapse (or a stale immutable disk blob) — a real baked clip always carries the duplicate tail frame, so
        // FrameCount==1 is never a legitimate anim. Delete the client disk-cache entry and refetch ONCE with &retry=1 (a
        // distinct key → a fresh render with the downscale-instead-of-collapse bake). Bounded via _escalatedV.
        // #14 EXCEPTION: a host-DEGRADED response is a deliberate single frame served because the machine is
        // oversubscribed — re-asking for the bake there would storm the host exactly when it declined the work.
        // Paint the stand-in and stop; the store cached nothing, so the next identity switch re-asks for the real
        // clip. Decision lives in the shared SpineClipEscalation (web twin: mirrorRenderer's inline guard).
        if (SpineClipEscalation.ShouldEscalateSingleFrame(
                loaded.Clip.FrameCount,
                alreadyEscalated: _retried,
                // A still-FIRST placeholder arrives through OnStillArrived, never here — but R9's Static mode
                // requests its `&still=1` clip down THIS path, and a 1-frame result is exactly what it asked for.
                stillRequest: _stillOnly,
                degraded: loaded.Temporary))
        {
            _retried = true;
            AssetDiskCache.Shared?.DeleteEntry(url);
            RequestAnimatedClip();
            return;
        }

        _clip = loaded;
        _awaiting = false;
        _animatedShown = true; // FIX 2b: the animated clip has swapped in — a late still can no longer clobber it

        var clip = loaded.Clip;
        _scale = clip.CanvasWidth > 0 ? clip.LocalWidth / clip.CanvasWidth : 1f;
        _localX = clip.LocalX;
        _localY = clip.LocalY;
        _shownFrame = -1; // force a repaint at the freshly-computed placement (also over a still-first frame 0)

        Advance(); // paint the first frame immediately — no blank gap
    }

    // #8 one-shot skel fallback: a permanent fetch/decode failure when the producer supplied a skeleton res-path →
    // retry ONCE with &skel=<res-path> (a distinct key → the extractor bakes straight from the skeleton, covering a
    // dynamically-added SpineSprite whose scene lookup misses on the offline extract). Bounded via _skelRetried; when
    // no retry is left the layer just keeps showing the previous clip's last frame (the existing freeze behavior).
    private void OnClipFailed(string url)
    {
        if (!GodotObject.IsInstanceValid(this) || url != _wantUrl)
        {
            return;
        }

        if (!_skelRetried && !string.IsNullOrEmpty(_skelResPath))
        {
            _skelRetried = true;
            // Remember the address so a later identity (the chest's open animation, a re-entered map) requests the
            // working `&skel=` url first time. Marked on the RETRY, not on its success: the scene lane has already
            // permanently failed for this address, which is exactly what the memo records.
            SpineClipStore.MarkSkelRequired(_scene, _nodePath);
            RequestAnimatedClip();
        }
    }

    public override void _Process(double delta)
    {
        // R9 item 10 Static: the single still frame is painted once on arrival (OnClipArrived → Advance) and there is
        // nothing to advance to — so skip the per-frame clock read entirely rather than re-resolving frame 0 forever.
        if (_stillOnly)
        {
            return;
        }

        Advance();
    }

    // Track I: freeze the clip on its current frame (idle-suspend sweep). Capture the extrapolated play time and stop
    // _Process so the wall-clock clip stops advancing (ContinuousCount is unaffected — spine Marks per frame change,
    // and those Marks now stop). Idempotent.
    public void Suspend()
    {
        if (_suspended)
        {
            return;
        }

        _suspendedPlayMs = (_clip is not null && !_awaiting)
            ? _syncTrackMs + ((double)Time.GetTicksMsec() - _syncWallMs)
            : _syncTrackMs;
        _frozenFrame = (_clip is not null && !_awaiting) ? _clip.Clip.FrameIndexAt(_suspendedPlayMs, _looping) : _shownFrame;
        SetProcess(false);
        _suspended = true;
        GD.Print($"M3_IDLE_SPINE: frozen anim={_anim ?? "<none>"} playMs={_suspendedPlayMs:0.0} frame={_frozenFrame}");
    }

    // Track I: resume from a frozen clip. RE-ANCHOR the clock to the captured play time so the very next Advance draws
    // the SAME frame it froze on (no phase jump); the DEBUG proof (asserted in Advance) confirms first-drawn==frozen.
    public void Resume()
    {
        if (!_suspended)
        {
            return;
        }

        _syncTrackMs = _suspendedPlayMs;
        _syncWallMs = Time.GetTicksMsec();
        _suspended = false;
        SetProcess(true);
        GD.Print($"M3_IDLE_SPINE: resumed re-anchor anim={_anim ?? "<none>"} playMs={_suspendedPlayMs:0.0} frozenFrame={_frozenFrame}");

        // Re-anchor proof: with the anchor just set (delta≈0) the frame index resolves to EXACTLY the frozen frame —
        // no phase jump (without the re-anchor it would jump ahead by the whole suspended duration). Verified inline
        // (only when a clip is loaded) so a clip still loading at resume never trips a spurious assert.
        if (_clip is not null && !_awaiting)
        {
            int first = _clip.Clip.FrameIndexAt(_syncTrackMs + ((double)Time.GetTicksMsec() - _syncWallMs), _looping);
            bool match = first == _frozenFrame;
            GD.Print($"M3_IDLE_SPINE: first-drawn frame={first} frozenFrame={_frozenFrame} match={match}");
            System.Diagnostics.Debug.Assert(match, "spine idle-resume re-anchor: first drawn frame != frozen frame");
        }

        // Paint the frozen frame now so the first VISIBLE frame after resume is the frozen frame; subsequent _Process
        // Advances carry the clip forward naturally off the wall clock.
        Advance();
    }

    // Pick the frame covering the extrapolated play time; redraw only when the index actually changes. Frozen
    // (returns early) when no clip is drawn yet or a new anim's clip is still loading.
    private void Advance()
    {
        if (_clip is null || _awaiting)
        {
            return;
        }

        // A PAUSED track (#13) holds the last streamed authoritative track time: the game froze it
        // (MegaAnimationState.SetTimeScale(0) — the closed treasure chest), so free-running the clip off the wall
        // clock would walk the chest open and then into its queued "shine_fade" glow.
        double playMs = FreezeAtSeed || _paused
            ? _syncTrackMs
            : _syncTrackMs + ((double)Time.GetTicksMsec() - _syncWallMs);
        int index = _clip.Clip.FrameIndexAt(playMs, _looping);
        if (index != _shownFrame)
        {
            _shownFrame = index;
            RenderActivity.Mark(); // a looping/one-shot spine clip advanced a frame — Mark keeps the stage alive while it plays; a finished/paused clip stops marking and lets it idle
            QueueRedraw();
        }
    }

    public override void _Draw()
    {
        if (_clip is null || _shownFrame < 0 || _shownFrame >= _clip.Frames.Length)
        {
            return;
        }

        var tex = _clip.Frames[_shownFrame];
        if (tex is null)
        {
            return; // this frame's PNG failed to decode — skip (a neighboring frame still paints)
        }

        var frame = _clip.Clip.Frames[_shownFrame];
        // Map canvas-pixel space → node-local: translate(localX, localY) · scale(fit). DrawTexture then places the
        // tight-cropped frame at its (offsetX, offsetY) within that canvas space (frame tex IS its natural size).
        DrawSetTransform(new Vector2(_localX, _localY), 0f, new Vector2(_scale, _scale));
        DrawTexture(tex, new Vector2(frame.OffsetX, frame.OffsetY));
    }
}
