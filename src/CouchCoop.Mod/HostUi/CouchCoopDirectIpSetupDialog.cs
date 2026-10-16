using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Server;
using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>Native trust bootstrap remains accessible before a browser trusts this host.</summary>
internal sealed partial class CouchCoopDirectIpSetupDialog : CouchCoopModalDialog
{
    private readonly Label _title = new();
    private readonly RichTextLabel _body = new()
    {
        Name = "CouchCoopDirectIpSetupInstructions", BbcodeEnabled = false,
        ScrollActive = true, SelectionEnabled = true, FocusMode = FocusModeEnum.All,
    };
    private readonly CouchCoopSkipButton _prepare = new(24, "CouchCoopDirectIpPrepare");
    private readonly CouchCoopSkipButton _export = new(24, "CouchCoopDirectIpExport");
    private readonly CouchCoopSkipButton _replace = new(24, "CouchCoopDirectIpReplace");
    private readonly CouchCoopSkipButton _cancelReplace = new(24, "CouchCoopDirectIpCancelReplace");
    private DirectIpHttpsState? _state;
    private bool _busy;
    private bool _confirmReplacement;
    private string? _messageKey;
    private string? _exportPath;

    public CouchCoopDirectIpSetupDialog() : base(
        new CouchCoopModalNames("CouchCoopDirectIpSetup", "CouchCoopDirectIpSetupScrim",
            "CouchCoopDirectIpSetupCard", "CouchCoopDirectIpSetupClose"),
        new Vector2(1400, 1000), dismissFontSize: 28)
    {
        ConfigureLabel(_title, HorizontalAlignment.Center, CouchCoopGameUiTheme.ButtonFontColor);
        _body.AddThemeColorOverride("default_color", CouchCoopGameUiTheme.ButtonFontColor);
        Card.AddChild(_title);
        Card.AddChild(_body);
        foreach (var button in new[] { _prepare, _export, _replace, _cancelReplace }) Card.AddChild(button);
        _prepare.Activated = () => StartOperation(replace: false);
        _export.Activated = Export;
        _replace.Activated = () =>
        {
            if (_busy) return;
            if (_confirmReplacement) StartOperation(replace: true);
            else { _confirmReplacement = true; RefreshText(); }
        };
        _cancelReplace.Activated = () => { _confirmReplacement = false; RefreshText(); };
        RefreshText();
    }

    protected override void InstallBody()
    {
        foreach (var button in new[] { _prepare, _export, _replace, _cancelReplace }) button.Install();
        _body.GuiInput += input =>
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
            _body.GetVScrollBar().Value += direction * _body.Size.Y;
            _body.AcceptEvent();
        };
    }

    public void Open(DirectIpHttpsState? state)
    {
        _state = state;
        _confirmReplacement = false;
        _messageKey = null;
        _exportPath = null;
        RefreshText();
        ApplyLayout();
        OpenModal();
    }

    public void Refresh(DirectIpHttpsState? state)
    {
        if (_state == state) return;
        _state = state;
        if (IsOpen) RefreshText();
    }

    public void RefreshText()
    {
        DismissText = L("couchcoop_direct_https_close");
        _title.Text = L("couchcoop_qr_method_direct_https_title");
        _body.Text = (_confirmReplacement ? L("couchcoop_direct_https_confirm") + "\n\n" : string.Empty)
            + (_messageKey is { } key ? L(key) + "\n" + (_exportPath ?? string.Empty) + "\n\n" : string.Empty)
            + DirectIpSetupCopy.Body(_state);
        _prepare.Text = L("couchcoop_direct_https_prepare");
        _export.Text = L("couchcoop_direct_https_export");
        _replace.Text = L(_confirmReplacement ? "couchcoop_direct_https_confirm_button" : "couchcoop_direct_https_replace");
        _cancelReplace.Text = L("couchcoop_direct_https_cancel");
        _prepare.Visible = !_busy && !_confirmReplacement;
        _export.Visible = !_busy && !_confirmReplacement && _state?.CanExport == true;
        _replace.Visible = !_busy;
        _cancelReplace.Visible = !_busy && _confirmReplacement;
        CouchCoopGameUiTheme.ApplyFont(_title, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 40);
        CouchCoopGameUiTheme.ApplyRichFont(_body, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 25);
        foreach (var button in new[] { _prepare, _export, _replace, _cancelReplace }) button.RefreshLocalization();
        RefreshDialogFont();
        RefreshFocusChain();
    }

    private void StartOperation(bool replace)
    {
        if (_busy) return;
        if (DirectIpHttpsSetup.Current is not { } actions)
        {
            _messageKey = "couchcoop_direct_https_failed";
            RefreshText();
            return;
        }
        _busy = true;
        _confirmReplacement = false;
        _messageKey = "couchcoop_direct_https_preparing";
        RefreshText();
        _ = Task.Run(async () =>
        {
            var failed = false;
            try
            {
                if (replace) await actions.ReplaceAuthorityAsync().ConfigureAwait(false);
                else await actions.PrepareAsync().ConfigureAwait(false);
            }
            catch { failed = true; }
            // Godot controls are updated only on the main thread, and only while their owner survives.
            Callable.From(() =>
            {
                if (!GodotObject.IsInstanceValid(this)) return;
                _busy = false;
                _messageKey = failed ? "couchcoop_direct_https_failed" : null;
                _state = CouchCoopMod.HostUiSnapshot.DirectIpHttps;
                RefreshText();
            }).CallDeferred();
        });
    }

    private void Export()
    {
        if (_busy || _state?.CanExport != true) return;
        try
        {
            var path = DirectIpHttpsSetup.Current?.ExportPublicRoot()
                ?? throw new InvalidOperationException("Direct-IP setup unavailable");
            // The host service returns a local public-only export. Never shell a player-supplied URL.
            _exportPath = Path.GetFullPath(path);
            var directory = Path.GetDirectoryName(_exportPath)!;
            var result = OS.ShellOpen(new Uri(directory + Path.DirectorySeparatorChar).AbsoluteUri);
            _messageKey = result == Error.Ok ? "couchcoop_direct_https_exported" : "couchcoop_direct_https_export_location";
        }
        catch
        {
            _exportPath = null;
            _messageKey = "couchcoop_direct_https_failed";
        }
        RefreshText();
    }

    protected override void OnClosing() => _confirmReplacement = false;

    protected override void CollectFocusChain(List<Control> chain)
    {
        chain.Add(_body);
        foreach (var button in new[] { _prepare, _export, _replace, _cancelReplace })
            if (button.Visible) chain.Add(button);
    }

    protected override void ApplyBodyLayout(HostLobbyQrOverlayLayout previous, HostLobbyQrOverlayLayout next) => RefreshText();

    protected override void LayoutBody(float padding, float textWidth)
    {
        _title.Position = new Vector2(padding, 24);
        _title.Size = new Vector2(textWidth, 60);
        _body.Position = new Vector2(padding, 100);
        _body.Size = new Vector2(textWidth, 690);
        var width = (textWidth - 32) / 3;
        var buttons = new[] { _prepare, _export, _replace };
        for (var i = 0; i < buttons.Length; i++)
        {
            buttons[i].Position = new Vector2(padding + i * (width + 16), 805);
            buttons[i].Size = new Vector2(width, 73);
        }
        _cancelReplace.Position = _prepare.Position;
        _cancelReplace.Size = _prepare.Size;
    }

    private static string L(string key) => CouchCoopLocalization.Resolve(key);
}
