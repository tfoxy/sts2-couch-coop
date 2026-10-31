using Godot;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace CouchCoop.Mod.Session;

/// <summary>
/// The streaming seat's item-identity tags (render-stream TAG3, client-extensions-design.md §6).
///
/// <para><b>Why.</b> The render-stream client's opt-in extension modules (couch <c>stream-ext/raisedHand.ts</c> and
/// <c>viewScale.ts</c>) match items by the <c>item_meta</c> fields the host grants: <c>scene</c>, <c>path</c>,
/// <c>script</c> and the mod's own groups. <c>scene</c> + <c>path</c> name an item's authored scene position; they
/// are NOT enough for a pooled hand holder (its path is the card that happens to fill it), a targeting arrow, a
/// creature HUD group (identified by its PARENT's scene), or the card-reward screen's NCard descendants. For those,
/// this component tags the live nodes with the mod's own groups, which the capture resolves through
/// <c>is_in_group</c> when the first viewer asks. Tagging is static at node entry, matching the capture's own
/// "resolved once at creation" identity rule.</para>
///
/// <para><b>Cost.</b> Runs only on the streaming seat (<see cref="StreamingSeatRole.IsStreamingSeat"/>): the
/// host's headed instance and a normal headless seat have no capture reading groups, so nothing is installed. On
/// the streaming seat it is one <c>SceneTree.NodeAdded</c> handler; the per-node work is a type-leaf read (already
/// computed by the producer) plus a bounded parent walk only for NCard nodes, and <c>AddToGroup</c> on the few
/// nodes that match.</para>
/// </remarks>
internal static class RenderStreamItemTagger
{
    // The mod's own group names (the frontend's stream-ext/groups.ts asks for exactly these).
    internal const string HandHolderGroup = "couchcoop_rs_hand_holder";
    internal const string HandRootGroup = "couchcoop_rs_hand_root";
    internal const string HandContainerGroup = "couchcoop_rs_hand_container";
    internal const string TargetingArrowGroup = "couchcoop_rs_targeting_arrow";
    internal const string HandChoiceGroup = "couchcoop_rs_hand_choice";
    internal const string CreatureHudGroup = "couchcoop_rs_creature_hud";
    internal const string CreatureReticleGroup = "couchcoop_rs_creature_reticle";
    internal const string CreaturePowerGroup = "couchcoop_rs_creature_power";
    internal const string CardRewardRootGroup = "couchcoop_rs_card_reward_root";
    internal const string CardRewardCardGroup = "couchcoop_rs_card_reward_card";
    internal const string TreasureRelicGroup = "couchcoop_rs_treasure_relic";

    // The node-type leaves and names the groups key on (the old mirror's raise/viewScale identity, verbatim).
    private const string HandHolderType = "NHandCardHolder";
    private const string HandRootType = "NPlayerHand";
    private const string HandContainerName = "CardHolderContainer";
    private const string TargetingArrowType = "NTargetingArrow";
    private const string HandChoiceType = "NChooseACardSelectionScreen";
    private const string HandChoiceName = "SelectModeBackstop";
    private const string CreatureSceneFileSuffix = "combat/creature.tscn";
    private const string CreatureHealthBarName = "HealthBar";
    private const string CreatureIntentsName = "Intents";
    private const string CreatureReticleName = "SelectionReticle";
    private const string CreaturePowerName = "PowerContainer";
    private const string CardRewardScreenType = "NCardRewardSelectionScreen";
    private const string CardType = "NCard";
    private const string TreasureRelicType = "NTreasureRoomRelicHolder";

    private static SceneTree? _tree;
    private static bool _installed;

    /// <summary>Tag every node that enters the streaming seat's scene tree, plus the nodes already in it.</summary>
    public static void Install()
    {
        if (_installed)
        {
            return;
        }

        _installed = true;
        _ = Task.Run(InstallLoopAsync);
    }

    private static async Task InstallLoopAsync()
    {
        for (var attempt = 0; attempt < 120; attempt++)
        {
            try
            {
                if (Engine.GetMainLoop() is SceneTree { Root: { } root } tree && GodotObject.IsInstanceValid(root))
                {
                    Callable.From(() => AttachOnMainThread(tree, root)).CallDeferred();
                    return;
                }
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr(
                    $"[rs-tag] install attempt failed: {exception.GetType().Name}: {exception.Message}");
            }

            await Task.Delay(250).ConfigureAwait(false);
        }

        CouchCoopLog.Stderr("[rs-tag] install gave up (SceneTree never became ready)");
    }

    private static void AttachOnMainThread(SceneTree tree, Node root)
    {
        if (_tree is not null)
        {
            return;
        }

        _tree = tree;
        tree.NodeAdded += OnNodeAdded;
        // The capture's GRC_ADOPT=arm covers anything pre-existing; walking here keeps a node added between the
        // mod's very early Init and the SceneTree's existence tagged too.
        TagRecursive(root);
        CouchCoopLog.Info("[rs-tag] render-stream item tagger ready");
    }

    private static void OnNodeAdded(Node node)
    {
        Tag(node);
    }

    private static void TagRecursive(Node node)
    {
        foreach (var child in node.GetChildren())
        {
            TagRecursive(child);
        }

        Tag(node);
    }

    private static void Tag(Node node)
    {
        if (!GodotObject.IsInstanceValid(node))
        {
            return;
        }

        var parent = node.GetParent();
        foreach (var group in GroupsFor(BuildFacts(node, parent)))
        {
            node.AddToGroup(group);
        }
    }

    // The per-node facts the pure decision keys on. SceneFilePath is non-empty only on an instanced-scene root.
    internal readonly record struct ItemTagFacts(
        string Name,
        string TypeLeaf,
        string? SceneFile,
        string? ParentName,
        string? ParentSceneFile,
        bool CardRewardAncestor);

    internal static ItemTagFacts BuildFacts(Node node, Node? parent)
    {
        var type = node.GetType().Name;
        var sceneFile = node.SceneFilePath;
        if (string.IsNullOrWhiteSpace(sceneFile))
        {
            sceneFile = null;
        }

        string? parentSceneFile = null;
        if (parent is not null && GodotObject.IsInstanceValid(parent) && !string.IsNullOrWhiteSpace(parent.SceneFilePath))
        {
            parentSceneFile = parent.SceneFilePath;
        }

        return new ItemTagFacts(
            node.Name.ToString(),
            type,
            sceneFile,
            parent is not null && GodotObject.IsInstanceValid(parent) ? parent.Name.ToString() : null,
            parentSceneFile,
            HasAncestor(parent, CardRewardScreenType));
    }

    private static bool HasAncestor(Node? node, string typeLeaf)
    {
        for (var depth = 0; depth < 32 && node is not null && GodotObject.IsInstanceValid(node); depth++)
        {
            if (node.GetType().Name == typeLeaf)
            {
                return true;
            }

            node = node.GetParent();
        }

        return false;
    }

    /// <summary>
    /// The mod's own groups a node belongs to, from its static facts. Pure, so the runner unit-tests it without an
    /// engine. A node may carry several groups (a hand choice name is also scanned separately from its type).
    /// </summary>
    internal static IReadOnlyList<string> GroupsFor(ItemTagFacts facts)
    {
        var groups = new List<string>(2);

        if (facts.TypeLeaf == HandHolderType) groups.Add(HandHolderGroup);
        if (facts.TypeLeaf == HandRootType) groups.Add(HandRootGroup);
        if (facts.Name == HandContainerName) groups.Add(HandContainerGroup);
        if (facts.TypeLeaf == TargetingArrowType) groups.Add(TargetingArrowGroup);
        if (facts.TypeLeaf == HandChoiceType || facts.Name == HandChoiceName) groups.Add(HandChoiceGroup);
        if (facts.TypeLeaf == TreasureRelicType) groups.Add(TreasureRelicGroup);
        if (facts.TypeLeaf == CardRewardScreenType) groups.Add(CardRewardRootGroup);
        if (facts.TypeLeaf == CardType && facts.CardRewardAncestor) groups.Add(CardRewardCardGroup);

        var parentIsCreature = facts.ParentSceneFile?.EndsWith(CreatureSceneFileSuffix, StringComparison.Ordinal) == true;
        if (parentIsCreature)
        {
            if (facts.Name is CreatureHealthBarName or CreatureIntentsName)
            {
                groups.Add(CreatureHudGroup);
            }

            if (facts.Name == CreatureReticleName)
            {
                groups.Add(CreatureReticleGroup);
            }

            if (facts.Name == CreaturePowerName && facts.ParentName == CreatureHealthBarName)
            {
                groups.Add(CreaturePowerGroup);
            }
        }

        return groups;
    }
}
