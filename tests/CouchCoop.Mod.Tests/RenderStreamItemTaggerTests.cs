using System.Reflection;
using CouchCoop.Mod.Session;

internal static class RenderStreamItemTaggerTests
{
    public static void Run()
    {
        Action[] tests =
        [
            PooledCardGroupsFollowItsParentContext,
            CreatureGroupsAreRemovedOutsideTheirContext,
            ReplacementClearsOnlyOwnedGroups,
            RepeatedEntryKeepsUnchangedGroups,
            WindowedHostNeverStreamingInstallsNoObservers,
            WindowedHostKeepsTipOwnerHookBetweenStreams,
            AttachmentOwnsObserversExactlyOnce,
            HeadlessCaptureKeepsStartupObservers,
            FailedObserverInstallRollsBackAndCanRetry,
            DetachedRewardTrackingIsDisabled
        ];
        foreach (var test in tests) test();
        Console.WriteLine($"RenderStreamItemTaggerTests: {tests.Length} passed.");
    }

    private static void WindowedHostNeverStreamingInstallsNoObservers()
    {
        var installs = 0;
        var removes = 0;
        var helpers = new RenderStreamCaptureHelpers(true, () => installs++, () => removes++, () => { });
        helpers.Start();
        helpers.Start();
        helpers.SetAttached(false);
        Assert(!helpers.Installed && installs == 0 && removes == 0,
            "a windowed host with no stream request never installs node or frame observers");
    }

    private static void WindowedHostKeepsTipOwnerHookBetweenStreams()
    {
        var tipOwnerInstalls = 0;
        var tipOwnerInstalled = false;
        var observers = false;
        var helpers = new RenderStreamCaptureHelpers(true, () => observers = true, () => observers = false,
            () => { tipOwnerInstalls++; tipOwnerInstalled = true; });
        helpers.Start();
        helpers.Start();
        Assert(tipOwnerInstalled && tipOwnerInstalls == 1 && !helpers.Installed && !observers,
            "windowed startup installs the tip-owner creation hook once without node or frame observers");
        helpers.SetAttached(false);
        Assert(tipOwnerInstalled && tipOwnerInstalls == 1 && !helpers.Installed,
            "a never-attached host keeps the tip-owner hook");
        helpers.SetAttached(true);
        helpers.SetAttached(false);
        helpers.Start();
        Assert(tipOwnerInstalled && tipOwnerInstalls == 1 && !helpers.Installed && !observers,
            "detaching removes observers but keeps the tip-owner hook installed once for later streams");
    }

    private static void AttachmentOwnsObserversExactlyOnce()
    {
        var installs = 0;
        var removes = 0;
        var helpers = new RenderStreamCaptureHelpers(true, () => installs++, () => removes++, () => { });
        helpers.Start();
        helpers.SetAttached(true);
        helpers.SetAttached(true);
        Assert(helpers.Installed && installs == 1 && removes == 0, "attach installs observers once");
        helpers.SetAttached(false);
        helpers.SetAttached(false);
        Assert(!helpers.Installed && removes == 1, "detach removes observers once");
        helpers.SetAttached(true);
        Assert(helpers.Installed && installs == 2, "reattach reinstalls observers and adopts current nodes");
    }

    private static void HeadlessCaptureKeepsStartupObservers()
    {
        var installs = 0;
        var helpers = new RenderStreamCaptureHelpers(false, () => installs++,
            () => throw new Exception("headless observers must stay installed"), () => { });
        helpers.Start();
        helpers.Start();
        helpers.SetAttached(false);
        helpers.SetAttached(true);
        Assert(helpers.Installed && installs == 1, "headless host and seat keep their startup observers");
    }

    private static void FailedObserverInstallRollsBackAndCanRetry()
    {
        var attempts = 0;
        var removes = 0;
        var helpers = new RenderStreamCaptureHelpers(true, () =>
        {
            if (++attempts == 1) throw new InvalidOperationException("install failure");
        }, () => removes++, () => { });
        try { helpers.SetAttached(true); throw new Exception("install failure must propagate"); }
        catch (InvalidOperationException) { }
        Assert(!helpers.Installed && removes == 1, "failed installation removes partial observers");
        helpers.SetAttached(true);
        Assert(helpers.Installed && attempts == 2, "a later request can retry the installation");
    }

    private static void DetachedRewardTrackingIsDisabled()
    {
        Assert(!StreamCardRewardPlacementPatch.CanTrack(true, false),
            "detached windowed capture does no reward-node or tween bookkeeping");
        Assert(StreamCardRewardPlacementPatch.CanTrack(true, true), "attached host tracks rewards");
        Assert(StreamCardRewardPlacementPatch.CanTrack(false, false)
            && StreamCardRewardPlacementPatch.CanTrack(false, true), "headless reward tracking is unchanged");
    }

    // The runner has no native engine. Replay the facts from the same pooled card's tree entries,
    // keeping its group storage across each move rather than testing isolated GroupsFor calls.
    private static void PooledCardGroupsFollowItsParentContext()
    {
        var groups = new HashSet<string> { "game_card" };
        void Enter(bool rewardAncestor) => Replace(new("Card", "NCard", null, null, rewardAncestor), groups);

        Enter(rewardAncestor: true);
        Assert(groups.SetEquals(["game_card", RenderStreamItemTagger.CardRewardCardGroup]),
            "a card entering the reward screen gains its role");
        Enter(rewardAncestor: false);
        Assert(groups.SetEquals(["game_card"]), "the same card entering a hand holder loses its reward role");
        Enter(rewardAncestor: true);
        Assert(groups.SetEquals(["game_card", RenderStreamItemTagger.CardRewardCardGroup]),
            "the pooled card regains its role when returned to rewards");
    }

    private static void CreatureGroupsAreRemovedOutsideTheirContext()
    {
        var groups = new HashSet<string>();
        Replace(new("HealthBar", "Control", "Creature", "res://scenes/combat/creature.tscn", false), groups);
        Assert(groups.Contains(RenderStreamItemTagger.CreatureHudGroup), "a creature HUD is tagged");
        Replace(new("HealthBar", "Control", "Other", null, false), groups);
        Assert(groups.Count == 0, "parent-derived groups disappear outside their context");
    }

    private static void ReplacementClearsOnlyOwnedGroups()
    {
        var groups = typeof(RenderStreamItemTagger).GetFields(BindingFlags.Static | BindingFlags.NonPublic)
            .Where(field => field.IsLiteral && field.FieldType == typeof(string) && field.Name.EndsWith("Group"))
            .Select(field => (string)field.GetRawConstantValue()!).ToHashSet();
        groups.UnionWith(["game_card", "other_mod", "couchcoop_rs_other_owner"]);
        Replace(new("Card", "NCard", null, null, false), groups);
        Assert(groups.SetEquals(["game_card", "other_mod", "couchcoop_rs_other_owner"]),
            "replacement clears every tagger-owned group and preserves all foreign groups");
    }

    private static void RepeatedEntryKeepsUnchangedGroups()
    {
        var groups = new HashSet<string> { RenderStreamItemTagger.HandHolderGroup };
        RenderStreamItemTagger.ReplaceGroups(new("Holder", "NHandCardHolder", null, null, false), groups.ToArray(),
            _ => throw new Exception("unchanged groups must not be re-added"),
            _ => throw new Exception("unchanged groups must not be removed"));
    }

    private static void Replace(RenderStreamItemTagger.ItemTagFacts facts, HashSet<string> groups) =>
        RenderStreamItemTagger.ReplaceGroups(facts, groups.ToArray(), group => groups.Add(group), group => groups.Remove(group));

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
