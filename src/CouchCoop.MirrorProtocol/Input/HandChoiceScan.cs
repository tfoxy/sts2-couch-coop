using System.Collections.Generic;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Input;

// #12 signal source (behind GestureCallbacks.HandChoiceActive). Pure (Godot-free) so the Exe suite unit-tests it; the
// godot-client InputRouter curries the live store over it and the web mirrorRenderer ports it 1:1 (handChoiceActive).
//
// A from-hand card CHOICE — the Survivor "Choose a card to Discard", plus the Exhaust / Enchant / etc. selection
// prompts (CardSelectorPrefs.{Discard,Exhaust,Enchant}SelectionPrompt) — is hosted by NChooseACardSelectionScreen (the
// ICardSelector implementor that is NOT the card GRID). While one is effectively visible, a tap on a HAND card selects
// it with a SINGLE tap (no arm-first double tap) and the below-line unselect right-click is suppressed (so a choose-2
// dialog's second selection isn't eaten). It DELIBERATELY excludes the card GRID selection screen
// (NCardGridSelectionScreen — remove-a-card and other decision pickers): those cards are not hand cards. Their
// separate immediate-click rule lives in TouchTargetScan, alongside the modal fallthrough guard. Matched by
// node-type LEAF (the screen's script type is attached at runtime; there is no dedicated .tscn to suffix-match,
// unlike EndTurnScan) and/or scene-file suffix, so the set is trivially extendable if a live QA `dumptypes` diff
// surfaces another hand-choice host.
public static class HandChoiceScan
{
    // Node-type LEAVES that host a from-hand card choice. Seed set (confirm/extend via a live QA `dumptypes` diff
    // taken across the Survivor discard prompt — see DemoInputPlayer.DoDumpTypes).
    private static readonly HashSet<string> HandChoiceTypeLeaves = new(System.StringComparer.Ordinal)
    {
        "NChooseACardSelectionScreen",
    };

    // Scene-file SUFFIXES (TextScale/EndTurnScan-style, tolerant of a path move). Empty today — the choose-a-card
    // screen carries no dedicated packed scene; kept as the natural extension point for a captured scene file.
    private static readonly string[] HandChoiceSceneFileSuffixes = System.Array.Empty<string>();

    // Node NAMES that gate a from-hand card choice but carry NO distinctive type leaf. The live "Choose a card to
    // Discard" (Survivor discard) / exhaust / enchant IN-HAND selection is view.handSelection on the combat hand — it
    // does NOT instantiate an NChooseACardSelectionScreen (that leaf hosts the pick-1-of-N choose-a-card OVERLAY, whose
    // cards are not hand cards). Its ONE select-mode-exclusive node is the player_hand.tscn backstop named
    // "SelectModeBackstop" (a plain ColorRect, so it has no distinctive type leaf — the NAME is the signal). It is
    // effectively visible ONLY while an in-hand choice is active (confirmed by a live QA dump/dumptypes diff: absent in
    // plain combat, present under the hand during the discard prompt — WS-smoke), so keying on its name lets a hand-card
    // tap single-tap-select through the discard/exhaust/enchant prompt. Exact-name match (System.StringComparer.Ordinal).
    private static readonly HashSet<string> HandChoiceNodeNames = new(System.StringComparer.Ordinal)
    {
        "SelectModeBackstop",
    };

    /// <summary>
    /// True when a from-hand card-choice screen is effectively visible (the node AND every ancestor visible), so a
    /// hand-card tap should select with a single tap (#12). False when none is present/visible (the common case).
    /// </summary>
    public static bool IsActive(MirrorState state)
    {
        foreach (var node in state.Nodes.Values)
        {
            if (!Matches(node, state) || !EffectivelyVisible(state, node))
            {
                continue;
            }

            return true;
        }

        return false;
    }

    private static bool Matches(MirrorNode node, MirrorState state)
    {
        if (HandChoiceTypeLeaves.Contains(NodeTypeLeaf(node.NodeType)))
        {
            return true;
        }

        if (HandChoiceNodeNames.Contains(node.Name))
        {
            return true;
        }

        if (HandChoiceSceneFileSuffixes.Length == 0)
        {
            return false;
        }

        var (file, _) = SceneIdentity.Resolve(node.Id, state);
        if (file is null)
        {
            return false;
        }

        foreach (var suffix in HandChoiceSceneFileSuffixes)
        {
            if (file.EndsWith(suffix, System.StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static bool EffectivelyVisible(MirrorState state, MirrorNode node)
    {
        var cur = node;
        while (cur is not null)
        {
            if (!cur.Visible)
            {
                return false;
            }

            cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;
        }

        return true;
    }

    private static string NodeTypeLeaf(string nodeType)
    {
        var dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }
}
