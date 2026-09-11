using System.Text;
using CouchCoop.Mod.Activity;
using CouchCoop.Mod.Localization;
using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The log's <see cref="RichTextLabel"/>, subclassed for exactly one reason: to make its content visible
/// to scene inspection.
/// </summary>
/// <remarks>
/// <para>
/// <c>RichTextLabel.append_text</c> pushes parsed items straight onto its item stack and deliberately does
/// NOT update the node's <c>text</c> property — so a <c>sts2 dev scene node --properties</c> dump of the
/// log reads EMPTY, and the live probe could not assert a single word of what the host is being shown.
/// (Switching to <c>.Text =</c> to fix that is the one thing this panel must not do: <c>set_text</c> calls
/// <c>clear()</c>, which re-arms <c>scroll_following</c> and yanks a scrolled-up reader to the bottom.)
/// </para>
/// <para>
/// <c>GetFormattedText()</c> is the FIRST accessor spirectl's text diagnostics probe by reflection
/// (<c>Sts2RuntimeSceneTextDiagnostics.Describe</c>: <c>GetFormattedText</c> → <c>Text</c> →
/// <c>BbcodeText</c>), and its type walk resolves a subclass of <c>Godot.RichTextLabel</c> normally. So
/// defining it here publishes the markup-stripped log with no extra node, no extra layout and no shipped
/// test-only widget. If spirectl ever renames that probe, the live leg fails loudly rather than passing on
/// an empty string.
/// </para>
/// </remarks>
internal sealed partial class CouchCoopActivityLogLabel : RichTextLabel
{
    private readonly StringBuilder _plain = new();

    /// <summary>The markup-stripped content, for scene inspection. See the type remarks.</summary>
    public string GetFormattedText() => _plain.ToString();

    /// <summary>Drop everything and start again (a first render, or a ring drop).</summary>
    public void ResetContent(string bbcode, string plain)
    {
        Clear();
        _plain.Clear();
        _plain.Append(plain);
        AppendText(bbcode);
    }

    /// <summary>Append one row, preserving Godot's own tail-follow behaviour.</summary>
    public void AppendRow(string bbcode, string plain)
    {
        _plain.Append(plain);
        AppendText(bbcode);
    }
}

/// <summary>
/// The host connectivity log as it appears on the television: a collapsible card in the lobby's top-right
/// corner, rendering <see cref="CouchCoopActivityLog"/>.
/// </summary>
/// <remarks>
/// <para>
/// It exists because every event it shows already goes to <see cref="Console.Error"/>, while the host still needs
/// an in-game answer to "what is it doing?" without consulting a terminal or launcher log.
/// </para>
/// <para>
/// <b>Node names are a contract</b> (<c>scripts/probe-pc-lobby-activity-log.mjs</c> asserts them, and the
/// mirror-exclusion leg greps the stream for <c>/CouchCoopActivity[A-Za-z0-9_]*/</c> — a prefix chosen to
/// be specific enough that the game's own "Mods loaded: … CouchCoop" label cannot match it).
/// </para>
/// <para>
/// <b>Mouse filters are load-bearing.</b> The root and the card are <c>Ignore</c> so the lobby underneath
/// stays fully clickable behind a panel that covers a third of the screen height; only the HEADER (toggle)
/// and the LOG TEXT (scroll) stop input. The header is a plain <c>Control</c> with a <c>gui_input</c>
/// connection rather than an <c>NButton</c>-derived control on purpose: the game's clickables only act
/// once already hovered (<c>NClickableControl</c> latches on <c>mouse_entered</c>), which makes them
/// awkward to drive and adds a hover dance this affordance does not need.
/// </para>
/// <para>
/// <b><c>_Ready</c> is not trusted</b> — this assembly is built without Godot's C# source generators, so
/// engine dispatch into these types is unproven (see <see cref="CouchCoopTextureButton"/>). The controller
/// calls the idempotent <see cref="Install"/> explicitly after <c>AddChild</c>; <c>_Ready</c> is a belt.
/// </para>
/// </remarks>
internal sealed partial class CouchCoopActivityPanel : Control
{
    public const string NodeName = "CouchCoopActivityPanel";
    public const string CardNodeName = "CouchCoopActivityCard";
    public const string HeaderNodeName = "CouchCoopActivityHeader";
    public const string TitleNodeName = "CouchCoopActivityTitleLabel";
    public const string ToggleNodeName = "CouchCoopActivityToggleLabel";
    public const string BodyNodeName = "CouchCoopActivityBody";
    public const string LogNodeName = "CouchCoopActivityLogText";

    /// <summary>Affordance glyph while the panel is open. Wording is part of the QA contract.</summary>
    public const string ExpandedToggleText = "–";

    /// <inheritdoc cref="ExpandedToggleText"/>
    public const string CollapsedToggleText = "+";

    private readonly Panel _card = new() { Name = CardNodeName };
    private readonly StyleBoxFlat _cardStyle = new();
    private readonly Control _header = new() { Name = HeaderNodeName };
    private readonly Label _title = new() { Name = TitleNodeName };
    private readonly Label _toggle = new() { Name = ToggleNodeName };
    private readonly Control _body = new() { Name = BodyNodeName };
    private readonly CouchCoopActivityLogLabel _log = new() { Name = LogNodeName };

    private bool _installed;

    // Render bookkeeping. `_renderedSequence` is the log revision this panel's text already reflects; the
    // common tick compares it and returns without touching a node.
    private bool _rendered;
    private long _renderedSequence;
    private bool _renderedCollapsed;
    private int _renderedLocaleRevision = -1;

    public CouchCoopActivityPanel()
    {
        Name = NodeName;
        // See the note in ApplyLayout: always the AND-OFFSETS form, so the preset cannot silently bake in
        // whatever rect the control happens to have at the moment it is called.
        SetAnchorsAndOffsetsPreset(LayoutPreset.FullRect);
        // Ignore on the root AND the card: this panel is a read-only status surface over a live lobby, and
        // the lobby's own controls must keep every click that is not on the header or the log body.
        MouseFilter = MouseFilterEnum.Ignore;

        _card.MouseFilter = MouseFilterEnum.Ignore;
        _cardStyle.AntiAliasing = true;
        _card.AddThemeStyleboxOverride("panel", _cardStyle);

        _header.MouseFilter = MouseFilterEnum.Stop;
        _title.MouseFilter = MouseFilterEnum.Ignore;
        _toggle.MouseFilter = MouseFilterEnum.Ignore;
        _body.MouseFilter = MouseFilterEnum.Ignore;

        ConfigureLabel(_title, HorizontalAlignment.Left, CouchCoopActivityLayout.TitleFontSize);
        ConfigureLabel(_toggle, HorizontalAlignment.Right, CouchCoopActivityLayout.TitleFontSize);
        _title.Text = CouchCoopActivityRender.EmptySummary;
        _toggle.Text = ExpandedToggleText;

        ConfigureLog();

        AddChild(_card);
        _card.AddChild(_header);
        _header.AddChild(_title);
        _header.AddChild(_toggle);
        _card.AddChild(_body);
        _body.AddChild(_log);
    }

    /// <summary>Idempotent wiring, called by the controller after <c>AddChild</c>.</summary>
    public void Install()
    {
        if (_installed)
        {
            return;
        }

        _installed = true;
        _header.Connect(Control.SignalName.GuiInput, Callable.From<InputEvent>(OnHeaderInput));
        ApplyLayout();
        Refresh();
    }

    public override void _Ready() => Install();

    /// <summary>Re-applies geometry and chrome. Cheap and idempotent; called on install and on refresh-all.</summary>
    public void ApplyLayout()
    {
        _cardStyle.BgColor = Color.FromHtml(CouchCoopActivityLayout.CardColorHtml);
        _cardStyle.BorderColor = Color.FromHtml(CouchCoopActivityLayout.CardBorderColorHtml);
        _cardStyle.SetBorderWidthAll((int)CouchCoopActivityLayout.CardBorderWidth);
        _cardStyle.SetCornerRadiusAll((int)CouchCoopActivityLayout.CardCornerRadius);

        // Right-anchored on BOTH horizontal edges: the project stretches canvas_items with `expand`, so an
        // ultrawide window grows the design width and an absolute rect would strand the panel mid-screen.
        _card.AnchorLeft = 1f;
        _card.AnchorRight = 1f;
        _card.AnchorTop = 0f;
        _card.AnchorBottom = 0f;
        _card.OffsetLeft = CouchCoopActivityLayout.OffsetLeft;
        _card.OffsetRight = CouchCoopActivityLayout.OffsetRight;
        _card.OffsetTop = CouchCoopActivityLayout.Top;
        _card.OffsetBottom = CouchCoopActivityLayout.Bottom;

        _header.AnchorLeft = 0f;
        _header.AnchorRight = 1f;
        _header.AnchorTop = 0f;
        _header.AnchorBottom = 0f;
        _header.OffsetLeft = 0f;
        _header.OffsetRight = 0f;
        _header.OffsetTop = 0f;
        _header.OffsetBottom = CouchCoopActivityLayout.HeaderHeight;

        _title.AnchorLeft = 0f;
        _title.AnchorRight = 1f;
        _title.AnchorTop = 0f;
        _title.AnchorBottom = 1f;
        _title.OffsetLeft = CouchCoopActivityLayout.ContentPadding;
        _title.OffsetRight = -(CouchCoopActivityLayout.ContentPadding + CouchCoopActivityLayout.ToggleWidth);
        _title.OffsetTop = 0f;
        _title.OffsetBottom = 0f;

        _toggle.AnchorLeft = 1f;
        _toggle.AnchorRight = 1f;
        _toggle.AnchorTop = 0f;
        _toggle.AnchorBottom = 1f;
        _toggle.OffsetLeft = -(CouchCoopActivityLayout.ContentPadding + CouchCoopActivityLayout.ToggleWidth);
        _toggle.OffsetRight = -CouchCoopActivityLayout.ContentPadding;
        _toggle.OffsetTop = 0f;
        _toggle.OffsetBottom = 0f;

        _body.AnchorLeft = 0f;
        _body.AnchorRight = 1f;
        _body.AnchorTop = 0f;
        _body.AnchorBottom = 1f;
        _body.OffsetLeft = CouchCoopActivityLayout.ContentPadding;
        _body.OffsetRight = -CouchCoopActivityLayout.ContentPadding;
        _body.OffsetTop = CouchCoopActivityLayout.HeaderHeight;
        _body.OffsetBottom = -CouchCoopActivityLayout.ContentPadding;

        // AND-OFFSETS, not `SetAnchorsPreset`. `set_anchors_preset` defaults to `keep_offsets:false`, which
        // does NOT mean "reset the offsets" — it recomputes them to PRESERVE the control's current rect. The
        // log is measured here while it is still 0x0, so the full-rect anchors came out carrying offsets of
        // right:-536 / bottom:-384 and the body rendered at 1x0: header and collapse chrome worked, and not
        // one row of the log was ever drawn. (The same call on the panel ROOT, in the constructor, is benign
        // only because a node outside the tree has no parent rect to measure against — hence the explicit
        // form there too, so this cannot come back if construction order ever changes.)
        _log.SetAnchorsAndOffsetsPreset(LayoutPreset.FullRect);

        // Re-assert the collapse geometry: ApplyLayout has just overwritten the card's bottom offset.
        ApplyCollapsed(CouchCoopActivityPanelState.Collapsed);
        _renderedCollapsed = CouchCoopActivityPanelState.Collapsed;
    }

    /// <summary>
    /// Per-scan repaint. Sequence-driven and INCREMENTAL: unchanged ticks cost one lock and a comparison,
    /// and new entries are appended rather than re-rendering the whole log.
    /// </summary>
    /// <remarks>
    /// <b><c>AppendRow</c> (i.e. <c>AppendText</c>), never <c>.Text =</c>.</b> Godot's <c>RichTextLabel::set_text</c> calls
    /// <c>clear()</c>, which RE-ARMS <c>scroll_following</c> (rich_text_label.cpp, 4.5.1) — so a host who
    /// had scrolled up to read an earlier line would be yanked back to the bottom on every new event.
    /// Appending leaves the engine's own tail-follow/disarm behaviour intact, which is exactly the
    /// behaviour wanted, and needs no manual scroll arithmetic at all.
    /// </remarks>
    public void Refresh()
    {
        var newest = CouchCoopActivityLog.NewestSequence;
        var collapsed = CouchCoopActivityPanelState.Collapsed;
        var localeRevision = CouchCoopLocalization.Revision;
        if (_rendered && newest == _renderedSequence && collapsed == _renderedCollapsed && localeRevision == _renderedLocaleRevision)
        {
            return;
        }

        if (!_rendered || collapsed != _renderedCollapsed)
        {
            ApplyCollapsed(collapsed);
        }

        if (!_rendered || newest != _renderedSequence || localeRevision != _renderedLocaleRevision)
        {
            var pending = CouchCoopActivityLog.SnapshotSince(_renderedSequence, out var truncated);
            if (!_rendered || truncated || localeRevision != _renderedLocaleRevision)
            {
                // Either we have never drawn, or the ring dropped lines we never saw — there is no append
                // that gets us to the right text, so redraw.
                var all = CouchCoopActivityLog.Snapshot();
                var droppedHead = all.Count > 0 && all[0].Sequence > 1;
                _log.ResetContent(
                    CouchCoopActivityRender.ToBbcode(all, droppedHead),
                    CouchCoopActivityRender.ToPlainText(all, droppedHead));
            }
            else
            {
                foreach (var entry in pending)
                {
                    _log.AppendRow(
                        CouchCoopActivityRender.RowBbcode(entry),
                        CouchCoopActivityRender.RowPlainText(entry));
                }
            }

            _title.Text = CouchCoopActivityRender.HeaderSummary(
                CouchCoopActivityLog.Count,
                CouchCoopActivityLog.NewestSeverity);
        }

        _rendered = true;
        _renderedSequence = newest;
        _renderedCollapsed = collapsed;
        _renderedLocaleRevision = localeRevision;
        CouchCoopGameUiTheme.ApplyFont(_title, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopActivityLayout.TitleFontSize);
        CouchCoopGameUiTheme.ApplyFont(_toggle, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopActivityLayout.TitleFontSize);
        CouchCoopGameUiTheme.ApplyRichFont(_log, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopActivityLayout.LogFontSize);
    }

    private void ApplyCollapsed(bool collapsed)
    {
        _body.Visible = !collapsed;
        _card.OffsetBottom = collapsed
            ? CouchCoopActivityLayout.Top + CouchCoopActivityLayout.HeaderHeight
            : CouchCoopActivityLayout.Bottom;
        _toggle.Text = collapsed ? CollapsedToggleText : ExpandedToggleText;
    }

    private void OnHeaderInput(InputEvent inputEvent)
    {
        if (inputEvent is not InputEventMouseButton { ButtonIndex: MouseButton.Left, Pressed: true })
        {
            return;
        }

        // The flag lives on a process static, not on this node: the panel is QueueFree'd on every screen
        // change, so a collapse held here would not survive backing out to the menu and returning.
        CouchCoopActivityPanelState.Toggle();
        Refresh();
    }

    private void ConfigureLog()
    {
        _log.BbcodeEnabled = true;
        _log.ScrollActive = true;
        // Follow the tail by default; Godot disarms this by itself the moment the reader scrolls up, and
        // re-arms it when they scroll back to the bottom. See Refresh's AppendText note.
        _log.ScrollFollowing = true;
        // FALSE deliberately: fitting content to the text would make the label grow past the card and
        // suppress its own scrollbar, which is the whole mechanism a long session depends on.
        _log.FitContent = false;
        _log.SelectionEnabled = false;
        _log.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        // ClipContents is left at its default (true) — correct here, and NOT the bug from
        // docs/agents/clip-contents-blast-radius.md: the log is a scrolling viewport and must clip.
        _log.MouseFilter = MouseFilterEnum.Stop;
        _log.AddThemeColorOverride("default_color", Color.FromHtml(CouchCoopActivityRender.InfoColor));
        CouchCoopGameUiTheme.ApplyRichFont(
            _log,
            CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne,
            CouchCoopActivityLayout.LogFontSize);
        // No ScrollContainer wrapper: RichTextLabel owns its own VScrollBar, and nesting the two makes the
        // inner one unreachable.
    }

    private static void ConfigureLabel(Label label, HorizontalAlignment alignment, int fontSize)
    {
        label.HorizontalAlignment = alignment;
        label.VerticalAlignment = VerticalAlignment.Center;
        label.ClipText = true;
        CouchCoopGameUiTheme.ApplyFont(label, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, fontSize);
        label.AddThemeColorOverride("font_color", CouchCoopGameUiTheme.DropdownFontColor);
        label.AddThemeColorOverride("font_shadow_color", CouchCoopGameUiTheme.DropdownShadowColor);
        label.AddThemeConstantOverride("shadow_offset_x", CouchCoopGameUiTheme.DropdownShadowOffsetX);
        label.AddThemeConstantOverride("shadow_offset_y", CouchCoopGameUiTheme.DropdownShadowOffsetY);
    }
}
