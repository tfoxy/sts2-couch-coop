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
            RepeatedEntryKeepsUnchangedGroups
        ];
        foreach (var test in tests) test();
        Console.WriteLine($"RenderStreamItemTaggerTests: {tests.Length} passed.");
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
