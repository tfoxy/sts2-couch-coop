using CouchCoop.Mod.Runtime;
using Godot;
using System;
using System.Collections.Generic;
using System.Linq;
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
/// <c>is_in_group</c> when the first viewer asks. Groups are replaced on each tree entry so pooled nodes
/// carry their current context when the capture refreshes their identity.</para>
///
/// <para><b>Cost.</b> Runs only where a local capture reads groups. Windowed hosts install on attachment and
/// remove on detachment; headless captures retain their startup observer. While installed it is one
/// <c>SceneTree.NodeAdded</c> handler; the per-node work reads the managed type leaf,
/// name and current group membership. Context is read only for the nodes that can use it: the parent's scene path and name
/// only for the four creature HUD names, and the bounded ancestor walk only for NCard nodes. Only this tagger's
/// groups are changed; groups owned by the game or other mods are preserved.</para>
/// </remarks>
internal static class RenderStreamItemTagger
{
    // The mod's own group names (the frontend's stream-ext/groups.ts asks for exactly these). Both copies are pinned
    // to tests/fixtures/render-stream/item-groups.json (role key = this const's name minus "Group", snake_cased).
    internal const string HandHolderGroup = "couchcoop_rs_hand_holder";
    internal const string HandRootGroup = "couchcoop_rs_hand_root";
    internal const string HandContainerGroup = "couchcoop_rs_hand_container";
    internal const string HandCoverGroup = "couchcoop_rs_hand_cover";
    internal const string TargetingArrowGroup = "couchcoop_rs_targeting_arrow";
    internal const string HandChoiceGroup = "couchcoop_rs_hand_choice";
    internal const string CreatureHudGroup = "couchcoop_rs_creature_hud";
    internal const string CreatureReticleGroup = "couchcoop_rs_creature_reticle";
    internal const string CreaturePowerGroup = "couchcoop_rs_creature_power";
    internal const string CardRewardRootGroup = "couchcoop_rs_card_reward_root";
    internal const string CardRewardCardGroup = "couchcoop_rs_card_reward_card";
    internal const string TreasureRelicGroup = "couchcoop_rs_treasure_relic";
    internal const string EventOptionGroup = "couchcoop_rs_event_option";
    internal const string ShopItemGroup = "couchcoop_rs_shop_item";
    internal const string HoverTipGroup = "couchcoop_rs_hover_tip";
    internal const string RestSiteGroup = "couchcoop_rs_rest_site";

    private static readonly HashSet<string> OwnedGroups = new(StringComparer.Ordinal)
    {
        HandHolderGroup, HandRootGroup, HandContainerGroup, HandCoverGroup, TargetingArrowGroup, HandChoiceGroup,
        CreatureHudGroup, CreatureReticleGroup, CreaturePowerGroup, CardRewardRootGroup, CardRewardCardGroup,
        TreasureRelicGroup, EventOptionGroup, ShopItemGroup, HoverTipGroup, RestSiteGroup
    };

    // The node-type leaves and names the groups key on (the old mirror's raise/viewScale identity, verbatim).
    private const string HandHolderType = "NHandCardHolder";
    private const string HandRootType = "NPlayerHand";
    private const string HandContainerName = "CardHolderContainer";
    private const string TargetingArrowType = "NTargetingArrow";
    private const string HandChoiceType = "NChooseACardSelectionScreen";
    private const string HandChoiceName = "SelectModeBackstop";
    private const string CreatureSceneFileSuffix = "combat/creature.tscn";
    private const string CreatureStateDisplaySceneFileSuffix = "combat/creature_state_display.tscn";
    private const string CreatureHealthBarName = "HealthBar";
    private const string CreatureIntentsName = "Intents";
    private const string CreatureReticleName = "SelectionReticle";
    private const string CreaturePowerName = "PowerContainer";
    private const string CardRewardScreenType = "NCardRewardSelectionScreen";
    private const string RewardsScreenType = "NRewardsScreen";
    private static readonly string[] HandCoverScreenTypes =
        [RewardsScreenType, CardRewardScreenType, "NDeckViewScreen", "NSimpleCardsViewScreen", "NCardPileScreen",
            "NMultiplayerPlayerExpandedState", "NMapScreen", "NInspectCardScreen", "NInspectRelicScreen",
            "NPauseMenu", "NSettingsScreen"];
    private const string CardType = "NCard";
    private const string TreasureRelicType = "NTreasureRoomRelicHolder";
    // CONFIRM TAP: the three confirm-eligible families to tag. The shop set is the whole merchant
    // inventory (relic / potion / card / the card-removal service coin) because every one of them spends gold.
    private const string EventOptionType = "NEventOptionButton";
    private const string RestSiteType = "NRestSiteButton";
    private static readonly string[] ShopItemTypes =
        ["NMerchantRelic", "NMerchantPotion", "NMerchantCard", "NMerchantCardRemoval", "NBlitzMerchantSlot"];

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

    // On-demand attachment already runs on the main thread with a live tree; no startup retry is needed.
    internal static void Attach()
    {
        if (_installed) return;
        if (Engine.GetMainLoop() is not SceneTree { Root: { } root } tree || !GodotObject.IsInstanceValid(root))
            throw new InvalidOperationException("No SceneTree for capture item tags.");
        _installed = true;
        AttachOnMainThread(tree, root);
    }

    internal static void Remove()
    {
        if (_tree is { } tree && GodotObject.IsInstanceValid(tree)) tree.NodeAdded -= OnNodeAdded;
        _tree = null;
        _installed = false;
    }

    private static async Task InstallLoopAsync()
    {
        for (var attempt = 0; attempt < 120; attempt++)
        {
            try
            {
                if (Engine.GetMainLoop() is SceneTree { Root: { } root } tree && GodotObject.IsInstanceValid(root))
                {
                    GameDeferred.Post(() => AttachOnMainThread(tree, root));
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
        if (!_installed || _tree is not null)
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

        ReplaceGroups(BuildFacts(node), node.GetGroups().Select(group => group.ToString()),
            group => node.AddToGroup(group), group => node.RemoveFromGroup(group));
    }

    // Capture reads Godot group membership again on re-entry and replaces the item's whole metadata row.
    internal static void ReplaceGroups(ItemTagFacts facts, IEnumerable<string> currentGroups,
        Action<string> add, Action<string> remove)
    {
        var desired = new HashSet<string>(GroupsFor(facts), StringComparer.Ordinal);
        foreach (var group in currentGroups)
        {
            if (desired.Remove(group)) continue;
            if (OwnedGroups.Contains(group)) remove(group);
        }

        foreach (var group in desired) add(group);
    }

    // The per-node facts the pure decision keys on. SceneFilePath is non-empty only on an instanced-scene root.
    internal readonly record struct ItemTagFacts(
        string Name,
        string TypeLeaf,
        string? ParentName,
        string? ParentSceneFile,
        bool CardRewardAncestor);

    // Called for EVERY node entering the streaming seat's tree, so it reads only what GroupsFor can use for this node:
    // the type leaf is managed (no interop) and the name is one marshal; the parent and its scene path and name are read
    // only for the creature HUD names (the only rules that key on them), and the ancestor walk only for an NCard. A
    // fact that cannot change this node's groups is left null/false.
    internal static ItemTagFacts BuildFacts(Node node)
    {
        var type = node.GetType().Name;
        var name = node.Name.ToString();
        var isCard = type == CardType;
        var needsParentFacts = NeedsParentFacts(name);
        var parent = isCard || needsParentFacts ? node.GetParent() : null;

        string? parentName = null;
        string? parentSceneFile = null;
        if (needsParentFacts && parent is not null && GodotObject.IsInstanceValid(parent))
        {
            var path = parent.SceneFilePath;
            parentSceneFile = string.IsNullOrWhiteSpace(path) ? null : path;
            parentName = parent.Name.ToString();
        }

        return new ItemTagFacts(
            name,
            type,
            parentName,
            parentSceneFile,
            isCard && HasAncestor(parent, CardRewardScreenType));
    }

    /// <summary>Whether a node with this name can be a creature HUD item — the only rules keyed on the parent.</summary>
    internal static bool NeedsParentFacts(string name) =>
        name is CreatureHealthBarName or CreatureIntentsName or CreatureReticleName or CreaturePowerName;

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
    /// The mod's own groups a node belongs to, from its current facts. Pure, so the runner unit-tests it without an
    /// engine. A node may carry several groups (a hand choice name is also scanned separately from its type).
    /// </summary>
    internal static IReadOnlyList<string> GroupsFor(ItemTagFacts facts)
    {
        var groups = new List<string>(2);

        if (facts.TypeLeaf == "NHoverTipSet") groups.Add(HoverTipGroup);
        if (facts.TypeLeaf == HandHolderType) groups.Add(HandHolderGroup);
        if (facts.TypeLeaf == HandRootType) groups.Add(HandRootGroup);
        if (facts.Name == HandContainerName) groups.Add(HandContainerGroup);
        if (facts.TypeLeaf == TargetingArrowType) groups.Add(TargetingArrowGroup);
        if (facts.TypeLeaf == HandChoiceType || facts.Name == HandChoiceName) groups.Add(HandChoiceGroup);
        if (facts.TypeLeaf == TreasureRelicType) groups.Add(TreasureRelicGroup);
        if (facts.TypeLeaf == CardRewardScreenType) groups.Add(CardRewardRootGroup);
        // These screens visually cover combat chrome even when their input backstops pass through to the hand.
        if (Array.IndexOf(HandCoverScreenTypes, facts.TypeLeaf) >= 0) groups.Add(HandCoverGroup);
        if (facts.TypeLeaf == CardType && facts.CardRewardAncestor) groups.Add(CardRewardCardGroup);
        if (facts.TypeLeaf == EventOptionType) groups.Add(EventOptionGroup);
        if (facts.TypeLeaf == RestSiteType) groups.Add(RestSiteGroup);
        if (Array.IndexOf(ShopItemTypes, facts.TypeLeaf) >= 0) groups.Add(ShopItemGroup);

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
        }

        if (facts.Name == CreaturePowerName && facts.ParentName == CreatureHealthBarName
            && facts.ParentSceneFile?.EndsWith(CreatureStateDisplaySceneFileSuffix, StringComparison.Ordinal) == true)
        {
            groups.Add(CreaturePowerGroup);
        }

        return groups;
    }
}
