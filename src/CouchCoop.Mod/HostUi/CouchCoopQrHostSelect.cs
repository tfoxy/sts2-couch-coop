using Godot;
using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.HostUi;

/// <summary>An in-tree, focusable picker shared by the network and method controls.</summary>
internal sealed partial class CouchCoopQrHostSelect : Control
{
    public const string NodeName = "CouchCoopQrHostSelect";
    public const string CurrentRowName = "CouchCoopQrHostSelectCurrent";
    public const string ListName = "CouchCoopQrHostSelectList";
    public const string OptionNamePrefix = "CouchCoopQrHostOption";
    public const float RowWidth = 380f;
    public const float RowHeight = 64f;

    private readonly CouchCoopQrHostRow _current;
    private readonly Control _list;
    private readonly Panel _listBackground = new();
    private readonly List<CouchCoopQrHostRow> _rows = [];
    private readonly string _prefix;
    private bool _rebuilding;

    public Action<QrSelectEntry>? SelectionChanged { get; set; }
    public Action<Control, QrSelectEntry, bool>? RowHover { get; set; }
    public Action<Control, bool>? SelectorHover { get; set; }
    public Action? OptionsHidden { get; set; }
    public Action? Opening { get; set; }
    public Action? FocusChainChanged { get; set; }
    public bool IsOpen => _list.Visible;

    public CouchCoopQrHostSelect(string name = NodeName)
    {
        Name = name;
        _prefix = name == NodeName ? OptionNamePrefix : name + "Option";
        MouseFilter = MouseFilterEnum.Ignore;
        CustomMinimumSize = new Vector2(RowWidth, RowHeight);
        _current = new CouchCoopQrHostRow(name + "Current", showChevron: true) { Activated = Toggle };
        _current.Size = new Vector2(RowWidth, RowHeight);
        _current.CustomMinimumSize = _current.Size;
        _current.HoverChanged = hovered => SelectorHover?.Invoke(_current, hovered);
        var background = new Panel { Name = name + "Background", MouseFilter = MouseFilterEnum.Ignore, Size = _current.Size };
        background.AddThemeStyleboxOverride("panel", CreateBackingStyle());
        _list = new Control { Name = name + "List", Visible = false, MouseFilter = MouseFilterEnum.Ignore,
            Position = new Vector2(0f, RowHeight) };
        _listBackground.MouseFilter = MouseFilterEnum.Ignore;
        _listBackground.AddThemeStyleboxOverride("panel", CreateBackingStyle());
        _list.AddChild(_listBackground);
        AddChild(background);
        AddChild(_current);
        AddChild(_list);
    }

    public void Install() => _current.Install();

    public void RefreshLocalization()
    {
        _current.RefreshLocalization();
        foreach (var row in _rows) row.RefreshLocalization();
    }

    public void SetOptions(IReadOnlyList<QrSelectEntry> options, string? selectedKey)
    {
        OptionsHidden?.Invoke();
        _rebuilding = true;
        try
        {
            Close();
            foreach (var row in _rows)
            {
                _list.RemoveChild(row);
                row.QueueFree();
            }
            _rows.Clear();
            for (var index = 0; index < options.Count; index++)
            {
                var entry = options[index];
                var row = new CouchCoopQrHostRow(_prefix + index.ToString(System.Globalization.CultureInfo.InvariantCulture))
                {
                    Position = new Vector2(0f, index * RowHeight),
                    Size = new Vector2(RowWidth, RowHeight),
                    CustomMinimumSize = new Vector2(RowWidth, RowHeight),
                };
                row.SetOption(entry);
                row.Activated = () => Choose(entry);
                row.HoverChanged = hovered => RowHover?.Invoke(row, entry, hovered);
                _rows.Add(row);
                _list.AddChild(row);
                row.Install();
                row.SetSelectable(entry.Selectable);
            }
            _listBackground.Size = new Vector2(RowWidth, MathF.Max(options.Count * RowHeight, 1f));
            var selected = options.FirstOrDefault(o => o.Key == selectedKey);
            _current.SetOption(selected);
            // The closed control always opens, even when its retained selection cannot activate.
        }
        finally { _rebuilding = false; }
        NotifyFocusChainChanged();
    }

    public void Toggle()
    {
        if (IsOpen) { Close(); return; }
        if (_rows.Count == 0) return;
        Opening?.Invoke();
        _list.Visible = true;
        NotifyFocusChainChanged();
    }

    public void Close()
    {
        if (!IsOpen) return;
        _list.Visible = false;
        OptionsHidden?.Invoke();
        NotifyFocusChainChanged();
    }

    public void AppendFocusChain(List<Control> chain)
    {
        chain.Add(_current);
        if (IsOpen) chain.AddRange(_rows.Where(GodotObject.IsInstanceValid));
    }

    private void NotifyFocusChainChanged()
    {
        if (!_rebuilding) FocusChainChanged?.Invoke();
    }

    private void Choose(QrSelectEntry entry)
    {
        if (!entry.Selectable) return;
        Close();
        SelectionChanged?.Invoke(entry);
    }

    private static StyleBox CreateBackingStyle() => CouchCoopGameUiTheme.CreateFallbackStyle(
        new Color(0.043f, 0.055f, 0.078f, 0.97f), new Color(1f, 1f, 1f, 0.2f), cornerRadius: 8, borderWidth: 2);
}

internal sealed partial class CouchCoopQrHostRow : CouchCoopTextureButton
{
    public const string HighlightName = "Highlight";
    public const string DetailLabelName = "Detail";

    private readonly ColorRect _highlight = new() { Name = HighlightName };
    private readonly Label _detail = new() { Name = DetailLabelName };
    private readonly Label? _chevron;
    private QrSelectEntry? _option;
    private bool _selectable = true;

    /// <summary>Raised on hover/focus enter (true) and leave (false), selectable or not.</summary>
    public Action<bool>? HoverChanged { get; set; }

    public CouchCoopQrHostRow(string name, bool showChevron = false)
        : base(name, texture: null, TextureRect.ExpandModeEnum.IgnoreSize, useFallbackPanel: false)
    {
        _highlight.SetAnchorsPreset(LayoutPreset.FullRect);
        _highlight.MouseFilter = MouseFilterEnum.Ignore;
        _highlight.Color = CouchCoopGameUiTheme.DropdownHighlightColor;
        _highlight.Visible = false;
        Visuals.AddChild(_highlight);
        Visuals.MoveChild(_highlight, 0);

        // Two lines fit the half-width control: name above, address or control role below.
        ButtonLabel.HorizontalAlignment = HorizontalAlignment.Left;
        ButtonLabel.AutowrapMode = TextServer.AutowrapMode.Off;
        ButtonLabel.OffsetLeft = 20f;
        ButtonLabel.OffsetRight = showChevron ? -52f : -20f;
        ButtonLabel.AnchorBottom = 0f;
        ButtonLabel.OffsetTop = 2f;
        ButtonLabel.OffsetBottom = 37f;
        ButtonLabel.TextOverrunBehavior = TextServer.OverrunBehavior.TrimEllipsis;
        CouchCoopGameUiTheme.ApplyFont(ButtonLabel, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 26);
        StyleLabel(ButtonLabel, CouchCoopGameUiTheme.DropdownFontColor);

        _detail.SetAnchorsPreset(LayoutPreset.FullRect);
        _detail.MouseFilter = MouseFilterEnum.Ignore;
        _detail.HorizontalAlignment = HorizontalAlignment.Left;
        _detail.AnchorTop = 0f;
        _detail.OffsetTop = 36f;
        _detail.AutowrapMode = TextServer.AutowrapMode.Off;
        _detail.TextOverrunBehavior = TextServer.OverrunBehavior.TrimEllipsis;
        _detail.VerticalAlignment = VerticalAlignment.Center;
        _detail.OffsetRight = showChevron ? -52f : -20f;
        _detail.OffsetLeft = 20f;
        CouchCoopGameUiTheme.ApplyFont(_detail, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 20);
        StyleLabel(_detail, new Color(1f, 0.964706f, 0.886275f, 0.65f));
        Visuals.AddChild(_detail);

        if (showChevron)
        {
            _chevron = new Label { Name = "Chevron", Text = "▼" };
            var chevron = _chevron;
            chevron.SetAnchorsPreset(LayoutPreset.FullRect);
            chevron.MouseFilter = MouseFilterEnum.Ignore;
            chevron.HorizontalAlignment = HorizontalAlignment.Right;
            chevron.VerticalAlignment = VerticalAlignment.Center;
            chevron.OffsetRight = -20f;
            CouchCoopGameUiTheme.ApplyFont(chevron, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 26);
            StyleLabel(chevron, CouchCoopGameUiTheme.DropdownFontColor);
            Visuals.AddChild(chevron);
        }
    }

    public void SetOption(QrSelectEntry? option)
    {
        _option = option;
        Text = option?.Label.Resolve() ?? CouchCoopLocalization.Resolve("couchcoop_option_no_address");
        _detail.Text = option?.Detail.Resolve() ?? string.Empty;
    }

    /// <summary>Reapplies the current locale's font while retaining row content and interaction state.</summary>
    public void RefreshLocalization()
    {
        SetOption(_option);
        CouchCoopGameUiTheme.ApplyFont(ButtonLabel, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 26);
        CouchCoopGameUiTheme.ApplyFont(_detail, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 20);
        if (_chevron is not null)
        {
            CouchCoopGameUiTheme.ApplyFont(_chevron, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 26);
        }
    }

    /// <summary>
    /// Grey and de-activate the row without deafening it: hover (and therefore the explanatory tips)
    /// keeps working, activation does not. Call AFTER <see cref="CouchCoopTextureButton.Install"/>,
    /// which forces <see cref="Control.FocusMode"/> back to All.
    /// </summary>
    public void SetSelectable(bool selectable)
    {
        _selectable = selectable;
        FocusMode = FocusModeEnum.All;
        Visuals.Modulate = new Color(1f, 1f, 1f, selectable ? 1f : 0.45f);
    }

    // Focus remains visible on disabled rows so keyboard/controller users can read the reason.
    protected override void OnFocus()
    {
        base.OnFocus();
        HoverChanged?.Invoke(true);
    }

    protected override void OnUnfocus()
    {
        base.OnUnfocus();
        HoverChanged?.Invoke(false);
    }

    protected override void OnPress()
    {
        if (_selectable)
        {
            base.OnPress();
        }
    }

    protected override void OnRelease()
    {
        if (_selectable)
        {
            base.OnRelease();
        }
    }

    protected override void ApplyFocusVisual() => _highlight.Visible = true;

    // The row is a list entry, not a button with art: pressing it dims the highlight rather than
    // moving it, so the list never jitters under the cursor.
    protected override void ApplyPressedVisual()
    {
        _highlight.Visible = true;
        _highlight.Color = CouchCoopGameUiTheme.DropdownHighlightColor.Darkened(0.25f);
    }

    protected override void ApplyRestingVisual(bool animate = false)
    {
        _highlight.Visible = false;
        _highlight.Color = CouchCoopGameUiTheme.DropdownHighlightColor;
    }

    private static void StyleLabel(Label label, Color color)
    {
        label.AddThemeColorOverride("font_color", color);
        label.AddThemeColorOverride("font_shadow_color", CouchCoopGameUiTheme.DropdownShadowColor);
        label.AddThemeConstantOverride("shadow_offset_x", CouchCoopGameUiTheme.DropdownShadowOffsetX);
        label.AddThemeConstantOverride("shadow_offset_y", CouchCoopGameUiTheme.DropdownShadowOffsetY);
    }
}
