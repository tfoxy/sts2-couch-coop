using System;
using System.Text.RegularExpressions;

namespace CouchCoop.MirrorProtocol.SceneModel;

// Native port of the web mirror's per-label text-scale table (frontend/src/mirror/mirrorTextScale.css). The
// browser can't reproduce the game's text metrics on a phone, so specific labels are nudged up by a per-element
// factor — and the SAME factors are the phone adaptation for the native Godot client (there is NO separate device
// multiplier). Each css rule becomes an Entry here; the multiplier folds into FontSizePx in TextBuilder.ApplyFont.
//
// Matching mirrors the css attribute-selector ops on BOTH `data-scene-file` (File) and `data-scene-node-path`
// (RelPath), resolved by the shared SceneIdentity walk:
//   =  Exact | $= Suffix | *= Contains | ^= Prefix
// An Entry AND-combines its File condition (optional) with every Path condition; the first Entry whose conditions
// all hold wins (so more-specific, file-scoped entries are listed BEFORE the bare-suffix ones they'd overlap —
// the css specificity tie-break, reproduced by source order). No match → 1.0.
//
// NOT PORTED — the css `text-align:center` (End Turn, rewards row), `white-space:pre`, `line-height:0.95`, the
// `.godot-rich-stack width:108%/translate` hack, `text-wrap:balance` and `padding-right` are all browser-flow
// band-aids with a native analog or none. In particular the two `text-align:center` rules compensate for the web
// flex layout LOSING the game's streamed halign; native ConfigureLabel already applies the game's real halign, so
// End Turn / rewards already render as the game centers them. Live-verified: forcing HorizontalAlignment.Center on
// the End Turn label in the combat replay produced position-IDENTICAL pixels (x[1634..1872]) to leaving the game
// halign — a no-op — so the flag was dropped rather than carried as dead config. Native rich text also re-wraps
// inside its fixed box (AutowrapMode.WordSmart), the acceptable native equivalent of the wrap tweaks.
//
// Selector audit (v0.107.1 recordings): 7 combat/HUD sub-widgets were promoted into their own instanced scenes,
// truncating their scene-relative paths — those entries use the PROVEN corrected (file, relPath). States absent
// from any recording (MP HUD, event options, rest-site buttons, rewards rows) keep the old rule AND a corrected
// candidate side-by-side (marked LIVE-VERIFY); both target the same value, so whichever matches live is harmless.
public static class TextScale
{
    private enum Op
    {
        Exact,
        Suffix,
        Contains,
        Prefix,
    }

    private readonly record struct Cond(Op Op, string Value)
    {
        public bool Matches(string s) => Op switch
        {
            Op.Exact => s == Value,
            Op.Suffix => s.EndsWith(Value, StringComparison.Ordinal),
            Op.Contains => s.Contains(Value, StringComparison.Ordinal),
            Op.Prefix => s.StartsWith(Value, StringComparison.Ordinal),
            _ => false,
        };
    }

    // File is null when the css rule has no [data-scene-file] condition (bare-suffix card / health-bar / power).
    // LineHeight / ParagraphExtra are optional per-label line-spacing tuning (default null = neutral), the parallel
    // of mirrorTextScale.css's `--godot-rich-line-height` / `--godot-rich-paragraph-spacing`:
    //   LineHeight     — wrapped-line line-height RATIO (× font size). Web sets `line-height: <ratio>`; native derives
    //                    the RichTextLabel `line_separation` theme constant = round(ratio × fontPx − natural height).
    //   ParagraphExtra — extra gap at an explicit `\n` break, as an em RATIO (× font size). Web sets the block
    //                    `margin-top` (`--godot-rich-paragraph-spacing: <ratio>em`); native sets the RichTextLabel
    //                    `paragraph_separation` theme constant = round(ratio × fontPx). Godot & the web both treat `\n`
    //                    as a paragraph boundary, so this lands only between newline-separated runs.
    //   MaxSizePx / Wrap — WS-TEXT v4 optional per-label fitting (default null / false = today's behavior). MaxSizePx
    //                    CAPS the scaled font px at min(round(px×scale), MaxSizePx); Wrap turns on AutowrapMode.WordSmart
    //                    for that Label (overriding the global Off) so a capped-but-still-long string wraps within the
    //                    streamed box instead of overflowing. Both are HONORED only when the COUCHCOOP_MIRROR_TEXTSCALE_V4
    //                    switch is ON (the gate lives in TextBuilder — this table stays a pure, env-free data source).
    //   NudgeYPx — per-label vertical centring nudge (px, default 0 = neutral). TextBuilder.GrowthCenterPlain lifts
    //              the plain Label by −NudgeYPx (Top/Center streamed valign, ON TOP of the growth-centering), NEVER via
    //              raw VerticalAlignment.Center. ROUND-5: retuned to 0 for every entry — the round-5 ink matrix proved
    //              the counts were OVER-lifted, not low (see VerticalCenterNudgePx / PlacementLift). Honored only under
    //              COUCHCOOP_MIRROR_TEXTNUDGE. Web twin: a per-selector `translate: 0 -<n>px` in mirrorTextScale.css.
    private sealed record Entry(
        Cond? File, Cond[] Path, double Scale, double? LineHeight = null, double? ParagraphExtra = null,
        int? MaxSizePx = null, bool Wrap = false, int NudgeYPx = 0);

    // The resolved per-label text metrics: the font-size multiplier plus the optional line-spacing ratios above and the
    // optional WS-TEXT-v4 cap / wrap flags and the R15 vertical nudge.
    public readonly record struct TextMetrics(
        double Scale, double? LineHeight, double? ParagraphExtra, int? MaxSizePx = null, bool Wrap = false,
        int NudgeYPx = 0)
    {
        public static readonly TextMetrics Neutral = new(1.0, null, null);
    }

    // ---- WS-TXT card-description line-spacing tune (kept in lockstep with mirrorTextScale.css) ----------------------
    // Card DescriptionLabel wrapped-line line-height ratio (× font size) and the extra em gap added at an explicit
    // `\n` paragraph break. Tuned against the real game's Choose-a-Card picker; see the DescriptionLabel entry below.
    public const double CardDescLineHeight = 0.88;
    public const double CardDescParagraphExtra = 0.14;

    // ---- WS-text round-4 (P5-c): card-description +1px line height, the End-Turn precedent applied to WRAPPED rich
    // text. Kept in lockstep with mirrorTextScale.css's `--godot-rich-line-height: calc(0.88em + 1px)`. TextBuilder.
    // ApplyRichLineSpacing adds this as a flat px addend to the computed line_separation (ratio×fontPx − natural),
    // exactly like WrappedLabelLineSpacingPx's `calc(1em + 1px)` idiom for the plain-Label End Turn wrap — the addend
    // is measured PRE-block-scale (this label's font renders at scale 1.0 per R6; the 1.24 BlockScale transform then
    // visually enlarges the +1 authored px to ~+1.24 rendered px, same as every other authored metric here).
    public const int CardDescLineHeightAddendPx = 1;

    // ---- WS-TEXT v4 end-turn font-size cap (px). Kept in lockstep with mirrorTextScale.css's `min(…, <cap>px)`. ----
    // Empirically tuned so EN "End Turn 3" just fits the 162×72 button box (the cap binds; ~one line) while a longer
    // locale ("Terminar turno") wraps to two lines within the same box. Only the end-turn entry carries it.
    public const int EndTurnMaxSizePx = 34;

    // ---- WS-TEXT #16 / R8 item 12: wrapped-Label line spacing. Kept in lockstep with mirrorTextScale.css's end-turn
    // `line-height: calc(<WrappedLabelLineHeight>em + <WrappedLabelLineSpacingPx>px)`. -------------------------------
    // A two-line WordSmart-wrapped Label (only End Turn opts into Wrap today) needs a TIGHT line pitch: the game fits
    // the button's 162×72 box to ONE line at the locale's own font size, and the phone bump then has to lay two lines
    // inside that same box.
    //
    // R8 fix — the two clients were measuring the gap against DIFFERENT baselines:
    //   * web  : `line-height: calc(1em + 1px)` = fontPx + 1 (35px at the 34px cap).
    //   * native: `line_spacing` is EXTRA space added to Godot's NATURAL line box (ascent+descent), which for
    //     kreon_bold is ~1.3em — so the flat +1 gave a 45px pitch, ~10px looser per line than the web. Worse, Godot's
    //     Label only renders as many lines as FIT (`lines_visible` in label.cpp): 2×45 = 90 > 72, so the SECOND line
    //     was silently dropped — "End Turn 10" (or any locale that wraps) rendered as "End Turn" with the count gone.
    // Both now target the SAME pitch, `WrappedLabelLineHeight × fontPx + WrappedLabelLineSpacingPx`, with the native
    // constant DERIVED from the resolved font's natural height exactly like ApplyRichLineSpacing does for rich text:
    //     line_spacing = round(WrappedLabelLineHeight × fontPx − naturalHeight) + WrappedLabelLineSpacingPx
    // (NEGATIVE — the natural line box is looser than the tuned pitch).
    //
    // The 0.79 ratio is not a taste call, it is the End-Turn box arithmetic: Godot renders only as many lines as fit
    // (`total_h > ceil(boxH + line_spacing)` breaks the loop), so TWO lines need pitch ≤ boxH − natural = 72 − 44 = 28,
    // i.e. ratio ≤ (28 − 1)/34 = 0.794. Anything looser silently drops the second line. A ONE-line label is completely
    // unaffected by the constant either way — Godot subtracts one line_spacing back out when centering, so the placement
    // of the common EN "End Turn 3" is byte-identical to the pre-R8 build.
    public const double WrappedLabelLineHeight = 0.79;
    public const int WrappedLabelLineSpacingPx = 1;

    // R8 item 12: the wrapped-Label line_spacing theme constant for a font whose natural line box is `naturalPx` at
    // the rendered `fontPx`, inside a `boxHeightPx`-tall streamed box. Pure (Godot-free) so TextBuilder and the tests
    // share one implementation.
    //
    // The ratio target is CLAMPED by the box's own two-line fitting budget (see the note above): whatever the ratio
    // says, the constant is never looser than `boxHeight − 2·natural`, so a wrapped label can never lose its second
    // line on a box the ratio wasn't tuned for. Clamping DOWN is free for a single-line label (its placement does not
    // depend on line_spacing at all), so the safety net costs nothing. boxHeightPx ≤ 0 (unknown box) skips the clamp.
    public static int WrappedLabelLineSpacing(double fontPx, double naturalPx, double boxHeightPx = 0)
    {
        int target = (int)Math.Round((WrappedLabelLineHeight * fontPx) - naturalPx) + WrappedLabelLineSpacingPx;
        if (boxHeightPx <= 0)
        {
            return target;
        }

        return Math.Min(target, (int)Math.Floor(boxHeightPx - (2 * naturalPx)));
    }

    // ---- R5 vertical-centring nudge (px). Kept in lockstep with mirrorTextScale.css's `translate: 0 -Npx`. --------
    // ROUND-5 RETUNE TO MEASURED 0. The R15/round-4 story ("counts read 1-2px BELOW centre, nudge them UP") was never
    // pixel-measured (the comments said "tune live"). The round-5 A/B ink matrix over the 37-10 combat recording
    // (verify-text-align.sh / scripts docs) MEASURED the opposite: the energy/pile count ink sat ~8-10px ABOVE its box
    // centre on the shipped build, and ~0 with BOTH the growth-centering AND the nudge disabled — i.e. the compensation
    // OVER-lifted a label Godot's Center already places correctly. So the measured residual for these LOOSE-box Center
    // counts is 0: no nudge. Kept as named consts (value 0) so the (now-inert) mechanism + the mirrorTextScale.css
    // lockstep stay documented and a future per-element tweak has a home; TextBuilder.GrowthCenterPlain still subtracts
    // −NudgeYPx, so a non-zero here would lift as before. If this ever moves, the paired css `translate` MUST move too.
    public const int VerticalCenterNudgePx = 0;

    // ROUND-5: was 4 (health-bar BlockLabel + draw/discard/exhaust pile Count). Measured residual = 0 (same loose-box
    // Center story as VerticalCenterNudgePx). MP-HUD block copies this and can't be single-player-measured — LIVE-VERIFY.
    public const int BlockAndPileNudgePx = 0;

    // ---- R5 growth-centering vertical alignment (streamed-Center plain Labels) ------------------------------------
    // A per-label text-scale bump grows the font inside a box the GAME fitted to the ORIGINAL (unbumped) size. Godot's
    // VerticalAlignment.Center then places the bumped glyph — and the round-5 pixel matrix proved this splits by
    // whether the bumped glyph FITS the box:
    //   * LOOSE box (box >> glyph, e.g. the energy '3/3' 96x186 box, the 24x100 pile-count boxes): the bumped glyph
    //     still fits, so Godot Center lands it on the box centre EXACTLY as the game's unbumped glyph — no lift. The
    //     old code lifted by grow/2 anyway, shoving the count ~8px ABOVE centre (the user's report). Correct lift = 0.
    //   * TIGHT box (box ≈ glyph, e.g. the 242x31 HP bar with a ×1.42 bump whose ~44px line box OVERFLOWS the 31px
    //     box): Godot Center does NOT keep an overflowing block on the box centre — it drifts DOWN (measured +6px below
    //     the bar centre with the lift OFF, visually confirmed). Here the growth-centering IS needed. The principled,
    //     box-relative compensation is HALF the OVERFLOW: (GetHeight(scaledSize) − boxHeight)/2. Because the game fitted
    //     boxHeight ≈ GetHeight(originalSize), for a tight box this equals the legacy grow/2 — HP stays exactly where the
    //     shipped build already had it centred — while for a loose box the overflow is negative ⇒ clamped to 0.
    // A streamed-Top label keeps grow/2 unconditionally (re-seat the top-anchored block, unchanged); Bottom/Fill are
    // untouched. This helper is the pure, Godot-free math with a truth-table test.
    public enum PlacementValign
    {
        Top,
        Center,
        Bottom,
        Fill,
    }

    // Vertical UPWARD lift (px, subtracted from the box-top Y) for a growth-centered plain Label.
    //   growAll  = max(0, GetHeight(scaledSize) − GetHeight(originalSize))  — the line-box growth from the bump (≥0).
    //   overflow = GetHeight(scaledSize) − boxHeight                        — how far the bumped line box exceeds the
    //                                                                          box (may be negative = fits ⇒ no lift).
    //   nudge    = the per-entry NudgeYPx (0 after the round-5 retune).
    // Top → grow/2 (+nudge) unconditionally; Bottom/Fill → 0 (never centered/nudged — GrowthCenterPlain early-returns).
    public static float PlacementLift(PlacementValign valign, float growAll, float overflow, float nudge)
    {
        float growTerm = valign switch
        {
            PlacementValign.Top => growAll / 2f,
            PlacementValign.Center => System.Math.Max(0f, overflow) / 2f,
            _ => 0f, // Bottom / Fill — untouched
        };
        return valign is PlacementValign.Bottom or PlacementValign.Fill ? 0f : growTerm + nudge;
    }

    private static Cond Exact(string v) => new(Op.Exact, v);
    private static Cond Suffix(string v) => new(Op.Suffix, v);
    private static Cond Contains(string v) => new(Op.Contains, v);
    private static Cond Prefix(string v) => new(Op.Prefix, v);

    // Resolve a node's font-scale multiplier by walking to its owning scene, then matching the table. Cheap; call
    // only when the node actually has text (MirrorNodeView.Apply gates on that). 1.0 = neutral (no rule matched).
    public static double ScaleFor(string id, MirrorState state)
    {
        var (file, relPath) = SceneIdentity.Resolve(id, state);
        return ScaleFor(file, relPath);
    }

    // Direct (file, relPath) matcher — the same tuple the web stamps as data-scene-file / data-scene-node-path.
    // relPath is null exactly when the node is not inside any instanced scene (→ neutral 1.0).
    public static double ScaleFor(string? file, string? relPath) => MetricsFor(file, relPath).Scale;

    // Resolve a node's full text metrics (scale + optional line-spacing ratios). Same first-match-wins table as
    // ScaleFor; no match → neutral (1.0, none).
    public static TextMetrics MetricsFor(string id, MirrorState state)
    {
        var (file, relPath) = SceneIdentity.Resolve(id, state);
        return MetricsFor(file, relPath);
    }

    public static TextMetrics MetricsFor(string? file, string? relPath)
    {
        var e = Match(file, relPath);
        return e is null
            ? TextMetrics.Neutral
            : new TextMetrics(e.Scale, e.LineHeight, e.ParagraphExtra, e.MaxSizePx, e.Wrap, e.NudgeYPx);
    }

    // ---- WS-TEXT item 1: inline absolute [font_size=N] scaling ----------------------------------------------------
    // A per-label bump (TextScale multiplier) rides the theme normal_font_size, so text authored at the theme size
    // scales — but an INLINE ABSOLUTE `[font_size=N]` bbcode run (e.g. a multiattack intent template
    // "3[font_size=18]x4[/font_size]": count at theme size, "xN" multiplier at an inline absolute size) is UNAFFECTED
    // and stays visually undersized after the bump. Rewrite each inline `[font_size=N]` to `[font_size=round(N×scale)]`
    // so the whole run scales coherently (the multiplier stays proportionally smaller — its N is smaller — which is the
    // desired look). Pure/Godot-free so TextBuilder and the tests share one implementation. No-op at scale 1
    // (round(N×1)=N) or with no inline size. The WEB rich-text renderer already scales inline sizes, so no web twin.
    public static string ScaleInlineFontSizes(string raw, double scale)
    {
        if (string.IsNullOrEmpty(raw) || scale == 1.0 ||
            raw.IndexOf("[font_size=", StringComparison.OrdinalIgnoreCase) < 0)
        {
            return raw;
        }

        return InlineFontSizeRegex.Replace(raw, m =>
        {
            int n = int.Parse(m.Groups[1].Value);
            int scaled = Math.Max(1, (int)Math.Round(n * scale));
            return $"[font_size={scaled}]";
        });
    }

    private static readonly Regex InlineFontSizeRegex =
        new(@"\[font_size=(\d+)\]", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // ---- WS-TEXT item 2: scaled font-size with optional cap ------------------------------------------------------
    // The final integer font px both clients apply: round(px × scale), then (when maxSizePx is set) capped at it —
    // min(round(px×scale), maxSizePx). Shared with TextBuilder.ApplyFont so the cap math has one home + a unit test;
    // maxSizePx null (or the v4 switch OFF, decided by the caller) → the plain round, i.e. today's behavior.
    public static int ScaledFontPx(double px, double scale, int? maxSizePx = null)
    {
        int size = Math.Max(1, (int)Math.Round(px * scale));
        return maxSizePx is { } cap ? Math.Min(size, cap) : size;
    }

    // First matching entry for the (file, relPath) tuple, or null. File conditions AND-combine with every Path
    // condition; source order is the css specificity tie-break (more-specific entries listed first).
    private static Entry? Match(string? file, string? relPath)
    {
        if (relPath is null)
        {
            return null;
        }

        foreach (var e in Entries)
        {
            if (e.File is { } fc && (file is null || !fc.Matches(file)))
            {
                continue;
            }

            bool allPath = true;
            foreach (var pc in e.Path)
            {
                if (!pc.Matches(relPath))
                {
                    allPath = false;
                    break;
                }
            }

            if (allPath)
            {
                return e; // first match wins
            }
        }

        return null;
    }

    // css res:// scene-file constants.
    private const string HoverTip = "res://scenes/ui/hover_tip.tscn";
    private const string TopBar = "res://scenes/ui/top_bar.tscn";
    private const string TopBarDeckButton = "res://scenes/ui/top_bar/top_bar_deck_button.tscn";
    private const string EndTurnButton = "res://scenes/combat/end_turn_button.tscn";
    private const string StarCounter = "res://scenes/combat/energy_counters/star_counter.tscn";
    private const string DrawPile = "res://scenes/combat/draw_pile.tscn";
    private const string DiscardPile = "res://scenes/combat/discard_pile.tscn";
    private const string ExhaustPile = "res://scenes/combat/exhaust_pile.tscn";
    private const string Intent = "res://scenes/combat/intent.tscn";
    private const string Power = "res://scenes/combat/power.tscn";
    private const string Relic = "res://scenes/relics/relic.tscn";
    private const string Orb = "res://scenes/orbs/orb.tscn";
    private const string Run = "res://scenes/run.tscn";
    private const string MultiplayerPlayerState = "res://scenes/ui/multiplayer_player_state.tscn";
    private const string AncientEventLayout = "res://scenes/events/ancient_event_layout.tscn";
    private const string DefaultEventLayout = "res://scenes/events/default_event_layout.tscn";
    private const string AncientEventOptionButton = "res://scenes/events/ancient_event_option_button.tscn";
    private const string EventOptionButton = "res://scenes/events/event_option_button.tscn";
    private const string RestSiteRoom = "res://scenes/rooms/rest_site_room.tscn";
    private const string RestSiteButton = "res://scenes/rest_site/rest_site_button.tscn";
    private const string ProceedButton = "res://scenes/ui/proceed_button.tscn";
    private const string MerchantInventory = "res://scenes/merchant/merchant_inventory.tscn";
    private const string MerchantCard = "res://scenes/merchant/merchant_card.tscn";
    private const string MerchantPotion = "res://scenes/merchant/merchant_potion.tscn";
    private const string MerchantRelic = "res://scenes/merchant/merchant_relic.tscn";
    private const string MerchantCardRemoval = "res://scenes/merchant/merchant_card_removal.tscn";
    private const string RewardsScreen = "res://scenes/screens/rewards_screen.tscn";
    private const string RewardButton = "res://scenes/rewards/reward_button.tscn";

    // Order = css source order, with file-scoped/multi-condition entries kept AHEAD of the bare-suffix entries they
    // could overlap (MP HUD HP/Block before the general health-bar suffix), reproducing css specificity via first-
    // match-wins. See mirrorTextScale.css for the authoritative per-label rationale and the LIVE-VERIFY notes.
    private static readonly Entry[] Entries =
    {
        // ---- ui/hover_tip.tscn (VALID) — Title under HBoxContainer, Description directly under VBoxContainer.
        // 1.08/1.08: the hover-tip Title/Description bump was softened from 1.20 (the tip text was reading too large
        // on the phone; kept in lockstep with mirrorTextScale.css).
        new(Exact(HoverTip), [Exact("TextContainer/VBoxContainer/HBoxContainer/Title")], 1.08),
        new(Exact(HoverTip), [Exact("TextContainer/VBoxContainer/Description")], 1.08),

        // ---- Cards (card.tscn) — reusable component folded into many scenes; match the stable internal suffix
        // (VALID against every combat recording). No scene-file scope, works in hand / shop / rewards / deck view.
        // The card description also carries the line-spacing tune (WS-TXT): tighter WRAPPED lines + a slightly larger
        // gap at explicit `\n` breaks, to match the game. Values live here AND in mirrorTextScale.css (parallel).
        //
        // R6 block-scale: the DescriptionLabel + TypeLabel FONT scales drop to 1.0 — the enlargement now rides a
        // TRANSFORM scale (BlockScale table → MirrorNodeView.FoldCosmetic), so the font lays out at the game's REAL
        // size (byte-identical line breaks) and the glyphs are transform-scaled instead. The line-spacing ratios are
        // KEPT (they are font-relative, so they scale with the transform and stay tuned). Title / Energy / Star are
        // unchanged (they keep font-size scaling — Title is one line, Energy/Star are single glyphs).
        new(null, [Suffix("CardContainer/DescriptionLabel")], 1.0, LineHeight: CardDescLineHeight, ParagraphExtra: CardDescParagraphExtra),
        new(null, [Suffix("CardContainer/TitleLabel")], 1.14),
        new(null, [Suffix("CardContainer/TypePlaque/TypeLabel")], 1.0),
        new(null, [Suffix("CardContainer/EnergyIcon/EnergyLabel")], 1.24),
        new(null, [Suffix("CardContainer/StarIcon/StarLabel")], 1.24),
        new(null, [Suffix("CardContainer/Enchantment/Label")], 1.24),

        // ---- ui/top_bar.tscn (VALID).
        new(Exact(TopBar), [Exact("LeftAlignedStuff/TopBarHp/HpLabel")], 1.20),
        new(Exact(TopBar), [Exact("LeftAlignedStuff/TopBarGold/GoldLabel")], 1.20),
        new(Exact(TopBar), [Exact("LeftAlignedStuff/RoomIcons/FloorIcon/FloorNumLabel")], 1.12),
        new(Exact(TopBar), [Exact("RightAlignedStuff/TimerContainer/TimerLabel")], 1.08),

        // ---- Deck count (STALE #1 → top_bar_deck_button.tscn :: DeckCardCount). v0.107.1 promoted the deck button
        // into its own scene; sample "13".
        new(Exact(TopBarDeckButton), [Exact("DeckCardCount")], 1.24),

        // ---- Energy counter (STALE #2 → per-character *_energy_counter.tscn :: Label). File SUFFIX covers every
        // character variant (defect/ironclad/regent/silent); sample "3/3", a LOOSE box (96x186). ROUND-5: NudgeYPx
        // back to 0 (measured) — the growth-centering + nudge shoved it ~8px above centre; the overflow rule now leaves
        // this loose-box Center label on Godot's own centre (== the game).
        new(Suffix("_energy_counter.tscn"), [Exact("Label")], 1.24, NudgeYPx: VerticalCenterNudgePx),

        // ---- End turn (STALE #3 → end_turn_button.tscn :: Visuals/Label). css text-align:center NOT ported (native
        // honors the game's real halign; live-verified no-op — see the class note above). WS-TEXT v4: the streamed
        // FontSizePx is the game's per-LOCALE fitted size, so the 1.54 phone bump overshoots the 162×72 box (EN "End
        // Turn 3" fits at the game's 30 → 1.54 = 46 px, grossly overflowing). Cap at MaxSizePx and allow a two-line
        // WordSmart wrap: EN binds the cap and stays ~one line; a longer locale ("Terminar turno") wraps to two lines.
        // MaxSizePx tuned empirically against the 40-09 combat recording's real button box — see the WS-TEXT report.
        new(Exact(EndTurnButton), [Exact("Visuals/Label")], 1.54, MaxSizePx: EndTurnMaxSizePx, Wrap: true),

        // ---- Star counter (STALE #4 → star_counter.tscn :: MarginContainer/CountLabel). ROUND-5: NudgeYPx 0
        // (shares VerticalCenterNudgePx). Absent from the settled 37-10 frame (no stars) — validated by analogy to
        // energy/piles (same loose-box Center regime) + LIVE-VERIFY on device.
        new(Exact(StarCounter), [Exact("MarginContainer/CountLabel")], 1.24, NudgeYPx: VerticalCenterNudgePx),

        // ---- Pile counts — draw/discard promoted to their own scenes (STALE #5/#6); exhaust already scene-scoped.
        // ROUND-5: NudgeYPx back to 0 (BlockAndPileNudgePx). The round-5 ink matrix measured draw/discard ~-8.5px
        // (above centre) on the shipped build → ~0 with the compensation off; the overflow rule leaves these loose-box
        // Center counts on Godot's centre (== the game).
        // R9 (WS-B) 1.24 → 1.16 (user decision): these three counts are the ONLY text-scale rules whose owning widget
        // is ALSO view-scaled (ViewScale's 1.25 pile stamps — R8 for draw/discard, R9 for exhaust). The two multiply,
        // so a 1.24 count rendered 1.55× the game's size and overflowed the enlarged button; 1.16 · 1.25 ≈ 1.45 keeps
        // the digits inside the disc while still reading bigger than the game. NOTHING else moves — the star / energy /
        // deck counters stay at 1.24 (they are not view-scaled). Web twin: mirrorTextScale.css.
        new(Exact(DrawPile), [Exact("CountContainer/Count")], 1.16, NudgeYPx: BlockAndPileNudgePx),
        new(Exact(DiscardPile), [Exact("CountContainer/Count")], 1.16, NudgeYPx: BlockAndPileNudgePx),
        new(Exact(ExhaustPile), [Exact("CountContainer/Count")], 1.16, NudgeYPx: BlockAndPileNudgePx),

        // ---- combat/intent.tscn (VALID).
        new(Exact(Intent), [Exact("IntentHolder/Value")], 1.32),

        // ---- Powers (STALE #7 → power.tscn :: AmountLabel, bare). Scene-file scoping to power.tscn keeps this rule
        // from matching relics/relic.tscn's own AmountLabel (which has its OWN entry below) just as the old
        // *PowerContainer/ scope did.
        new(Exact(Power), [Exact("AmountLabel")], 1.48),

        // ---- Relic stack count and orb passive/evoke values. The inventory holder instances relic.tscn, so its
        // AmountLabel resolves here; all three counts use the user-selected 1.48 multiplier.
        new(Exact(Relic), [Exact("AmountLabel")], 1.48),
        new(Exact(Orb), [Exact("LabelContainer/PassiveAmount")], 1.48),
        new(Exact(Orb), [Exact("LabelContainer/EvokeAmount")], 1.48),

        // ---- Multiplayer HUD (LIVE-VERIFY) — single-player recordings can't exercise these. Old run.tscn rules kept
        // (harmless: won't match once the widget is its own scene) + corrected multiplayer_player_state.tscn
        // candidates (same values). Both listed BEFORE the general health-bar suffix so the MP HP/Block win when the
        // old form matches. NOTE: the MP widget's HealthBar is an instance of health_bar.tscn, so live its Hp/Block
        // resolve to the general suffix rule below (1.42) — indistinguishable from creature bars by (file,relPath);
        // no separate MP HP/Block candidate is added (it would corrupt every creature bar). Live: confirm.
        new(Exact(Run), [Contains("MultiplayerPlayerContainer/"), Suffix("TopInfoContainer/NameplateLabel")], 1.08),
        new(Exact(Run), [Contains("MultiplayerPlayerContainer/"), Suffix("TopInfoContainer/EnergyCountContainer/EnergyCount")], 1.40),
        new(Exact(Run), [Contains("MultiplayerPlayerContainer/"), Suffix("TopInfoContainer/StarCountContainer/StarCount")], 1.40),
        new(Exact(Run), [Contains("MultiplayerPlayerContainer/"), Suffix("TopInfoContainer/CardCountContainer/CardCount")], 1.40),
        new(Exact(Run), [Contains("MultiplayerPlayerContainer/"), Suffix("HealthBar/HpBarContainer/HpLabel")], 1.32),
        new(Exact(Run), [Contains("MultiplayerPlayerContainer/"), Suffix("HealthBar/BlockContainer/BlockLabel")], 1.40, NudgeYPx: BlockAndPileNudgePx), // ROUND-5: block nudge 0 (lockstep with bare-suffix + web translate); MP-HUD unmeasurable single-player — LIVE-VERIFY
        new(Exact(MultiplayerPlayerState), [Exact("TopInfoContainer/NameplateLabel")], 1.08),                        // LIVE-VERIFY
        new(Exact(MultiplayerPlayerState), [Exact("TopInfoContainer/EnergyCountContainer/EnergyCount")], 1.40),      // LIVE-VERIFY
        new(Exact(MultiplayerPlayerState), [Exact("TopInfoContainer/StarCountContainer/StarCount")], 1.40),          // LIVE-VERIFY
        new(Exact(MultiplayerPlayerState), [Exact("TopInfoContainer/CardCountContainer/CardCount")], 1.40),          // LIVE-VERIFY

        // ---- Health-bar HP/Block (VALID) — reusable health_bar.tscn folded into creatures; bare suffix covers all.
        // ROUND-5: BlockLabel NudgeYPx back to 0 (BlockAndPileNudgePx). NOTE the HpLabel here is the round-5 TIGHT-box
        // control: its ×1.42 bump OVERFLOWS the ~31px bar box, so GrowthCenterPlain's overflow rule keeps its lift
        // (matches the shipped, correctly-centred HP) while dropping it for the loose-box counts. HP carries no nudge.
        new(null, [Suffix("HpBarContainer/HpLabel")], 1.42),
        new(null, [Suffix("BlockContainer/BlockLabel")], 1.42, NudgeYPx: BlockAndPileNudgePx),

        // ---- Event option buttons (LIVE-VERIFY) — old layout-scoped rules + corrected option-button-scene candidates.
        new(Exact(AncientEventLayout), [Contains("OptionsContainer/"), Suffix("/Text")], 1.12),
        new(Exact(DefaultEventLayout), [Contains("OptionsContainer/"), Suffix("/Text")], 1.12),
        new(Exact(AncientEventOptionButton), [Exact("HBoxContainer/Text")], 1.12),                                   // LIVE-VERIFY
        new(Exact(EventOptionButton), [Exact("Text")], 1.12),                                                        // LIVE-VERIFY

        // ---- Rest site — choices (LIVE-VERIFY): old room-scoped rule + corrected rest_site_button.tscn candidate;
        // Description authored in the room scene (likely VALID).
        new(Exact(RestSiteRoom), [Prefix("ChoicesScreen/ChoicesContainer/"), Suffix("/Label")], 1.16),
        new(Exact(RestSiteButton), [Exact("Label")], 1.16),                                                          // LIVE-VERIFY
        new(Exact(RestSiteRoom), [Exact("ChoicesScreen/Description")], 1.20),

        // ---- ui/proceed_button.tscn (VALID).
        new(Exact(ProceedButton), [Exact("Image/Label")], 1.08),

        // ---- Merchant item costs (per merchant audit: per-type scenes look correct; inventory umbrella kept). As-is.
        new(Exact(MerchantInventory), [Suffix("Cost/CostLabel")], 1.20),
        new(Exact(MerchantCard), [Exact("Cost/CostLabel")], 1.20),
        new(Exact(MerchantPotion), [Exact("Cost/CostLabel")], 1.20),
        new(Exact(MerchantRelic), [Exact("Cost/CostLabel")], 1.20),
        new(Exact(MerchantCardRemoval), [Exact("Cost/CostLabel")], 1.20),

        // ---- Rewards rows (LIVE-VERIFY) — old rewards_screen.tscn rule + corrected reward_button.tscn candidate.
        // css text-align:center NOT ported (native honors the game halign; same reasoning as End Turn).
        new(Exact(RewardsScreen), [Suffix("LabelContainer/Label")], 1.32),
        new(Exact(RewardButton), [Exact("LabelContainer/Label")], 1.32),                                             // LIVE-VERIFY
    };
}
