using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>Structured help shared by the host guide and the stock-Godot layout fixture.</summary>
internal sealed partial class DirectIpSetupHelpView : VBoxContainer
{
    private readonly Func<string, string> _text;
    private readonly Action<Label, int, bool> _style;
    private readonly Action<RichTextLabel, int> _richStyle;
    private readonly Dictionary<Label, (string Key, bool Heading)> _copy = [];
    private readonly Label _first = new();
    private readonly Label _expiry = new();
    private readonly Label _codeTitle;
    private readonly Control _review;
    public Control Start { get; }
    public RichTextLabel Verification { get; } = new()
    {
        Name = "AuthorityVerification", BbcodeEnabled = false, SelectionEnabled = true,
        FitContent = true, ScrollActive = false, AutowrapMode = TextServer.AutowrapMode.Arbitrary,
        FocusMode = FocusModeEnum.All,
    };

    public DirectIpSetupHelpView(Func<string, string> text, Action<Label, int, bool> style,
        Action<RichTextLabel, int> richStyle, Func<Node, string, Action, Control> button,
        Action reviewDevice, Action reset)
    {
        Name = "CouchCoopHttpsHelp";
        _text = text;
        _style = style;
        _richStyle = richStyle;
        MouseFilter = MouseFilterEnum.Ignore;
        SizeFlagsHorizontal = SizeFlags.ExpandFill;
        AddThemeConstantOverride("separation", 20);
        Start = AddCopy("help_first_title", true);
        AddBody(_first);
        AddCopy("help_file_title", true);
        AddCopy("help_file_body");
        AddCopy("help_warning_title", true);
        AddCopy("help_warning_body");
        _review = button(this, "help_review_device", reviewDevice);
        AddCopy("help_remove_title", true);
        AddCopy("help_remove_intro");
        foreach (var device in new[] { "iphone", "android", "windows", "macos", "linux" })
        {
            AddCopy("device_" + device, true);
            AddCopy("help_remove_" + device);
        }
        AddCopy("help_address_title", true);
        AddCopy("help_address_body");
        AddCopy("help_details_title", true);
        AddBody(_expiry);
        _codeTitle = AddCopy("code_label", true);
        AddChild(Verification);
        AddCopy("help_reset_body");
        button(this, "reset", reset);
    }

    public void Refresh(string stage, string? expiry, string? fingerprint, bool canReview)
    {
        foreach (var (label, copy) in _copy)
        {
            label.Text = _text(copy.Key);
            _style(label, copy.Heading ? 28 : 23, copy.Heading);
        }
        _first.Text = _text("help_first_" + stage);
        _style(_first, 23, false);
        _expiry.Text = expiry ?? string.Empty;
        _expiry.Visible = !string.IsNullOrEmpty(expiry);
        _style(_expiry, 23, false);
        _codeTitle.Visible = Verification.Visible = !string.IsNullOrEmpty(fingerprint);
        Verification.Text = fingerprint ?? string.Empty;
        _richStyle(Verification, 23);
        _review.Visible = canReview;
    }

    private Label AddCopy(string key, bool heading = false)
    {
        var label = new Label { Name = key };
        AddBody(label);
        _copy[label] = (key, heading);
        return label;
    }

    private void AddBody(Label label)
    {
        label.MouseFilter = MouseFilterEnum.Ignore;
        label.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        label.SizeFlagsHorizontal = SizeFlags.ExpandFill;
        AddChild(label);
    }
}
