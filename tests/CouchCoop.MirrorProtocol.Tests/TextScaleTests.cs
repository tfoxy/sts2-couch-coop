using System;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for the native text-scale port (SceneIdentity + TextScale) — the C# transliteration of
// frontend/src/mirror/mirrorTextScale.css. Covers: the 7 PROVEN-CORRECTED combat entries against the recorded
// (file, relPath) tuples from the v0.107.1 selector audit; the old stale forms no longer matching; VALID spot
// checks (hover tip, card suffix under differing owner scenes, health-bar suffix); the power/relic AmountLabel
// scene-scoping; scene-identity semantics via the walk (root-name-excluded, volatile-name-in-middle suffix);
// unknown → 1.0; and a SceneIdentity ↔ old-CosmeticAnimator parity spot-check.
internal static class TextScaleTests
{
    public static void Run()
    {
        CorrectedCombatEntriesMatchRecordedTuples();
        OldStaleFormsNoLongerMatch();
        ValidSpotChecks();
        CardDescriptionCarriesLineSpacingMetrics();
        CardRuleMatchesAcrossOwningScenes();
        PowerScopedToPowerSceneExcludesRelic();
        UnknownAndNotInSceneAreNeutral();
        SceneIdentitySemantics();
        SceneIdentityParityWithOldWalk();
        InlineFontSizeRewrite();
        EndTurnCapAndWrapSchema();
        ScaledFontPxClamp();
        WrappedLabelLineSpacingConst();
        WrappedLabelLineSpacingFromFontMetrics();
        NudgeEntriesRound5();
    }

    // ROUND-5 RETUNE: the R15/round-4 per-entry vertical nudges (energy/star/pile counts + health-bar block, 2-4px UP)
    // were never pixel-measured. The round-5 ink matrix (verify-text-align.sh over the 37-10 combat recording) measured
    // those counts sitting ~8-10px ABOVE their box centre on the shipped build and ~0 with BOTH the growth-centering
    // and the nudge disabled — the compensation OVER-lifted a loose-box Center label Godot's Center already centres.
    // So every NudgeYPx retunes to the measured residual: 0. The overflow-aware growth-centering (PlacementLift) then
    // carries the ONLY real compensation (tight-box HP), so no nudge is needed anywhere. Both consts are 0.
    private static void NudgeEntriesRound5()
    {
        Check.Equal(TextScale.VerticalCenterNudgePx, 0, "round-5: shared vertical-centring nudge retuned to measured 0");
        Check.Equal(TextScale.BlockAndPileNudgePx, 0, "round-5: block/pile nudge retuned to measured 0");

        // Every previously-nudged count/block entry now resolves to 0 (via the retuned consts).
        var star = TextScale.MetricsFor("res://scenes/combat/energy_counters/star_counter.tscn", "MarginContainer/CountLabel");
        Check.Equal(star.NudgeYPx, 0, "star counter nudge → 0");
        foreach (var file in new[]
                 {
                     "res://scenes/combat/energy_counters/ironclad_energy_counter.tscn",
                     "res://scenes/combat/energy_counters/silent_energy_counter.tscn",
                 })
        {
            Check.Equal(TextScale.MetricsFor(file, "Label").NudgeYPx, 0, $"{file}: energy counter nudge → 0");
        }

        foreach (var pile in new[] { "draw_pile", "discard_pile", "exhaust_pile" })
        {
            Check.Equal(TextScale.MetricsFor($"res://scenes/combat/{pile}.tscn", "CountContainer/Count").NudgeYPx, 0,
                $"{pile} count nudge → 0");
        }

        var block = TextScale.MetricsFor("res://scenes/combat/health_bar.tscn", "BlockContainer/BlockLabel");
        Check.Equal(block.NudgeYPx, 0, "health-bar block number nudge → 0");

        // The MP-HUD BlockLabel copy stays in lockstep with the bare block (both 0). MP is unmeasurable single-player.
        var mpBlock = TextScale.MetricsFor(
            "res://scenes/run.tscn", "MultiplayerPlayerContainer/Player2/HealthBar/BlockContainer/BlockLabel");
        Check.Equal(mpBlock.NudgeYPx, 0, "MP health-bar block copy nudge → 0 (lockstep with the bare block)");

        // HP and an unrelated label were already 0 and stay 0.
        Check.Equal(TextScale.MetricsFor("res://scenes/combat/health_bar.tscn", "HpBarContainer/HpLabel").NudgeYPx, 0,
            "HP label carries no nudge");
        Check.Equal(TextScale.MetricsFor("res://scenes/combat/intent.tscn", "IntentHolder/Value").NudgeYPx, 0,
            "a non-count/non-block label carries no nudge");
    }

    // Item #16: the wrapped-Label line-spacing constant is the small positive px gap both clients hold in lockstep
    // (native AddThemeConstantOverride("line_spacing", …); web `line-height: calc(1em + 1px)`). Assert its value so a
    // drift here forces a matching edit to mirrorTextScale.css's end-turn line-height. It is scoped to the Wrap entry
    // (End Turn) — no other entry carries Wrap, so nothing else acquires the override.
    private static void WrappedLabelLineSpacingConst()
    {
        Check.Equal(TextScale.WrappedLabelLineSpacingPx, 1, "wrapped-Label line spacing addend is 1px (issue #16)");
        Check.Close(TextScale.WrappedLabelLineHeight, 0.79,
            "R8 item 12: wrapped-Label line-height ratio is 0.79 (lockstep with mirrorTextScale.css `calc(0.79em + 1px)`)");

        // Only the End Turn entry opts into Wrap — the trigger for the native line_spacing override.
        var endTurn = TextScale.MetricsFor("res://scenes/combat/end_turn_button.tscn", "Visuals/Label");
        Check.That(endTurn.Wrap, "end-turn is the Wrap entry that acquires the line_spacing override");
        var intent = TextScale.MetricsFor("res://scenes/combat/intent.tscn", "IntentHolder/Value");
        Check.That(!intent.Wrap, "a non-wrapping label carries no Wrap flag → no line_spacing override");
    }

    // R8 item 12: the native line_spacing constant is DERIVED from the resolved font's natural line box so both
    // clients land on the SAME pitch as the web's `line-height: calc(<ratio>em + <addend>px)`. The vectors are the
    // real End-Turn geometry: kreon_bold at the 34px cap has ascent 34 + descent 10 = 44px natural, the button box is
    // 162×72, and "End Turn 3" measures 161.7px wide — i.e. one line at EN, but "End Turn 10" (176px) wraps.
    private static void WrappedLabelLineSpacingFromFontMetrics()
    {
        const double fontPx = 34, natural = 44, boxH = 72;
        int ls = TextScale.WrappedLabelLineSpacing(fontPx, natural, boxH);
        Check.Equal(ls, -16, "line_spacing = round(0.79·34 − 44) + 1 = −16 (the box budget 72 − 2·44 = −16 binds equally)");

        // The pitch both clients target. Web: 0.79em + 1px = 27.86. Native: natural + line_spacing.
        double webPitch = (TextScale.WrappedLabelLineHeight * fontPx) + TextScale.WrappedLabelLineSpacingPx;
        Check.That(Math.Abs((natural + ls) - webPitch) <= 1.0,
            $"native pitch {natural + ls} is within 1px of the web pitch {webPitch:0.##}");

        // Godot renders only as many lines as FIT: its loop breaks once total_h > ceil(boxH + line_spacing)
        // (scene/gui/label.cpp get_layout_data). The pre-R8 flat +1 put two lines at 2×45 = 90 against a budget of 73,
        // so the SECOND line was silently dropped ("End Turn 10" → "End Turn"). The derived constant fits.
        Check.That((2 * (natural + 1)) > Math.Ceiling(boxH + 1),
            "pre-R8 flat +1 overflowed Godot's two-line budget (the dropped-second-line bug)");
        Check.That((2 * (natural + ls)) <= Math.Ceiling(boxH + ls),
            "the derived constant fits BOTH wrapped lines inside Godot's budget");

        // The box clamp is the safety net: a ratio too loose for a given box is pulled down to the fitting limit.
        Check.Equal(TextScale.WrappedLabelLineSpacing(fontPx, natural, 0), -16, "no box height → the pure ratio target");
        Check.That(TextScale.WrappedLabelLineSpacing(fontPx, natural, 60) < ls, "a SHORTER box clamps the constant further");
        Check.Equal(TextScale.WrappedLabelLineSpacing(fontPx, natural, 200), -16,
            "a box with room to spare leaves the ratio target alone");

        // Godot subtracts one line_spacing back out when centering AND its fitting test for a single line reduces to
        // natural ≤ boxH — so a ONE-line label (the common EN "End Turn 3") is placed identically for ANY constant.
        Check.Close((natural + ls) - ls, natural, "a single-line label's centred block height is independent of line_spacing");
    }

    // ---- WS-TEXT round-4 (items 1 + 2) ----------------------------------------------------------------------------

    // Item 1: inline absolute [font_size=N] runs scale by the label's own factor so a multiattack intent's "xN"
    // multiplier scales coherently with the count. No-op at scale 1 (== the switch-off / no-bump path) and when there
    // is no inline size.
    private static void InlineFontSizeRewrite()
    {
        // Multiattack intent template: count "3" at theme size, "x4" at inline font_size=18. round(18×1.32)=24.
        Check.Equal(TextScale.ScaleInlineFontSizes("3[font_size=18]x4[/font_size]", 1.32),
            "3[font_size=24]x4[/font_size]", "multiattack inline size scales with the label factor");

        // Two inline runs, both rewritten; the close tag is left untouched.
        Check.Equal(TextScale.ScaleInlineFontSizes("[font_size=10]a[/font_size][font_size=20]b[/font_size]", 2.0),
            "[font_size=20]a[/font_size][font_size=40]b[/font_size]", "every inline run scales, closes untouched");

        // No-scale (scale 1 == switch OFF / unbumped label): byte-identical pass-through.
        Check.Equal(TextScale.ScaleInlineFontSizes("3[font_size=18]x4[/font_size]", 1.0),
            "3[font_size=18]x4[/font_size]", "scale 1 is a no-op (switch-off parity)");

        // No inline size, or no bbcode at all → returned unchanged (other tags left alone).
        Check.Equal(TextScale.ScaleInlineFontSizes("[color=#fff]hi[/color]", 1.32),
            "[color=#fff]hi[/color]", "a label with no inline font_size is untouched");
        Check.Equal(TextScale.ScaleInlineFontSizes("plain", 1.32), "plain", "plain text is untouched");
        Check.Equal(TextScale.ScaleInlineFontSizes("", 1.32), "", "empty is untouched");
    }

    // Item 2: the end-turn entry (and ONLY it) carries the MaxSizePx cap + Wrap flag; every other label resolves to
    // the neutral (null / false) defaults.
    private static void EndTurnCapAndWrapSchema()
    {
        var endTurn = TextScale.MetricsFor("res://scenes/combat/end_turn_button.tscn", "Visuals/Label");
        Check.Close(endTurn.Scale, 1.54, "end-turn still scales 1.54");
        Check.That(endTurn.MaxSizePx == TextScale.EndTurnMaxSizePx, "end-turn carries the MaxSizePx cap const");
        Check.That(endTurn.Wrap, "end-turn opts into WordSmart wrap");

        // A different scaled label (intent) carries neither cap nor wrap.
        var intent = TextScale.MetricsFor("res://scenes/combat/intent.tscn", "IntentHolder/Value");
        Check.That(intent.MaxSizePx is null && !intent.Wrap, "intent has no cap / wrap");

        // Neutral tuple → no cap / wrap.
        var neutral = TextScale.MetricsFor("res://scenes/whatever.tscn", "Some/Unknown");
        Check.That(neutral.MaxSizePx is null && !neutral.Wrap, "unknown → no cap / wrap");
    }

    // Item 2: the shared clamp math min(round(px×scale), maxSizePx) — no cap when maxSizePx is null (today's round).
    private static void ScaledFontPxClamp()
    {
        // End-turn: streamed 30 × 1.54 = 46.2 → round 46, capped to 34.
        Check.Equal(TextScale.ScaledFontPx(30, 1.54, TextScale.EndTurnMaxSizePx), 34, "cap binds (46 → 34)");
        // Cap does NOT bind when the scaled size is already under it.
        Check.Equal(TextScale.ScaledFontPx(18, 1.0, 34), 18, "cap above scaled size is a no-op");
        // No cap → plain rounded scale.
        Check.Equal(TextScale.ScaledFontPx(30, 1.54, null), 46, "no cap → round(px×scale)");
        // Rounds to nearest and floors at 1.
        Check.Equal(TextScale.ScaledFontPx(10, 1.32, null), 13, "round(13.2) = 13");
        Check.Equal(TextScale.ScaledFontPx(0.1, 1.0, null), 1, "font px floors at 1");
    }

    // ---- fixtures -------------------------------------------------------------------------------------------------

    private static MirrorNode N(string id, string? parent, string name, string? sceneFile = null) =>
        new() { Id = id, ParentId = parent, Name = name, SceneFilePath = sceneFile };

    private static MirrorState StateOf(params MirrorNode[] nodes)
    {
        var s = MirrorState.Create();
        foreach (var n in nodes)
        {
            s.Nodes[n.Id] = n;
        }

        return s;
    }

    // The 7 PROVEN corrected (file, relPath) tuples from the audit — the exact shape the wire streams post-v0.107.1.
    private static void CorrectedCombatEntriesMatchRecordedTuples()
    {
        Check.Close(TextScale.ScaleFor("res://scenes/ui/top_bar/top_bar_deck_button.tscn", "DeckCardCount"),
            1.24, "deck count → top_bar_deck_button.tscn :: DeckCardCount");

        // Per-character energy counter — matched by the file SUFFIX; ironclad in these recordings.
        Check.Close(TextScale.ScaleFor("res://scenes/combat/energy_counters/ironclad_energy_counter.tscn", "Label"),
            1.24, "energy counter → *_energy_counter.tscn :: Label");
        Check.Close(TextScale.ScaleFor("res://scenes/combat/energy_counters/silent_energy_counter.tscn", "Label"),
            1.24, "energy counter suffix covers another character variant");

        Check.Close(TextScale.ScaleFor("res://scenes/combat/end_turn_button.tscn", "Visuals/Label"),
            1.54, "end turn → end_turn_button.tscn :: Visuals/Label");
        Check.Close(TextScale.ScaleFor("res://scenes/combat/energy_counters/star_counter.tscn", "MarginContainer/CountLabel"),
            1.24, "star counter → star_counter.tscn :: MarginContainer/CountLabel");
        // R9 (WS-B): the three pile counts dropped 1.24 → 1.16 because their buttons are ALSO view-scaled 1.25 (the
        // factors multiply). The star / energy / deck counters above keep 1.24 — they carry no view-scale stamp.
        Check.Close(TextScale.ScaleFor("res://scenes/combat/draw_pile.tscn", "CountContainer/Count"),
            1.16, "draw pile → draw_pile.tscn :: CountContainer/Count (R9: 1.24 → 1.16, the button is view-scaled 1.25)");
        Check.Close(TextScale.ScaleFor("res://scenes/combat/discard_pile.tscn", "CountContainer/Count"),
            1.16, "discard pile → discard_pile.tscn :: CountContainer/Count (R9: 1.24 → 1.16)");
        Check.Close(TextScale.ScaleFor("res://scenes/combat/power.tscn", "AmountLabel"),
            1.48, "power stacks → power.tscn :: AmountLabel");
    }

    // The pre-v0.107.1 selectors (combat_ui.tscn / combat_piles_container.tscn / top_bar deck path) must now MISS —
    // proving the stale forms were replaced, not merely shadowed.
    private static void OldStaleFormsNoLongerMatch()
    {
        Check.Close(TextScale.ScaleFor("res://scenes/combat/combat_ui.tscn", "EndTurnButton/Visuals/Label"),
            1.0, "old combat_ui.tscn End Turn path no longer matches");
        Check.Close(TextScale.ScaleFor("res://scenes/combat/combat_ui.tscn", "IroncladEnergyCounter/Label"),
            1.0, "old combat_ui.tscn energy path no longer matches");
        Check.Close(TextScale.ScaleFor("res://scenes/combat/combat_piles_container.tscn", "DrawPile/CountContainer/Count"),
            1.0, "old combat_piles_container.tscn draw-pile path no longer matches");
        Check.Close(TextScale.ScaleFor("res://scenes/ui/top_bar.tscn", "RightAlignedStuff/DeckContainer/Deck/DeckCardCount"),
            1.0, "old top_bar.tscn deck-count path no longer matches");
    }

    private static void ValidSpotChecks()
    {
        // Hover tip — Title under HBoxContainer, Description directly under VBoxContainer (1.08/1.08: softened from
        // 1.20 because the tip text read too large on the phone; kept in lockstep with mirrorTextScale.css).
        Check.Close(TextScale.ScaleFor("res://scenes/ui/hover_tip.tscn", "TextContainer/VBoxContainer/HBoxContainer/Title"),
            1.08, "hover tip Title");
        Check.Close(TextScale.ScaleFor("res://scenes/ui/hover_tip.tscn", "TextContainer/VBoxContainer/Description"),
            1.08, "hover tip Description");

        // Top bar exact rules.
        Check.Close(TextScale.ScaleFor("res://scenes/ui/top_bar.tscn", "LeftAlignedStuff/TopBarHp/HpLabel"),
            1.20, "top bar HpLabel");
        Check.Close(TextScale.ScaleFor("res://scenes/ui/top_bar.tscn", "RightAlignedStuff/TimerContainer/TimerLabel"),
            1.08, "top bar TimerLabel");

        // Intent value (also the CosmeticAnimator bob leaf).
        Check.Close(TextScale.ScaleFor("res://scenes/combat/intent.tscn", "IntentHolder/Value"),
            1.32, "intent value");

        // Health-bar HP/Block bare suffix (health_bar.tscn its own scene in v0.107.1).
        Check.Close(TextScale.ScaleFor("res://scenes/combat/health_bar.tscn", "HpBarContainer/HpLabel"),
            1.42, "health bar HpLabel suffix");
        Check.Close(TextScale.ScaleFor("res://scenes/combat/health_bar.tscn", "BlockContainer/BlockLabel"),
            1.42, "health bar BlockLabel suffix");

        // Exhaust pile (already scene-scoped pre-audit) + proceed button. R9 (WS-B): 1.24 → 1.16 in lockstep with
        // draw/discard — all three pile buttons now carry a 1.25 view-scale stamp that multiplies with the text scale.
        Check.Close(TextScale.ScaleFor("res://scenes/combat/exhaust_pile.tscn", "CountContainer/Count"),
            1.16, "exhaust pile count (R9: 1.24 → 1.16)");
        Check.Close(TextScale.ScaleFor("res://scenes/ui/proceed_button.tscn", "Image/Label"),
            1.08, "proceed button label");
    }

    // WS-TXT: the card DescriptionLabel entry additionally carries the line-spacing metrics (wrapped line-height ratio
    // + explicit-newline paragraph-extra em). MetricsFor exposes them; other labels resolve to none; the values equal
    // the public constants the mirrorTextScale.css --godot-rich-* properties are kept in lockstep with.
    private static void CardDescriptionCarriesLineSpacingMetrics()
    {
        var desc = TextScale.MetricsFor("res://scenes/cards/card.tscn", "CardContainer/DescriptionLabel");
        Check.Close(desc.Scale, 1.0, "card desc FONT scale drops to 1.0 (R6: the block TRANSFORM scale takes over)");
        Check.That(desc.LineHeight is not null, "card desc carries a line-height ratio");
        Check.Close(desc.LineHeight!.Value, TextScale.CardDescLineHeight, "card desc line-height == const");
        Check.That(desc.ParagraphExtra is not null, "card desc carries a paragraph-extra ratio");
        Check.Close(desc.ParagraphExtra!.Value, TextScale.CardDescParagraphExtra, "card desc paragraph-extra == const");

        // WS-text round-4 (P5-c): the +1px line-height addend TextBuilder.ApplyRichLineSpacing adds on top of the
        // ratio target (the End-Turn `WrappedLabelLineSpacingPx` idiom, ported to wrapped rich text). Kept in
        // lockstep with mirrorTextScale.css's `--godot-rich-line-height: calc(0.88em + 1px)`.
        Check.Equal(TextScale.CardDescLineHeightAddendPx, 1, "card desc line-height +1px addend");

        // Folded into another owning scene (rewards row) via the file-scope-free suffix rule → still carries them.
        var folded = TextScale.MetricsFor(
            "res://scenes/screens/rewards_screen.tscn", "Rows/Row/CardContainer/DescriptionLabel");
        Check.Close(folded.LineHeight ?? -1, TextScale.CardDescLineHeight, "folded card desc keeps line-height");
        Check.Close(folded.ParagraphExtra ?? -1, TextScale.CardDescParagraphExtra, "folded card desc keeps paragraph-extra");

        // A different card label (title) scales but carries NO line-spacing metrics.
        var title = TextScale.MetricsFor("res://scenes/cards/card.tscn", "CardContainer/TitleLabel");
        Check.Close(title.Scale, 1.14, "card title scale");
        Check.That(title.LineHeight is null && title.ParagraphExtra is null, "card title has no line-spacing metrics");

        // Unknown tuple → fully neutral.
        var neutral = TextScale.MetricsFor("res://scenes/whatever.tscn", "Some/Unknown");
        Check.That(neutral is { Scale: 1.0, LineHeight: null, ParagraphExtra: null }, "unknown → neutral metrics");
    }

    // The card suffix rules have NO file scope, so they must fire whether the card is its own scene (card.tscn) or
    // folded into a different owning scene (player_hand.tscn) at a longer path over a volatile middle segment.
    private static void CardRuleMatchesAcrossOwningScenes()
    {
        Check.Close(TextScale.ScaleFor("res://scenes/cards/card.tscn", "CardContainer/TitleLabel"),
            1.14, "card title under card.tscn");
        Check.Close(TextScale.ScaleFor("res://scenes/combat/player_hand.tscn", "Card/@Control@42/CardContainer/TitleLabel"),
            1.14, "card title folded into player_hand.tscn at a longer path");
        Check.Close(TextScale.ScaleFor("res://scenes/screens/rewards_screen.tscn", "Rows/Row/CardContainer/DescriptionLabel"),
            1.0, "card description folded into rewards_screen.tscn — R6 font scale is 1.0 (block transform enlarges)");
        Check.Close(TextScale.ScaleFor("res://scenes/cards/card.tscn", "CardContainer/TypePlaque/TypeLabel"),
            1.0, "card type label font scale is 1.0 (R6: TypePlaque block transform enlarges bg+label)");
    }

    // The power rule is scoped to power.tscn; relics/relic.tscn has its OWN AmountLabel entry — so the two are
    // distinct (the power rule never touches the relic label, and vice versa). Relics and the two orb values now use
    // the same user-selected 1.48 multiplier.
    private static void PowerScopedToPowerSceneExcludesRelic()
    {
        Check.Close(TextScale.ScaleFor("res://scenes/combat/power.tscn", "AmountLabel"),
            1.48, "power AmountLabel scales 1.48");
        Check.Close(TextScale.ScaleFor("res://scenes/relics/relic.tscn", "AmountLabel"),
            1.48, "relic AmountLabel scales 1.48");
        Check.Close(TextScale.ScaleFor("res://scenes/orbs/orb.tscn", "LabelContainer/PassiveAmount"),
            1.48, "orb passive amount scales 1.48");
        Check.Close(TextScale.ScaleFor("res://scenes/orbs/orb.tscn", "LabelContainer/EvokeAmount"),
            1.48, "orb evoke amount scales 1.48");
        Check.Close(TextScale.ScaleFor("res://scenes/orbs/orb.tscn", "PassiveAmount"),
            1.0, "orb amount rule requires its exact node path");
    }

    private static void UnknownAndNotInSceneAreNeutral()
    {
        Check.Close(TextScale.ScaleFor("res://scenes/whatever.tscn", "Some/Unknown/Path"),
            1.0, "unknown (file, relPath) → 1.0");

        // Not inside any scene (relPath null) → neutral.
        Check.Close(TextScale.ScaleFor((string?)null, (string?)null), 1.0, "not-in-scene tuple → 1.0");

        // A node id absent from the state (nothing to walk) → neutral.
        Check.Close(TextScale.ScaleFor("ghost", StateOf()), 1.0, "unknown node id → 1.0");
    }

    // SceneIdentity walk: the scene ROOT's own name is excluded, and a volatile @Control@N middle segment is kept
    // verbatim so the css suffix/contains matchers skip over it. Exercised through the full ScaleFor(id, state) path.
    private static void SceneIdentitySemantics()
    {
        // End-turn button chain: root EndTurnButton (name excluded) → Visuals → Label.
        var endTurn = StateOf(
            N("scene", null, "EndTurnButton", sceneFile: "res://scenes/combat/end_turn_button.tscn"),
            N("visuals", "scene", "Visuals"),
            N("label", "visuals", "Label"));
        var (f, rel) = SceneIdentity.Resolve("label", endTurn);
        Check.Equal(f, "res://scenes/combat/end_turn_button.tscn", "end-turn scene file");
        Check.Equal(rel, "Visuals/Label", "end-turn relPath excludes root name 'EndTurnButton'");
        Check.Close(TextScale.ScaleFor("label", endTurn), 1.54, "end-turn scales via the walk");

        // The scene ROOT itself resolves to an EMPTY relPath (path relative to, and excluding, itself).
        var (rf, rrel) = SceneIdentity.Resolve("scene", endTurn);
        Check.Equal(rf, "res://scenes/combat/end_turn_button.tscn", "root resolves its own file");
        Check.Equal(rrel, "", "root's own relPath is empty");

        // Event-option chain with a VOLATILE middle: AncientEventLayout → OptionsContainer → @Control@1328 → Text.
        var evt = StateOf(
            N("layout", null, "AncientEventLayout", sceneFile: "res://scenes/events/ancient_event_layout.tscn"),
            N("opts", "layout", "OptionsContainer"),
            N("btn", "opts", "@Control@1328"),
            N("txt", "btn", "Text"));
        var (ef, erel) = SceneIdentity.Resolve("txt", evt);
        Check.Equal(ef, "res://scenes/events/ancient_event_layout.tscn", "event layout scene file");
        Check.Equal(erel, "OptionsContainer/@Control@1328/Text", "volatile @Control middle kept verbatim");
        Check.Close(TextScale.ScaleFor("txt", evt), 1.12,
            "event option matches over the volatile middle (Contains + Suffix)");

        // Not inside any scene → (null, null) → neutral.
        var loose = StateOf(N("a", null, "A"), N("b", "a", "B"));
        var (lf, lrel) = SceneIdentity.Resolve("b", loose);
        Check.That(lf is null && lrel is null, "no ancestor scene → (null, null)");
        Check.Close(TextScale.ScaleFor("b", loose), 1.0, "no-scene node → 1.0");
    }

    // Parity: the old CosmeticAnimator computed the scene-relative path inline. Re-implement that exact walk here and
    // assert SceneIdentity.Resolve(...).RelPath equals it across representative chains (in-scene leaf, scene root,
    // not-in-scene, volatile middle) — proving the refactor preserved behavior.
    private static void SceneIdentityParityWithOldWalk()
    {
        var intent = StateOf(
            N("intentScene", null, "NIntent", sceneFile: "res://scenes/combat/intent.tscn"),
            N("holder", "intentScene", "IntentHolder"),
            N("value", "holder", "Value"),
            // A bare "Value" NOT inside intent.tscn (the co-op sibling the animator must reject).
            N("outerScene", null, "SomethingElse", sceneFile: "res://scenes/ui/other.tscn"),
            N("strayValue", "outerScene", "Value"));

        foreach (var id in new[] { "value", "intentScene", "strayValue", "holder" })
        {
            Check.Equal(SceneIdentity.Resolve(id, intent).RelPath, OldSceneRelPath(id, intent),
                $"SceneIdentity.RelPath parity with old inline walk for '{id}'");
        }

        // The bob leaf resolves the suffix the animator matched, and picks up the intent text-scale.
        Check.Equal(SceneIdentity.Resolve("value", intent).RelPath, "IntentHolder/Value", "intent bob leaf relPath");
        Check.Close(TextScale.ScaleFor("value", intent), 1.32, "intent value text-scale via walk");

        // A not-in-scene id → null (BindingFor(null) → None, the reject path).
        var orphan = StateOf(N("x", null, "X"));
        Check.That(OldSceneRelPath("x", orphan) is null && SceneIdentity.Resolve("x", orphan).RelPath is null,
            "both walks return null when not inside a scene");
    }

    // Verbatim copy of CosmeticAnimator's pre-refactor inline SceneRelPath, for the parity assertion above.
    private static string? OldSceneRelPath(string id, MirrorState state)
    {
        var names = new List<string>();
        MirrorNode? cur = state.Nodes.GetValueOrDefault(id);
        while (cur is not null)
        {
            if (cur.SceneFilePath is not null)
            {
                names.Reverse();
                return string.Join("/", names);
            }

            if (!string.IsNullOrEmpty(cur.Name))
            {
                names.Add(cur.Name);
            }

            cur = cur.ParentId is { } pid ? state.Nodes.GetValueOrDefault(pid) : null;
        }

        return null;
    }
}
