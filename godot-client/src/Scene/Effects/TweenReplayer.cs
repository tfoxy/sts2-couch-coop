// M1d effect seam — TWEEN replayer (WS-J). SceneReconciler.OnDrained calls Consume AFTER the views for this drain
// exist/updated (web order), handing it the drain's accumulated MirrorTweenHints. This ports the web declarative
// tween arm (mirrorRenderer.ts applyTweenHints L2771-2874 + tickTweens L2882-2921) onto REAL Godot tweens:
//
//   * Channel per hint (keyed off the ENDPOINT present, NOT the property string — the web `hasTransform`/`hasOpacity`
//     gates): a 6-tuple EndTransform → the Transform channel (built like SceneReconciler.WireXform, used DIRECTLY as
//     the view's end local Transform2D — Godot's tree nesting rides descendants for free); an EndOpacity → the
//     ModulateA channel, or SelfModulateA when the raw property is self_modulate:a/self_modulate (the web `isSelf`).
//   * Supersede: a registry keyed (targetId, channel); a new hint on the same key KILLS the prior Godot Tween and
//     replaces it (web supersede — Kill does not fire Finished, so ownership carries straight into the replacement).
//   * The matching MirrorNodeView ownership flag is set BEFORE the tween starts (after BeginTween(channel) snapshots
//     the channel's pre-arm streamed truth); on Finished the view SettleTween(channel, rawEnd)s — adopting the
//     hint's own (unfolded) endpoint into streamed truth when the producer suppressed this channel's deltas for the
//     whole tween (the common case), or keeping whatever fresh delta already landed otherwise (WS-T1; see SettleTween
//     doc in MirrorNodeView.cs) — and the entry is pruned. Dead entries (tween freed with its bound node) are pruned
//     by IsInstanceValid each Consume.
//   * SetTrans/SetEase only when the wire names parse to a Godot enum; absent/unparsable → Godot's default
//     TRANS_LINEAR/EASE_IN_OUT, which equal the game's tween defaults. When the hint carries a StartTransform/
//     StartOpacity (WS-ANIM: an explicit `.From(...)` OR the producer's implicit pre-tween sample), the property is
//     PRIMED to that start at arm time AND `.From(start)` is set — so a slow client that folded the near-final value in
//     never flashes it for a frame before the tween plays. No start → no prime, no `.From` (backward-compatible).
//     `Group` is ignored (the web never branches on it).
//
// InstantTweens (deterministic --replay single-shot): skipped entirely — the streamed values already hold the
// endpoints, so the final-state shot renders with no in-flight animation and stays pixel-identical.

using System;
using System.Collections.Generic;
using CouchCoop.GodotClient.Scene;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Effects;

public static class TweenReplayer
{
    // Registry key: one active declarative tween per (target node id, tween channel). The two channels of one node
    // are independent (a fade may outlast a move), exactly like the web's per-channel `tweenTransformUntil` /
    // `tweenOpacityUntil`.
    private readonly struct Key : IEquatable<Key>
    {
        public readonly string TargetId;
        public readonly MirrorNodeView.TweenChannel Channel;

        public Key(string targetId, MirrorNodeView.TweenChannel channel)
        {
            TargetId = targetId;
            Channel = channel;
        }

        public bool Equals(Key other) =>
            Channel == other.Channel && string.Equals(TargetId, other.TargetId, StringComparison.Ordinal);

        public override bool Equals(object? obj) => obj is Key k && Equals(k);

        public override int GetHashCode() => HashCode.Combine(TargetId, (int)Channel);
    }

    // WS-B pooled arm handler: one allocated-once Action per pool entry — the entry object IS the Finished handler
    // target, its fields re-homing what the old per-arm closure captured (this kills the display class + delegate
    // + capture allocations per armed tween; Godot's signal `+=` interop may still allocate a little — measured,
    // not assumed). Recycled at ALL FOUR Active-removal sites: supersede-kill (Arm), Finished (OnTweenFinished),
    // RemoveChannel, PruneDead. Staleness: OnTweenFinished guards with ReferenceEquals(Active[key], entry) — the
    // pooled equivalent of the old `current == capturedTween` — and every kill-path recycle DISCONNECTS the
    // handler from its still-valid tween first, so an emission from a prior tenure can never reach a recycled
    // entry (PruneDead's tween is already freed, its connections died with it).
    private sealed class ArmedTween
    {
        public readonly Action OnFinished; // allocated ONCE per pool entry, reused across arms forever
        public Key Key;
        public Tween Tween = null!;
        public MirrorNodeView View = null!;
        public MirrorNodeView.TweenChannel Channel;
        public Variant RawEnd;

        public ArmedTween()
        {
            OnFinished = HandleFinished;
        }

        private void HandleFinished() => OnTweenFinished(this);
    }

    private static readonly Dictionary<Key, ArmedTween> Active = new();
    private static readonly Stack<ArmedTween> HandlerPool = new();

    private static ArmedTween RentEntry() => HandlerPool.Count > 0 ? HandlerPool.Pop() : new ArmedTween();

    // Return an entry to the pool, dropping its object refs (pool entries must never pin views/tweens/Variants).
    private static void Recycle(ArmedTween entry)
    {
        entry.Tween = null!;
        entry.View = null!;
        entry.RawEnd = default;
        HandlerPool.Push(entry);
    }

    // Kill-path release (supersede / RemoveChannel): sever the Finished connection while the tween is still valid —
    // so a stale emission can NEVER reach the recycled entry — then kill it (Kill() does not fire Finished) and
    // pool the entry. An already-freed tween skips both (its connections died with it).
    private static void DisconnectKillAndRecycle(ArmedTween entry)
    {
        if (GodotObject.IsInstanceValid(entry.Tween))
        {
            entry.Tween.Finished -= entry.OnFinished;
            entry.Tween.Kill();
        }

        Recycle(entry);
    }

    // ---- Feature B: tween HIDE-LATCH ------------------------------------------------------------------------------
    // The registry tracks which (id, opacity-channel) pairs
    // currently hold a latch so the sweep can expire stale ones on drain starvation and teardown can clear them all;
    // the latch STATE (resting signature + arm clock) lives on the MirrorNodeView.

    private static readonly Dictionary<Key, MirrorNodeView> HideLatched = new();

    // ---- Feature B: independent flash-detector probe (COUCHCOOP_MIRROR_HIDELATCH_PROBE=1) --------------------------
    // Detects the raw defect signature — a node whose RENDERED alpha (Modulate.A) goes ≈0 → resting (a reappear) and
    // then hides / is removed within ≤3 drains — INDEPENDENTLY of the latch, by sampling live views per drain. With the
    // latch on the reappear is clamped away (0 flashes); with it off the flashes surface. Off → zero cost.
    private const float ProbeReappearThreshold = 0.5f; // a clearly-visible reappear (the resting flash), not fade noise
    private struct ProbeEntry
    {
        public bool Init;         // this id has been sampled at least once (LastAlpha is valid)
        public float LastAlpha;
        public bool EverVisible;  // reached ≥ threshold at some drain (had a real on-screen presence)
        public bool Faded;        // after being visible, its OWN alpha dropped to ≈0 (a real fade-out — the flash setup)
        public int ReappearDrain; // 0 = not armed
    }

    private static readonly Dictionary<string, ProbeEntry> Probe = new(StringComparer.Ordinal);
    private static int _probeDrain;
    public static int ProbeFlashCount { get; private set; }

    // On-demand rendering (RenderActivity): a declarative tween animates transform/modulate:a through a REAL Godot
    // Tween with NO per-frame C# callback, so the render-activity oracle can't Mark it each tick — instead AppShell
    // treats ActiveCount > 0 as a force-alive source. Prune-on-read (cheap — called once/frame from AppShell) drops
    // tweens freed with their node; briefly over-counting a stale entry is harmless (false-alive is safe, false-idle
    // is the bug).
    public static int ActiveCount
    {
        get
        {
            PruneDead();
            return Active.Count;
        }
    }

    // CULL: how many nodes currently own an ACTIVE transform tween (a live Transform-channel entry). The cull pass
    // treats such nodes as bounds-uncertain (their streamed transform is pinned at the pre-tween value while the Godot
    // tween animates the VISIBLE transform elsewhere), so an offscreen decision derived from the streamed global would
    // be wrong. Near-zero at steady state; EMPTY during map scroll (streamed deltas, no client tweens) and under
    // InstantTweens (the deterministic replay path never arms a tween). Add each live Transform entry's target id to
    // `into`; a superseded/settled/released tween has already dropped its entry, so membership tracks ownership.
    public static void CollectTransformOwned(ISet<string> into)
    {
        if (Active.Count == 0)
        {
            return;
        }

        foreach (var (key, entry) in Active)
        {
            if (key.Channel == MirrorNodeView.TweenChannel.Transform && GodotObject.IsInstanceValid(entry.Tween))
            {
                into.Add(key.TargetId);
            }
        }
    }

    // WS-SHOP (round 6): the END LOCAL transform (raw 6-tuple wire affine [a,b,c,d,tx,ty]) of the ACTIVE transform
    // tween on `id`, if one is armed. ViewScaler measures a group being slid on-screen at this endpoint on a later
    // drain (the tween already owns it, so the arm-drain endpoint stamp missed). RawEnd is the UNFOLDED end local
    // (Variant.From(WireXform(endT)) — see Consume) → decompose back to a 6-tuple. Empty at steady state (near-free).
    public static bool TryGetTransformEndpointLocal(string id, out IReadOnlyList<double>? endpointLocal)
    {
        endpointLocal = null;
        if (Active.Count == 0)
        {
            return false;
        }

        var key = new Key(id, MirrorNodeView.TweenChannel.Transform);
        if (!Active.TryGetValue(key, out var entry) || !GodotObject.IsInstanceValid(entry.Tween))
        {
            return false;
        }

        var t = entry.RawEnd.AsTransform2D();
        endpointLocal = new double[] { t.X.X, t.X.Y, t.Y.X, t.Y.Y, t.Origin.X, t.Origin.Y };
        return true;
    }

    // R8 (WS-2): the round-6 view-scale settle backstop (a one-shot "run ViewScaler.Apply again next frame" request
    // raised when a TRANSFORM tween finished) is GONE. It existed only because the old stateful pass could DEFER a
    // stamp at a screen-entry transition; the pure per-drain ViewScaleStampIndex never defers — a tween-owned node
    // folds its scale through FoldCosmetic like any other transform — so there is nothing left to back-stop.

    // WS-CRISP R17: a real reveal (fade-IN) has an endpoint alpha above this; a fade-OUT / hide settles below it and
    // must NOT feed the text-overlay eligibility override (its endpoint is the hidden state, so the label should stay
    // rejected).
    public const double FadeInEndpointMin = 0.05;

    // WS-CRISP R17: for every node with an ACTIVE modulate:a (ModulateA) tween whose raw endpoint alpha exceeds
    // FadeInEndpointMin — i.e. a fade-IN in flight — record `id → endpoint`. The producer pins the streamed modulate
    // at the pre-tween ≈0 for the tween's whole duration, so the TextOverlay eligibility's Invisible check reads ≈0
    // and rejects a label under a fading-in chain until settle; feeding the endpoint (via EffectiveModulate's fade-in
    // override) promotes it at the START of the reveal. ONLY the ModulateA channel: EffectiveModulate composes Godot
    // Modulate, never SelfModulate, so a SelfModulateA endpoint would be wrongly applied as a modulate alpha. One
    // active tween per (id, channel), so a plain overwrite is correct (no max needed). Empty at steady state.
    public static void CollectFadeInEndpoints(IDictionary<string, double> into)
    {
        if (Active.Count == 0)
        {
            return;
        }

        foreach (var (key, entry) in Active)
        {
            if (key.Channel != MirrorNodeView.TweenChannel.ModulateA || !GodotObject.IsInstanceValid(entry.Tween))
            {
                continue;
            }

            double endpoint = entry.RawEnd.AsDouble();
            if (endpoint > FadeInEndpointMin)
            {
                into[key.TargetId] = endpoint;
            }
        }
    }

    public static void Consume(
        IReadOnlyList<MirrorTweenHint> hints,
        IReadOnlyDictionary<string, MirrorNodeView> views,
        RenderContext ctx)
    {
        // Deterministic single-shot: never animate. Streamed values already hold the endpoints (that is WHY the
        // final-state replay shot is correct with no in-flight tween), so replay stays byte-identical.
        if (ctx.Options.InstantTweens)
        {
            return;
        }

        // Drop entries whose tween was freed with its bound node (a removed target). IsInstanceValid short-circuits
        // before touching the freed instance.
        PruneDead();

        if (hints.Count == 0)
        {
            return;
        }

        foreach (var hint in hints)
        {
            if (hint.DurationMs <= 0)
            {
                continue;
            }

            if (!views.TryGetValue(hint.TargetId, out var view) || !GodotObject.IsInstanceValid(view))
            {
                continue; // one-shot: a hint whose node isn't (yet) mirrored is dropped (web drops it too)
            }

            // TRANSFORM channel — keyed off a usable 6-tuple endpoint (the web `hasTransform`). EndTransform is the
            // END LOCAL transform; build it exactly like SceneReconciler.WireXform and use it as the view's end
            // Transform. `.From` only when a StartTransform was declared.
            if (hint.EndTransform is { Count: 6 } endT)
            {
                // Fold the wide-screen spread + cosmetic offsets into the endpoints (MirrorNodeView.FoldForTween) so a
                // widened-stage tween animates to the SHIFTED resting placement, not the un-shifted wire endpoint (it
                // would otherwise snap on finish). Identity at F=1 with no cosmetic offset → byte-identical replay.
                // rawEnd is the UNFOLDED endpoint (pre-FoldForTween) — SettleTween adopts THIS into streamed truth on
                // finish, not the folded `end`, so a settle re-fold picks up whatever cosmetic offset is current then.
                Transform2D endLocal = WireXform(endT);
                Variant rawEnd = Variant.From(endLocal);
                Variant end = Variant.From(view.FoldForTween(endLocal));
                bool hasStart = hint.StartTransform is { Count: 6 };
                Variant start = hasStart ? Variant.From(view.FoldForTween(WireXform(hint.StartTransform!))) : default;
                Arm(view, MirrorNodeView.TweenChannel.Transform, "transform", end, rawEnd, start, hasStart, hint);
            }

            // OPACITY channel — keyed off EndOpacity (the web `hasOpacity`). self_modulate:a/self_modulate → the
            // SelfModulateA channel (raw self_modulate:a property), else the ModulateA channel (raw modulate:a). No
            // rgb folding: the ownership flag preserves streamed rgb while the tween owns the alpha.
            if (hint.EndOpacity is { } endOpacity)
            {
                bool isSelf = hint.Property is "self_modulate:a" or "self_modulate";
                var channel = isSelf
                    ? MirrorNodeView.TweenChannel.SelfModulateA
                    : MirrorNodeView.TweenChannel.ModulateA;
                string path = isSelf ? "self_modulate:a" : "modulate:a";
                bool hasStart = hint.StartOpacity is not null;
                // Opacity is never folded (FoldForTween only applies to the transform channel), so the raw endpoint
                // IS the wire endpoint — rawEnd and end carry the same value.
                Variant end = OpacityVariant(endOpacity);
                Variant rawEnd = end;
                Variant start = hasStart ? OpacityVariant(hint.StartOpacity!.Value) : default;
                Arm(view, channel, path, end, rawEnd, start, hasStart, hint);
            }
        }
    }

    // WS-B: the ubiquitous opacity endpoints 0.0/1.0 as build-once Variants (a double Variant is a plain value, so
    // sharing copies is safe); every other opacity value still boxes per hint. Transform2D endpoints are per-hint
    // values and stay un-cached deliberately.
    private static readonly Variant OpacityZero = Variant.From(0.0);
    private static readonly Variant OpacityOne = Variant.From(1.0);

    private static Variant OpacityVariant(double v) =>
        v == 0.0 ? OpacityZero : v == 1.0 ? OpacityOne : Variant.From(v);

    // Arm (or supersede) the declarative tween on one (view, channel): kill any running tween on the key, snapshot +
    // take the channel's ownership flag, start a real Godot tween to the endpoint, and settle streamed truth on
    // Finished. `rawEnd` is the hint's UNFOLDED endpoint (pre-FoldForTween) that SettleTween needs — see its doc.
    private static void Arm(
        MirrorNodeView view,
        MirrorNodeView.TweenChannel channel,
        string property,
        Variant end,
        Variant rawEnd,
        Variant start,
        bool hasStart,
        MirrorTweenHint hint)
    {
        var key = new Key(view.NodeId, channel);

        // #7 instrumentation (COUCHCOOP_MIRROR_TWEEN_DEBUG=1): trace the arm — target, channel, duration, and the
        // decomposed start/end SCALE for a transform channel (the death-shrink suspect). No behavior change.
        if (TweenDebugSettings.Enabled)
        {
            string scaleTrace = string.Empty;
            if (channel == MirrorNodeView.TweenChannel.Transform)
            {
                var endScale = end.AsTransform2D().Scale;
                scaleTrace = hasStart
                    ? $" startScale=({start.AsTransform2D().Scale.X:0.###},{start.AsTransform2D().Scale.Y:0.###}) endScale=({endScale.X:0.###},{endScale.Y:0.###})"
                    : $" endScale=({endScale.X:0.###},{endScale.Y:0.###})";
            }

            GD.Print($"TWEEN_DEBUG: arm target={view.NodeId} channel={channel} durationMs={hint.DurationMs:0.#}{scaleTrace}");
        }

        // Feature B: a fresh tween arming on this (id, channel) is a genuine re-animation — supersede any hide-latch
        // that a prior fade left on the SAME channel (a real re-show must not be clamped to the hidden state).
        CancelHideLatch(key, view);

        // Supersede: a new hint on the same key kills the prior tween (web supersede). Kill() does NOT emit Finished,
        // so we do not settle here — the replacement re-snapshots (BeginTween below) and keeps ownership continuously.
        // WS-B: the prior entry is disconnected + recycled (recycle site 1 of 4; Active[key] is overwritten below).
        if (Active.TryGetValue(key, out var prior))
        {
            DisconnectKillAndRecycle(prior);
        }

        // Snapshot the channel's pre-arm streamed truth, THEN take ownership before the tween starts so the next
        // Apply stops stomping the tweened channel. Order matters: BeginTween must read StreamedLocal/Modulate
        // before anything else could touch it this frame.
        view.BeginTween(channel);
        SetOwnership(view, channel, true);

        // PRIME (WS-ANIM): when a start is declared, set the VISIBLE property to it NOW. `.From(start)` below only sets
        // the Godot tween's internal start — the property itself isn't written until the tween's first PROCESS step next
        // frame, so a frame that already stomped in the near-final streamed value (a slow client folds the node-create +
        // settle + hint into ONE message) would FLASH that near-final value for one frame before the tween snaps back to
        // `start`. Priming kills the flash and makes the replay latency-proof. It writes ONLY the Godot base prop, never
        // the Streamed* records — so BeginTween's arm-time snapshot (taken just above) and SettleTween's endpoint
        // adoption are unaffected regardless of order. No start declared → no prime (backward-compatible: old-mod hints
        // without a start behave exactly as before).
        if (hasStart)
        {
            Prime(view, channel, start);
        }

        var tween = view.CreateTween();
        var tweener = tween.TweenProperty(view, property, end, hint.DurationMs / 1000.0);
        if (hasStart)
        {
            tweener.From(start);
        }

        if (hint.Trans is { } trans && Enum.TryParse<Tween.TransitionType>(trans, ignoreCase: true, out var transType))
        {
            tweener.SetTrans(transType);
        }

        if (hint.Ease is { } ease && Enum.TryParse<Tween.EaseType>(ease, ignoreCase: true, out var easeType))
        {
            tweener.SetEase(easeType);
        }

        // WS-B: rent a pooled handler entry (no closure, no per-arm delegate), re-home the old captures, register.
        var entry = RentEntry();
        entry.Key = key;
        entry.Tween = tween;
        entry.View = view;
        entry.Channel = channel;
        entry.RawEnd = rawEnd;
        tween.Finished += entry.OnFinished;
        Active[key] = entry;
    }

    // The pooled Finished handler body — an EXACT port of the old per-arm closure (hide-latch / settle semantics
    // verbatim; `entry.*` re-homes the captures). Recycle site 2 of 4.
    private static void OnTweenFinished(ArmedTween entry)
    {
        // Only settle if THIS entry is still the owner (a later hint may have superseded it — its Kill()ed tween
        // never reaches here, but guard against any stale emission). Reference equality on the pooled entry is the
        // staleness guard: a recycled handler firing late (precluded by the kill-path disconnects, but guarded
        // anyway) is a no-op unless this exact entry still owns its key.
        if (!Active.TryGetValue(entry.Key, out var current) || !ReferenceEquals(current, entry))
        {
            return;
        }

        Active.Remove(entry.Key);
        var key = entry.Key;
        var view = entry.View;
        var channel = entry.Channel;
        var rawEnd = entry.RawEnd;
        Recycle(entry); // safe here: everything below reads the locals, and this emission was the entry's last

        if (GodotObject.IsInstanceValid(view))
        {
            // Feature B: a fade that settled to ≈0 is exactly the reappear-flash setup — arm the hide-latch
            // BEFORE SettleTween writes (closing the raced-restore hole documented below), so the latch is live
            // when SettleTween's own settle write and the producer's later resting-alpha upsert land.
            if (IsOpacityChannel(channel) && rawEnd.AsDouble() <= HideLatchPolicy.AlphaEps
                && view.TryArmHideLatch(channel))
            {
                HideLatched[key] = view;
            }

            // KNOWN RESIDUAL (same hole exists on web): if an unrelated delta for this node lands between this
            // Finished callback and the producer's settle upsert (~1 drain later), that delta still carries the
            // stale doc-side transform/opacity for THIS channel (the producer hasn't caught up yet), and
            // applying it re-stomps the just-settled value for one frame. Feature B's hide-latch closes the
            // OPACITY case of this hole (the resting-alpha reappear flash); the transform case is unchanged.
            view.SettleTween(channel, rawEnd);
        }

    }

    // Prime the channel's VISIBLE property to the tween's START value at ARM time (WS-ANIM). `start` is the SAME folded
    // Variant handed to `.From(start)`: a folded Transform2D for the Transform channel, a double alpha for the modulate
    // channels. The modulate channels preserve the current (streamed) RGB and set only the alpha — matching how Apply
    // writes an owned modulate channel. Writes only the Godot base prop (Transform/Modulate/SelfModulate), never the
    // Streamed* records, so the WS-T1 settle logic is untouched.
    private static void Prime(MirrorNodeView view, MirrorNodeView.TweenChannel channel, Variant start)
    {
        switch (channel)
        {
            case MirrorNodeView.TweenChannel.Transform:
                view.Transform = start.AsTransform2D();
                break;
            case MirrorNodeView.TweenChannel.ModulateA:
                var mod = view.Modulate;
                view.Modulate = new Color(mod.R, mod.G, mod.B, (float)start.AsDouble());
                break;
            case MirrorNodeView.TweenChannel.SelfModulateA:
                var self = view.SelfModulate;
                view.SelfModulate = new Color(self.R, self.G, self.B, (float)start.AsDouble());
                break;
        }
    }

    private static void SetOwnership(MirrorNodeView view, MirrorNodeView.TweenChannel channel, bool owned)
    {
        switch (channel)
        {
            case MirrorNodeView.TweenChannel.Transform:
                view.TweenOwnsTransform = owned;
                break;
            case MirrorNodeView.TweenChannel.ModulateA:
                view.TweenOwnsModulateA = owned;
                break;
            case MirrorNodeView.TweenChannel.SelfModulateA:
                view.TweenOwnsSelfModulateA = owned;
                break;
        }
    }

    // WS-P1 pool linchpin. Called from MirrorNodeView.ResetForPool when a view is recycled: KILL + drop BOTH channel
    // entries bound to this node id. A tween created via view.CreateTween() is BOUND to the view — tree-exit only
    // PAUSES it, so without this the paused tween resumes animating the RECYCLED view when it re-enters the tree, and
    // (crucially) IsInstanceValid pruning no longer catches it (the view is pooled, never freed → the tween stays
    // valid forever). Kill() does not fire Finished, so no stray settle. Idempotent (missing keys are no-ops).
    public static void ReleaseFor(string nodeId)
    {
        RemoveChannel(nodeId, MirrorNodeView.TweenChannel.Transform);
        RemoveChannel(nodeId, MirrorNodeView.TweenChannel.ModulateA);
        RemoveChannel(nodeId, MirrorNodeView.TweenChannel.SelfModulateA);

        // Feature B: drop any hide-latch registry entry for this recycled id (the view's own latch fields reset in
        // ResetForPool). Idempotent — a missing key is a no-op.
        HideLatched.Remove(new Key(nodeId, MirrorNodeView.TweenChannel.ModulateA));
        HideLatched.Remove(new Key(nodeId, MirrorNodeView.TweenChannel.SelfModulateA));
    }

    // ---- Feature B: hide-latch registry + sweep + teardown + probe ------------------------------------------------

    // The write-site helper (MirrorNodeView.LatchedAlpha) observed a cancel/expire and dropped the latch; drop the
    // registry entry to match. Idempotent.
    public static void UnregisterHideLatch(string nodeId, MirrorNodeView.TweenChannel channel) =>
        HideLatched.Remove(new Key(nodeId, channel));

    // A new tween on the SAME channel supersedes the latch (a real re-animation). Drop the view's field + the entry.
    private static void CancelHideLatch(Key key, MirrorNodeView view)
    {
        if (HideLatched.Remove(key))
        {
            view.ForceDropHideLatch(key.Channel);
            if (MirrorNodeView.HideLatchDebug)
            {
                GD.Print($"M1D_HIDELATCH: cancelled(newtween) id={key.TargetId} ch={key.Channel}");
            }
        }
    }

    // Expire stale latches (drain-starvation safety): called from SceneReconciler.OnDrained AFTER Consume and from
    // SceneReconciler._Process every frame. A view whose grace elapsed (or which vanished) is pruned; the view logs
    // "expired" itself. Near-free — the registry is empty at steady state.
    public static void SweepHideLatches()
    {
        if (HideLatched.Count == 0)
        {
            return;
        }

        List<Key>? dead = null;
        foreach (var (key, view) in HideLatched)
        {
            if (!GodotObject.IsInstanceValid(view) || view.SweepHideLatch(key.Channel))
            {
                (dead ??= new List<Key>()).Add(key);
            }
        }

        if (dead is not null)
        {
            foreach (var key in dead)
            {
                HideLatched.Remove(key);
            }
        }
    }

    // Teardown (AppShell.ReturnToMenu): drop every latch registry entry. The views themselves are being freed, so no
    // per-view field clear is needed.
    public static void ClearHideLatches()
    {
        HideLatched.Clear();
        Probe.Clear();
        _probeDrain = 0;
        ProbeFlashCount = 0;
    }

    // Env-gated flash detector (COUCHCOOP_MIRROR_HIDELATCH_PROBE=1). Independently of the latch, sample each live
    // view's RENDERED alpha per drain and log when one went ≈0 → resting (a reappear) and then hides / is removed
    // within ≤3 drains — the 1-frame flash signature. With the latch on the reappear is clamped (0 flashes); with it
    // off the flashes surface. Called at the tail of SceneReconciler.OnDrained.
    public static void ProbeHideLatch(IReadOnlyDictionary<string, MirrorNodeView> views)
    {
        if (!MirrorNodeView.HideLatchDebug)
        {
            return;
        }

        _probeDrain++;
        float eps = (float)HideLatchPolicy.AlphaEps;
        foreach (var (id, view) in views)
        {
            if (!GodotObject.IsInstanceValid(view))
            {
                continue;
            }

            float a = view.Modulate.A;
            bool vis = view.Visible;

            // First sight: seed the history WITHOUT running detection, so a node that is simply CREATED at its resting
            // alpha (0 → resting on its first paint) is not mistaken for a fade-then-reappear flash.
            if (!Probe.TryGetValue(id, out var e) || !e.Init)
            {
                Probe[id] = new ProbeEntry { Init = true, LastAlpha = a, EverVisible = a >= ProbeReappearThreshold };
                continue;
            }

            // An armed reappear that now hides / fades within the window is the 1-frame flash.
            if (e.ReappearDrain > 0)
            {
                int gap = _probeDrain - e.ReappearDrain;
                if (!vis || a <= eps)
                {
                    if (gap <= 3)
                    {
                        ProbeFlashCount++;
                        GD.Print($"M1D_HIDELATCH_PROBE: flash id={id} gap={gap} (fade->reappear->hide)");
                    }

                    e.ReappearDrain = 0;
                    e.Faded = false;
                }
                else if (gap > 3)
                {
                    e.ReappearDrain = 0; // stayed visible past the window → a legit reveal, not a flash
                    e.Faded = false;
                }
            }

            // The flash SETUP: a node that was on-screen and then faded its OWN alpha to ≈0 (the tween settle). Only
            // AFTER that does a jump back to a visible alpha count as a reappear — this filters brand-new appear→remove
            // nodes (which never faded) that would otherwise masquerade as flashes.
            if (e.EverVisible && a <= eps)
            {
                e.Faded = true;
            }

            if (e.ReappearDrain == 0 && e.Faded && e.LastAlpha <= eps && a >= ProbeReappearThreshold && vis)
            {
                e.ReappearDrain = _probeDrain; // faded → reappeared: a candidate flash
            }

            if (a >= ProbeReappearThreshold)
            {
                e.EverVisible = true;
            }

            e.LastAlpha = a;
            Probe[id] = e;
        }

        // A view that VANISHED while a reappear was armed within the window is also a flash (reappeared then removed).
        List<string>? gone = null;
        foreach (var (id, e) in Probe)
        {
            if (!views.ContainsKey(id))
            {
                if (e.ReappearDrain > 0 && (_probeDrain - e.ReappearDrain) <= 3)
                {
                    ProbeFlashCount++;
                    GD.Print($"M1D_HIDELATCH_PROBE: flash id={id} gap={_probeDrain - e.ReappearDrain} (reappear->removed)");
                }

                (gone ??= new List<string>()).Add(id);
            }
        }

        if (gone is not null)
        {
            foreach (var id in gone)
            {
                Probe.Remove(id);
            }
        }
    }

    private static bool IsOpacityChannel(MirrorNodeView.TweenChannel channel) =>
        channel is MirrorNodeView.TweenChannel.ModulateA or MirrorNodeView.TweenChannel.SelfModulateA;

    private static void RemoveChannel(string nodeId, MirrorNodeView.TweenChannel channel)
    {
        var key = new Key(nodeId, channel);
        if (Active.Remove(key, out var entry))
        {
            DisconnectKillAndRecycle(entry); // WS-B recycle site 3 of 4 (kill-path: sever Finished first)
        }
    }

    private static void PruneDead()
    {
        if (Active.Count == 0)
        {
            return;
        }

        List<Key>? dead = null;
        foreach (var (key, entry) in Active)
        {
            if (!GodotObject.IsInstanceValid(entry.Tween))
            {
                (dead ??= new List<Key>()).Add(key);
            }
        }

        if (dead is not null)
        {
            foreach (var key in dead)
            {
                // WS-B recycle site 4 of 4: the tween was freed with its node, so its signal connections died
                // with it — the entry recycles without a disconnect.
                if (Active.Remove(key, out var entry))
                {
                    Recycle(entry);
                }
            }
        }
    }

    // Wire CSS matrix [a,b,c,d,tx,ty] → Godot Transform2D — identical mapping to SceneReconciler.WireXform.
    private static Transform2D WireXform(IReadOnlyList<double> m) =>
        new((float)m[0], (float)m[1], (float)m[2], (float)m[3], (float)m[4], (float)m[5]);
}
