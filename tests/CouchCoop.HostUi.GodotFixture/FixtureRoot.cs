using System.Text.Json;
using CouchCoop.Mod.HostUi;
using Godot;

public partial class FixtureRoot : Control
{
    private readonly SystemFont _regular = new() { FontNames = ["Noto Sans", "DejaVu Sans"], FontWeight = 400 };
    private readonly SystemFont _bold = new() { FontNames = ["Noto Sans", "DejaVu Sans"], FontWeight = 700 };
    private static readonly Color Cream = new(0.96f, 0.92f, 0.81f);
    private static readonly Color Gold = new(0.93f, 0.75f, 0.28f);
    private Dictionary<string, string> _catalog = [];
    private Control _card = null!;
    private DirectIpSetupProgressStrip _progress = null!;
    private ScrollContainer _scroll = null!;
    private VBoxContainer _body = null!;
    private DirectIpSetupHelpView _help = null!;
    private Label _intro = null!;
    private Label _title = null!;
    private Button _primary = null!;
    private readonly List<Button> _platforms = [];
    private readonly List<Button> _helpButtons = [];
    private int _activations;
    private string? _shots;

    public override async void _Ready()
    {
        try
        {
            var arguments = OS.GetCmdlineUserArgs();
            for (var i = 0; i < arguments.Length; i++)
                if (arguments[i] == "--shots-dir") _shots = Path.GetFullPath(arguments[++i]);
            if (_shots is not null) Directory.CreateDirectory(_shots);
            foreach (var viewport in new[] { new Vector2I(1920, 1080), new Vector2I(1280, 800) })
            {
                GetWindow().Size = viewport;
                GetWindow().ContentScaleSize = viewport;
                foreach (var language in new[] { "en", "deu", "esp", "spa", "fra", "ita", "jpn", "kor", "pol", "ptb", "rus", "tha", "tur", "zhs" })
                {
                    LoadCatalog(language);
                    await Build(viewport);
                    await Settle();
                    CheckProgress();
                    SetHelp(false);
                    await Settle();
                    CheckProgress();
                    if (language == "en") await Shot($"{viewport.X}x{viewport.Y}-prepare");
                    _title.Text = T("device_title");
                    _primary.GetNode<Label>("Caption").Text = T("installed");
                    _intro.Text = T("device_prompt");
                    foreach (var platform in _platforms) platform.Visible = true;
                    _progress.Refresh([T("progress_prepare"), T("progress_device"), T("progress_connect")], 1,
                        label => Style(label, 24, true), Gold, Cream.Darkened(0.3f));
                    await Settle();
                    CheckProgress();
                    foreach (var platform in _platforms)
                    {
                        Check(platform.Size == new Vector2(300, 73), "platform input bounds changed");
                        var caption = platform.GetNode<Label>("Caption");
                        Check(caption.GetLineCount() <= 2, $"platform caption overflow: {language}/{caption.Text}");
                        foreach (var child in platform.GetNode<Control>("PlatformIcon").GetChildren().Cast<Control>())
                            Check(child.MouseFilter == MouseFilterEnum.Ignore && child.FocusMode == FocusModeEnum.None,
                                "platform icon intercepts input");
                    }
                    if (language == "en")
                    {
                        await CheckInput();
                        await Shot($"{viewport.X}x{viewport.Y}-device");
                    }
                    for (var i = 0; i < 2; i++)
                    {
                        SetHelp(true);
                        _help.Refresh("device", T("expiry").Replace("{expiry}", "2031-01-02"), new string('A', 64), true);
                        await Settle();
                        CheckProgress();
                        CheckHelp();
                        _scroll.ScrollVertical = 500;
                        await Settle();
                        CheckProgress();
                        if (language == "en" && i == 0)
                        {
                            await Shot($"{viewport.X}x{viewport.Y}-help");
                            _scroll.ScrollVertical = (int)_help.Position.Y;
                            await Settle();
                            await Shot($"{viewport.X}x{viewport.Y}-help-start");
                            _scroll.ScrollVertical = (int)(_help.Position.Y + _help.GetNode<Label>("device_windows").Position.Y);
                            await Settle();
                            await Shot($"{viewport.X}x{viewport.Y}-help-removal");
                        }
                        SetHelp(false);
                        _scroll.ScrollVertical = 0;
                        await Settle();
                    }
                    _intro.Text = T("operation_failed");
                    await Settle();
                    CheckProgress();
                    GD.Print($"layout: {viewport.X}x{viewport.Y} {language} ok");
                }
            }
            GD.Print("HOST_UI_GODOT_FIXTURE_PASS: actual bounds, wrapping, expansion, icons and stock-Godot input");
            GetTree().Quit();
        }
        catch (Exception error)
        {
            GD.PushError(error.ToString());
            GetTree().Quit(1);
        }
    }

    private async Task Build(Vector2I viewport)
    {
        foreach (var child in GetChildren()) { RemoveChild(child); child.QueueFree(); }
        _platforms.Clear();
        _helpButtons.Clear();
        await Settle();
        var scale = MathF.Min(viewport.X / 1920f, viewport.Y / 1080f);
        _card = new Panel
        {
            Position = (new Vector2(viewport.X, viewport.Y) - new Vector2(1400, 960) * scale) / 2,
            Size = new Vector2(1400, 960), Scale = new Vector2(scale, scale), MouseFilter = MouseFilterEnum.Stop,
        };
        var panelStyle = new StyleBoxFlat { BgColor = new Color(0.05f, 0.065f, 0.08f), BorderColor = new Color(0.3f, 0.3f, 0.3f) };
        panelStyle.SetBorderWidthAll(2); panelStyle.SetCornerRadiusAll(14);
        _card.AddThemeStyleboxOverride("panel", panelStyle);
        AddChild(_card);
        var geometry = DirectIpSetupLayout.Calculate(24, 16);
        _title = new Label { Text = T("prepare_title"), HorizontalAlignment = HorizontalAlignment.Center };
        Style(_title, 38, true); _card.AddChild(_title); Place(_title, geometry.Title);
        _progress = new DirectIpSetupProgressStrip();
        _progress.Refresh([T("progress_prepare"), T("progress_device"), T("progress_connect")], 0,
            label => Style(label, 24, true), Gold, Cream.Darkened(0.3f));
        _card.AddChild(_progress); Place(_progress, geometry.Progress);
        _scroll = new ScrollContainer { HorizontalScrollMode = ScrollContainer.ScrollMode.Disabled, FollowFocus = true };
        _card.AddChild(_scroll); Place(_scroll, geometry.Content);
        _body = new VBoxContainer { SizeFlagsHorizontal = SizeFlags.ExpandFill, MouseFilter = MouseFilterEnum.Ignore };
        _body.AddThemeConstantOverride("separation", 20); _scroll.AddChild(_body);
        _intro = BodyLabel(T("prepare_intro")); _body.AddChild(_intro);
        _body.AddChild(BodyLabel(T("trust_notice")));
        var grid = new GridContainer { Columns = 3, MouseFilter = MouseFilterEnum.Ignore };
        grid.AddThemeConstantOverride("h_separation", 20); grid.AddThemeConstantOverride("v_separation", 10);
        _body.AddChild(grid);
        foreach (var platform in new[] { "iphone", "android", "windows", "macos", "linux" })
        {
            var button = MakeButton(grid, "device_" + platform, () => _activations++);
            var icon = DirectIpPlatformIcons.Create(platform); icon.Position = new Vector2(24, 20.5f); button.AddChild(icon);
            var label = button.GetNode<Label>("Caption"); label.OffsetLeft = 84;
            _platforms.Add(button); button.Visible = false;
        }
        MakeButton(_body, "advanced", () => SetHelp(!_help.Visible));
        _help = new DirectIpSetupHelpView(T, (label, size, role) =>
        {
            Style(label, size, role != DirectIpSetupHelpView.TextRole.Body);
            label.AddThemeColorOverride("font_color", role == DirectIpSetupHelpView.TextRole.Heading ? Gold : Cream);
        }, (label, size) =>
        {
            label.AddThemeFontOverride("normal_font", _regular);
            label.AddThemeFontSizeOverride("normal_font_size", size);
            label.AddThemeColorOverride("default_color", Cream);
        }, (parent, key, action) =>
        {
            var button = MakeButton(parent, key, action); _helpButtons.Add(button); return button;
        }, () => SetHelp(false), () => { });
        _body.AddChild(_help);
        _help.Refresh("prepare", null, null, false); SetHelp(false);
        var dismiss = MakeButton(_card, "close", () => { }, false); Place(dismiss, geometry.Dismiss);
        _primary = MakeButton(_card, "create_file", () => { }, false); Place(_primary, geometry.Primary);
    }

    private Button MakeButton(Node parent, string key, Action action, bool slot = true)
    {
        var button = new Button { Name = key, CustomMinimumSize = new Vector2(300, 73), Size = new Vector2(300, 73),
            SizeFlagsHorizontal = SizeFlags.ShrinkCenter, SizeFlagsVertical = SizeFlags.ShrinkCenter };
        var buttonStyle = new StyleBoxFlat { BgColor = new Color(0.12f, 0.32f, 0.37f), BorderColor = new Color(0.3f, 0.6f, 0.65f) };
        buttonStyle.SetBorderWidthAll(3); buttonStyle.SetCornerRadiusAll(8);
        button.AddThemeStyleboxOverride("normal", buttonStyle);
        button.Pressed += action;
        var caption = new Label { Name = "Caption", Text = T(key), HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center, MouseFilter = MouseFilterEnum.Ignore,
            AutowrapMode = TextServer.AutowrapMode.WordSmart, ClipText = true, MaxLinesVisible = 2 };
        caption.SetAnchorsAndOffsetsPreset(LayoutPreset.FullRect);
        caption.OffsetLeft = 24; caption.OffsetRight = -24; caption.OffsetTop = 8.5f; caption.OffsetBottom = -8.5f;
        Style(caption, 22, true);
        caption.AddThemeColorOverride("font_color", Cream);
        button.AddChild(caption);
        if (slot)
        {
            var holder = new CenterContainer { MouseFilter = MouseFilterEnum.Ignore, SizeFlagsHorizontal = SizeFlags.ExpandFill };
            parent.AddChild(holder); holder.AddChild(button);
        }
        else parent.AddChild(button);
        return button;
    }

    private async Task CheckInput()
    {
        var button = _platforms[0];
        var before = _activations;
        await Click(button.GetGlobalRect().GetCenter());
        Check(_activations == before + 1, "button center did not activate");
        await Click(button.GetNode<Control>("PlatformIcon").GetGlobalRect().GetCenter());
        Check(_activations == before + 2, "icon intercepted click");
        await Click(button.GetGlobalRect().Position - new Vector2(5, -20));
        Check(_activations == before + 2, "surrounding slot activated button");
        button.GrabFocus();
        var accept = new InputEventAction { Action = "ui_accept", Pressed = true };
        GetViewport().PushInput(accept); await Settle();
        GetViewport().PushInput(new InputEventAction { Action = "ui_accept", Pressed = false }); await Settle();
        Check(_activations == before + 3, "keyboard accept did not activate focused button");
        button.ReleaseFocus();
    }

    private async Task Click(Vector2 position)
    {
        GetViewport().PushInput(new InputEventMouseMotion { Position = position, GlobalPosition = position }, true);
        GetViewport().PushInput(new InputEventMouseButton { Position = position, GlobalPosition = position, ButtonIndex = MouseButton.Left, Pressed = true }, true);
        await Settle();
        GetViewport().PushInput(new InputEventMouseButton { Position = position, GlobalPosition = position, ButtonIndex = MouseButton.Left, Pressed = false }, true);
        await Settle();
    }

    private void SetHelp(bool visible)
    {
        _help.Visible = visible;
        foreach (var button in _helpButtons) button.FocusMode = visible && button.Visible ? FocusModeEnum.All : FocusModeEnum.None;
        _help.Verification.FocusMode = visible && _help.Verification.Visible ? FocusModeEnum.All : FocusModeEnum.None;
    }

    private void CheckProgress()
    {
        var strip = _progress.GetGlobalRect();
        Check(strip.End.Y <= _scroll.GetGlobalRect().Position.Y, "progress overlaps scroll viewport");
        for (var i = 0; i < 3; i++)
        {
            var label = _progress.GetNode<Label>($"Step{i}/Caption");
            Check(strip.Encloses(label.GetGlobalRect()), "resolved progress caption escaped bounded strip");
            Check(label.GetLineCount() <= 2, "progress caption has more than two lines");
        }
    }

    private void CheckHelp()
    {
        foreach (var child in _help.GetChildren().OfType<Label>())
        {
            if (!child.Visible) continue;
            Check(child.Size.X <= _scroll.Size.X, "help exceeded scroll width");
            if (child.Name.ToString().EndsWith("_title", StringComparison.Ordinal) || child.Name.ToString().StartsWith("device_", StringComparison.Ordinal))
                Check(child.GetThemeFont("font") == _bold, "help heading is not bold");
        }
    }

    private Label BodyLabel(string text)
    {
        var label = new Label { Text = text, AutowrapMode = TextServer.AutowrapMode.WordSmart, SizeFlagsHorizontal = SizeFlags.ExpandFill };
        Style(label, 24, false); return label;
    }
    private void Style(Label label, int size, bool heading)
    {
        label.AddThemeFontOverride("font", heading ? _bold : _regular);
        label.AddThemeFontSizeOverride("font_size", size);
        label.AddThemeColorOverride("font_color", heading ? Gold : Cream);
    }
    private void LoadCatalog(string language)
    {
        using var stream = GetType().Assembly.GetManifestResourceStream($"Catalogs.couchcoop.{language}.json")!;
        _catalog = JsonSerializer.Deserialize<Dictionary<string, string>>(stream)!;
    }
    private string T(string key) => _catalog.GetValueOrDefault("couchcoop_https_" + key) ?? key;
    private async Task Settle() { for (var i = 0; i < 3; i++) await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame); }
    private async Task Shot(string name)
    {
        if (_shots is null) return;
        await ToSignal(RenderingServer.Singleton, RenderingServer.SignalName.FramePostDraw);
        using var image = GetViewport().GetTexture().GetImage();
        Check(image.SavePng(Path.Combine(_shots, name + ".png")) == Error.Ok, "screenshot write failed");
    }
    private static void Place(Control control, DirectIpSetupLayout.Box box) { control.Position = new(box.X, box.Y); control.Size = new(box.Width, box.Height); }
    private static void Check(bool condition, string reason) { if (!condition) throw new InvalidOperationException(reason); }
}
