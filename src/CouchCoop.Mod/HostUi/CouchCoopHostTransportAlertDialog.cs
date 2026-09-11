using Godot;
using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The modal a host gets on entering the multiplayer lobby when the hosting transport is degraded —
/// today that is "Steam offline, so remote friends can't join". Body text comes straight from
/// <see cref="CouchCoopHostUiNotices.HostTransportNote"/>; the decision to show it comes from
/// <see cref="HostTransportAlert"/>.
/// </summary>
/// <remarks>
/// <para>
/// The same <see cref="CouchCoopModalDialog"/> chrome as the QR dialog — same scrim, same card, same
/// <see cref="CouchCoopSkipButton"/> — with one difference that is deliberate: the button is BIGGER than
/// the QR dialog's tucked-away close button, because here it is the only thing on the card the player
/// can act on, and a host reading this from a couch is several feet from the screen.
/// </para>
/// <para>
/// The note is rendered as the card's BODY at roughly twice the size the QR dialog's tip line used. That
/// tip line is still there and still correct; it just was not enough on its own, because a host who
/// never opens the QR dialog never sees it and is left guessing why nobody can connect.
/// </para>
/// </remarks>
internal sealed partial class CouchCoopHostTransportAlertDialog : CouchCoopModalDialog
{
    public const string NodeName = "CouchCoopHostTransportAlert";
    public const string ScrimName = "CouchCoopHostTransportAlertScrim";
    public const string PanelName = "CouchCoopHostTransportAlertPanel";
    public const string TitleLabelName = "CouchCoopHostTransportAlertTitleLabel";
    public const string BodyLabelName = "CouchCoopHostTransportAlertBodyLabel";
    public const string DismissButtonName = "CouchCoopHostTransportAlertDismissButton";

    public static string TitleText => CouchCoopLocalization.Resolve("couchcoop_alert_title");

    /// <summary>Longer than "OK" on purpose, so the button reads as a deliberate acknowledgement.</summary>
    public static string DismissButtonText => CouchCoopLocalization.Resolve("couchcoop_alert_continue");

    // Card geometry, design units. Wider and much shorter than the QR dialog's: one title row, a body
    // that wraps to at most two lines at this font size, and the button.
    private const float PanelWidth = 1100f;
    private const float PanelHeight = 420f;
    private const float TitleTop = 32f;
    private const float TitleHeight = 60f;
    private const float BodyTop = 120f;
    private const float BodyHeight = 140f;

    /// <summary>1.3x the QR dialog's close button — the alert's only affordance, so it earns the space.</summary>
    private static readonly Vector2 DismissSize = new(390f, 95f);

    private const int DismissFontSize = 42;

    private readonly Label _title = new() { Name = TitleLabelName };
    private readonly Label _body = new() { Name = BodyLabelName };
    private CouchCoopText? _text;

    public CouchCoopHostTransportAlertDialog()
        : base(
            new CouchCoopModalNames(NodeName, ScrimName, PanelName, DismissButtonName),
            new Vector2(PanelWidth, PanelHeight),
            DismissSize,
            DismissFontSize)
    {
        DismissText = DismissButtonText;

        ConfigureLabel(_title, HorizontalAlignment.Center, CouchCoopGameUiTheme.ButtonFontColor);
        _title.Text = TitleText;

        // The same amber the QR dialog's notice line uses, so the two readings of the same fact look
        // like the same fact.
        ConfigureLabel(_body, HorizontalAlignment.Center, new Color(1f, 0.79f, 0.35f, 1f));

        Card.AddChild(_title);
        Card.AddChild(_body);
    }

    /// <summary>The note currently on the card. Empty until the first <see cref="Open"/>.</summary>
    public string BodyText => _body.Text;

    protected override void ApplyBodyLayout(HostLobbyQrOverlayLayout previous, HostLobbyQrOverlayLayout next)
    {
        _title.AddThemeFontSizeOverride("font_size", next.TitleFontSize + 16);
        // The QR dialog renders this same string at UrlFontSize - 4 as a footnote. Here it IS the
        // message, so it goes up to title scale minus a step rather than down.
        _body.AddThemeFontSizeOverride("font_size", Math.Max(next.TitleFontSize + 4, 12));
    }

    /// <summary>Show the alert carrying <paramref name="note"/>. Blank notes are refused.</summary>
    public void Open(CouchCoopText note)
    {
        var resolved = note.Resolve();
        if (string.IsNullOrWhiteSpace(resolved))
        {
            return;
        }

        ApplyLayout();
        _text = note;
        _body.Text = resolved.Trim();
        LayoutContent();
        OpenModal();
    }

    public void RefreshLocalization()
    {
        DismissText = DismissButtonText;
        _title.Text = TitleText;
        _body.Text = _text?.Resolve() ?? string.Empty;
        CouchCoopGameUiTheme.ApplyFont(_title, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, Layout.TitleFontSize + 16);
        CouchCoopGameUiTheme.ApplyFont(_body, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, Math.Max(Layout.TitleFontSize + 4, 12));
        RefreshDialogFont();
    }

    protected override void LayoutBody(float padding, float textWidth)
    {
        _title.Position = new Vector2(padding, TitleTop);
        _title.Size = new Vector2(textWidth, TitleHeight);

        _body.Position = new Vector2(padding, BodyTop);
        _body.Size = new Vector2(textWidth, BodyHeight);
    }
}
