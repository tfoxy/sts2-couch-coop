using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Session;
using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The QR dialog's right-hand companion card: the mods the host may turn off for the games it runs for browser
/// players, for when one of those mods crashes them.
/// </summary>
/// <remarks>
/// <para>
/// The connection card's mirror image, built the same way for the same reasons: a sibling of the QR card
/// rather than a row inside it, signals wired in <see cref="Install"/> because the host cannot be trusted to
/// call Ready, and hidden outright when it has nothing to list. Every decision it draws — which rows, what each
/// says, what a press does — comes from <see cref="SeatModPanelModel"/>, which is where the rules are tested.
/// </para>
/// <para>
/// Read in <see cref="Refresh"/>, which the dialog calls from Open ONLY (see the dialog's cost note). The
/// inventory can mean reading manifests off disk, and nothing about it changes while the dialog is up except
/// through this card's own presses, which it applies itself.
/// </para>
/// <para>
/// It stays editable while players are connected. A change is written for the next game the host launches for
/// a player; one already running keeps the mods it started with, and the standing copy says so.
/// </para>
/// </remarks>
internal sealed partial class CouchCoopSeatModPanel : Panel
{
    public const string NodeName = "CouchCoopSeatModPanel";
    public const string ListName = "CouchCoopSeatModList";
    public const string DetailName = "CouchCoopSeatModDetail";
    public const string ConfirmName = "CouchCoopSeatModConfirm";
    public const string CancelName = "CouchCoopSeatModCancel";
    private readonly StyleBoxFlat _style = new();
    private readonly Label _title = new();
    private readonly ScrollContainer _scroll = new()
    {
        Name = ListName
    };
    private readonly VBoxContainer _group = new();
    private readonly Label _purpose = new(), _visuals = new(), _declared = new();
    private readonly ScrollContainer _detailScroll = new()
    {
        Name = DetailName
    };
    private readonly Label _detail = new();
    private readonly Button _confirm = new()
    {
        Name = ConfirmName
    };
    private readonly Button _cancel = new()
    {
        Name = CancelName
    };
    private readonly Dictionary<string, Button> _rowControls = new(SeatModSelectionPlan.IdComparer);
    private readonly Dictionary<string, Label[]> _rowLabels = new(SeatModSelectionPlan.IdComparer);
    private IReadOnlyList<SeatModDescriptor> _mods = [];
    private HashSet<string> _chosen = new(SeatModSelectionPlan.IdComparer);
    private IReadOnlyList<SeatModRowView> _view = [];
    // What the explanation box is about: the highlighted row, a turn-off waiting on its confirm, and the note
    // the last press left. All three are per-opening and reset by Refresh.
    private string? _subject;
    private SeatModPress? _pending;
    private CouchCoopText? _note;
    private string? _lastPressId;
    private ulong _lastPressFrame;
    private int _localeRevision = -1;
    private bool _installed, _hasAppeared;

    /// <summary>Where the inventory and the host's choices come from. The dialog hands it the host's own.</summary>
    public ISeatModSelectionSource Source { get; set; } = SeatModSelectionService.Shared;
    public Action? FocusChainChanged { get; set; }

    public CouchCoopSeatModPanel()
    {
        Name = NodeName;
        MouseFilter = MouseFilterEnum.Stop;
        FocusMode = FocusModeEnum.None;
        AnchorLeft = AnchorRight = AnchorTop = AnchorBottom = .5f;
        OffsetLeft = CouchCoopSeatModLayout.Left - 960f;
        OffsetRight = OffsetLeft + CouchCoopSeatModLayout.Width;
        OffsetTop = -CouchCoopSeatModLayout.Height / 2f;
        OffsetBottom = CouchCoopSeatModLayout.Height / 2f;
        _style.BgColor = Color.FromHtml(HostLobbyQrOverlayLayout.DefaultPanelColorHtml);
        _style.BorderColor = Color.FromHtml(HostLobbyQrOverlayLayout.DefaultPanelBorderColorHtml);
        _style.SetBorderWidthAll(3);
        _style.SetCornerRadiusAll(16);
        AddThemeStyleboxOverride("panel", _style);
        ConfigureLabel(_title, CouchCoopGameUiTheme.ConnectionTitleFontSize, CouchCoopGameUiTheme.ConnectionPanelTitleGold);
        _title.HorizontalAlignment = HorizontalAlignment.Center;
        _title.Position = new Vector2(CouchCoopSeatModLayout.Padding, CouchCoopSeatModLayout.TitleTop);
        _title.Size = new Vector2(CouchCoopSeatModLayout.InnerWidth, CouchCoopSeatModLayout.TitleHeight);
        _scroll.Position = new Vector2(CouchCoopSeatModLayout.Padding, CouchCoopSeatModLayout.ListTop);
        _scroll.Size = new Vector2(CouchCoopSeatModLayout.InnerWidth, CouchCoopSeatModLayout.ListHeight);
        _scroll.HorizontalScrollMode = ScrollContainer.ScrollMode.Disabled;
        _scroll.AddChild(BuildGroup());
        _detailScroll.Position = new Vector2(CouchCoopSeatModLayout.Padding, CouchCoopSeatModLayout.DetailTop);
        _detailScroll.Size = new Vector2(CouchCoopSeatModLayout.InnerWidth, CouchCoopSeatModLayout.DetailHeightFor(false));
        _detailScroll.HorizontalScrollMode = ScrollContainer.ScrollMode.Disabled;
        ConfigureLabel(_detail, CouchCoopGameUiTheme.ConnectionBodyFontSize, CouchCoopGameUiTheme.ConnectionExplanationCream);
        _detail.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        _detailScroll.AddChild(_detail);
        ConfigureButton(_confirm);
        _confirm.Position = new Vector2(CouchCoopSeatModLayout.Padding, CouchCoopSeatModLayout.ButtonTop);
        _confirm.Size = new Vector2(CouchCoopSeatModLayout.ButtonWidth, CouchCoopSeatModLayout.ButtonHeight);
        ConfigureButton(_cancel);
        _cancel.Position = new Vector2(CouchCoopSeatModLayout.Width - CouchCoopSeatModLayout.Padding - CouchCoopSeatModLayout.ButtonWidth, CouchCoopSeatModLayout.ButtonTop);
        _cancel.Size = new Vector2(CouchCoopSeatModLayout.ButtonWidth, CouchCoopSeatModLayout.ButtonHeight);
        _confirm.Visible = _cancel.Visible = false;
        AddChild(_title);
        AddChild(_scroll);
        AddChild(_detailScroll);
        AddChild(_confirm);
        AddChild(_cancel);
        Visible = false;
    }

    /// <summary>Wires native Godot signals explicitly because the host cannot be trusted to call Ready.</summary>
    public void Install()
    {
        if (_installed)
            return;
        _installed = true;
        _confirm.Pressed += OnConfirm;
        _cancel.Pressed += OnCancel;
    }

    /// <summary>Re-read the inventory and the host's choices, and redraw from scratch. Called when the dialog opens.</summary>
    public void Refresh()
    {
        RefreshLocalization();
        Read();
        _subject = null;
        _pending = null;
        _note = null;
        _view = SeatModPanelModel.Rows(_mods, _chosen);
        var hadRows = _rowControls.Count > 0;
        ClearRows();
        Visible = _view.Count > 0;
        if (Visible && !_hasAppeared)
        {
            _hasAppeared = true;
            var final = Position;
            Position = final + new Vector2(24, 0);
            CreateTween().TweenProperty(this, "position", final, .16f);
        }

        if (!Visible)
        {
            _confirm.Visible = _cancel.Visible = false;
            if (hadRows)
                FocusChainChanged?.Invoke();
            return;
        }

        foreach (var row in _view)
            AddRow(row);
        _scroll.ScrollVertical = 0;
        Render();
        FocusChainChanged?.Invoke();
    }

    /// <summary>The rows, then the confirm pair while a turn-off is waiting on it.</summary>
    public void AppendFocusChain(List<Control> chain)
    {
        if (!Visible)
            return;
        foreach (var row in _view)
            if (_rowControls.TryGetValue(row.Id, out var button))
                chain.Add(button);
        if (_pending is not null)
        {
            chain.Add(_confirm);
            chain.Add(_cancel);
        }
    }

    public void RefreshLocalization()
    {
        if (_localeRevision == CouchCoopLocalization.Revision)
            return;
        _localeRevision = CouchCoopLocalization.Revision;
        _title.Text = CouchCoopLocalization.Resolve(SeatModPanelModel.TitleKey);
        _purpose.Text = CouchCoopLocalization.Resolve(SeatModPanelModel.PurposeKey);
        _visuals.Text = CouchCoopLocalization.Resolve(SeatModPanelModel.VisualsKey);
        _declared.Text = CouchCoopLocalization.Resolve(SeatModPanelModel.DeclaredKey);
        _confirm.Text = CouchCoopLocalization.Resolve(SeatModPanelModel.ConfirmKey);
        _cancel.Text = CouchCoopLocalization.Resolve(SeatModPanelModel.CancelKey);
        // Five locales swap Kreon for the game's substitute face, so the fonts follow the language as well.
        ApplyFont(_title, CouchCoopGameUiTheme.ConnectionTitleFontSize);
        ApplyFont(_purpose, CouchCoopGameUiTheme.ConnectionHeadingFontSize);
        ApplyFont(_visuals, CouchCoopGameUiTheme.ConnectionSubtitleFontSize);
        ApplyFont(_declared, CouchCoopGameUiTheme.ConnectionSubtitleFontSize);
        ApplyFont(_detail, CouchCoopGameUiTheme.ConnectionBodyFontSize);
        CouchCoopGameUiTheme.ApplyFont(_confirm, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopGameUiTheme.ConnectionBodyFontSize);
        CouchCoopGameUiTheme.ApplyFont(_cancel, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopGameUiTheme.ConnectionBodyFontSize);
        foreach (var labels in _rowLabels.Values)
        {
            ApplyFont(labels[0], CouchCoopGameUiTheme.ConnectionBodyFontSize);
            ApplyFont(labels[1], CouchCoopGameUiTheme.ConnectionSubtitleFontSize);
        }

        Render();
    }

    private void Read()
    {
        try
        {
            _mods = Source.ReadInventory() ?? [];
            _chosen = new HashSet<string>(Source.ReadExplicitlyDisabled() ?? new HashSet<string>(), SeatModSelectionPlan.IdComparer);
        }
        catch (Exception exception)
        {
            // Hide rather than offer switches whose state could not be read; the dialog must still open.
            CouchCoopLog.Stderr($"seat mod panel read failed detail={exception.GetType().Name}: {exception.Message}");
            _mods = [];
            _chosen = new HashSet<string>(SeatModSelectionPlan.IdComparer);
        }
    }

    private Control BuildGroup()
    {
        var box = new PanelContainer
        {
            SizeFlagsHorizontal = SizeFlags.ExpandFill
        };
        var boxStyle = CouchCoopGameUiTheme.CreateFallbackStyle(new Color(.07f, .07f, .08f, .88f), CouchCoopGameUiTheme.ConnectionGroupGold, 8, 1);
        boxStyle.ContentMarginLeft = 8;
        boxStyle.ContentMarginRight = 8;
        boxStyle.ContentMarginTop = 8;
        boxStyle.ContentMarginBottom = 8;
        box.AddThemeStyleboxOverride("panel", boxStyle);
        _group.AddThemeConstantOverride("separation", 4);
        box.AddChild(_group);
        // Plain text on the group's own fill, NOT a framed box. Every row state is a framed box — and the
        // connection card's gold-framed amber group header, which this once copied, is within a shade of a
        // hovered or pressed row, so under the rows it read as one more row to select. Inset to line up with the
        // rows' own text; never focusable, never a mouse target.
        var header = new MarginContainer
        {
            FocusMode = FocusModeEnum.None,
            MouseFilter = MouseFilterEnum.Ignore
        };
        header.AddThemeConstantOverride("margin_left", 8);
        header.AddThemeConstantOverride("margin_right", 8);
        header.AddThemeConstantOverride("margin_top", 2);
        header.AddThemeConstantOverride("margin_bottom", 8);
        var lines = new VBoxContainer
        {
            MouseFilter = MouseFilterEnum.Ignore
        };
        lines.AddThemeConstantOverride("separation", 4);
        header.AddChild(lines);
        // The purpose, then the two things the host trades by turning a mod off: the players' view of it, and
        // a gameplay rule that rests on each author's own word.
        ConfigureLabel(_purpose, CouchCoopGameUiTheme.ConnectionHeadingFontSize, CouchCoopGameUiTheme.ConnectionGroupGold);
        ConfigureLabel(_visuals, CouchCoopGameUiTheme.ConnectionSubtitleFontSize, CouchCoopGameUiTheme.ConnectionSubtitleGold);
        ConfigureLabel(_declared, CouchCoopGameUiTheme.ConnectionSubtitleFontSize, CouchCoopGameUiTheme.ConnectionSubtitleGold);
        lines.AddChild(_purpose);
        lines.AddChild(_visuals);
        lines.AddChild(_declared);
        _group.AddChild(header);
        return box;
    }

    private void AddRow(SeatModRowView row)
    {
        var button = new Button
        {
            Name = row.NodeName,
            FocusMode = FocusModeEnum.All,
            ToggleMode = true,
            CustomMinimumSize = new Vector2(0, CouchCoopSeatModLayout.RowHeight)
        };
        ConfigureButton(button);
        button.AddThemeStyleboxOverride("normal", CouchCoopGameUiTheme.CreateConnectionRowStyle(selected: false));
        button.AddThemeStyleboxOverride("hover", CouchCoopGameUiTheme.CreateConnectionRowStyle(selected: true));
        button.AddThemeStyleboxOverride("pressed", CouchCoopGameUiTheme.CreateConnectionRowStyle(selected: true));
        button.AddThemeStyleboxOverride("hover_pressed", CouchCoopGameUiTheme.CreateConnectionRowStyle(selected: true));
        button.AddThemeStyleboxOverride("focus", CouchCoopGameUiTheme.CreateConnectionRowStyle(selected: false, focused: true));
        var lines = new VBoxContainer
        {
            MouseFilter = MouseFilterEnum.Ignore,
            Alignment = BoxContainer.AlignmentMode.Center
        };
        lines.AddThemeConstantOverride("separation", 0);
        button.AddChild(lines);
        lines.SetAnchorsAndOffsetsPreset(LayoutPreset.FullRect);
        lines.OffsetLeft = 8;
        lines.OffsetRight = -8;
        var labels = new[] { CouchCoopGameUiTheme.ConnectionBodyFontSize, CouchCoopGameUiTheme.ConnectionSubtitleFontSize }.Select(size =>
        {
            var label = new Label
            {
                ClipText = true,
                TextOverrunBehavior = TextServer.OverrunBehavior.TrimEllipsis
            };
            ConfigureLabel(label, size, CouchCoopGameUiTheme.ConnectionDeviceCream);
            label.AutowrapMode = TextServer.AutowrapMode.Off;
            lines.AddChild(label);
            return label;
        }).ToArray();
        var id = row.Id;
        button.Pressed += () => OnRowPressed(id);
        button.FocusEntered += () => _scroll.EnsureControlVisible(button);
        _group.AddChild(button);
        _rowControls.Add(id, button);
        _rowLabels.Add(id, labels);
    }

    private void Render()
    {
        foreach (var row in _view)
            if (_rowControls.TryGetValue(row.Id, out var button))
                UpdateRow(button, _rowLabels[row.Id], row, _subject is { } subject && SeatModSelectionPlan.IdComparer.Equals(subject, row.Id));
        var confirming = _pending is not null;
        _confirm.Visible = _cancel.Visible = confirming;
        _detailScroll.Size = new Vector2(CouchCoopSeatModLayout.InnerWidth, CouchCoopSeatModLayout.DetailHeightFor(confirming));
        var detail = (_pending?.Detail ?? _note)?.Resolve() ?? CouchCoopLocalization.Resolve(SeatModPanelModel.AppliesToNewKey);
        if (_detail.Text != detail)
        {
            // New text reads from its first line, not from wherever the last one was scrolled to.
            _detail.Text = detail;
            _detailScroll.ScrollVertical = 0;
        }
    }

    private void OnRowPressed(string id)
    {
        // A belt, not a known path: a row press is the one control in this dialog that is not idempotent, and
        // the same activation arriving twice in a frame would turn a mod off and straight back on unseen.
        var frame = Engine.GetProcessFrames();
        if (frame == _lastPressFrame && SeatModSelectionPlan.IdComparer.Equals(id, _lastPressId))
            return;
        _lastPressFrame = frame;
        _lastPressId = id;
        var wasConfirming = _pending is not null;
        var press = SeatModPanelModel.Press(_mods, _chosen, id);
        _pending = press.Kind == SeatModPressKind.ConfirmTurnOff ? press : null;
        _note = _pending is null ? press.Detail : null;
        if ((press.Kind is SeatModPressKind.TurnOff or SeatModPressKind.TurnOn) && press.Next is { } next)
            Commit(next);
        _subject = _pending is not null || _note is not null ? press.Id : null;
        Render();
        if (_pending is not null)
        {
            FocusChainChanged?.Invoke();
            // Onto the answer, so a d-pad host confirms with the next press and Cancel is one step down.
            _confirm.GrabFocus();
        }
        else if (wasConfirming)
        {
            FocusChainChanged?.Invoke();
        }
    }

    private void OnConfirm()
    {
        if (_pending is not { } pending)
            return;
        var press = SeatModPanelModel.Confirm(_mods, _chosen, pending.Id);
        if (press.Kind == SeatModPressKind.TurnOff && press.Next is { } next)
            Commit(next);
        CloseConfirm(pending.Id, press.Detail);
    }

    private void OnCancel()
    {
        if (_pending is { } pending)
            CloseConfirm(pending.Id, null);
    }

    private void CloseConfirm(string id, CouchCoopText? note)
    {
        _pending = null;
        _note = note;
        _subject = note is null ? null : id;
        // Back to the row that asked, BEFORE the pair hides: a focus owner that vanishes under a controller
        // would be re-parked at the head of the whole dialog instead.
        if (_rowControls.TryGetValue(id, out var row) && row.IsVisibleInTree())
            row.GrabFocus();
        Render();
        FocusChainChanged?.Invoke();
    }

    private void Commit(IReadOnlySet<string> next)
    {
        _chosen = new HashSet<string>(next, SeatModSelectionPlan.IdComparer);
        try
        {
            Source.WriteExplicitlyDisabled([.. _chosen]);
            CouchCoopLog.Info($"seat mods turned off by host: {(_chosen.Count == 0 ? "none" : string.Join(",", _chosen.Order(StringComparer.OrdinalIgnoreCase)))}");
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"seat mod panel write failed detail={exception.GetType().Name}: {exception.Message}");
        }

        _view = SeatModPanelModel.Rows(_mods, _chosen);
    }

    private void ClearRows()
    {
        foreach (var button in _rowControls.Values)
        {
            _group.RemoveChild(button);
            button.QueueFree();
        }

        _rowControls.Clear();
        _rowLabels.Clear();
    }

    private static void UpdateRow(Button button, Label[] labels, SeatModRowView row, bool selected)
    {
        var status = row.Status.Resolve();
        labels[0].Text = row.Name;
        labels[1].Text = status;
        labels[1].AddThemeColorOverride("font_color", StatusColor(row.State));
        button.SetPressedNoSignal(selected);
        button.AccessibilityName = $"{row.Name}. {status}";
    }

    private static Color StatusColor(SeatModRowState state) => state switch
    {
        SeatModRowState.On => CouchCoopGameUiTheme.ConnectionCompleteGreen,
        // Off is the host's own choice, not a failure: the warning orange, never the failure red.
        SeatModRowState.Off or SeatModRowState.OffWithDependency => CouchCoopGameUiTheme.ConnectionWarningOrange,
        _ => CouchCoopGameUiTheme.ConnectionProgressMuted
    };

    private static void ApplyFont(Label label, int size)
        => CouchCoopGameUiTheme.ApplyFont(label, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, size);

    private static void ConfigureLabel(Label label, int size, Color color)
    {
        label.MouseFilter = MouseFilterEnum.Ignore;
        label.VerticalAlignment = VerticalAlignment.Center;
        label.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        label.AddThemeColorOverride("font_color", color);
        ApplyFont(label, size);
    }

    private static void ConfigureButton(Button button)
    {
        button.FocusMode = FocusModeEnum.All;
        button.MouseFilter = MouseFilterEnum.Stop;
        CouchCoopGameUiTheme.ApplyFont(button, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopGameUiTheme.ConnectionBodyFontSize);
    }
}
