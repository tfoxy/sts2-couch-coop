using Godot;
using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The QR dialog's option picker: a closed "current" row that expands into a list of
/// <see cref="QrHostOption"/> rows (adapter × method, mdns last — see <see cref="QrHostOptions"/>).
/// </summary>
/// <remarks>
/// <para>
/// <b>Why not <c>OptionButton</c> or the game's <c>NDropdown</c>.</b> <c>OptionButton</c> opens a
/// <c>PopupMenu</c>, which Godot renders in a separate embedded subwindow — invisible to
/// <c>dev scene tree</c>, so the QA probe could neither see the options nor click one, and a feature
/// whose whole point is picking the right address would have been untestable. <c>NDropdown</c> is
/// hard-wired to unique-name children of its own scene and cannot be instanced standalone. So the
/// list is plain in-tree <c>Control</c>s, styled after <c>scenes/ui/dropdown_item.tscn</c>.
/// </para>
/// <para>
/// Rows are ordinary children, so everything is probeable by node name and driveable by a real click
/// at a real screen position.
/// </para>
/// <para>
/// <b>Identity is <see cref="QrHostOption.SelectionKey"/>, never the host.</b> Every adapter's web
/// row shares the public origin's host, so host-keyed matching would treat three different QRs as one
/// row. The key also carries the method, which is what lets a remembered "web" preference find a web
/// row after the adapter's address changed under a new DHCP lease.
/// </para>
/// <para>
/// <b>Disabled rows stay hoverable.</b> A disabled option renders greyed with its blocker in the
/// detail slot, refuses selection and drops out of controller navigation — but keeps
/// <see cref="Control.MouseFilter"/>.Stop so its hover tips (the "why is this greyed out" answer)
/// still fire. This is deliberately NOT the old toggle's <c>MouseFilter = Ignore</c> pattern, which
/// made "disabled" also mean "unexplained".
/// </para>
/// </remarks>
internal sealed partial class CouchCoopQrHostSelect : Control
{
    public const string NodeName = "CouchCoopQrHostSelect";
    public const string CurrentRowName = "CouchCoopQrHostSelectCurrent";
    public const string ListName = "CouchCoopQrHostSelectList";

    /// <summary>Option rows are <c>CouchCoopQrHostOption0</c>, <c>...1</c>, in displayed order.</summary>
    public const string OptionNamePrefix = "CouchCoopQrHostOption";

    /// <summary>Design size of one row, sized to be comfortably tappable from a couch.</summary>
    public const float RowWidth = 760f;
    public const float RowHeight = 64f;

    private readonly CouchCoopQrHostRow _current;
    private readonly Panel _currentBackground = new() { Name = "CouchCoopQrHostSelectBackground" };
    private readonly Control _list = new() { Name = ListName };
    private readonly Panel _listBackground = new() { Name = "CouchCoopQrHostSelectListBackground" };
    private readonly List<CouchCoopQrHostRow> _rows = [];
    private IReadOnlyList<QrHostOption> _options = [];

    /// <summary>Raised when the player picks a DIFFERENT option (never for a re-pick of the current one).</summary>
    public Action<QrHostOption>? SelectionChanged { get; set; }

    /// <summary>
    /// Hover/focus entered or left an expanded option row. The dialog hangs that row's method/interface
    /// hover-tip pair off this callback.
    /// </summary>
    public Action<Control, QrHostOption, bool>? RowHover { get; set; }

    /// <summary>Hover/focus entered or left the closed selector row, which has its own generic tip.</summary>
    public Action<Control, bool>? SelectorHover { get; set; }

    /// <summary>
    /// Raised whenever rows stop being visible or valid (list collapsed, options replaced). The dialog
    /// uses it to take down any hover tips — a hidden or freed row does not reliably deliver its own
    /// mouse-exit.
    /// </summary>
    public Action? OptionsHidden { get; set; }

    public QrHostOption? Selected { get; private set; }

    public bool IsOpen => _list.Visible;

    public CouchCoopQrHostSelect()
    {
        Name = NodeName;
        // Ignore, not Stop: the root's rect is only the closed row, but the expanded list hangs BELOW
        // it and Godot does not clip children to the parent rect. A Stop root would swallow clicks in
        // its own band while the rows handled theirs, which reads as a dead strip. The rows are Stop,
        // so every click that matters is still consumed.
        MouseFilter = MouseFilterEnum.Ignore;
        CustomMinimumSize = new Vector2(RowWidth, RowHeight);

        _current = new CouchCoopQrHostRow(CurrentRowName, showChevron: true)
        {
            Activated = Toggle,
        };
        _current.SetAnchorsPreset(LayoutPreset.TopLeft);
        _current.Size = new Vector2(RowWidth, RowHeight);
        _current.CustomMinimumSize = new Vector2(RowWidth, RowHeight);
        _current.HoverChanged = hovered => SelectorHover?.Invoke(_current, hovered);

        // The closed row gets the same backing as the expanded list, always visible: a row that only
        // shows a color on hover reads as a label, and this control's whole job is to look pressable.
        _currentBackground.MouseFilter = MouseFilterEnum.Ignore;
        _currentBackground.Size = new Vector2(RowWidth, RowHeight);
        _currentBackground.AddThemeStyleboxOverride("panel", CreateBackingStyle());

        _list.Visible = false;
        _list.MouseFilter = MouseFilterEnum.Ignore;
        _list.Position = new Vector2(0f, RowHeight);

        // Opaque backing so the list stays readable where it overlaps the QR code.
        _listBackground.MouseFilter = MouseFilterEnum.Ignore;
        _listBackground.AddThemeStyleboxOverride("panel", CreateBackingStyle());

        _list.AddChild(_listBackground);
        AddChild(_currentBackground);
        AddChild(_current);
        AddChild(_list);
    }

    public void Install()
    {
        _current.Install();
        foreach (var row in _rows)
        {
            row.Install();
        }
    }

    /// <summary>Reapplies locale-sensitive fonts to retained rows without changing the open/selection state.</summary>
    public void RefreshLocalization()
    {
        _current.RefreshLocalization();
        foreach (var row in _rows)
        {
            row.RefreshLocalization();
        }
    }

    /// <summary>
    /// Replace the offered options. <paramref name="preferredSelectionKey"/> keeps a pick selected
    /// across a refresh: an exact <see cref="QrHostOption.SelectionKey"/> match wins, else the default —
    /// the first ENABLED option.
    /// </summary>
    public void SetOptions(IReadOnlyList<QrHostOption> options, string? preferredSelectionKey = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        _options = options;

        // Tips down BEFORE the rows they hang off are freed: QueueFree defers the free, so the game's
        // own TreeExiting backstop fires a frame later than the rows disappear from view.
        OptionsHidden?.Invoke();

        foreach (var row in _rows)
        {
            row.QueueFree();
        }

        _rows.Clear();
        Close();

        for (var index = 0; index < options.Count; index++)
        {
            var option = options[index];
            var row = new CouchCoopQrHostRow($"{OptionNamePrefix}{index.ToString(System.Globalization.CultureInfo.InvariantCulture)}");
            row.SetAnchorsPreset(LayoutPreset.TopLeft);
            row.Position = new Vector2(0f, index * RowHeight);
            row.Size = new Vector2(RowWidth, RowHeight);
            row.CustomMinimumSize = new Vector2(RowWidth, RowHeight);
            row.SetOption(option);
            if (option.Enabled)
            {
                row.Activated = () => Choose(option);
            }

            row.HoverChanged = hovered => RowHover?.Invoke(row, option, hovered);
            _rows.Add(row);
            _list.AddChild(row);
            row.Install();
            // After Install: Install() forces FocusMode.All, and an unselectable row must end up None.
            row.SetSelectable(option.Enabled);
        }

        _listBackground.Size = new Vector2(RowWidth, MathF.Max(options.Count * RowHeight, 1f));

        // Controller navigation: up/down walks the ENABLED rows instead of escaping to whatever
        // Godot's geometric guess finds — disabled rows are unfocusable, so they are skipped in the
        // chain too. Wired after every row exists so the paths resolve.
        CouchCoopQrHostRow? previous = null;
        for (var index = 0; index < _rows.Count; index++)
        {
            if (!options[index].Enabled)
            {
                continue;
            }

            if (previous is not null)
            {
                _rows[index].FocusNeighborTop = previous.GetPath();
                previous.FocusNeighborBottom = _rows[index].GetPath();
            }

            previous = _rows[index];
        }

        Selected = QrHostOptions.RestoreSelection(options, preferredSelectionKey);
        _current.SetOption(Selected);
    }

    public void Toggle()
    {
        if (IsOpen)
        {
            Close();
            return;
        }

        if (_rows.Count > 0)
        {
            _list.Visible = true;
        }
    }

    public void Close()
    {
        if (_list.Visible)
        {
            _list.Visible = false;
            // Rows just vanished under the cursor; Godot does not reliably deliver their mouse-exit.
            OptionsHidden?.Invoke();
        }
    }

    // One style per surface: the closed row and the expanded list must stay visually one control,
    // and a theme stylebox cannot be shared between two Panels without them fighting over it.
    private static StyleBox CreateBackingStyle() => CouchCoopGameUiTheme.CreateFallbackStyle(
        new Color(0.043f, 0.055f, 0.078f, 0.97f), new Color(1f, 1f, 1f, 0.2f), cornerRadius: 8, borderWidth: 2);

    /// <summary>Height the expanded list occupies below the closed row, for the dialog's hit testing.</summary>
    public float ExpandedHeight => RowHeight + (IsOpen ? _rows.Count * RowHeight : 0f);

    private void Choose(QrHostOption option)
    {
        Close();
        if (!option.Enabled)
        {
            return;
        }

        if (Selected is not null && string.Equals(Selected.SelectionKey, option.SelectionKey, StringComparison.Ordinal))
        {
            return;
        }

        Selected = option;
        _current.SetOption(option);
        SelectionChanged?.Invoke(option);
    }
}

/// <summary>
/// One option row, styled after <c>scenes/ui/dropdown_item.tscn</c>: a hidden <c>Highlight</c> ColorRect
/// revealed on hover/controller focus, over a two-line label.
/// </summary>
internal sealed partial class CouchCoopQrHostRow : CouchCoopTextureButton
{
    public const string HighlightName = "Highlight";
    public const string DetailLabelName = "Detail";

    private readonly ColorRect _highlight = new() { Name = HighlightName };
    private readonly Label _detail = new() { Name = DetailLabelName };
    private readonly Label? _chevron;
    private QrHostOption? _option;
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

        // Host on the left, source on the right — the address is what the player reads, the detail is
        // only how they tell two rows apart (which adapter, which blocker).
        ButtonLabel.HorizontalAlignment = HorizontalAlignment.Left;
        ButtonLabel.AutowrapMode = TextServer.AutowrapMode.Off;
        ButtonLabel.OffsetLeft = 20f;
        ButtonLabel.OffsetRight = -220f;
        CouchCoopGameUiTheme.ApplyFont(ButtonLabel, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 30);
        StyleLabel(ButtonLabel, CouchCoopGameUiTheme.DropdownFontColor);

        _detail.SetAnchorsPreset(LayoutPreset.FullRect);
        _detail.MouseFilter = MouseFilterEnum.Ignore;
        _detail.HorizontalAlignment = HorizontalAlignment.Right;
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

    public void SetOption(QrHostOption? option)
    {
        _option = option;
        Text = option?.Label ?? CouchCoopLocalization.Resolve("couchcoop_option_no_address");
        _detail.Text = option?.Detail ?? string.Empty;
    }

    /// <summary>Reapplies the current locale's font while retaining row content and interaction state.</summary>
    public void RefreshLocalization()
    {
        SetOption(_option);
        CouchCoopGameUiTheme.ApplyFont(ButtonLabel, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 30);
        CouchCoopGameUiTheme.ApplyFont(_detail, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 20);
        if (_chevron is not null)
        {
            CouchCoopGameUiTheme.ApplyFont(_chevron, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 26);
        }
    }

    /// <summary>
    /// Grey and de-activate the row without deafening it: hover (and therefore the explanatory tips)
    /// keeps working, clicks and controller focus do not. Call AFTER <see cref="CouchCoopTextureButton.Install"/>,
    /// which forces <see cref="Control.FocusMode"/> back to All.
    /// </summary>
    public void SetSelectable(bool selectable)
    {
        _selectable = selectable;
        FocusMode = selectable ? FocusModeEnum.All : FocusModeEnum.None;
        Modulate = new Color(1f, 1f, 1f, selectable ? 1f : 0.45f);
    }

    public bool IsSelectable => _selectable;

    // An unselectable row must not light up, click or play SFX — but its hover must still be
    // observable, so the base is skipped rather than the whole handler.
    protected override void OnFocus()
    {
        if (_selectable)
        {
            base.OnFocus();
        }

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
