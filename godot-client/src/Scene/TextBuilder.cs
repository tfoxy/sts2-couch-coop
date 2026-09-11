// Configures the child Label / RichTextLabel that renders a mirror node's text (WS-F). Faithful port of the web's
// text pipeline (frontend/src/mirror/nodeStyles.ts textStyle L464-515 + richHtml L516-523):
//   - placement : the label is a Control child of the node's Node2D; it takes the node's localRect box directly
//                 (Position/Size — NEVER anchors/containers; the wire streams final rects).
//   - font      : family/size from MirrorFont + MirrorText.fontSizePx (already folds appliedFontSize in the
//                 reader), fetched via FontStore; falls back to the default theme font until the file arrives.
//   - align     : halign/valign → Godot Label Horizontal/VerticalAlignment (the flex justify/align the web used).
//   - color     : text.colorHtml → font_color (Label) / default_color (RichTextLabel).
//   - outline   : volatile text.outlineColor/Size take precedence over the stale node.outline (web L487-492),
//                 applied via font_outline_color + outline_size theme overrides.
//   - shadow    : node.shadow → font_shadow_color + shadow_offset_x/y.
//   - selfMod   : the owner's self_modulate does NOT reach child nodes, so its rgb×selfAlpha is folded into the
//                 label's Modulate (the owner's cascading Modulate already reaches the label — not re-applied).
//   - rich text : Godot RichTextLabel with BbcodeEnabled; the STS2 custom BBCode tags (DEFAULT_BBCODE_TAGS) are
//                 rewritten to native BBCode (color aliases → [color=#hex]) or stripped (animated effect tags).

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public static partial class TextBuilder
{
    // Native Godot renders text outlines with the SAME engine the game used, and the producer streams the game's
    // real outline_size — so the faithful native outline is the FULL value (scale 1). The web's OUTLINE_SCALE=0.5
    // (nodeStyles.ts L37) is a CSS `-webkit-text-stroke` compensation (that stroke renders ~2× too thick); porting
    // it here would double-compensate and render outlines HALF the game's thickness. See WS-F report.
    private const double OutlineScale = 1.0;

    // Item 1: rewrite inline absolute [font_size=N] bbcode to round(N×textScale) so a bumped label's inline sizes
    // (multiattack intent "xN" multiplier) scale coherently with the theme size.

    // Items 2 + 9 (gated together): the end-turn font-size CAP + two-line WordSmart wrap (per-entry MaxSizePx / Wrap),
    // and the growth-centering of scaled plain Labels (a scaled Top label centers on its box instead of overflowing
    // downward).

    // R15 (item 15): the per-entry vertical-centring nudge (NudgeYPx) that lifts a plain Label by −nudge in
    // GrowthCenterPlain (energy/star/pile counts + health-bar block, off 1-2px after the phone bump).

    // R5 (text centering fix): a streamed-Center plain Label gets the growth-centering lift ONLY when its bumped glyph
    // OVERFLOWS the box (a tight box the game fitted to the unbumped size — e.g. the HP bar). A LOOSE-box Center label
    // (the energy/pile counts) is already placed on the box centre by Godot's Center, so the legacy grow/2 lift shoved
    // it ~8px too high. See TextScale.PlacementLift for the pure math + test.

    private const string FontUrlMeta = "__mirrorFontUrl";

    // PER-ROLE fetch guards. The single FontUrlMeta guard cannot serve the role slots: two roles on the SAME label
    // fetching DIFFERENT files would each find the other's url in the meta when their callback settled and drop
    // their own apply (last writer wins the meta, so at most one role would ever land).
    private const string BoldFontUrlMeta = "__mirrorRichBoldFontUrl";
    private const string ItalicFontUrlMeta = "__mirrorRichItalicFontUrl";
    private const string BoldItalicFontUrlMeta = "__mirrorRichBoldItalicFontUrl";

    private static readonly string[] LabelFontSlots = { "font" };
    private static readonly string[] LabelSizeSlots = { "font_size" };

    // Godot 4 RichTextLabel theme item names. `italics_font` / `bold_italics_font` are the CORRECT spellings: the
    // pre-fix list said `italic_font` / `bold_italic_font`, which are not Godot 4 theme items at all, so those two
    // overrides were SILENT NO-OPS (an [i] span fell through to the default theme font and the default theme size).
    private const string RtlNormalFontSlot = "normal_font";
    private const string RtlBoldFontSlot = "bold_font";
    private const string RtlItalicFontSlot = "italics_font";
    private const string RtlBoldItalicFontSlot = "bold_italics_font";
    private const string RtlMonoFontSlot = "mono_font";

    // Every role slot, for the callers that want the node's own font everywhere (see RtlOwnFontSlots).
    private static readonly string[] RtlFontSlots =
        { RtlNormalFontSlot, RtlBoldFontSlot, RtlItalicFontSlot, RtlBoldItalicFontSlot, RtlMonoFontSlot };

    private static readonly string[] RtlSizeSlots =
        { "normal_font_size", "bold_font_size", "italics_font_size", "bold_italics_font_size", "mono_font_size" };

    // Which slots the node's OWN font fills, given which roles the producer streamed a real font for. Indexed by
    // bit0 = RichBoldFont, bit1 = RichItalicFont, bit2 = RichBoldItalicFont (see RichRoleMask). A role WITH a
    // streamed font is excluded here and pointed at that file by ApplyRichRoleFonts — leaving it in BOTH lists
    // would let ApplyFont's async settle clobber the role face back to the normal one whenever the two fetches
    // resolve in the unlucky order. A role WITHOUT one keeps the existing in-family fallback (a stray [b] stays in
    // the label's own face rather than dropping to Godot's default theme font).
    private static readonly string[][] RtlOwnFontSlots = BuildOwnFontSlotTable();

    private static string[][] BuildOwnFontSlotTable()
    {
        var table = new string[8][];
        for (int mask = 0; mask < table.Length; mask++)
        {
            bool bold = (mask & 1) != 0;
            bool italic = (mask & 2) != 0;
            bool boldItalic = (mask & 4) != 0;
            var slots = new List<string> { RtlNormalFontSlot, RtlMonoFontSlot };
            if (!bold)
            {
                slots.Add(RtlBoldFontSlot);
            }

            if (!italic)
            {
                slots.Add(RtlItalicFontSlot);
            }

            // The bold-italic slot is covered by the bold role too (its fallback), so the own font only fills it
            // when NEITHER is streamed.
            if (!boldItalic && !bold)
            {
                slots.Add(RtlBoldItalicFontSlot);
            }

            table[mask] = slots.ToArray();
        }

        return table;
    }

    // ---- public entry points --------------------------------------------------------------------------------

    public static void ConfigureLabel(
        Label label, MirrorNode node, double textScale, int? maxSizePx = null, bool wrap = false, int nudgeYPx = 0)
    {
        var text = node.Text!;
        PlaceControl(label, node);
        // Item 2: a per-entry Wrap opts this Label into WordSmart wrapping (End Turn wraps to two lines within its box);
        // every other label keeps the single-line / explicit-\n Off default the streamed localRect was fitted for.
        label.AutowrapMode = wrap ? TextServer.AutowrapMode.WordSmart : TextServer.AutowrapMode.Off;
        label.ClipText = false;

        label.HorizontalAlignment = MapHalign(text.Halign);
        label.VerticalAlignment = MapValign(text.Valign); // keep the streamed valign; item 9 nudges by POSITION, not align
        label.Text = text.Text;

        if (ParseHtml(text.ColorHtml) is { } col)
        {
            label.AddThemeColorOverride("font_color", col);
        }
        else
        {
            label.RemoveThemeColorOverride("font_color");
        }

        ApplyOutlineAndShadow(label, node);
        // Item 9 growth-centering rides ApplyFont's afterApply hook so it recomputes off the REAL font metrics once an
        // async font fetch settles (the offset depends on the font's line heights at the original vs scaled size).
        ApplyFont(label, node, LabelFontSlots, LabelSizeSlots, textScale,
            afterApply: () =>
            {
                // R8 item 12: the wrapped-line pitch is measured off the RESOLVED font, so it rides the same
                // afterApply hook as the growth-centering (and is recomputed once an async font fetch settles).
                // Applied BEFORE GrowthCenterPlain — the lift reads the same font metrics but not the constant.
                ApplyWrappedLineSpacing(label, node, textScale, wrap, maxSizePx);
                GrowthCenterPlain(label, node, textScale, maxSizePx, nudgeYPx);
            },
            maxSizePx: maxSizePx);
        ApplyModulate(label, node);
    }

    // ---- R8 item 12: wrapped plain-Label line spacing ------------------------------------------------------------

    // Godot's Label `line_spacing` theme constant is EXTRA space added to the font's NATURAL line box
    // (ascent+descent ≈ 1.3em for kreon_bold) — NOT a line height. The web's twin rule is a CSS `line-height`, i.e. an
    // ABSOLUTE pitch. Setting the constant to a flat +1 (the pre-R8 code) therefore made the native pitch ~10px looser
    // per line than the web at the End-Turn cap, and pushed a two-line wrap over the button's 72px box — at which
    // point Godot's own `lines_visible` fitting loop (scene/gui/label.cpp) DROPS the second line, so "End Turn 10"
    // rendered as "End Turn". Derive the constant from the resolved font's natural height instead, exactly like
    // ApplyRichLineSpacing does for RichTextLabel, so both clients hit the same target pitch
    // (TextScale.WrappedLabelLineHeight × fontPx + WrappedLabelLineSpacingPx).
    //
    // Only a Wrap entry (End Turn today) under the v4 switch gets an override; every other Label REMOVES it and keeps
    // Godot's default, byte-identical to before. Idempotent Add/Remove across re-syncs + the async font re-apply.
    private static void ApplyWrappedLineSpacing(Label label, MirrorNode node, double scale, bool wrap, int? maxSizePx)
    {
        if (!wrap || node.Text!.FontSizePx is not { } px)
        {
            label.RemoveThemeConstantOverride("line_spacing");
            return;
        }

        int size = TextScale.ScaledFontPx(px, scale, maxSizePx); // the ACTUAL rendered size (honours the cap)
        Font? font = label.HasThemeFontOverride("font") ? label.GetThemeFont("font") : null;
        font ??= label.GetThemeDefaultFont();
        double natural = font is not null ? font.GetHeight(size) : size;
        double boxHeight = node.LocalRect?.Height ?? 0;
        label.AddThemeConstantOverride("line_spacing", TextScale.WrappedLabelLineSpacing(size, natural, boxHeight));
    }

    // ---- item 9: plain-Label growth-centering ---------------------------------------------------------------------

    // A per-label TextScale bump grows the font inside a box the GAME fitted to the ORIGINAL (unbumped) size. Godot's
    // VerticalAlignment.Center (the game streams Center for these HUD labels) then places the bumped glyph — and the
    // round-5 pixel matrix (verify-text-align.sh over the 37-10 combat recording) proved the correct compensation
    // splits by whether the bumped glyph FITS the box:
    //   * LOOSE box (box >> glyph — the energy '3/3' 96×186 box, the 24×100 pile-count boxes): the bumped glyph still
    //     fits, so Godot Center lands it on the box centre EXACTLY as the game's unbumped glyph. The old code lifted by
    //     grow/2 REGARDLESS, shoving the count ~8px ABOVE centre (the user's report). Correct lift here = 0.
    //   * TIGHT box (box ≈ glyph — the HP bar: a ×1.42 bump whose ~44px line box OVERFLOWS the 31px box): Godot Center
    //     does NOT keep an overflowing block on the box centre; it drifts DOWN (measured +6px below the bar centre with
    //     the lift OFF, visually confirmed). Here the growth-centering IS needed. The box-relative compensation is HALF
    //     the OVERFLOW: (height(scaledSize) − boxHeight)/2. Because the game fitted boxHeight ≈ height(originalSize),
    //     for a tight box this equals the legacy grow/2 — HP stays exactly where the shipped build had it centred.
    // A streamed-Top label keeps grow/2 unconditionally (re-seat the top-anchored block, unchanged). No-op at scale 1,
    // a Bottom/Fill streamed valign; RichTextLabels go through CenterRichVertically, never here. PlaceControl
    // reset Position.Y to the box top on this same ConfigureLabel call, so we recompute the lift from the box top
    // (idempotent across re-syncs and the async font re-apply). The pure lift math lives in TextScale.PlacementLift.
    private static void GrowthCenterPlain(Label label, MirrorNode node, double scale, int? maxSizePx, int nudgeYPx)
    {
        var text = node.Text!;
        var box = node.LocalRect;
        var valign = MapValign(text.Valign);
        // The compensation only touches a Top/Center streamed valign and needs a box to anchor off. Bottom/Fill and
        // box-less labels keep the box-top placement.
        if (box is not { } b || valign is not (VerticalAlignment.Top or VerticalAlignment.Center))
        {
            return;
        }

        // Line-box growth (Top path) + box overflow (Center path), only under the v4 switch and a REAL scale-up. Both
        // read the SAME font metric so a Center label's overflow and a Top label's growth stay drain-coherent.
        float growAll = 0f, overflow = 0f;
        if (scale != 1.0 && text.FontSizePx is { } px)
        {
            int originalSize = Math.Max(1, (int)Math.Round(px));
            int scaledSize = TextScale.ScaledFontPx(px, scale, maxSizePx); // the ACTUAL rendered size (honours the cap)

            Font? font = label.HasThemeFontOverride("font") ? label.GetThemeFont("font") : null;
            font ??= label.GetThemeDefaultFont();
            if (font is not null)
            {
                float scaledHeight = font.GetHeight(scaledSize);
                growAll = Math.Max(0f, scaledHeight - font.GetHeight(originalSize));
                overflow = scaledHeight - (float)b.Height; // >0 only for a tight box the bumped glyph overflows
            }
        }

        // Per-entry constant nudge, applied ON TOP of the growth-centering (0 for every entry after the round-5 retune;
        // gated by its own switch). NEVER via raw VerticalAlignment.Center.
        float nudge = nudgeYPx;

        var pv = valign == VerticalAlignment.Center ? TextScale.PlacementValign.Center : TextScale.PlacementValign.Top;
        float lift = TextScale.PlacementLift(pv, growAll, overflow, nudge);
        if (lift == 0f)
        {
            return; // nothing to compensate → leave the box-top placement untouched
        }

        // Anchored off the box TOP (not the live Position) so it's idempotent across re-syncs AND the async font
        // re-apply (PlaceControl reset Position to the box top this call).
        label.Position = new Vector2(label.Position.X, (float)b.Y - lift);
    }

    public static void ConfigureRich(
        RichTextLabel rtl,
        MirrorNode node,
        double textScale,
        double? lineHeightRatio = null,
        double? paragraphExtraEm = null,
        TextureStore? textures = null)
    {
        var text = node.Text!;
        PlaceControl(rtl, node);
        rtl.BbcodeEnabled = true;
        rtl.ScrollActive = false;
        rtl.AutowrapMode = TextServer.AutowrapMode.WordSmart; // descriptions wrap within the card box
        rtl.FitContent = false;
        // Godot's RichTextLabel defaults clip_contents=TRUE, so TextScale-bumped rich content (card DescriptionLabel,
        // hover-tip Description, [img]-bearing cost labels) is CLIPPED at the streamed node rect. The web renders rich
        // text overflow-visible, so disable clipping and let CenterRichVertically spill the overflow per valign.
        rtl.ClipContents = false;

        // Item #20b: honor the game's streamed horizontal alignment. Godot 4.3+ gives RichTextLabel a real
        // HorizontalAlignment property, and the producer streams the RTL's actual horizontal_alignment via
        // text.layout.horizontalAlignment — but (unlike ConfigureLabel) this path used to ignore it, so every rich
        // label the game centers/right-aligns rendered LEFT: the rest-site Smith description ("Upgrade a card in your
        // deck.", streamed Center), event descriptions, merchant dialogue, and the right-aligned "Game Saved"
        // indicator. Set it as the DEFAULT paragraph alignment. This is byte-identical for the common case (streamed
        // Left == the RTL default) and does NOT fight a card description's inner [center]…[/center] bbcode, which is
        // replayed per-paragraph via PushParagraph (BuildRichContent) / parsed by Godot and overrides the default.
        // Web parity: nodeStyles sets justify-content, but a full-width .godot-rich-stack needs a per-node
        // text-align — see the rest-site Description rule in mirrorTextScale.css.
        rtl.HorizontalAlignment = MapHalign(text.Halign);

        BuildRichContent(rtl, node, textScale, textures);

        if (ParseHtml(text.ColorHtml) is { } col)
        {
            rtl.AddThemeColorOverride("default_color", col);
        }
        else
        {
            rtl.RemoveThemeColorOverride("default_color");
        }

        ApplyOutlineAndShadow(rtl, node);

        // Line-spacing depends on the resolved font's metrics, so apply it (and re-center, since content height
        // shifts) from ApplyFont's afterApply hook — which fires now AND again when an async font fetch settles.
        // The node's own font fills every role slot the producer did NOT stream a distinct face for (see
        // RtlOwnFontSlots); the streamed roles are pointed at their own files right after.
        ApplyFont(rtl, node, RtlOwnFontSlots[RichRoleMask(node)], RtlSizeSlots, textScale, afterApply: () =>
        {
            ApplyRichLineSpacing(rtl, node, textScale, lineHeightRatio, paragraphExtraEm);
            CenterRichVertically(rtl, node);
        });
        ApplyRichRoleFonts(rtl, node);

        ApplyModulate(rtl, node);
    }

    // ---- rich-text line / paragraph spacing (WS-TXT) --------------------------------------------------------------

    // Apply the tuned line-spacing to a RichTextLabel via Godot's theme constants. BOTH constants are measured
    // relative to the resolved font's NATURAL line height (ascent+descent at `size`), because Godot derives each
    // gap from the natural metrics, not from each other:
    //   line_separation      — added to each WRAPPED line's descent WITHIN a paragraph. Set so the wrapped pitch =
    //                          lineHeightRatio × fontPx  →  line_separation = round(lineHeightRatio×fontPx − natural).
    //                          WS-text round-4 (P5-c): a flat +CardDescLineHeightAddendPx (1px) is added ON TOP of
    //                          that ratio target — the End-Turn precedent (WrappedLabelLineSpacingPx's plain-Label
    //                          `calc(1em + 1px)`) applied here to wrapped RICH text. The addend is authored PRE the
    //                          card's separate BlockScale transform (this label's font renders at scale 1.0 per R6),
    //                          so it renders ~CardBlockScale× larger on screen — same convention as every other
    //                          authored metric in this table.
    //   paragraph_separation — added AFTER a paragraph's last line, i.e. at an explicit `\n` break (Godot treats `\n`
    //                          as a paragraph boundary). Crucially Godot does NOT fold line_separation into the
    //                          paragraph boundary — it starts from the NATURAL line box — so this must ALSO be
    //                          measured off natural to hit the target paragraph pitch (lineHeightRatio+paragraphExtra)
    //                          × fontPx: paragraph_separation = round((lineHeightRatio+paragraphExtra)×fontPx − natural)
    //                          (usually negative — the game's natural line box is looser than the tuned pitch). The
    //                          round-4 line-height addend deliberately does NOT fold into this — item P5-c scoped it
    //                          to wrapped-line height only, not the explicit-newline paragraph gap.
    // Web parity: the CSS block gets `line-height: lineHeightRatio` (wrapped, now `calc(<ratio>em + 1px)` per the
    // round-4 addend) and a `margin-top: paragraphExtra·em` between blocks — the same target both clients hit.
    // Null lineHeightRatio removes both overrides (neutral, Godot default). Values live in TextScale (const) + css.
    private static void ApplyRichLineSpacing(
        RichTextLabel rtl, MirrorNode node, double scale, double? lineHeightRatio, double? paragraphExtraEm)
    {
        if (node.Text!.FontSizePx is not { } px || lineHeightRatio is not { } lh)
        {
            rtl.RemoveThemeConstantOverride("line_separation");
            rtl.RemoveThemeConstantOverride("paragraph_separation");
            return;
        }

        int size = Math.Max(1, (int)Math.Round(px * scale));

        // The effective normal-role font (our fetched font once it arrives, else the theme default). GetHeight is
        // ascent+descent at `size` — the natural line box every gap is measured against.
        Font? font = rtl.HasThemeFontOverride("normal_font") ? rtl.GetThemeFont("normal_font") : null;
        font ??= rtl.GetThemeDefaultFont();
        double natural = font is not null ? font.GetHeight(size) : size;

        rtl.AddThemeConstantOverride(
            "line_separation", (int)Math.Round((lh * size) - natural) + TextScale.CardDescLineHeightAddendPx);

        double paragraphRatio = lh + (paragraphExtraEm ?? 0);
        rtl.AddThemeConstantOverride("paragraph_separation", (int)Math.Round((paragraphRatio * size) - natural));
    }

    // ---- rich-text content (inline energy-orb [img] support, WS-TXT) ----------------------------------------------

    private const string RichSigMeta = "__mirrorRichSig";

    // Re-entrancy guard for the orb build. TextureStore.Request fires its callback SYNCHRONOUSLY on a warm
    // (disk-cache) hit — i.e. WHILE BuildRichContent is still appending — which would otherwise rebuild the label
    // nested inside its own build and DOUBLE the content ("Gain [orbs].[orbs]."). While a build is in progress the
    // callback is a no-op: the just-cached texture is already picked up by the SAME build via Request's return value.
    // Main-thread-only (Godot single-threaded scene work), so a plain static flag is sufficient.
    private static bool _buildingRich;

    // Populate the RichTextLabel's content. No inline `[img]` → the simple path: hand the (color-alias-preprocessed)
    // bbcode to Godot's own parser via the Text property, exactly as before. WITH inline images → build the label
    // PROGRAMMATICALLY so each `[img]res://…[/img]` becomes an AddImage: the local ResourceLoader cannot load the
    // game's res:// paths (they aren't in the client's project), so the icon is fetched over HTTP via TextureStore and
    // added as a Texture2D. The outer [center]/[left]/… wrapper is replayed as PushParagraph(align)/Pop per newline-
    // separated paragraph (so segments never carry unbalanced tags and every wrapped paragraph stays aligned);
    // unbalanced / unparseable input falls back to today's strip behavior (never render broken tags).
    private static void BuildRichContent(RichTextLabel rtl, MirrorNode node, double textScale, TextureStore? textures)
    {
        string raw = node.Text!.Text;

        if (raw.IndexOf("[img", StringComparison.OrdinalIgnoreCase) < 0)
        {
            rtl.SetMeta(RichSigMeta, ""); // invalidate any pending orb callback from a prior (orb) tenant of this label
            rtl.Text = PreprocessBbcode(raw, textScale);
            return;
        }

        var doc = ParseRichImageDoc(raw);
        if (doc is null || textures is null)
        {
            rtl.SetMeta(RichSigMeta, "");
            rtl.Text = PreprocessBbcode(raw, textScale); // fallback: strip the [img] blocks (old behavior)
            return;
        }

        rtl.SetMeta(RichSigMeta, raw); // staleness guard for async icon arrivals
        rtl.Clear();

        _buildingRich = true;
        try
        {
            foreach (var para in doc.Paragraphs)
            {
                rtl.PushParagraph(doc.Align);
                foreach (var part in para)
                {
                    if (part.ImagePath is { } imgPath)
                    {
                        AppendOrbImage(rtl, imgPath, node, textScale, textures, raw);
                    }
                    else
                    {
                        rtl.AppendText(PreprocessBbcode(part.Text ?? "", textScale));
                    }
                }

                rtl.Pop();
            }
        }
        finally
        {
            _buildingRich = false;
        }
    }

    // Fetch (or read from cache) the orb icon and AddImage it at natural size, centered on the text line-box (Godot's
    // default InlineAlignment.Center — the web parity nudge). On async arrival the whole label content is rebuilt (the
    // now-cached texture then resolves synchronously) and re-centered, guarded so a recycled/re-texted label is skipped.
    private static void AppendOrbImage(
        RichTextLabel rtl, string imgPath, MirrorNode node, double textScale, TextureStore textures, string sig)
    {
        string relUrl = SceneDeltaReader.MirrorResourceUrl(imgPath);
        Texture2D? tex = textures.Request(relUrl, _ =>
        {
            // Skip a synchronous (warm-cache) callback that fires DURING this build — the return value below already
            // AddImages the now-cached texture. Only a truly-async arrival (after the build) rebuilds the label.
            if (_buildingRich)
            {
                return;
            }

            if (GodotObject.IsInstanceValid(rtl) && rtl.GetMeta(RichSigMeta, "").AsString() == sig)
            {
                BuildRichContent(rtl, node, textScale, textures);
                CenterRichVertically(rtl, node); // content height shifted now that the icon is present
            }
        });

        if (tex is not null)
        {
            rtl.AddImage(tex, 0, 0, Colors.White, InlineAlignment.Center);
        }

        // else: still fetching — render nothing for this orb now; the callback rebuilds when it lands.
    }

    private sealed record RichPart(string? Text, string? ImagePath);

    private sealed record RichImageDoc(HorizontalAlignment Align, List<List<RichPart>> Paragraphs);

    private static readonly (string Tag, HorizontalAlignment Align)[] AlignTags =
    {
        ("center", HorizontalAlignment.Center), ("fill", HorizontalAlignment.Fill),
        ("right", HorizontalAlignment.Right), ("left", HorizontalAlignment.Left),
    };

    // Parse `[align]…[/align]`-wrapped rich text containing inline `[img]` blocks into per-newline paragraphs of
    // text/image parts. Returns null when the input can't be cleanly split into balanced text + image parts (e.g. an
    // unmatched `[img`), so the caller can fall back to the strip path rather than emit broken tags.
    private static RichImageDoc? ParseRichImageDoc(string raw)
    {
        string trimmed = raw.Trim();
        HorizontalAlignment align = HorizontalAlignment.Left;
        string inner = trimmed;

        foreach (var (tag, a) in AlignTags)
        {
            string open = $"[{tag}]";
            string close = $"[/{tag}]";
            if (trimmed.Length >= open.Length + close.Length &&
                trimmed.StartsWith(open, StringComparison.OrdinalIgnoreCase) &&
                trimmed.EndsWith(close, StringComparison.OrdinalIgnoreCase))
            {
                align = a;
                inner = trimmed.Substring(open.Length, trimmed.Length - open.Length - close.Length);
                break;
            }
        }

        var paragraphs = new List<List<RichPart>>();
        foreach (var rawPara in inner.Split('\n'))
        {
            string para = rawPara.EndsWith('\r') ? rawPara[..^1] : rawPara;
            var parts = new List<RichPart>();
            int pos = 0;

            foreach (Match m in ImgBlockRegex().Matches(para))
            {
                if (m.Index > pos)
                {
                    parts.Add(new RichPart(para[pos..m.Index], null));
                }

                parts.Add(new RichPart(null, m.Groups[1].Value.Trim()));
                pos = m.Index + m.Length;
            }

            if (pos < para.Length)
            {
                parts.Add(new RichPart(para[pos..], null));
            }

            // Any residual `[img` in a text part means the block was malformed / unbalanced → bail to the strip path.
            foreach (var p in parts)
            {
                if (p.Text is { } t && t.Contains("[img", StringComparison.OrdinalIgnoreCase))
                {
                    return null;
                }
            }

            paragraphs.Add(parts);
        }

        return new RichImageDoc(align, paragraphs);
    }

    [GeneratedRegex(@"\[img[^\]]*\]([\s\S]*?)\[/img\]", RegexOptions.IgnoreCase)]
    private static partial Regex ImgBlockRegex();

    // ---- placement / tint -----------------------------------------------------------------------------------

    private static void PlaceControl(Control c, MirrorNode node)
    {
        c.MouseFilter = Control.MouseFilterEnum.Ignore; // render-only overlay; never eat input
        var box = node.LocalRect;
        if (box is { } b)
        {
            c.Position = new Vector2((float)b.X, (float)b.Y);
            c.Size = new Vector2((float)b.Width, (float)b.Height);
        }
    }

    // Fold the owner's self_modulate (rgb × selfAlpha) into the label's Modulate. The owner's own SelfModulate is
    // own-draw only (never reaches children); its cascading Modulate already reaches the label via tree nesting, so
    // it is deliberately NOT re-applied here.
    private static void ApplyModulate(Control c, MirrorNode node) =>
        c.Modulate = node.SelfModulate is { } s
            ? new Color((float)s.R, (float)s.G, (float)s.B, (float)s.A)
            : Colors.White;

    // ---- outline + shadow (identical theme item names on Label and RichTextLabel) ---------------------------

    private static void ApplyOutlineAndShadow(Control c, MirrorNode node)
    {
        var text = node.Text!;

        // Volatile text-diagnostics outline wins over the stale node.outline (nodeStyles.ts L487-492).
        string? outlineHtml = text.OutlineColorHtml ?? node.Outline?.ColorHtml;
        double outlineSize = text.OutlineColorHtml is not null && text.OutlineSize > 0
            ? text.OutlineSize
            : node.Outline?.Size ?? 0;

        if (outlineHtml is not null && outlineSize > 0 && ParseHtml(outlineHtml) is { } oc)
        {
            c.AddThemeColorOverride("font_outline_color", oc);
            c.AddThemeConstantOverride("outline_size", Math.Max(0, (int)Math.Round(outlineSize * OutlineScale)));
        }
        else
        {
            c.RemoveThemeColorOverride("font_outline_color");
            c.RemoveThemeConstantOverride("outline_size");
        }

        if (node.Shadow is { } sh && ParseHtml(sh.ColorHtml) is { } shc)
        {
            c.AddThemeColorOverride("font_shadow_color", shc);
            c.AddThemeConstantOverride("shadow_offset_x", (int)Math.Round(sh.OffsetX));
            c.AddThemeConstantOverride("shadow_offset_y", (int)Math.Round(sh.OffsetY));
        }
        else
        {
            c.RemoveThemeColorOverride("font_shadow_color");
            c.RemoveThemeConstantOverride("shadow_offset_x");
            c.RemoveThemeConstantOverride("shadow_offset_y");
        }
    }

    // ---- font (size override now; file async via FontStore) -------------------------------------------------

    // `afterApply` (optional) runs once the font size + file are applied on THIS call, AND again when an async font
    // fetch later settles (the RichTextLabel line-spacing depends on the resolved font's metrics, so it must recompute
    // when the real font arrives). It is guarded by the same IsInstanceValid + font-url check as the font re-apply.
    private static void ApplyFont(
        Control c, MirrorNode node, string[] fontSlots, string[] sizeSlots, double scale, Action? afterApply = null,
        int? maxSizePx = null)
    {
        if (node.Text!.FontSizePx is { } px)
        {
            // The per-label text-scale multiplier folds in HERE — the single choke point both the plain Label
            // font_size slot and every RTL slot flow through — BEFORE the round (matching the web calc(px * scale)).
            // FontSizePx already folds the game's appliedFontSize, so this layers on top exactly like the css does.
            // Item 2: cap the scaled px at the per-entry MaxSizePx (End Turn), honored only under the v4 switch.
            int size = TextScale.ScaledFontPx(px, scale, maxSizePx);
            foreach (var slot in sizeSlots)
            {
                c.AddThemeFontSizeOverride(slot, size);
            }
        }
        else
        {
            foreach (var slot in sizeSlots)
            {
                c.RemoveThemeFontSizeOverride(slot);
            }
        }

        if (node.Font is not { } font)
        {
            afterApply?.Invoke(); // no wire font → default theme font; still (re)compute spacing off its metrics
            return;
        }

        c.SetMeta(FontUrlMeta, font.Url);
        string wantUrl = font.Url;

        FontFile? ready = FontStore.For(c).Request(wantUrl, loaded =>
        {
            // The label may have been freed (node removed) or re-pointed at another font before this settles.
            if (GodotObject.IsInstanceValid(c) && c.GetMeta(FontUrlMeta, "").AsString() == wantUrl)
            {
                foreach (var slot in fontSlots)
                {
                    c.AddThemeFontOverride(slot, loaded);
                }

                afterApply?.Invoke(); // real font arrived → recompute line-spacing off its true metrics
            }
        });

        if (ready is not null)
        {
            foreach (var slot in fontSlots)
            {
                c.AddThemeFontOverride(slot, ready);
            }
        }

        afterApply?.Invoke();
    }

    // ---- rich-text PER-ROLE fonts ----------------------------------------------------------------------------

    // Godot does NOT synthesise bold/italic inside a RichTextLabel: it renders a `[b]` / `[i]` / `[b][i]` span by
    // SWAPPING the label's font to its `bold_font` / `italics_font` / `bold_italics_font` theme item, which in STS2
    // is a genuinely different font FILE (res://fonts/kreon_bold.ttf). The wire used to carry one font per node, so
    // this client pointed every role slot at that single file — an honest fallback (a stray [b] stayed in-family)
    // but never actually bold. The producer now streams the role faces; point each slot at its own file.
    private static int RichRoleMask(MirrorNode node) =>
        (node.RichBoldFont is not null ? 1 : 0) |
        (node.RichItalicFont is not null ? 2 : 0) |
        (node.RichBoldItalicFont is not null ? 4 : 0);

    private static void ApplyRichRoleFonts(RichTextLabel rtl, MirrorNode node)
    {
        // The bold face doubles as the bold-italic slot's fallback UNLESS a dedicated bold-italic face was streamed
        // (a `[b][i]` span in the bold face beats one in the plain normal face).
        ApplyRoleFont(
            rtl,
            node.RichBoldFont,
            BoldFontUrlMeta,
            node.RichBoldItalicFont is null ? BoldRoleSlotsWithItalicFallback : BoldRoleSlots);
        ApplyRoleFont(rtl, node.RichItalicFont, ItalicFontUrlMeta, ItalicRoleSlots);
        ApplyRoleFont(rtl, node.RichBoldItalicFont, BoldItalicFontUrlMeta, BoldItalicRoleSlots);
    }

    private static readonly string[] BoldRoleSlots = { RtlBoldFontSlot };
    private static readonly string[] BoldRoleSlotsWithItalicFallback = { RtlBoldFontSlot, RtlBoldItalicFontSlot };
    private static readonly string[] ItalicRoleSlots = { RtlItalicFontSlot };
    private static readonly string[] BoldItalicRoleSlots = { RtlBoldItalicFontSlot };

    // Point ONE role's theme slots at its streamed font file (async through FontStore, exactly like ApplyFont).
    // `metaKey` is PER ROLE on purpose: the single FontUrlMeta guard would mis-cancel here — two roles fetching
    // different files on the same label would each read the other's url out of the meta when their callback
    // settled and drop their own apply, so at most one role would ever land.
    // A role with no streamed font clears its meta (so an in-flight fetch from a previous node state can't apply
    // late) and leaves the slots to ApplyFont's own-font fallback.
    private static void ApplyRoleFont(Control c, MirrorFont? font, string metaKey, string[] slots)
    {
        if (font is null)
        {
            c.SetMeta(metaKey, "");
            return;
        }

        string wantUrl = font.Url;
        c.SetMeta(metaKey, wantUrl);

        FontFile? ready = FontStore.For(c).Request(wantUrl, loaded =>
        {
            // The label may have been freed (node removed) or re-pointed at another role font before this settles.
            if (GodotObject.IsInstanceValid(c) && c.GetMeta(metaKey, "").AsString() == wantUrl)
            {
                foreach (var slot in slots)
                {
                    c.AddThemeFontOverride(slot, loaded);
                }
            }
        });

        if (ready is not null)
        {
            foreach (var slot in slots)
            {
                c.AddThemeFontOverride(slot, ready);
            }
        }
    }

    // ---- rich-text vertical centering -----------------------------------------------------------------------

    // A GetContentHeight() read of ≤0.5px means the label had not laid out yet (measurement unreliable). Rather than
    // settling on the top-align fallback FOREVER after a single bad read (issue #20a state ii: promoted-but-blank —
    // the rest-site description could stay top-aligned when its first deferred measure landed before the label shaped),
    // re-defer the measure a bounded number of times so a label that simply hasn't shaped yet (font still resolving /
    // first frame in tree) gets a later, valid read. Godot's MessageQueue does NOT re-enter its flush, so a deferred
    // call re-queued from inside a deferred call runs on the NEXT idle pass — each retry gives the label another frame.
    private const int CenterRichMaxRetries = 2;

    // RichTextLabel has no vertical-alignment property, so valign=Center (card descriptions) is achieved by
    // measuring the laid-out content height and nudging the label's top down by half the slack. Deferred because
    // GetContentHeight is only valid after the label lays out; guarded against a freed/re-pointed label.
    private static void CenterRichVertically(RichTextLabel rtl, MirrorNode node)
    {
        var box = node.LocalRect;
        if (box is not { } b || MapValign(node.Text!.Valign) is not VerticalAlignment.Center and not VerticalAlignment.Bottom)
        {
            return;
        }

        bool bottom = MapValign(node.Text!.Valign) == VerticalAlignment.Bottom;
        DeferCenterRich(rtl, (float)b.Y, (float)b.Height, bottom, 0);
    }

    private static void DeferCenterRich(RichTextLabel rtl, float boxTop, float boxHeight, bool bottom, int attempt)
    {
        Callable.From(() =>
        {
            if (!GodotObject.IsInstanceValid(rtl))
            {
                return;
            }

            float content = rtl.GetContentHeight();

            // Unshaped content reads as ~0 height. Re-defer up to CenterRichMaxRetries times (giving the label a frame
            // each) before settling on the safe top-align fallback — so a label that shapes a frame late still centers
            // instead of stranding at the box top, but a genuinely-empty label never pushes bogus 0-height text to the
            // box middle. The retry is bounded, so a permanently-unshaped label costs at most CenterRichMaxRetries idle
            // callbacks and then behaves exactly like today.
            if (content <= 0.5f)
            {
                if (attempt < CenterRichMaxRetries)
                {
                    DeferCenterRich(rtl, boxTop, boxHeight, bottom, attempt + 1);
                    return;
                }

                rtl.Position = new Vector2(rtl.Position.X, boxTop);
                return;
            }

            float slack = boxHeight - content;

            // Center nudges by half the slack, bottom by the full slack. Slack goes NEGATIVE when TextScale-bumped
            // content overflows the box: the SAME formula then makes the (now-unclipped) overflow honor valign — center
            // spills symmetrically around the box center, bottom grows upward — instead of top-aligning and clipping the
            // overflow downward. The near-flush band |slack|<=0.5 keeps today's EXACT top-align (offset 0), so a fitting
            // label with a sub-pixel measurement never jitters and the non-overflow path stays byte-identical.
            float offset = Mathf.Abs(slack) <= 0.5f ? 0f : (bottom ? slack : slack / 2f);
            rtl.Position = new Vector2(rtl.Position.X, boxTop + offset);
        }).CallDeferred();
    }

    // ---- BBCode preprocessing -------------------------------------------------------------------------------

    // Rewrite the STS2 custom BBCode tags (DEFAULT_BBCODE_TAGS, bbcodeTags.ts) into what Godot's RichTextLabel
    // parses natively: color aliases → [color=#hex]; animated effect tags → stripped (they are no-op wrappers in
    // the offline table; live-only animation is out of M1c scope). Standard tags ([center]/[color]/[font_size]/…)
    // pass through untouched. Unmapped tags would otherwise render literally, so this table is load-bearing.
    public static string PreprocessBbcode(string raw, double textScale)
    {
        if (string.IsNullOrEmpty(raw) || raw.IndexOf('[') < 0)
        {
            return raw;
        }

        string s = raw;

        // Item 1: scale inline absolute [font_size=N] runs by the label's own text-scale so a multiattack intent's "xN"
        // multiplier scales with the count (the rewrite is a no-op at scale 1). Gated by the INLINE_FONTSCALE switch.
        if (textScale != 1.0)
        {
            s = TextScale.ScaleInlineFontSizes(s, textScale);
        }

        foreach (var (name, hex) in ColorAliases)
        {
            s = s.Replace($"[{name}]", $"[color={hex}]", StringComparison.OrdinalIgnoreCase)
                 .Replace($"[/{name}]", "[/color]", StringComparison.OrdinalIgnoreCase);
        }

        // Effect tags may carry params (e.g. [sine freq=5.0]); strip open (with optional params) and close.
        s = EffectTagRegex().Replace(s, "");

        // [img]res://…[/img] blocks: RichTextLabel resolves the path via the LOCAL ResourceLoader, which cannot see
        // game resources ("Resource file not found" errors on live trees). The rich builder (BuildRichContent) now
        // fetches inline icons over HTTP and AddImages them; this strip is only the FALLBACK for unparseable input or
        // a missing TextureStore, keeping broken tags from ever rendering.
        if (s.Contains("[img", StringComparison.OrdinalIgnoreCase))
        {
            s = ImgTagRegex().Replace(s, "");
            if (!_imgNoticed)
            {
                _imgNoticed = true;
                GD.Print("M1C: BBCode [img] blocks stripped (fallback path — unparseable input or no TextureStore).");
            }
        }

        return s;
    }

    private static bool _imgNoticed;

    [GeneratedRegex(@"\[img[^\]]*\].*?\[/img\]", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex ImgTagRegex();

    // Mirror of DEFAULT_BBCODE_TAGS color entries (bbcodeTags.ts L16-28).
    private static readonly (string Name, string Hex)[] ColorAliases =
    {
        ("aqua", "#2aebbe"), ("blue", "#87ceeb"), ("gold", "#efc851"), ("green", "#7fff00"),
        ("orange", "#ffa518"), ("pink", "#ff78a0"), ("purple", "#ee82ee"), ("red", "#ff5555"),
        ("yellow", "#efc851"), ("grey", "#a9a9a9"), ("gray", "#a9a9a9"), ("white", "#fff6e2"),
        ("black", "#000000"),
    };

    [GeneratedRegex(@"\[/?(?:sine|jitter|thinky_dots|ancient_banner|fade_in|fly_in)(?:\s[^\]]*)?\]",
        RegexOptions.IgnoreCase)]
    private static partial Regex EffectTagRegex();

    // ---- helpers --------------------------------------------------------------------------------------------

    private static Color? ParseHtml(string? html)
    {
        if (string.IsNullOrEmpty(html))
        {
            return null;
        }

        string hex = html.TrimStart('#');
        if ((hex.Length is 6 or 8) && IsHex(hex))
        {
            return Color.FromHtml(html);
        }

        // Named / unexpected form — let Godot try, but never throw.
        try
        {
            return Color.FromHtml(html);
        }
        catch
        {
            return null;
        }
    }

    private static bool IsHex(string s)
    {
        foreach (char ch in s)
        {
            if (!Uri.IsHexDigit(ch))
            {
                return false;
            }
        }

        return true;
    }

    private static HorizontalAlignment MapHalign(string? h) =>
        (h ?? "").ToLowerInvariant() switch
        {
            "center" => HorizontalAlignment.Center,
            "right" or "end" => HorizontalAlignment.Right,
            "fill" => HorizontalAlignment.Fill,
            _ => HorizontalAlignment.Left,
        };

    private static VerticalAlignment MapValign(string? v) =>
        (v ?? "").ToLowerInvariant() switch
        {
            "center" or "middle" => VerticalAlignment.Center,
            "bottom" or "end" => VerticalAlignment.Bottom,
            "fill" => VerticalAlignment.Fill,
            _ => VerticalAlignment.Top,
        };
}
