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
    private readonly ScrollContainer _scroll = new()
    {
        Name = ListName
    };
    private readonly VBoxContainer _rows = new();
    private readonly ScrollContainer _summaryScroll = new();
    private readonly VBoxContainer _summary = new();
    private readonly Button _technical = new();
    private readonly RichTextLabel _detail = new()
    {
        Name = DetailName
    };
    private readonly Button _copy = new(), _dismiss = new();
    private readonly Label _feedback = new();
    private readonly List<Control> _focus = [];
    private readonly Dictionary<Guid, Button> _rowControls = [];
    private readonly Dictionary<Guid, Label[]> _rowLabels = [];
    private Guid? _selected;
    private Guid? _detailIssueId;
    private int _localeRevision = -1;
    private long _renderedRevision = -1;
    private bool _installed, _hasAppeared, _technicalOpen;
    public Action? FocusChainChanged { get; set; }

    public CouchCoopConnectionPanel()
    {
        Name = NodeName;
        MouseFilter = MouseFilterEnum.Stop;
        FocusMode = FocusModeEnum.None;
        AnchorLeft = AnchorRight = AnchorTop = AnchorBottom = .5f;
        OffsetLeft = CouchCoopConnectionLayout.Left - 960f;
        OffsetRight = OffsetLeft + CouchCoopConnectionLayout.Width;
        OffsetTop = -CouchCoopConnectionLayout.Height / 2f;
        OffsetBottom = CouchCoopConnectionLayout.Height / 2f;
        _style.BgColor = Color.FromHtml(HostLobbyQrOverlayLayout.DefaultPanelColorHtml);
        _style.BorderColor = Color.FromHtml(HostLobbyQrOverlayLayout.DefaultPanelBorderColorHtml);
        _style.SetBorderWidthAll(3);
        _style.SetCornerRadiusAll(16);
        AddThemeStyleboxOverride("panel", _style);
        ConfigureLabel(_title, CouchCoopGameUiTheme.ConnectionTitleFontSize, CouchCoopGameUiTheme.ConnectionPanelTitleGold);
        _title.HorizontalAlignment = HorizontalAlignment.Center;
        Place(_title, 8, 44);
        _scroll.Position = new Vector2(CouchCoopConnectionLayout.Padding, 60);
        _scroll.Size = new Vector2(CouchCoopConnectionLayout.InnerWidth, CouchCoopConnectionLayout.ListHeight);
        _scroll.HorizontalScrollMode = ScrollContainer.ScrollMode.Disabled;
        _rows.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
        _rows.AddThemeConstantOverride("separation", 10);
        _scroll.AddChild(_rows);
        _summaryScroll.Position = new Vector2(CouchCoopConnectionLayout.Padding, CouchCoopConnectionLayout.DetailTop);
        _summaryScroll.Name = "ConnectionExplanation";
        _summaryScroll.Size = new Vector2(CouchCoopConnectionLayout.InnerWidth, CouchCoopConnectionLayout.SummaryHeight);
        _summaryScroll.HorizontalScrollMode = ScrollContainer.ScrollMode.Disabled;
        _summaryScroll.FocusMode = FocusModeEnum.All;
        _summaryScroll.AddChild(_summary);
        _summary.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        _summary.AddThemeConstantOverride("separation", 6);
        ConfigureButton(_technical);
        _technical.Name = "ConnectionTechnicalDisclosure";
        _technical.AddThemeFontSizeOverride("font_size", CouchCoopGameUiTheme.ConnectionSubtitleFontSize);
        Place(_technical, CouchCoopConnectionLayout.TechnicalToggleTop, 34);
        _technical.Pressed += ToggleTechnical;
        _detail.BbcodeEnabled = false;
        _detail.ScrollActive = true;
        _detail.SelectionEnabled = true;
        _detail.FocusMode = FocusModeEnum.All;
        _detail.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        _detail.Position = new Vector2(CouchCoopConnectionLayout.Padding, CouchCoopConnectionLayout.TechnicalTop);
        _detail.Size = new Vector2(CouchCoopConnectionLayout.InnerWidth, CouchCoopConnectionLayout.TechnicalHeight);
        _detail.AddThemeColorOverride("default_color", CouchCoopGameUiTheme.ConnectionTechnicalMuted);
        _summaryScroll.AddThemeStyleboxOverride("focus", CouchCoopGameUiTheme.CreateConnectionRowStyle(false, true));
        _detail.AddThemeStyleboxOverride("focus", CouchCoopGameUiTheme.CreateConnectionRowStyle(false, true));
        ConfigureButton(_copy);
        _copy.Position = new Vector2(CouchCoopConnectionLayout.Padding, CouchCoopConnectionLayout.ButtonTop);
        _copy.Size = new Vector2(180, 48);
        ConfigureButton(_dismiss);
        _dismiss.Position = new Vector2(CouchCoopConnectionLayout.Width - CouchCoopConnectionLayout.Padding - 180, CouchCoopConnectionLayout.ButtonTop);
        _dismiss.Size = new Vector2(180, 48);
        ConfigureLabel(_feedback, CouchCoopGameUiTheme.ConnectionSubtitleFontSize, CouchCoopGameUiTheme.ConnectionExplanationCream);
        _feedback.HorizontalAlignment = HorizontalAlignment.Center;
        Place(_feedback, CouchCoopConnectionLayout.FeedbackTop, 30);
        AddChild(_title);
        AddChild(_scroll);
        AddChild(_summaryScroll);
        AddChild(_technical);
        AddChild(_detail);
        AddChild(_copy);
        AddChild(_dismiss);
        AddChild(_feedback);
        Visible = false;
        return;
        void Place(Control control, float top, float height)
        {
            control.Position = new Vector2(CouchCoopConnectionLayout.Padding, top);
            control.Size = new Vector2(CouchCoopConnectionLayout.InnerWidth, height);
        }
    }

    /// <summary>Wires native Godot signals explicitly because the host cannot be trusted to call Ready.</summary>
    public void Install()
    {
        if (_installed)
            return;
        _installed = true;
        _copy.Pressed += OnCopy;
        _dismiss.Pressed += OnDismiss;
        _detail.GuiInput += OnDetailInput;
        _summaryScroll.GuiInput += OnSummaryInput;
    }

    public void Refresh(bool force = false)
    {
        var snapshot = ConnectionRegistry.Shared.Snapshot();
        var localeChanged = _localeRevision != CouchCoopLocalization.Revision;
        RefreshLocalization();
        var all = snapshot.Rows.Where(row => row.IsLive || (row.Issue is not null && !row.Dismissed)).ToArray();
        Visible = all.Length > 0;
        if (Visible && !_hasAppeared)
        {
            _hasAppeared = true;
            var final = Position;
            Position = final + new Vector2(-24, 0);
            CreateTween().TweenProperty(this, "position", final, .16f);
        }

        if (!Visible)
        {
            var hadFocus = _focus.Count > 0;
            Clear();
            _selected = null;
            _renderedRevision = snapshot.Revision;
            if (hadFocus)
                FocusChainChanged?.Invoke();
            return;
        }

        // An active warning gets a historical row ID on recovery or retry. Keep its report selected.
        if (_detailIssueId is { } problemId && all.FirstOrDefault(row => row.Attempt?.IssueId == problemId) is { } savedProblem)
            _selected = savedProblem.Id;
        if (_selected is { } id && !all.Any(row => row.Id == id))
        {
            _selected = null;
            _technicalOpen = false;
        }
        _selected ??= all[0].Id;
        if (!force && !localeChanged && _renderedRevision == snapshot.Revision)
        {
            foreach (var row in all)
                if (_rowControls.TryGetValue(row.Id, out var button))
                    UpdateRow(button, _rowLabels[row.Id], row);
            return;
        }

        var focused = _rowControls.FirstOrDefault(pair => pair.Value.HasFocus()).Key;
        var previousRows = _rowControls.Keys.ToArray();
        var scroll = _scroll.GetVScrollBar().Value;
        var listHeight = _scroll.Size.Y;
        Clear();
        AddGroup(all.Where(row => row.IsLive && row.Issue is null).ToArray(), "couchcoop_connection_devices", "couchcoop_connection_devices_subtitle");
        AddGroup(all.Where(row => row.Issue is not null).ToArray(), "couchcoop_connection_problems", "couchcoop_connection_problems_subtitle");
        if (snapshot.OverflowCount > 0)
        {
            var overflow = new Label { Text = $"{snapshot.OverflowCount}: {CouchCoopLocalization.Resolve("couchcoop_connection_history_overflow")}" };
            ConfigureLabel(overflow, CouchCoopGameUiTheme.ConnectionSubtitleFontSize, CouchCoopGameUiTheme.ConnectionTechnicalMuted);
            _rows.AddChild(overflow);
        }
        RenderDetails(all.First(row => row.Id == _selected));
        _renderedRevision = snapshot.Revision;
        _scroll.GetVScrollBar().SetDeferred(Godot.Range.PropertyName.Value, scroll);
        FocusChainChanged?.Invoke();
        if (focused != Guid.Empty && _rowControls.TryGetValue(focused, out var replacement))
            replacement.CallDeferred(Control.MethodName.GrabFocus);
        if (_scroll.Size.Y != listHeight || localeChanged || !previousRows.SequenceEqual(_rowControls.Keys))
            EnsureSelectionVisible();
    }

    public void AppendFocusChain(List<Control> chain) => chain.AddRange(_focus.Where(control => control.Visible));
    public static (int Count, HashSet<string> Keys) Attention()
    {
        var rows = ConnectionRegistry.Shared.Snapshot().Rows.Where(row => row.Issue is not null && !row.Dismissed).ToArray();
        return (rows.Length, rows.Select(row => (row.Attempt?.IssueId ?? row.Id).ToString("N")).ToHashSet(StringComparer.Ordinal));
    }

    private void AddGroup(IReadOnlyList<ConnectionStatusRow> section, string titleKey, string subtitleKey)
    {
        if (section.Count == 0)
            return;
        var box = new PanelContainer();
        var boxStyle = CouchCoopGameUiTheme.CreateFallbackStyle(new Color(.07f, .07f, .08f, .88f), CouchCoopGameUiTheme.ConnectionGroupGold, 8, 1);
        boxStyle.ContentMarginLeft = 8;
        boxStyle.ContentMarginRight = 8;
        boxStyle.ContentMarginTop = 8;
        boxStyle.ContentMarginBottom = 8;
        box.AddThemeStyleboxOverride("panel", boxStyle);
        var group = new VBoxContainer();
        group.AddThemeConstantOverride("separation", 4);
        box.AddChild(group);
        var header = new PanelContainer();
        var headerStyle = CouchCoopGameUiTheme.CreateFallbackStyle(new Color(.16f, .12f, .055f, 1f), CouchCoopGameUiTheme.ConnectionGroupGold, 6, 1);
        headerStyle.ContentMarginLeft = headerStyle.ContentMarginRight = 8;
        headerStyle.ContentMarginTop = headerStyle.ContentMarginBottom = 6;
        header.AddThemeStyleboxOverride("panel", headerStyle);
        var lines = new VBoxContainer();
        header.AddChild(lines);
        var title = new Label
        {
            Text = CouchCoopLocalization.Resolve(titleKey, Args("count", section.Count))
        };
        ConfigureLabel(title, CouchCoopGameUiTheme.ConnectionHeadingFontSize, CouchCoopGameUiTheme.ConnectionGroupGold);
        var subtitle = new Label
        {
            Text = CouchCoopLocalization.Resolve(subtitleKey)
        };
        ConfigureLabel(subtitle, CouchCoopGameUiTheme.ConnectionSubtitleFontSize, CouchCoopGameUiTheme.ConnectionSubtitleGold);
        lines.AddChild(title);
        lines.AddChild(subtitle);
        group.AddChild(header);
        foreach (var row in section)
            group.AddChild(AddRow(row));
        _rows.AddChild(box);
    }

    private Button AddRow(ConnectionStatusRow row)
    {
        var button = new Button
        {
            FocusMode = FocusModeEnum.All,
            ToggleMode = true,
            ButtonPressed = row.Id == _selected,
            CustomMinimumSize = new Vector2(0, 104)
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
        var labels = Enumerable.Range(0, 4).Select(index =>
        {
            var label = new Label
            {
                ClipText = true,
                TextOverrunBehavior = TextServer.OverrunBehavior.TrimEllipsis
            };
            ConfigureLabel(label, index == 3 ? CouchCoopGameUiTheme.ConnectionProgressFontSize : CouchCoopGameUiTheme.ConnectionBodyFontSize, RowColor(index, row));
            label.AutowrapMode = TextServer.AutowrapMode.Off;
            lines.AddChild(label);
            return label;
        }).ToArray();
        UpdateRow(button, labels, row);
        var id = row.Id;
        button.Pressed += () => Select(id);
        button.FocusEntered += () => _scroll.EnsureControlVisible(button);
        _focus.Add(button);
        _rowControls.Add(id, button);
        _rowLabels.Add(id, labels);
        return button;
    }

    private void RenderDetails(ConnectionStatusRow row)
    {
        foreach (var child in _summary.GetChildren())
        {
            _summary.RemoveChild(child);
            child.QueueFree();
        }
        var issue = row.Issue;
        var visible = issue is not null;
        var issueId = visible ? row.Attempt?.IssueId ?? row.Id : (Guid?)null;
        if (_detailIssueId != issueId)
        {
            _technicalOpen = false;
            _summaryScroll.ScrollVertical = 0;
            _detail.GetVScrollBar().Value = 0;
            _feedback.Text = string.Empty;
        }
        _detailIssueId = issueId;
        _summaryScroll.Visible = _technical.Visible = _copy.Visible = _dismiss.Visible = visible;
        _feedback.Visible = visible;
        _detail.Visible = visible && _technicalOpen;
        _scroll.Size = new Vector2(CouchCoopConnectionLayout.InnerWidth, CouchCoopConnectionLayout.ListHeightFor(visible, _technicalOpen));
        _summaryScroll.Position = new Vector2(CouchCoopConnectionLayout.Padding, CouchCoopConnectionLayout.SummaryTopFor(_technicalOpen));
        _technical.Position = new Vector2(CouchCoopConnectionLayout.Padding, CouchCoopConnectionLayout.DisclosureTopFor(_technicalOpen));
        if (!visible)
            return;
        AddDetail("couchcoop_connection_what_happened", Summary(issue!), CouchCoopGameUiTheme.ConnectionGroupGold);
        AddDetail("couchcoop_connection_what_try", Action(issue!), CouchCoopGameUiTheme.ConnectionGroupGold);
        AddDetail("couchcoop_connection_outcome", CouchCoopLocalization.Resolve($"couchcoop_connection_outcome_detail_{issue!.Outcome.ToString().ToLowerInvariant()}"), OutcomeColor(issue!));
        _technical.Text = CouchCoopLocalization.Resolve(_technicalOpen ? "couchcoop_connection_hide_technical" : "couchcoop_connection_show_technical");
        var scroll = _detail.GetVScrollBar().Value;
        _detail.Text = ConnectionRegistry.Shared.BuildReport(row.Id) ?? string.Empty;
        _detail.GetVScrollBar().SetDeferred(Godot.Range.PropertyName.Value, scroll);
        _copy.Text = CouchCoopLocalization.Resolve("couchcoop_connection_copy_report");
        _dismiss.Text = CouchCoopLocalization.Resolve("couchcoop_connection_dismiss");
        _focus.Add(_summaryScroll);
        _focus.Add(_technical);
        if (_technicalOpen)
            _focus.Add(_detail);
        _focus.Add(_copy);
        _focus.Add(_dismiss);
        return;
        void AddDetail(string key, string value, Color color)
        {
            var title = new Label
            {
                Text = CouchCoopLocalization.Resolve(key)
            };
            ConfigureLabel(title, CouchCoopGameUiTheme.ConnectionBodyFontSize, color);
            var body = new Label
            {
                Text = value
            };
            ConfigureLabel(body, CouchCoopGameUiTheme.ConnectionBodyFontSize, CouchCoopGameUiTheme.ConnectionExplanationCream);
            _summary.AddChild(title);
            _summary.AddChild(body);
        }
    }

    private void Select(Guid id)
    {
        if (_selected != id)
        {
            _detailIssueId = null;
            _technicalOpen = false;
            _summaryScroll.ScrollVertical = 0;
            _detail.GetVScrollBar().Value = 0;
        }
        _selected = id;
        _feedback.Text = string.Empty;
        Refresh(true);
        EnsureSelectionVisible();
    }

    private void ToggleTechnical()
    {
        _technicalOpen = !_technicalOpen;
        Refresh(true);
        EnsureSelectionVisible();
    }

    private void EnsureSelectionVisible()
    {
        // Container sorting and the new list height settle after this input callback. Waiting until
        // then keeps the selected four-line row in view when opening or expanding its report.
        Callable.From(() =>
        {
            if (!GodotObject.IsInstanceValid(this) || !IsInsideTree()) return;
            if (_selected is { } id && _rowControls.TryGetValue(id, out var row))
                _scroll.EnsureControlVisible(row);
        }).CallDeferred();
    }

    private void OnCopy()
    {
        if (_selected is { } id && ConnectionRegistry.Shared.BuildReport(id)is { Length: > 0 } report)
            _feedback.Text = CouchCoopClipboard.TryCopy(report, DisplayServer.ClipboardSet, DisplayServer.ClipboardGet) ? CouchCoopLocalization.Resolve("couchcoop_connection_copied") : CouchCoopLocalization.Resolve("couchcoop_connection_copy_failed");
    }

    private void OnDismiss()
    {
        if (_selected is { } id && ConnectionRegistry.Shared.Dismiss(id))
        {
            _selected = null;
            _detailIssueId = null;
            _technicalOpen = false;
            _feedback.Text = string.Empty;
            Refresh(true);
        }
    }

    private void OnDetailInput(InputEvent input)
    {
        var direction = PageDirection(input);
        if (direction != 0)
        {
            _detail.GetVScrollBar().Value += direction * _detail.Size.Y;
            _detail.AcceptEvent();
        }
    }

    private void OnSummaryInput(InputEvent input)
    {
        var direction = PageDirection(input);
        if (direction == 0) return;
        _summaryScroll.ScrollVertical += direction * (int)_summaryScroll.Size.Y;
        _summaryScroll.AcceptEvent();
    }

    private static int PageDirection(InputEvent input) => input switch
    {
        InputEventKey { Pressed: true, Keycode: Key.Pageup } => -1,
        InputEventKey { Pressed: true, Keycode: Key.Pagedown } => 1,
        InputEventJoypadButton { Pressed: true, ButtonIndex: JoyButton.LeftShoulder } => -1,
        InputEventJoypadButton { Pressed: true, ButtonIndex: JoyButton.RightShoulder } => 1,
        _ => 0
    };

    private void RefreshLocalization()
    {
        if (_localeRevision == CouchCoopLocalization.Revision)
            return;
        _localeRevision = CouchCoopLocalization.Revision;
        _title.Text = CouchCoopLocalization.Resolve("couchcoop_connection_title");
        CouchCoopGameUiTheme.ApplyFont(_title, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopGameUiTheme.ConnectionTitleFontSize);
        CouchCoopGameUiTheme.ApplyRichFont(_detail, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopGameUiTheme.ConnectionSubtitleFontSize);
        CouchCoopGameUiTheme.ApplyFont(_technical, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopGameUiTheme.ConnectionSubtitleFontSize);
        CouchCoopGameUiTheme.ApplyFont(_copy, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopGameUiTheme.ConnectionBodyFontSize);
        CouchCoopGameUiTheme.ApplyFont(_dismiss, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopGameUiTheme.ConnectionBodyFontSize);
    }

    private void Clear()
    {
        foreach (var child in _rows.GetChildren())
        {
            _rows.RemoveChild(child);
            child.QueueFree();
        }
        _focus.Clear();
        _rowControls.Clear();
        _rowLabels.Clear();
    }

    private static void UpdateRow(Button button, Label[] labels, ConnectionStatusRow row)
    {
        var lines = RowText(row).Split('\n');
        button.AccessibilityName = string.Join(". ", lines);
        for (var i = 0; i < labels.Length; i++)
        {
            labels[i].Text = lines[i];
            labels[i].AddThemeColorOverride("font_color", RowColor(i, row));
        }
    }

    private static string RowText(ConnectionStatusRow row)
    {
        var hostRow = row.DeviceLabel == "Host service";
        var device = hostRow ? CouchCoopLocalization.Resolve("couchcoop_connection_host_service") : string.IsNullOrWhiteSpace(row.DeviceLabel) ? CouchCoopLocalization.Resolve("couchcoop_connection_unknown_device") : row.DeviceLabel;
        var stage = row.Issue?.Timing?.Stage ?? row.FailedStage ?? row.Stage;
        var elapsed = row.Issue?.Timing?.StageElapsedMs ?? row.StageElapsedMs;
        var timer = stage is ConnectionStage.Initializing or ConnectionStage.Joining or ConnectionStage.LoadingView ? $" ({Math.Max(0, (int)(elapsed / 1000))}s)" : string.Empty;
        var status = row.Issue is { } issue ? $"{OutcomeMarker(issue.Outcome)} " : string.Empty;
        // A host-service warning has no attempt behind it, so its step count would be a fabricated "1/6";
        // it keeps the code on the fourth line like any other issue row. Client warnings are unchanged.
        var fourth = row.Issue is { IsWarning: true } && !hostRow ? CouchCoopLocalization.Resolve("couchcoop_connection_progress", Args("current", row.StepCount, "total", row.StepTotal)) : row.Issue is not null ? row.Issue.Code : stage == ConnectionStage.Complete ? "✓" : CouchCoopLocalization.Resolve("couchcoop_connection_progress", Args("current", row.StepCount, "total", row.StepTotal));
        // Keep the stage and its saved timer together. The quieter fourth line spells out the outcome.
        if (row.Issue is { } savedIssue) fourth += $" · {Outcome(savedIssue)}";
        return $"{One(device)}\n{One(string.IsNullOrWhiteSpace(row.DisplayName) ? "…" : row.DisplayName)}\n{status}{CouchCoopLocalization.Resolve($"couchcoop_connection_stage_{stage.ToString().ToLowerInvariant()}")}{timer}\n{fourth}";
    }

    private static Color RowColor(int line, ConnectionStatusRow row) => line switch
    {
        0 => CouchCoopGameUiTheme.ConnectionDeviceCream,
        1 => CouchCoopGameUiTheme.ConnectionPlayerCream,
        2 => row.Issue is { } issue ? OutcomeColor(issue) : row.Stage == ConnectionStage.Complete ? CouchCoopGameUiTheme.ConnectionCompleteGreen : CouchCoopGameUiTheme.ConnectionStageCream,
        _ => CouchCoopGameUiTheme.ConnectionProgressMuted
    };
    private static string IssueKey(ConnectionIssue issue) => issue.Code switch
    {
        "process-exited" => "process_exit",
        Session.HeadlessClientManager.SeatBuildMismatchCode => "mod_mismatch",
        // Its own key, never the generic "join" fallback: this failure is about the player's SAVES, and the join
        // copy ("check that game and mod versions match") would send the operator to look at versions while the
        // thing they need to know is that nothing was written and their saves are intact.
        Session.HeadlessClientManager.SeatCloudIsolationCode => "seat_cloud_isolation",
        // Also its own key, and for the mirror-image reason: this seat's saves are provably fine (the lobby
        // has it, so the isolation guard passed), and the thing the operator needs pointed at is that player's
        // own log and the other mods loaded beside us — not versions, ports or the network.
        Session.HeadlessClientManager.SeatSilentAfterJoinCode => "seat_silent",
        // Split out of `seat_silent`, which tells the operator their player's game stopped responding and
        // points them at its log and their other mods. This cause is reached only once the host has PROVED
        // that game is still running and serving, so that copy would send them hunting a fault that is not
        // there — the fault is on this computer, between two processes. See SeatControlBlockedCode.
        Session.HeadlessClientManager.SeatControlBlockedCode => "seat_control",
        // The three causes the old single readiness sentence used to cover. Each has its own next action — free
        // the port, allow the port through this computer's firewall, fix the path from the device — so each
        // needs its own localized copy rather than a differently-worded English detail under one key.
        Session.SeatReadinessVerdict.PortTakenCode => "seat_port",
        Session.SeatReadinessVerdict.PortBlockedCode => "seat_port_blocked",
        Session.SeatReadinessVerdict.NetworkPathCode => "seat_network",
        "launch-exception" or "launch-refused" or "startup-timeout" or "process-monitor-failed" => "launch",
        // Split out of "launch" for the same reason seat_run_in_progress was: the launch copy says "try joining
        // again", and no retry can bind a port another process owns. This row is also raised against the HOST
        // itself at host start, where "try joining again" would be addressed to nobody.
        Session.CouchSeatAvailability.NoCouchListenerCode => "host_no_couch_seats",
        "native-join-rejected" or "native-disconnected" or "child-status-lost" => "join",
        // Split OUT of "join" deliberately. The generic join copy tells the host to check that game and mod
        // versions match, which is wrong twice over for a run already in progress: nothing is mismatched, and
        // the only thing that helps is reloading the save. Both ends of the same refusal share this code — the
        // host declining to launch a seat into a running run, and a seat the host's netcode turned away.
        Session.HeadlessDisconnectReason.RunInProgressCode => "seat_run_in_progress",
        "browser-view-slow" => "slow",
        "browser-render-failed" or "browser-transport-lost" => "browser",
        "host-service-failed" or "host-service-stopped" => "service",
        Connections.CouchCoopPatchHealth.IssueCode => "patch",
        Connections.HostReachabilityWatch.IssueCode => "reachability",
        // Split out of `reachability` because the two rows are opposite news. That one says "this may just be
        // nobody having scanned yet"; this one is raised only once this computer's own firewall has been asked
        // and has said it is the blocker, and its action is a thing to go and change here.
        Connections.HostReachabilityWatch.FirewallIssueCode => "host_firewall",
        Session.HeadlessClientManager.SharedUserDirCode => "shared_profile",
        // Distinct from `seat_port` above, and deliberately so: that one is a join that FAILED on a port with an
        // owner, this one is a join that succeeded by stepping around it. Same machine condition, opposite news,
        // and the failure copy ("restart the game, then try again") would tell the operator to fix something that
        // is not currently broken.
        Session.HeadlessClientManager.SeatPortOccupiedCode => "seat_port_occupied",
        _ => "join"
    };
    private static string Summary(ConnectionIssue issue) => CouchCoopLocalization.Resolve($"couchcoop_connection_error_{IssueKey(issue)}_summary");
    private static string Action(ConnectionIssue issue) => CouchCoopLocalization.Resolve($"couchcoop_connection_error_{(issue.Code == "process-exited" ? "launch" : IssueKey(issue))}_action");
    private static string Outcome(ConnectionIssue issue) => CouchCoopLocalization.Resolve($"couchcoop_connection_outcome_{issue.Outcome.ToString().ToLowerInvariant()}");
    private static string OutcomeMarker(ConnectionIssueOutcome outcome) => outcome switch
    {
        ConnectionIssueOutcome.Waiting or ConnectionIssueOutcome.Degraded => "⚠",
        ConnectionIssueOutcome.Failed => "✕",
        ConnectionIssueOutcome.Recovered => "✓",
        _ => "■"
    };
    private static Color OutcomeColor(ConnectionIssue issue) => issue.Outcome switch
    {
        // A degraded host condition is a running session with a limitation, never a stopped one — orange like
        // the slow-view warning, and expressly not the failure red.
        ConnectionIssueOutcome.Waiting or ConnectionIssueOutcome.Degraded => CouchCoopGameUiTheme.ConnectionWarningOrange,
        ConnectionIssueOutcome.Recovered => CouchCoopGameUiTheme.ConnectionCompleteGreen,
        ConnectionIssueOutcome.Failed => CouchCoopGameUiTheme.ConnectionFailureRed,
        _ => CouchCoopGameUiTheme.ConnectionTechnicalMuted
    };
    private static string One(string text) => text.Replace('\r', ' ').Replace('\n', ' ').Trim();
    private static Dictionary<string, CouchCoopTextArgument> Args(params object[] values)
    {
        var result = new Dictionary<string, CouchCoopTextArgument>();
        for (var i = 0; i < values.Length; i += 2)
            result[(string)values[i]] = values[i + 1].ToString()!;
        return result;
    }

    private static void ConfigureLabel(Label label, int size, Color color)
    {
        label.MouseFilter = MouseFilterEnum.Ignore;
        label.VerticalAlignment = VerticalAlignment.Center;
        label.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        label.AddThemeColorOverride("font_color", color);
        CouchCoopGameUiTheme.ApplyFont(label, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, size);
    }

    private static void ConfigureButton(Button button)
    {
        button.FocusMode = FocusModeEnum.All;
        button.MouseFilter = MouseFilterEnum.Stop;
        CouchCoopGameUiTheme.ApplyFont(button, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, CouchCoopGameUiTheme.ConnectionBodyFontSize);
    }
}
