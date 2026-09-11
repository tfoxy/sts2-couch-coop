using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for QaHideSelector — the QA hide-verb selector grammar (parse + wire-node match). The client-side
// enforcement (QaForcedHide + the three Visible write sites) is Godot-bound and covered by the live smoke flow;
// the pure matcher's suffix/exact/case rules are pinned here.
internal static class QaHideSelectorTests
{
    public static void Run()
    {
        ParseKinds();
        ParseRejects();
        TypeSuffixMatch();
        NameExactMatch();
        IdExactMatch();
        RoundTripAndEquality();
    }

    private static MirrorNode Node(string id, string name, string nodeType) =>
        new() { Id = id, Name = name, NodeType = nodeType };

    private static QaHideSelector Parse(string text)
    {
        Check.That(QaHideSelector.TryParse(text, out var selector), $"parses '{text}'");
        return selector;
    }

    private static void ParseKinds()
    {
        Check.Equal(Parse("type:NCreature").Kind, QaHideSelector.SelectorKind.Type, "type: kind");
        Check.Equal(Parse("name:NCombatSceneContainer").Kind, QaHideSelector.SelectorKind.Name, "name: kind");
        Check.Equal(Parse("id:n_42").Kind, QaHideSelector.SelectorKind.Id, "id: kind");
        Check.Equal(Parse("TYPE:NCreature").Kind, QaHideSelector.SelectorKind.Type, "prefix is case-insensitive");
        Check.Equal(Parse("name:Enemy 2").Value, "Enemy 2", "value may contain spaces");
        Check.Equal(Parse("id:a:b:c").Value, "a:b:c", "only the FIRST colon splits — value keeps later colons");
    }

    private static void ParseRejects()
    {
        Check.That(!QaHideSelector.TryParse("stage", out _), "stage is a pseudo-selector, not a wire selector");
        Check.That(!QaHideSelector.TryParse("bake", out _), "bake is a pseudo-selector, not a wire selector");
        Check.That(!QaHideSelector.TryParse("type:", out _), "empty value rejected");
        Check.That(!QaHideSelector.TryParse(":NCreature", out _), "empty prefix rejected");
        Check.That(!QaHideSelector.TryParse("glob:NCreature", out _), "unknown prefix rejected");
        Check.That(!QaHideSelector.TryParse("NCreature", out _), "bare word rejected");
    }

    private static void TypeSuffixMatch()
    {
        var creature = Node("n1", "Cultist", "MegaCrit.Sts2.Core.Nodes.Combat.NCreature");
        var energy = Node("n2", "EnergyCounter", "MegaCrit.Sts2.Core.Nodes.Combat.NEnergyCounter");

        Check.That(Parse("type:NCreature").Matches(creature), "leaf suffix matches");
        Check.That(Parse("type:ncreature").Matches(creature), "suffix match is case-insensitive");
        Check.That(Parse("type:Combat.NEnergyCounter").Matches(energy), "multi-segment suffix matches");
        Check.That(Parse("type:MegaCrit.Sts2.Core.Nodes.Combat.NCreature").Matches(creature), "full type matches");
        Check.That(!Parse("type:NCreature").Matches(energy), "non-suffix does not match");
        Check.That(!Parse("type:Combat").Matches(creature), "mid-string segment is not a suffix");
    }

    private static void NameExactMatch()
    {
        var node = Node("n1", "NCombatSceneContainer", "Godot.Node2D");

        Check.That(Parse("name:NCombatSceneContainer").Matches(node), "exact name matches");
        Check.That(Parse("name:ncombatscenecontainer").Matches(node), "name match is case-insensitive");
        Check.That(!Parse("name:NCombatScene").Matches(node), "name is EXACT — a prefix does not match");
        Check.That(!Parse("name:XNCombatSceneContainer").Matches(node), "name is EXACT — a suffix does not match");
    }

    private static void IdExactMatch()
    {
        var node = Node("Node_1234", "x", "Godot.Node2D");

        Check.That(Parse("id:Node_1234").Matches(node), "exact id matches");
        Check.That(!Parse("id:node_1234").Matches(node), "id match is case-SENSITIVE (ordinal)");
        Check.That(!Parse("id:Node_123").Matches(node), "id is exact — a prefix does not match");
    }

    private static void RoundTripAndEquality()
    {
        Check.Equal(Parse("type:NCreature").ToString(), "type:NCreature", "type round-trips");
        Check.Equal(Parse("name:Enemy 2").ToString(), "name:Enemy 2", "name round-trips");
        Check.Equal(Parse("id:n_42").ToString(), "id:n_42", "id round-trips");
        Check.Equal(Parse("type:NCreature"), Parse("type:NCreature"), "identical text → equal (show removes what hide added)");
        Check.That(Parse("type:NCreature") != Parse("name:NCreature"), "same value, different kind → not equal");
        Check.That(Parse("type:NCreature") != Parse("type:ncreature"), "dedupe is exact-text (case differs → distinct)");
    }
}
