using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Localization;
using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>The QR dialog's live browser-connection companion card.</summary>
internal sealed partial class CouchCoopConnectionPanel : Panel
{
    public const string NodeName = "CouchCoopConnectionPanel";
    public const string ListName = "CouchCoopConnectionList";
    public const string DetailName = "CouchCoopConnectionDetail";

    private readonly StyleBoxFlat _style = new();
    private readonly Label _title = new();
    private readonly ScrollContainer _scroll = new() { Name = ListName };
    private readonly VBoxContainer _rows = new();
    private readonly RichTextLabel _detail = new() { Name = DetailName };
    private readonly Label _overflow = new();
    private readonly Button _copy = new();
    private readonly Button _dismiss = new();
    private readonly Label _feedback = new();
    private readonly List<Control> _focus = [];
    private readonly Dictionary<Guid, Button> _rowControls = [];
    private readonly Dictionary<Guid, Label[]> _rowLabels = [];
    private Guid? _selected;
    private int _localeRevision = -1;
    private long _renderedRevision = -1;
    private bool _installed;
    private bool _hasAppeared;

    public Action? FocusChainChanged { get; set; }

    public CouchCoopConnectionPanel()
    {
        Name = NodeName;
        MouseFilter = MouseFilterEnum.Stop;
        FocusMode = FocusModeEnum.None;
        AnchorLeft = 0.5f;
        AnchorRight = 0.5f;
        AnchorTop = 0.5f;
        AnchorBottom = 0.5f;
        OffsetLeft = CouchCoopConnectionLayout.Left - 960f;
        OffsetRight = OffsetLeft + CouchCoopConnectionLayout.Width;
        OffsetTop = -CouchCoopConnectionLayout.Height / 2f;
        OffsetBottom = CouchCoopConnectionLayout.Height / 2f;

        _style.BgColor = Color.FromHtml(HostLobbyQrOverlayLayout.DefaultPanelColorHtml);
        _style.BorderColor = Color.FromHtml(HostLobbyQrOverlayLayout.DefaultPanelBorderColorHtml);
        _style.SetBorderWidthAll(3);
        _style.SetCornerRadiusAll(16);
        AddThemeStyleboxOverride("panel", _style);

        ConfigureLabel(_title, 22);
        _title.HorizontalAlignment = HorizontalAlignment.Center;
        _title.Position = new Vector2(CouchCoopConnectionLayout.Padding, 8);
        _title.Size = new Vector2(CouchCoopConnectionLayout.Width - CouchCoopConnectionLayout.Padding * 2, CouchCoopConnectionLayout.TitleHeight);

        _scroll.Position = new Vector2(CouchCoopConnectionLayout.Padding, 60);
        _scroll.Size = new Vector2(CouchCoopConnectionLayout.Width - CouchCoopConnectionLayout.Padding * 2, 520);
        _scroll.HorizontalScrollMode = ScrollContainer.ScrollMode.Disabled;
        _scroll.MouseFilter = MouseFilterEnum.Stop;
        _rows.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
        _rows.AddThemeConstantOverride("separation", 8);
        _scroll.AddChild(_rows);

        _detail.BbcodeEnabled = false;
        _detail.FitContent = false;
        _detail.ScrollActive = true;
        _detail.SelectionEnabled = true;
        _detail.FocusMode = FocusModeEnum.All;
        _detail.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        _detail.MouseFilter = MouseFilterEnum.Stop;
        _detail.Position = new Vector2(CouchCoopConnectionLayout.Padding, 592);
        _detail.Size = new Vector2(CouchCoopConnectionLayout.Width - CouchCoopConnectionLayout.Padding * 2, 190);
        _detail.AddThemeColorOverride("default_color", CouchCoopGameUiTheme.ButtonFontColor);

        ConfigureLabel(_overflow, 14);
        _overflow.HorizontalAlignment = HorizontalAlignment.Center;
        _overflow.Position = new Vector2(CouchCoopConnectionLayout.Padding, 566);
        _overflow.Size = new Vector2(CouchCoopConnectionLayout.Width - CouchCoopConnectionLayout.Padding * 2, 24);

        ConfigureButton(_copy);
        _copy.Position = new Vector2(CouchCoopConnectionLayout.Padding, 796);
        _copy.Size = new Vector2(180, 52);
        ConfigureButton(_dismiss);
        _dismiss.Position = new Vector2(CouchCoopConnectionLayout.Width - CouchCoopConnectionLayout.Padding - 180, 796);
        _dismiss.Size = new Vector2(180, 52);

        ConfigureLabel(_feedback, 16);
        _feedback.HorizontalAlignment = HorizontalAlignment.Center;
        _feedback.Position = new Vector2(CouchCoopConnectionLayout.Padding, 858);
        _feedback.Size = new Vector2(CouchCoopConnectionLayout.Width - CouchCoopConnectionLayout.Padding * 2, 32);

        AddChild(_title);
        AddChild(_scroll);
        AddChild(_detail);
        AddChild(_overflow);
        AddChild(_copy);
        AddChild(_dismiss);
        AddChild(_feedback);
        Visible = false;
    }

    /// <summary>
    /// Explicit wiring, called by the dialog's install path.  This assembly must not depend on a
    /// virtual <c>_Ready</c> callback being dispatched by the game host.
    /// </summary>
    public void Install()
    {
        if (_installed) return;
        _installed = true;
        _copy.Pressed += OnCopy;
        _dismiss.Pressed += OnDismiss;
        _detail.GuiInput += OnDetailInput;
    }

    public void Refresh(bool force = false)
    {
        var snapshot = ConnectionRegistry.Shared.Snapshot();
        var localeChanged = _localeRevision != CouchCoopLocalization.Revision;
        RefreshLocalization();
        var rows = snapshot.Rows.Where(row => row.IsLive || (row.Issue is not null && !row.Dismissed)).ToArray();
        Visible = rows.Length > 0;
        if (Visible && !_hasAppeared)
        {
            _hasAppeared = true;
            var final = Position;
            Position = final + new Vector2(-24, 0);
            CreateTween().TweenProperty(this, "position", final, 0.16f);
        }
        if (!Visible)
        {
            var hadFocusControls = _focus.Count > 0;
            _selected = null;
            _focus.Clear();
            _rowControls.Clear();
            _rowLabels.Clear();
            _renderedRevision = snapshot.Revision;
            if (hadFocusControls) FocusChainChanged?.Invoke();
            return;
        }

        if (_selected is { } selected && !rows.Any(row => row.Id == selected))
        {
            _selected = null;
        }
        _selected ??= rows[0].Id;

        // A lobby scan runs four times a second.  Rows only need rebuilding when lifecycle data or
        // wording changes; elapsed labels are updated in place so a focused Deck row never disappears.
        if (!force && !localeChanged && _renderedRevision == snapshot.Revision)
        {
            foreach (var row in rows)
            {
                if (_rowControls.TryGetValue(row.Id, out var control)) UpdateRow(control, _rowLabels[row.Id], row);
            }
            return;
        }

        var focused = _rowControls.FirstOrDefault(pair => pair.Value.HasFocus()).Key;
        foreach (var child in _rows.GetChildren()) child.QueueFree();
        _focus.Clear();
        _rowControls.Clear();
        _rowLabels.Clear();
        var liveRows = rows.Where(row => row.IsLive && row.Issue is null).ToArray();
        var issueRows = rows.Where(row => row.Issue is not null).ToArray();
        AddSection(liveRows, "couchcoop_connection_live");
        AddSection(issueRows, "couchcoop_connection_recent_issues");

        void AddSection(IReadOnlyList<ConnectionStatusRow> section, string labelKey)
        {
            if (section.Count == 0) return;
            var header = new Label { Text = CouchCoopLocalization.Resolve(labelKey) };
            ConfigureLabel(header, 16);
            _rows.AddChild(header);
            foreach (var row in section)
            {
                var button = new Button { FocusMode = FocusModeEnum.All, MouseFilter = MouseFilterEnum.Stop };
                ConfigureButton(button);
                button.ToggleMode = true;
                button.ButtonPressed = row.Id == _selected;
                button.CustomMinimumSize = new Vector2(0, 104);
                var lines = new VBoxContainer { MouseFilter = MouseFilterEnum.Ignore, Alignment = BoxContainer.AlignmentMode.Center };
                lines.AddThemeConstantOverride("separation", 0);
                button.AddChild(lines);
                lines.SetAnchorsAndOffsetsPreset(LayoutPreset.FullRect);
                lines.OffsetLeft = 4;
                lines.OffsetRight = -4;
                var labels = Enumerable.Range(0, 4).Select(index =>
                {
                    var label = new Label();
                    ConfigureLabel(label, index == 3 ? 15 : 18);
                    label.AutowrapMode = TextServer.AutowrapMode.Off;
                    label.ClipText = true;
                    label.TextOverrunBehavior = TextServer.OverrunBehavior.TrimEllipsis;
                    lines.AddChild(label);
                    return label;
                }).ToArray();
                UpdateRow(button, labels, row);
                var id = row.Id;
                button.Pressed += () => Select(id);
                button.FocusEntered += () => _scroll.EnsureControlVisible(button);
                _rows.AddChild(button);
                _focus.Add(button);
                _rowControls.Add(id, button);
                _rowLabels.Add(id, labels);
            }
        }

        var current = rows.First(row => row.Id == _selected);
        var report = current.Issue is null ? null : ConnectionRegistry.Shared.BuildReport(current.Id);
        var reportDetails = report is not null && report.IndexOf("\nreport id:", StringComparison.Ordinal) is var reportStart && reportStart >= 0
            ? report[reportStart..] : string.Empty;
        var detailScroll = _detail.GetVScrollBar().Value;
        _detail.Text = current.Issue is { } issue ? $"{LocalizedIssue(issue)}\n{reportDetails}"
            : CouchCoopLocalization.Resolve("couchcoop_connection_detail_waiting");
        _detail.GetVScrollBar().SetDeferred(Godot.Range.PropertyName.Value, detailScroll);
        _copy.Visible = !string.IsNullOrWhiteSpace(report);
        _dismiss.Visible = current.Issue is not null;
        _copy.Text = CouchCoopLocalization.Resolve("couchcoop_connection_copy_report");
        _dismiss.Text = CouchCoopLocalization.Resolve("couchcoop_connection_dismiss");
        _overflow.Text = rows.Any(row => row.IssueHistoryOverflow > 0)
            ? $"{snapshot.OverflowCount}: {CouchCoopLocalization.Resolve("couchcoop_connection_history_overflow")}" : string.Empty;
        _overflow.Visible = !string.IsNullOrEmpty(_overflow.Text);
        if (current.Issue is not null) _focus.Add(_detail);
        if (_copy.Visible) _focus.Add(_copy);
        if (_dismiss.Visible) _focus.Add(_dismiss);
        _renderedRevision = snapshot.Revision;
        FocusChainChanged?.Invoke();
        if (focused != Guid.Empty && _rowControls.TryGetValue(focused, out var replacement))
        {
            replacement.CallDeferred(Control.MethodName.GrabFocus);
        }
    }

    public void AppendFocusChain(List<Control> chain) => chain.AddRange(_focus.Where(control => control.Visible));

    public static (int Count, HashSet<string> Keys) Attention()
    {
        var rows = ConnectionRegistry.Shared.Snapshot().Rows
            .Where(row => row.Issue is not null && !row.Dismissed).ToArray();
        return (rows.Length, rows.Select(row => $"{row.Id:N}:{row.Issue!.Code}").ToHashSet(StringComparer.Ordinal));
    }

    private void Select(Guid id)
    {
        _selected = id;
        _detail.GetVScrollBar().Value = 0;
        _feedback.Text = string.Empty;
        Refresh(force: true);
    }

    private void OnCopy()
    {
        if (_selected is not { } id || ConnectionRegistry.Shared.BuildReport(id) is not { Length: > 0 } report)
        {
            return;
        }
        _feedback.Text = CouchCoopClipboard.TryCopy(report, DisplayServer.ClipboardSet, DisplayServer.ClipboardGet)
            ? CouchCoopLocalization.Resolve("couchcoop_connection_copied")
            : CouchCoopLocalization.Resolve("couchcoop_connection_copy_failed");
    }

    private void OnDismiss()
    {
        if (_selected is { } id && ConnectionRegistry.Shared.Dismiss(id))
        {
            _selected = null;
            _feedback.Text = string.Empty;
            Refresh(force: true);
        }
    }

    private void OnDetailInput(InputEvent input)
    {
        var direction = input switch
        {
            InputEventKey { Pressed: true, Keycode: Key.Pageup } => -1,
            InputEventKey { Pressed: true, Keycode: Key.Pagedown } => 1,
            InputEventJoypadButton { Pressed: true, ButtonIndex: JoyButton.LeftShoulder } => -1,
            InputEventJoypadButton { Pressed: true, ButtonIndex: JoyButton.RightShoulder } => 1,
            _ => 0
        };
        if (direction == 0) return;
        _detail.GetVScrollBar().Value += direction * _detail.Size.Y;
        _detail.AcceptEvent();
    }

    private void RefreshLocalization()
    {
        if (_localeRevision == CouchCoopLocalization.Revision) return;
        _localeRevision = CouchCoopLocalization.Revision;
        _title.Text = CouchCoopLocalization.Resolve("couchcoop_connection_title");
        CouchCoopGameUiTheme.ApplyFont(_title, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 22);
        CouchCoopGameUiTheme.ApplyRichFont(_detail, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 18);
    }

    private static void UpdateRow(Button button, Label[] labels, ConnectionStatusRow row)
    {
        var text = RowText(row);
        button.AccessibilityName = text;
        var lines = text.Split('\n');
        for (var index = 0; index < labels.Length; index++) labels[index].Text = lines[index];
    }

    private static string RowText(ConnectionStatusRow row)
    {
        var device = row.DeviceLabel == "Host service"
            ? CouchCoopLocalization.Resolve("couchcoop_connection_host_service")
            : string.IsNullOrWhiteSpace(row.DeviceLabel)
            ? CouchCoopLocalization.Resolve("couchcoop_connection_unknown_device") : row.DeviceLabel;
        var name = string.IsNullOrWhiteSpace(row.DisplayName) ? "…" : row.DisplayName;
        var phase = CouchCoopLocalization.Resolve($"couchcoop_connection_stage_{(row.FailedStage ?? row.Stage).ToString().ToLowerInvariant()}");
        var elapsed = TimeSpan.FromMilliseconds(Math.Max(row.StageElapsedMs, 0));
        var elapsedText = row.Stage is ConnectionStage.Initializing or ConnectionStage.Joining or ConnectionStage.LoadingView
            ? $" ({Math.Max(0, (int)Math.Floor(elapsed.TotalSeconds))}s)" : string.Empty;
        var progress = row.Stage == ConnectionStage.Failed ? row.Issue?.Code ?? "connection-failed" : row.Stage == ConnectionStage.Complete
            ? "✓"
            : CouchCoopLocalization.Resolve("couchcoop_connection_progress", new Dictionary<string, CouchCoopTextArgument>
            {
                ["current"] = row.StepCount.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["total"] = row.StepTotal.ToString(System.Globalization.CultureInfo.InvariantCulture),
            });
        return $"{SingleLine(device)}\n{SingleLine(name)}\n{phase}{elapsedText}\n{progress}";
    }

    private static string SingleLine(string value)
        => value.Replace('\r', ' ').Replace('\n', ' ').Trim();

    private static string LocalizedIssue(ConnectionIssue issue)
    {
        var key = issue.Code switch
        {
            "launch-exception" or "launch-refused" or "process-exited" or "startup-timeout" or "process-monitor-failed" => "launch",
            // Its own group, not the generic join one: the remedy is to remove one of the two installed copies
            // of the mod, which no amount of reconnecting achieves.
            Session.HeadlessClientManager.SeatBuildMismatchCode => "mod_mismatch",
            "native-join-rejected" or "native-disconnected" or "child-status-lost" => "join",
            "browser-view-slow" => "slow",
            "browser-render-failed" or "browser-transport-lost" => "browser",
            "host-service-failed" or "host-service-stopped" => "service",
            _ => "join"
        };
        var summaryKey = issue.Code == "process-exited" ? "process_exit" : key;
        var summary = CouchCoopLocalization.Resolve($"couchcoop_connection_error_{summaryKey}_summary");
        var action = CouchCoopLocalization.Resolve($"couchcoop_connection_error_{key}_action");
        return string.IsNullOrWhiteSpace(issue.Detail) ? $"{summary}\n{action}" : $"{summary}\n{action}\n\n{ConnectionReportFormatter.SanitizeDiagnostic(issue.Detail)}";
    }

    private static void ConfigureLabel(Label label, int size)
    {
        label.MouseFilter = MouseFilterEnum.Ignore;
        label.VerticalAlignment = VerticalAlignment.Center;
        label.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        label.AddThemeColorOverride("font_color", CouchCoopGameUiTheme.ButtonFontColor);
        CouchCoopGameUiTheme.ApplyFont(label, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, size);
    }

    private static void ConfigureButton(Button button)
    {
        button.FocusMode = FocusModeEnum.All;
        button.MouseFilter = MouseFilterEnum.Stop;
        button.AddThemeFontOverride("font", CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne);
        button.AddThemeFontSizeOverride("font_size", 18);
    }
}
