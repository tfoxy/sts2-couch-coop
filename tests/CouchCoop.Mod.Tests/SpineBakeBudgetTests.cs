using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

// Round-8 item 14 — the host-side Spine bake budget. Pure policy only (no Godot, no IO): the instance count, the
// degrade decision it feeds, and the still-key derivation that makes a degraded answer land on (and populate) the
// ordinary still cache entry instead of poisoning the full-clip one.
internal static class SpineBakeBudgetTests
{
    public static void Run()
    {
        CountsHostPlusLiveSeats();
        CountsHeadlessSlotAsALowerBound();
        DegradesOnlyAtOrAboveTheLimit();
        ResolvesTheLimitFromTheEnvOverride();
        DerivesTheStillKeyForADegradedAnswer();
        NeverDegradesAStillRequest();
    }

    private static MirrorSeatDescription Seat(ulong netId, bool live) => new(netId, null, live, false);

    // The HOST owns the seat table: itself plus every seat whose headless PROCESS is up. A claimed-but-dead seat is
    // not an instance (it consumes no CPU), so it must not push the budget toward degradation.
    private static void CountsHostPlusLiveSeats()
    {
        Assert(SpineBakeBudget.CountGameInstances([], null) == 1, "no seats ⇒ the host alone");
        Assert(
            SpineBakeBudget.CountGameInstances([Seat(2, true), Seat(3, true), Seat(4, true)], null) == 4,
            "host + 3 live headless seats = 4 instances");
        Assert(
            SpineBakeBudget.CountGameInstances([Seat(2, true), Seat(3, false), Seat(4, false)], null) == 2,
            "a seat whose process is gone is not an instance");
    }

    // A spawned HEADLESS client has no seat table of its own; slots are handed out lowest-free-first from 2..4, so
    // "I am slot N" means at least N instances exist (host + N-1 seats).
    private static void CountsHeadlessSlotAsALowerBound()
    {
        Assert(SpineBakeBudget.CountGameInstances(null, "2") == 2, "headless slot 2 ⇒ >= 2 instances");
        Assert(SpineBakeBudget.CountGameInstances(null, "4") == 4, "headless slot 4 ⇒ >= 4 instances");
        Assert(SpineBakeBudget.CountGameInstances(null, null) == 1, "no table and no slot ⇒ assume a lone instance");
        Assert(SpineBakeBudget.CountGameInstances(null, "garbage") == 1, "an unparsable slot degrades to 1, never throws");
        Assert(SpineBakeBudget.CountGameInstances(null, "0") == 1, "a nonsense slot never reports fewer than 1");
    }

    // The approved rule: one game instance per core is the point where a full bake would come out of the games'
    // frame budget. Sampled per request, so it is a pure comparison with no hysteresis.
    private static void DegradesOnlyAtOrAboveTheLimit()
    {
        Assert(!SpineBakeBudget.ShouldDegrade(1, 4), "a lone host bakes normally");
        Assert(!SpineBakeBudget.ShouldDegrade(3, 4), "below the limit bakes normally");
        Assert(SpineBakeBudget.ShouldDegrade(4, 4), "at the limit degrades");
        Assert(SpineBakeBudget.ShouldDegrade(9, 4), "above the limit degrades");
        Assert(!SpineBakeBudget.ShouldDegrade(9, 0), "a disabled (0) limit never degrades");
        // A single-core box must not decide the host alone is already oversubscribed.
        Assert(SpineBakeBudget.DefaultInstanceLimit(1) == 2, "the default limit floors at 2 so a lone host never degrades");
        Assert(SpineBakeBudget.DefaultInstanceLimit(12) == 12, "otherwise the default limit is one instance per core");
    }

    private static void ResolvesTheLimitFromTheEnvOverride()
    {
        Assert(SpineBakeBudget.ResolveInstanceLimit("2", 12) == 2, "an explicit override wins");
        Assert(SpineBakeBudget.ResolveInstanceLimit(" 3 ", 12) == 3, "the override is trimmed");
        Assert(SpineBakeBudget.ResolveInstanceLimit(null, 12) == 12, "absent ⇒ the default");
        Assert(SpineBakeBudget.ResolveInstanceLimit("", 12) == 12, "blank ⇒ the default");
        Assert(SpineBakeBudget.ResolveInstanceLimit("nope", 12) == 12, "unparsable ⇒ the default");
        Assert(SpineBakeBudget.ResolveInstanceLimit("-1", 12) == 12, "a non-positive override ⇒ the default");
    }

    // The degraded answer must address the SAME still the clients already fetch as their placeholder, byte-for-byte:
    // that is what makes it usually a disk HIT, and what keeps the full-clip cache entry unwritten.
    private static void DerivesTheStillKeyForADegradedAnswer()
    {
        var clip = CouchCoopSpineClipProvider.BuildSpineKey(
            "res://scenes/creature_visuals/gremlin.tscn", "Visuals/SpineSprite", "attack");
        var still = CouchCoopSpineClipProvider.BuildSpineKey(
            "res://scenes/creature_visuals/gremlin.tscn", "Visuals/SpineSprite", "attack", still: true);

        Assert(CouchCoopSpineClipProvider.ToDegradedStillKey(clip) == still,
            "the degraded key IS the canonical still key for that identity");

        // The one-shot retry selector only ever addressed a fresh full bake; carrying it into the still key would
        // mint a second, pointless still entry per escalated identity.
        var escalated = CouchCoopSpineClipProvider.BuildSpineKey(
            "res://scenes/creature_visuals/gremlin.tscn", "Visuals/SpineSprite", "attack", retry: true);
        Assert(escalated != clip, "the retry=1 key differs from the plain clip key (guards the fixture)");
        Assert(CouchCoopSpineClipProvider.ToDegradedStillKey(escalated) == still,
            "a retry=1 escalated request degrades onto the same still key");

        // A skin/mat/skel-widened identity keeps its selectors (the still must be of the SAME thing).
        var widened = CouchCoopSpineClipProvider.BuildSpineKey(
            "res://scenes/map/boss_map_point.tscn", "Spine", "animation", skin: "act2", mat: "ab12cd", skel: "res://x.tres");
        var widenedStill = CouchCoopSpineClipProvider.BuildSpineKey(
            "res://scenes/map/boss_map_point.tscn", "Spine", "animation", still: true, skin: "act2", mat: "ab12cd", skel: "res://x.tres");
        Assert(CouchCoopSpineClipProvider.ToDegradedStillKey(widened) == widenedStill,
            "skin/mat/skel selectors ride into the degraded still key");
    }

    // A still request is ALREADY a single frame: degrading it would be a no-op that recursed forever.
    private static void NeverDegradesAStillRequest()
    {
        var still = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/x.tscn", "Spine", "idle_loop", still: true);
        Assert(CouchCoopSpineClipProvider.ToDegradedStillKey(still) is null, "a still key has nothing to degrade to");
        Assert(CouchCoopSpineClipProvider.ToDegradedStillKey("") is null, "an empty key degrades to nothing");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[SpineBakeBudgetTests] FAILED: {label}");
        }
    }
}
