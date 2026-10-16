using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>A bounded header: wrapped captions never contribute minimum height to the parent.</summary>
internal sealed partial class DirectIpSetupProgressStrip : Control
{
    private readonly Label[] _labels = new Label[3];
    private readonly Control[] _cells = new Control[3];

    public DirectIpSetupProgressStrip()
    {
        Name = "CouchCoopHttpsProgress";
        MouseFilter = MouseFilterEnum.Ignore;
        ClipContents = true;
        var background = new Panel { MouseFilter = MouseFilterEnum.Ignore };
        background.SetAnchorsAndOffsetsPreset(LayoutPreset.FullRect);
        var style = new StyleBoxFlat { BgColor = new Color(0.18f, 0.23f, 0.25f, 0.65f) };
        style.SetCornerRadiusAll(8);
        background.AddThemeStyleboxOverride("panel", style);
        AddChild(background);
        for (var i = 0; i < _labels.Length; i++)
        {
            var cell = new Control { Name = "Step" + i, MouseFilter = MouseFilterEnum.Ignore, ClipContents = true };
            var label = new Label
            {
                Name = "Caption", MouseFilter = MouseFilterEnum.Ignore,
                AutowrapMode = TextServer.AutowrapMode.WordSmart, MaxLinesVisible = 2, ClipText = true,
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
            };
            AddChild(cell);
            cell.AddChild(label);
            _cells[i] = cell;
            _labels[i] = label;
        }
        Resized += Arrange;
    }

    public void Refresh(IReadOnlyList<string> captions, int active, Action<Label> styleLabel,
        Color activeColor, Color otherColor)
    {
        // Establish widths before assigning wrapped text, including on the first open.
        Arrange();
        for (var i = 0; i < _labels.Length; i++)
        {
            styleLabel(_labels[i]);
            _labels[i].Text = captions[i];
            _labels[i].AddThemeColorOverride("font_color", i == active ? activeColor : otherColor);
        }
    }

    private void Arrange()
    {
        var width = Size.X / 3;
        for (var i = 0; i < _cells.Length; i++)
        {
            _cells[i].Position = new Vector2(i * width, 0);
            _cells[i].Size = new Vector2(width, Size.Y);
            _labels[i].Position = new Vector2(12, 0);
            _labels[i].Size = new Vector2(MathF.Max(1, width - 24), Size.Y);
        }
    }
}
