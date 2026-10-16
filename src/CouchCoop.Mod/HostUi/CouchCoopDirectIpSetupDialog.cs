using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Server;
using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>The host-side guide is available even when a client cannot load the HTTPS page.</summary>
internal sealed partial class CouchCoopDirectIpSetupDialog : CouchCoopModalDialog
{
    private readonly DirectIpSetupFlow _flow = new();
    private readonly Label _title = new();
    private readonly DirectIpSetupProgressStrip _progress = new();
    private readonly ScrollContainer _scroll = new()
    {
        Name = "CouchCoopDirectIpSetupInstructions", FocusMode = FocusModeEnum.All,
        HorizontalScrollMode = ScrollContainer.ScrollMode.Disabled, FollowFocus = true,
    };
    private readonly VBoxContainer _content = Stack();
    private readonly VBoxContainer _prepare = Stack();
    private readonly VBoxContainer _device = Stack();
    private readonly VBoxContainer _deviceInstructions = Stack();
    private readonly VBoxContainer _connect = Stack();
    private readonly DirectIpSetupHelpView _advanced;
    private readonly VBoxContainer _resetConfirmation = Stack();
    private readonly VBoxContainer _verification = Stack();
    private readonly Label _status = new();
    private readonly Label _filePath = new();
    private readonly Label _verifyInstructions = new();
    private readonly Label _installInstructions = new();
    private readonly Label _deviceHeading = new();
    private readonly RichTextLabel _fingerprint = new()
    {
        BbcodeEnabled = false, SelectionEnabled = true, FitContent = true, ScrollActive = false,
        FocusMode = FocusModeEnum.All, AutowrapMode = TextServer.AutowrapMode.Arbitrary,
    };
    private readonly CouchCoopSetupButton _primary = new("CouchCoopDirectIpPrimary");
    private readonly CouchCoopSetupButton _back = new("CouchCoopDirectIpBack");
    private readonly Dictionary<Label, (string Key, int Size, bool Heading)> _copy = [];
    private readonly Dictionary<CouchCoopSetupButton, string> _buttonCopy = [];
    private readonly Dictionary<DirectIpSetupDevice, CouchCoopSetupButton> _deviceButtons = [];
    private readonly List<CouchCoopSetupButton> _bodyButtons = [];
    private readonly CouchCoopSetupButton _advancedButton;
    private readonly CouchCoopSetupButton _verificationButton;
    private string? _fileOpenError;
    private bool _installed;

    public CouchCoopDirectIpSetupDialog() : base(
        new CouchCoopModalNames("CouchCoopDirectIpSetup", "CouchCoopDirectIpSetupScrim",
            "CouchCoopDirectIpSetupCard", "CouchCoopDirectIpSetupClose"),
        new Vector2(DirectIpSetupLayout.CardWidth, DirectIpSetupLayout.CardHeight), dismissFontSize: 22)
    {
        ConfigureLabel(_title, HorizontalAlignment.Center, CouchCoopGameUiTheme.ButtonFontColor);
        Card.AddChild(_title);
        Card.AddChild(_progress);
        Card.AddChild(_scroll);
        _scroll.AddChild(_content);
        _content.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        _content.AddChild(_prepare);
        Copy(_prepare, "prepare_intro", 28);
        Copy(_prepare, "ca_explanation", 23);
        var trust = Copy(_prepare, "trust_notice", 23);
        trust.AddThemeColorOverride("font_color", CouchCoopGameUiTheme.ConnectionWarningOrange);

        _content.AddChild(_device);
        Copy(_device, "device_prompt", 24);
        Copy(_device, "trust_notice", 22).AddThemeColorOverride("font_color", CouchCoopGameUiTheme.ConnectionWarningOrange);
        var choices = new GridContainer { Columns = 3, MouseFilter = MouseFilterEnum.Ignore };
        choices.AddThemeConstantOverride("h_separation", 20);
        choices.AddThemeConstantOverride("v_separation", 10);
        _device.AddChild(choices);
        foreach (var choice in Enum.GetValues<DirectIpSetupDevice>())
        {
            var captured = choice;
            _deviceButtons[choice] = Button(choices, "device_" + DirectIpSetupCopy.DeviceKey(choice), () =>
            {
                _flow.ChooseDevice(captured);
                RefreshText();
                Callable.From(() => { if (GodotObject.IsInstanceValid(this) && IsOpen) _scroll.EnsureControlVisible(_deviceHeading); }).CallDeferred();
            });
            _deviceButtons[choice].SetPlatformIcon(DirectIpSetupCopy.DeviceKey(choice));
        }
        _device.AddChild(_deviceInstructions);
        AddDynamic(_deviceInstructions, _deviceHeading, 30, true);
        Copy(_deviceInstructions, "transfer_title", 28, true);
        Copy(_deviceInstructions, "transfer_body", 23);
        Button(_deviceInstructions, "show_file", Export);
        AddDynamic(_deviceInstructions, _filePath, 21);
        _filePath.AutowrapMode = TextServer.AutowrapMode.Arbitrary;
        Copy(_deviceInstructions, "verify_title", 28, true);
        Copy(_deviceInstructions, "verify_body", 23);
        _verificationButton = Button(_deviceInstructions, "show_code", () => { _flow.ToggleVerification(); RefreshText(); if (_flow.ShowVerification) Reveal(_verification); });
        _deviceInstructions.AddChild(_verification);
        Copy(_verification, "code_label", 24, true);
        _verification.AddChild(_fingerprint);
        AddDynamic(_verification, _verifyInstructions, 23);
        Copy(_deviceInstructions, "install_title", 28, true);
        AddDynamic(_deviceInstructions, _installInstructions, 24);

        _content.AddChild(_connect);
        Copy(_connect, "connect_body", 28);
        Copy(_connect, "certificate_warning", 23).AddThemeColorOverride("font_color", CouchCoopGameUiTheme.ConnectionWarningOrange);
        Button(_connect, "another_device", () => { _flow.AnotherDevice(); RefreshText(); _scroll.ScrollVertical = 0; });
        AddDynamic(_content, _status, 23);
        _status.AddThemeColorOverride("font_color", CouchCoopGameUiTheme.ConnectionFailureRed);
        _content.MoveChild(_status, 0);
        _advancedButton = Button(_content, "advanced", () =>
        {
            _flow.ToggleAdvanced();
            RefreshText();
            if (_flow.ShowAdvanced) Reveal(_advanced.Start);
            else Reveal(_advancedButton);
        });
        _advanced = new DirectIpSetupHelpView(L, (label, size, role) =>
        {
            Style(label, size, role != DirectIpSetupHelpView.TextRole.Body);
            label.AddThemeColorOverride("font_color", role == DirectIpSetupHelpView.TextRole.Heading ? CouchCoopGameUiTheme.ConnectionGroupGold : CouchCoopGameUiTheme.ConnectionExplanationCream);
        }, (label, size) =>
        {
            CouchCoopGameUiTheme.ApplyBodyRichFont(label, size);
            label.AddThemeColorOverride("default_color", CouchCoopGameUiTheme.ConnectionDeviceCream);
        }, (parent, key, action) => Button(parent, key, action), () =>
        {
            _flow.ReviewDeviceSetup();
            RefreshText();
            _scroll.ScrollVertical = 0;
            if (_installed && _flow.Device is { } device) _deviceButtons[device].GrabFocus();
        }, () => { _flow.RequestReset(); RefreshText(); Reveal(_resetConfirmation); });
        _content.AddChild(_advanced);
        _advanced.AddChild(_resetConfirmation);
        Copy(_resetConfirmation, "reset_warning", 24).AddThemeColorOverride("font_color", CouchCoopGameUiTheme.ConnectionWarningOrange);
        var resetActions = new HBoxContainer { MouseFilter = MouseFilterEnum.Ignore };
        resetActions.AddThemeConstantOverride("separation", 20);
        _resetConfirmation.AddChild(resetActions);
        Button(resetActions, "cancel", () => { _flow.CancelReset(); RefreshText(); });
        Button(resetActions, "reset_confirm", () => { if (_flow.ConfirmReset) StartOperation(true); });
        Card.AddChild(_primary);
        Card.AddChild(_back);
        _primary.Activated = Primary;
        _back.Activated = () => { _flow.Back(); RefreshText(); _scroll.ScrollVertical = 0; };
        RefreshText();
    }

    protected override void InstallBody()
    {
        _installed = true;
        foreach (var button in _bodyButtons.Concat([_primary, _back]))
        {
            button.Install();
            button.GuiInput += ScrollInput;
            button.FocusEntered += () => { if (_scroll.IsAncestorOf(button)) _scroll.EnsureControlVisible(button); };
        }
        // Limit the shared dismiss label locally; do not change other modals' button sizing.
        var dismissLabel = DismissButton.GetNode<Label>("Visuals/Label");
        dismissLabel.OffsetLeft = DirectIpSetupLayout.ButtonPadding;
        dismissLabel.OffsetRight = -DirectIpSetupLayout.ButtonPadding;
        dismissLabel.OffsetTop = (DirectIpSetupLayout.ButtonHeight - DirectIpSetupLayout.ButtonTextHeight) / 2;
        dismissLabel.OffsetBottom = -dismissLabel.OffsetTop;
        dismissLabel.AddThemeConstantOverride("outline_size", 3);
        dismissLabel.AddThemeConstantOverride("shadow_offset_x", 1);
        dismissLabel.AddThemeConstantOverride("shadow_offset_y", 1);
        dismissLabel.ClipText = true;
        dismissLabel.MaxLinesVisible = 2;
        DismissButton.GuiInput += ScrollInput;
        _scroll.GuiInput += ScrollInput;
        _fingerprint.GuiInput += ScrollInput;
        _advanced.Verification.GuiInput += ScrollInput;
        RefreshText();
    }

    public void Open(DirectIpHttpsState? state)
    {
        _flow.Open(state);
        _fileOpenError = null;
        RefreshText();
        ApplyLayout();
        _scroll.ScrollVertical = 0;
        OpenModal();
    }

    public void Refresh(DirectIpHttpsState? state)
    {
        if (_flow.State == state) return;
        _flow.Refresh(state);
        if (IsOpen) RefreshText();
    }

    public void RefreshText()
    {
        DismissText = L("close");
        _title.Text = L(_flow.Stage switch { DirectIpSetupStage.Prepare => "prepare_title", DirectIpSetupStage.Device => "device_title", _ => "connect_title" });
        CouchCoopGameUiTheme.ApplyFont(_title, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 38);
        foreach (var (label, value) in _copy)
        {
            label.Text = L(value.Key);
            Style(label, value.Size, value.Heading);
        }
        foreach (var (button, key) in _buttonCopy) { button.Text = L(key); button.RefreshLocalization(); }
        _progress.Refresh([L("progress_prepare"), L("progress_device"), L("progress_connect")],
            (int)_flow.Stage, label => Style(label, 24, true),
            CouchCoopGameUiTheme.ConnectionGroupGold, CouchCoopGameUiTheme.ConnectionProgressMuted);
        Style(_status, 23, false);
        Style(_filePath, 21, false);
        Style(_verifyInstructions, 23, false);
        Style(_installInstructions, 24, false);
        Style(_deviceHeading, 30, true);
        _prepare.Visible = _flow.Stage == DirectIpSetupStage.Prepare;
        _device.Visible = _flow.Stage == DirectIpSetupStage.Device;
        _connect.Visible = _flow.Stage == DirectIpSetupStage.Connect;
        _deviceInstructions.Visible = _flow.Device is not null;
        foreach (var (device, button) in _deviceButtons)
            button.Modulate = device == _flow.Device ? CouchCoopGameUiTheme.ConnectionGroupGold : Colors.White;
        if (_flow.Device is { } selected)
        {
            var key = DirectIpSetupCopy.DeviceKey(selected);
            _deviceHeading.Text = L("device_" + key);
            _verifyInstructions.Text = L("verify_" + key);
            _installInstructions.Text = L("install_" + key);
        }
        _verification.Visible = _flow.ShowVerification;
        _verificationButton.Text = L(_flow.ShowVerification ? "hide_code" : "show_code");
        _fingerprint.Text = _flow.State?.CaFingerprint ?? string.Empty;
        CouchCoopGameUiTheme.ApplyBodyRichFont(_fingerprint, 23);
        _fingerprint.AddThemeColorOverride("default_color", CouchCoopGameUiTheme.ConnectionDeviceCream);
        _filePath.Visible = _flow.ExportPath is not null;
        _filePath.Text = CouchCoopText.Create("couchcoop_https_file_location", ("path", _flow.ExportPath ?? string.Empty)).Resolve();
        _status.Text = _flow.IsBusy ? L("busy") : _flow.Error?.Resolve() ?? (_fileOpenError is { } error ? L(error)
            : _flow.State?.ErrorCode is not null ? DirectIpSetupCopy.Status(_flow.State).Resolve() : string.Empty);
        _status.Visible = _status.Text.Length > 0;
        _status.AddThemeColorOverride("font_color", _flow.IsBusy ? CouchCoopGameUiTheme.ConnectionGroupGold : CouchCoopGameUiTheme.ConnectionFailureRed);
        _advanced.Visible = _flow.ShowAdvanced;
        _advancedButton.Text = L(_flow.ShowAdvanced ? "hide_advanced" : "advanced");
        _resetConfirmation.Visible = _flow.ConfirmReset;
        _advanced.Refresh(_flow.Stage.ToString().ToLowerInvariant(),
            _flow.State?.CaExpiresAt is { } expiry
                ? CouchCoopText.Create("couchcoop_https_expiry", ("expiry", expiry.ToString("d"))).Resolve() : null,
            _flow.State?.CaFingerprint, _flow.HostReady);
        _advanced.Verification.FocusMode = _advanced.Visible && _advanced.Verification.Visible
            ? FocusModeEnum.All : FocusModeEnum.None;
        _primary.Text = L(_flow.IsBusy ? "busy" : _flow.Stage switch
        {
            DirectIpSetupStage.Prepare => _flow.Error is null ? "create_file" : "retry",
            DirectIpSetupStage.Device => "installed", _ => "show_qr",
        });
        _primary.Visible = !_flow.ConfirmReset;
        _back.Text = L("back");
        _back.Visible = _flow.Stage != DirectIpSetupStage.Prepare && !_flow.ConfirmReset;
        foreach (var button in _bodyButtons.Concat([_primary, _back]))
        {
            button.RefreshLocalization();
            var enabled = !_flow.IsBusy && (button != _primary || _flow.Stage != DirectIpSetupStage.Device || _flow.Device is not null && _flow.HostReady);
            if (_installed && button.IsEnabled != enabled)
            {
                if (enabled) button.Enable(); else button.Disable();
            }
            button.FocusMode = enabled && IsBodyVisible(button) ? FocusModeEnum.All : FocusModeEnum.None;
        }
        _scroll.FocusMode = FocusModeEnum.All;
        _fingerprint.FocusMode = _verification.Visible && _device.Visible && _deviceInstructions.Visible ? FocusModeEnum.All : FocusModeEnum.None;
        RefreshDialogFont();
        if (_installed) RefreshFocusChain();
        if (IsOpen && IsInsideTree() && GetViewport()?.GuiGetFocusOwner() is Control focused
            && IsAncestorOf(focused) && (!focused.IsVisibleInTree() || focused.FocusMode == FocusModeEnum.None))
            DismissButton.GrabFocus();
    }

    private void Primary()
    {
        if (_flow.IsBusy) return;
        switch (_flow.Stage)
        {
            case DirectIpSetupStage.Prepare: StartOperation(false); break;
            case DirectIpSetupStage.Device:
                if (_flow.AcknowledgeInstallation()) { RefreshText(); _scroll.ScrollVertical = 0; }
                break;
            case DirectIpSetupStage.Connect: Close(); break;
        }
    }

    private void StartOperation(bool replace)
    {
        if (!_flow.BeginOperation()) return;
        _fileOpenError = null;
        RefreshText();
        var actions = DirectIpHttpsSetup.Current;
        _ = Task.Run(async () =>
        {
            string? path = null;
            CouchCoopText? error = null;
            try
            {
                if (actions is null) throw new InvalidOperationException();
                if (replace) await actions.ReplaceAuthorityAsync().ConfigureAwait(false);
                else await actions.PrepareAsync().ConfigureAwait(false);
                path = Path.GetFullPath(actions.ExportPublicRoot());
            }
            catch { error = CouchCoopText.Create("couchcoop_https_operation_failed"); }
            Callable.From(() =>
            {
                if (!GodotObject.IsInstanceValid(this)) return;
                _flow.CompleteOperation(CouchCoopMod.HostUiSnapshot.DirectIpHttps, path, error);
                RefreshText();
                _scroll.ScrollVertical = 0;
            }).CallDeferred();
        });
    }

    private void Export()
    {
        if (!_flow.BeginOperation()) return;
        _fileOpenError = null;
        RefreshText();
        var actions = DirectIpHttpsSetup.Current;
        _ = Task.Run(() =>
        {
            string? path = null;
            CouchCoopText? error = null;

            try
            {
                path = Path.GetFullPath(actions?.ExportPublicRoot() ?? throw new InvalidOperationException());

            }
            catch { error = CouchCoopText.Create("couchcoop_https_export_failed"); }
            Callable.From(() =>
            {
                if (!GodotObject.IsInstanceValid(this)) return;
                _flow.Refresh(CouchCoopMod.HostUiSnapshot.DirectIpHttps);
                _flow.CompleteExport(path, error);
                if (_flow.ExportPath is not null && _flow.Error is null)
                {
                    // The OS action is dispatched on the main thread, using only a host-generated public path.
                    try
                    {
                        var directory = Path.GetDirectoryName(_flow.ExportPath)!;
                        if (OS.ShellOpen(new Uri(directory + Path.DirectorySeparatorChar).AbsoluteUri) != Error.Ok)
                            _fileOpenError = "file_open_failed";
                    }
                    catch { _fileOpenError = "file_open_failed"; }
                }
                RefreshText();
                if (_flow.Error is not null || _fileOpenError is not null) Reveal(_status);
            }).CallDeferred();
        });
    }

    protected override void OnClosing() => _flow.CancelReset();
    protected override void CollectFocusChain(List<Control> chain)
    {
        chain.Add(_scroll);
        foreach (var button in _bodyButtons)
            if (IsBodyVisible(button) && button.IsEnabled) chain.Add(button);
        if (_fingerprint.FocusMode != FocusModeEnum.None) chain.Add(_fingerprint);
        if (_advanced.Verification.FocusMode != FocusModeEnum.None) chain.Add(_advanced.Verification);
        if (_back.Visible && _back.IsEnabled) chain.Add(_back);
        if (_primary.Visible && _primary.IsEnabled) chain.Add(_primary);
    }

    private bool IsBodyVisible(Control control)
    {
        for (Node? node = control; node is not null && node != Card; node = node.GetParent())
            if (node is Control { Visible: false }) return false;
        return true;
    }

    protected override void ApplyBodyLayout(HostLobbyQrOverlayLayout previous, HostLobbyQrOverlayLayout next) => RefreshText();
    protected override void LayoutBody(float padding, float textWidth)
    {
        var layout = DirectIpSetupLayout.Calculate(padding, DefaultDismissBottomInset);
        Place(_title, layout.Title);
        Place(_progress, layout.Progress);
        Place(_scroll, layout.Content);
        Place(_back, layout.Back);
        Place(_primary, layout.Primary);
    }

    private void Reveal(Control control) => Callable.From(() =>
    {
        if (GodotObject.IsInstanceValid(this) && IsOpen && control.IsVisibleInTree())
            _scroll.EnsureControlVisible(control);
    }).CallDeferred();

    private void ScrollInput(InputEvent input)
    {
        var direction = input switch
        {
            InputEventKey { Pressed: true, Keycode: Key.Pageup } => -1,
            InputEventKey { Pressed: true, Keycode: Key.Pagedown } => 1,
            InputEventJoypadButton { Pressed: true, ButtonIndex: JoyButton.LeftShoulder } => -1,
            InputEventJoypadButton { Pressed: true, ButtonIndex: JoyButton.RightShoulder } => 1,
            _ => 0,
        };
        if (direction == 0) return;
        _scroll.ScrollVertical += (int)(direction * _scroll.Size.Y * 0.8f);
        _scroll.AcceptEvent();
    }

    private static VBoxContainer Stack()
    {
        var box = new VBoxContainer { MouseFilter = MouseFilterEnum.Ignore, SizeFlagsHorizontal = SizeFlags.ExpandFill };
        box.AddThemeConstantOverride("separation", (int)DirectIpSetupLayout.ContentGap);
        return box;
    }
    private Label Copy(Node parent, string key, int size, bool heading = false)
    {
        var label = new Label();
        AddDynamic(parent, label, size, heading);
        _copy[label] = (key, size, heading);
        return label;
    }
    private static void AddDynamic(Node parent, Label label, int size, bool heading = false)
    {
        label.MouseFilter = MouseFilterEnum.Ignore;
        label.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        label.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        label.AddThemeColorOverride("font_color", heading ? CouchCoopGameUiTheme.ConnectionGroupGold : CouchCoopGameUiTheme.ConnectionExplanationCream);
        Style(label, size, heading);
        parent.AddChild(label);
    }
    private static void Style(Label label, int size, bool heading)
    {
        if (heading) CouchCoopGameUiTheme.ApplyFont(label, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, size);
        else CouchCoopGameUiTheme.ApplyBodyFont(label, size);
    }
    private CouchCoopSetupButton Button(Node parent, string key, Action action)
    {
        var button = new CouchCoopSetupButton("CouchCoopHttps_" + key) { Activated = action };
        // The slot may stretch to the column width, but the button itself never does.
        var slot = new CenterContainer { MouseFilter = MouseFilterEnum.Ignore, SizeFlagsHorizontal = SizeFlags.ExpandFill };
        slot.AddChild(button);
        parent.AddChild(slot);
        _bodyButtons.Add(button);
        _buttonCopy[button] = key;
        return button;
    }
    private static void Place(Control control, DirectIpSetupLayout.Box box)
    {
        control.Position = new Vector2(box.X, box.Y);
        control.Size = new Vector2(box.Width, box.Height);
    }
    private static string L(string key) => CouchCoopLocalization.Resolve("couchcoop_https_" + key);
}
