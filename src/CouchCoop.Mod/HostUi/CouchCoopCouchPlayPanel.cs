using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Session;
using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>The single player QR dialog's host-only mode card.</summary>
internal sealed partial class CouchCoopCouchPlayPanel : Panel
{
    public const string NodeName = "CouchCoopCouchPlayPanel";
    internal const float SelectTop = CouchCoopSeatModLayout.ListTop;
    internal const float DescriptionTop = SelectTop + CouchCoopQrHostSelect.RowHeight + 16f;
    internal const float DescriptionHeight = 160f;

    private readonly Label _title = new();
    private readonly Label _description = new() { Name = "CouchCoopCouchPlayDescription" };
    private readonly CouchCoopQrHostSelect _select = new("CouchCoopCouchPlaySelect");
    private bool _installed;
    public Action? FocusChainChanged { get; set; }
    public Action? Opening { get; set; }
    public bool IsOpen => _select.IsOpen;

    public CouchCoopCouchPlayPanel()
    {
        Name = NodeName;
        MouseFilter = MouseFilterEnum.Stop;
        FocusMode = FocusModeEnum.None;
        AnchorLeft = AnchorRight = AnchorTop = AnchorBottom = .5f;
        OffsetLeft = CouchCoopSeatModLayout.Left - 960f;
        OffsetRight = OffsetLeft + CouchCoopSeatModLayout.Width;
        OffsetTop = -CouchCoopSeatModLayout.Height / 2f;
        OffsetBottom = CouchCoopSeatModLayout.Height / 2f;
        var style = new StyleBoxFlat
        {
            BgColor = Color.FromHtml(HostLobbyQrOverlayLayout.DefaultPanelColorHtml),
            BorderColor = Color.FromHtml(HostLobbyQrOverlayLayout.DefaultPanelBorderColorHtml),
        };
        style.SetBorderWidthAll(3);
        style.SetCornerRadiusAll(16);
        AddThemeStyleboxOverride("panel", style);
        _title.MouseFilter = _description.MouseFilter = MouseFilterEnum.Ignore;
        _title.HorizontalAlignment = HorizontalAlignment.Center;
        _title.Position = new(CouchCoopSeatModLayout.Padding, CouchCoopSeatModLayout.TitleTop);
        _title.Size = new(CouchCoopSeatModLayout.InnerWidth, CouchCoopSeatModLayout.TitleHeight);
        _title.AddThemeColorOverride("font_color", CouchCoopGameUiTheme.ConnectionPanelTitleGold);
        _description.Position = new(CouchCoopSeatModLayout.Padding, DescriptionTop);
        _description.Size = new(CouchCoopSeatModLayout.InnerWidth, DescriptionHeight);
        _description.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        _description.AddThemeColorOverride("font_color", CouchCoopGameUiTheme.ConnectionExplanationCream);
        _select.Position = new((CouchCoopSeatModLayout.Width - CouchCoopQrHostSelect.RowWidth) / 2f, SelectTop);
        _select.Size = new(CouchCoopQrHostSelect.RowWidth, CouchCoopQrHostSelect.RowHeight);
        AddChild(_title);
        AddChild(_description);
        AddChild(_select);
        Visible = false;
    }

    public void Install()
    {
        if (_installed) return;
        _installed = true;
        _select.Install();
        _select.Opening = () => Opening?.Invoke();
        _select.FocusChainChanged = () =>
        {
            _description.Visible = !_select.IsOpen;
            FocusChainChanged?.Invoke();
        };
        _select.SelectionChanged = entry =>
        {
            if (CouchPlayPanelModel.Choose(entry.Key) is { } mode) CouchPlayModeStore.TrySet(mode);
            Refresh(CouchPlayModeStore.Current);
        };
    }

    public void Refresh(CouchPlayMode mode)
    {
        _title.Text = CouchCoopLocalization.Resolve(CouchPlayPanelModel.TitleKey);
        _description.Text = CouchCoopLocalization.Resolve(CouchPlayPanelModel.Selected(mode).DescriptionKey);
        CouchCoopGameUiTheme.ApplyFont(_title, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne,
            CouchCoopGameUiTheme.ConnectionTitleFontSize);
        CouchCoopGameUiTheme.ApplyBodyFont(_description, CouchCoopGameUiTheme.ConnectionBodyFontSize);
        _select.SetOptions(CouchPlayPanelModel.Options.Select(option => new QrSelectEntry(option.Key,
            new CouchCoopText(option.LabelKey), new CouchCoopText(CouchPlayPanelModel.TitleKey), null)).ToArray(),
            CouchPlayPanelModel.Selected(mode).Key);
        _select.RefreshLocalization();
    }

    public void Close() => _select.Close();

    public void AppendFocusChain(List<Control> chain)
    {
        if (Visible) _select.AppendFocusChain(chain);
    }
}
