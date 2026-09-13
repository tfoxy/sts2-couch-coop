using Godot;
using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The full-screen join dialog: pick how a phone joins (one select — adapter × method, mdns last),
/// show a large QR for the pick, print the URL as a typeable fallback, close.
/// </summary>
/// <remarks>
/// <para>
/// The scrim/card/close-button chrome, Escape handling and focus parking all live in
/// <see cref="CouchCoopModalDialog"/>; this type is the BODY. The four structural node names it passes
/// up (<see cref="NodeName"/>, <see cref="ScrimName"/>, <see cref="PanelName"/>,
/// <see cref="CouchCoopSkipButton.NodeName"/>) are the published QA contract and must not change.
/// </para>
/// <para>
/// <b>One select, no modes.</b> The pre-redesign dialog had a host select plus two mutually exclusive
/// checkboxes whose link URLs ignored the selected row (both were derived from the machine-picked
/// advertised address). Now every option IS a row — each adapter's plain address, web link and secure
/// link are separate, per-adapter entries (see <see cref="QrHostOptions.Build"/>) — so "what does the
/// QR encode" and "what is selected" are the same question, and the old mode plumbing, select dimming
/// and offer state are gone. Hovering or focusing a row shows the game-native tip pair explaining the
/// adapter and the method (see <see cref="CouchCoopQrHoverTips"/>). The closed selector itself has a separate
/// explanatory tip so it does not appear to describe the currently selected row.
/// </para>
/// <para>
/// <b>Cost discipline.</b> The host list is recomputed in <see cref="Open"/> ONLY. Enumerating network
/// interfaces is a syscall walk, and the controller's scan runs four times a second — doing it there
/// would put an OS enumeration on every lobby frame budget for a dialog that is usually closed.
/// </para>
/// </remarks>
internal sealed partial class CouchCoopQrDialog : CouchCoopModalDialog
{
    public const string NodeName = "CouchCoopQrDialog";
    public const string ScrimName = "CouchCoopQrDialogScrim";
    public const string PanelName = "CouchCoopQrDialogPanel";
    public const string TitleLabelName = "CouchCoopQrDialogTitleLabel";
    public const string QrTextureName = "CouchCoopQrDialogQrTexture";
    public const string UrlLabelName = "CouchCoopQrDialogUrlLabel";
    public const string NoticeLabelName = "CouchCoopQrDialogNoticeLabel";

    public static string TitleText => CouchCoopLocalization.Resolve("couchcoop_qr_title");
    public static string CloseButtonText => CouchCoopLocalization.Resolve("couchcoop_qr_close");
    private static string NoAddressText => CouchCoopLocalization.Resolve("couchcoop_qr_no_address");

    // Dialog card geometry, design units. Sized around the QR's constant 592-unit extent plus the
    // title, select, URL, notice and close rows.
    //
    // The card once carried two link-toggle rows between the select and the QR and stood at 1064 —
    // two units shy of what a 1080-tall design space allows. The single-select redesign folded the
    // toggles into the option list, so the QR moved up to 152 and the card shrank to 936, which clears
    // the design space by 72 on each side. The expanded option list (at most QrHostOptions.MaxOptions
    // rows of 64 under a 64 closed row at 72) bottoms out at 904, still inside the card.
    // CouchCoopQrLayoutContractTests pins the arithmetic.
    private const float PanelWidth = 1000f;
    private const float PanelHeight = 936f;
    private const float TitleTop = 12f;
    private const float TitleHeight = 52f;
    private const float SelectTop = 72f;
    private const float QrTop = 152f;
    private const float UrlGap = 6f;
    private const float UrlHeight = 32f;
    private const float NoticeGap = 2f;
    private const float NoticeHeight = 40f;

    private readonly Label _title = new() { Name = TitleLabelName };
    private readonly Label _url = new() { Name = UrlLabelName };
    private readonly Label _notice = new() { Name = NoticeLabelName };
    private readonly TextureRect _qr = new() { Name = QrTextureName };
    private readonly CouchCoopQrHostSelect _select = new();
    private readonly CouchCoopConnectionPanel _connections = new();

    private string? _qrCacheKey;
    // The row a live hover-tip set hangs off, if any. Tracked so the set can be taken down on paths
    // where the row itself never reports a hover-leave (dialog close, list collapse, row rebuild).
    private Control? _tipOwner;

    public CouchCoopQrDialog()
        : base(
            new CouchCoopModalNames(NodeName, ScrimName, PanelName, CouchCoopSkipButton.NodeName),
            new Vector2(PanelWidth, PanelHeight), dismissFontSize: 28)
    {
        DismissText = CloseButtonText;

        ConfigureLabel(_title, HorizontalAlignment.Center, CouchCoopGameUiTheme.ButtonFontColor);
        _title.Text = TitleText;
        _title.Position = new Vector2(0f, TitleTop);
        _title.Size = new Vector2(PanelWidth, TitleHeight);

        _select.Position = new Vector2((PanelWidth - CouchCoopQrHostSelect.RowWidth) / 2f, SelectTop);
        _select.Size = new Vector2(CouchCoopQrHostSelect.RowWidth, CouchCoopQrHostSelect.RowHeight);
        _select.SelectionChanged = OnSelectionChanged;
        _select.RowHover = OnRowHover;
        _select.SelectorHover = OnSelectorHover;
        _select.OptionsHidden = ClearTips;
        _select.FocusChainChanged = RefreshFocusChain;

        // Nearest filtering plus the raster's whole-pixel module grid is what keeps module edges hard.
        // Stop: the code itself is a dialog ELEMENT, so clicking it must not dismiss the dialog — a
        // player lining a phone up over the code will touch it.
        _qr.ExpandMode = TextureRect.ExpandModeEnum.IgnoreSize;
        _qr.StretchMode = TextureRect.StretchModeEnum.KeepAspectCentered;
        _qr.TextureFilter = TextureFilterEnum.Nearest;
        _qr.MouseFilter = MouseFilterEnum.Stop;

        ConfigureLabel(_url, HorizontalAlignment.Center, CouchCoopGameUiTheme.ButtonFontColor);
        ConfigureLabel(_notice, HorizontalAlignment.Center, new Color(1f, 0.79f, 0.35f, 1f));
        _notice.Visible = false;

        Card.AddChild(_title);
        Card.AddChild(_qr);
        Card.AddChild(_url);
        Card.AddChild(_notice);
        // Added last so the expanded option list draws over the QR rather than under it.
        Card.AddChild(_select);
        _connections.FocusChainChanged = RefreshFocusChain;
        // A sibling of the central card, deliberately: its fixed left edge clears the QR card rather
        // than competing for the QR, URL or close-button vertical budget.
        AddChild(_connections);
    }

    protected override void InstallBody()
    {
        _select.Install();
        _connections.Install();
    }

    /// <summary>
    /// What a d-pad walks in this dialog, top to bottom: the selector's closed row, the selectable option
    /// rows while the list is expanded, and then (appended by the base) the close button.
    /// </summary>
    /// <remarks>
    /// The rows were always focusable — <c>CouchCoopQrHostSelect</c> gives every selectable one
    /// <c>FocusMode.All</c> — but before the chain nothing walked to them, so a Deck host could only ever
    /// scan the default LAN address: no adapter switch, no HTTPS row, no way to reach either without a
    /// mouse. The list is re-declared, not remembered, so an expand, a collapse or a re-scan that rebuilds
    /// every row all produce a correct chain by construction.
    /// </remarks>
    protected override void CollectFocusChain(List<Control> chain)
    {
        _connections.AppendFocusChain(chain);
        _select.AppendFocusChain(chain);
    }

    public void RefreshConnections()
    {
        _connections.Refresh();
        ApplyNotice();
    }

    public void RefreshLocalization(CouchCoopHostUiSnapshot snapshot)
    {
        DismissText = CloseButtonText;
        _title.Text = TitleText;
        CouchCoopGameUiTheme.ApplyFont(_title, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, Layout.TitleFontSize + 16);
        CouchCoopGameUiTheme.ApplyFont(_url, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, Layout.UrlFontSize);
        CouchCoopGameUiTheme.ApplyFont(_notice, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, Math.Max(Layout.UrlFontSize - 8, 8));
        RefreshDialogFont();
        if (IsOpen)
        {
            RefreshOptions(snapshot);
        }
        else
        {
            _select.RefreshLocalization();
        }
        RenderSelection();
    }

    protected override void ApplyBodyLayout(HostLobbyQrOverlayLayout previous, HostLobbyQrOverlayLayout next)
    {
        _title.AddThemeFontSizeOverride("font_size", next.TitleFontSize + 16);
        _url.AddThemeFontSizeOverride("font_size", next.UrlFontSize);
        _notice.AddThemeFontSizeOverride("font_size", Math.Max(next.UrlFontSize - 8, 8));

        var qrChanged = next.QuietZoneModules != previous.QuietZoneModules
            || Math.Abs(next.ResolvedQrDialogExtent - previous.ResolvedQrDialogExtent) > 0.01f;
        if (qrChanged)
        {
            _qrCacheKey = null;
        }
    }

    /// <summary>
    /// Show the dialog for <paramref name="snapshot"/>, recomputing the option list from the OS.
    /// </summary>
    public void Open(CouchCoopHostUiSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ApplyLayout();
        RefreshOptions(snapshot);
        RefreshConnections();
        OpenModal();
    }

    // ClearTips is load-bearing here, not belt-and-braces: closing HIDES the dialog rather than
    // freeing it, so the game's own TreeExiting backstop for an owner's tip set never fires.
    protected override void OnClosing()
    {
        _select.Close();
        ClearTips();
    }

    private void RefreshOptions(CouchCoopHostUiSnapshot snapshot)
    {
        var options = QrHostOptions.Build(
            System.Environment.MachineName,
            LanAddressRanking.ReadAdvertisedHostOverride(),
            LanAddressRanking.GatherFromOs(),
            snapshot.ListenerBaseUri?.Port ?? 0,
            Server.CouchCoopWebOrigin.Resolve(),
            snapshot.SecureDomain,
            snapshot.SecurePort,
            snapshot.SecureUnavailableReason,
            // Read per OPEN, not once: the self-check completes a couple of seconds after the responder
            // starts, which can easily be after this dialog was first constructed.
            CouchCoopHostUiNotices.MdnsRowTrusted());

        // Keep the player's pick across a reopen when it is still on offer (so re-scanning after a
        // failed attempt does not silently switch them back to the default), falling back to the pick
        // remembered from earlier sessions.
        var preferredKey = _select.Selected?.SelectionKey
            ?? CouchCoopQrSelectionPreference.Read()?.PreferredSelectionKey;
        _select.SetOptions(options, preferredKey);

        RenderSelection();
    }

    private void OnSelectionChanged(QrHostOption option)
    {
        // Persist first, then re-render: the persisted pick is what the NEXT open restores, and
        // writing it before the render means a crash mid-render cannot lose the choice.
        CouchCoopQrSelectionPreference.Write(option);
        RenderSelection();
    }

    private void RenderSelection()
    {
        // ONE code, whose payload is the selected row and nothing else. The URL label and the QR
        // texture are both built from this one value, so the scanned code and the typed fallback
        // cannot disagree even in principle.
        if (_select.Selected is not { Enabled: true } option || option.Port <= 0)
        {
            _url.Text = NoAddressText;
            _qr.Texture = null;
            _qr.Visible = false;
            _qrCacheKey = null;
            ApplyNotice();
            LayoutContent();
            return;
        }

        var uri = option.ToUri();
        _url.Text = uri.ToString();
        _qr.Visible = true;

        var cacheKey = $"{uri}|quiet={Layout.QuietZoneModules}|extent={Layout.ResolvedQrDialogExtent}";
        if (!string.Equals(_qrCacheKey, cacheKey, StringComparison.Ordinal))
        {
            // The payload's length still decides the module COUNT (37 for a plain LAN URL, 41 for the
            // longer secure one) but no longer the on-screen size: the raster plan packs whichever grid it
            // gets onto one fixed canvas and pads the remainder with white quiet zone. See QrRasterPlan.
            var code = OfflineQrCode.EncodeJoinUrl(uri, Layout.QuietZoneModules);
            _qr.Texture = QrCodeTextureFactory.Create(code, Layout.RasterPlanFor(code.Size));
            _qrCacheKey = cacheKey;
        }

        ApplyNotice();
        LayoutContent();
    }

    private void OnRowHover(Control row, QrHostOption option, bool hovered)
    {
        // Always tear down first: hover-enter can arrive twice without a leave (mouse + controller
        // focus), and the game throws on a second set for the same owner.
        CouchCoopQrHoverTips.Remove(row);
        if (_tipOwner == row)
        {
            _tipOwner = null;
        }

        if (!hovered)
        {
            return;
        }

        // One pair at a time: a stale set on another row (its leave got swallowed by a relayout)
        // must not stack beside the fresh one.
        ClearTips();
        if (CouchCoopQrHoverTips.ShowOption(row, option))
        {
            _tipOwner = row;
        }
    }

    private void OnSelectorHover(Control row, bool hovered)
    {
        // The closed row describes the selector as a control, not the option currently displayed in it.
        CouchCoopQrHoverTips.Remove(row);
        if (_tipOwner == row)
        {
            _tipOwner = null;
        }

        if (!hovered)
        {
            return;
        }

        ClearTips();
        if (CouchCoopQrHoverTips.ShowSelector(row))
        {
            _tipOwner = row;
        }
    }

    private void ClearTips()
    {
        CouchCoopQrHoverTips.Remove(_tipOwner);
        _tipOwner = null;
    }

    private void ApplyNotice()
    {
        var note = CouchCoopHostUiNotices.HostTransportNote?.Resolve();
        if (string.IsNullOrWhiteSpace(note) && !CouchCoop.Mod.Connections.ConnectionRegistry.Shared.Snapshot().Rows.Any())
            note = CouchCoopLocalization.Resolve("couchcoop_connection_empty");
        _notice.Text = note ?? string.Empty;
        _notice.Visible = !string.IsNullOrWhiteSpace(note);
    }

    protected override void LayoutBody(float padding, float textWidth)
    {
        _title.Position = new Vector2(padding, TitleTop);
        _title.Size = new Vector2(textWidth, TitleHeight);

        // Constant for every payload now (HostLobbyQrOverlayLayout.QrDisplayExtent), which is also why
        // the URL and notice rows below no longer shift when the encoded host changes length.
        var extent = Layout.QrDisplayExtent;
        _qr.Position = new Vector2((PanelWidth - extent) / 2f, QrTop);
        // Minimum first: Godot clamps Size against the CURRENT minimum, so assigning Size while a larger
        // minimum is still in place would silently keep the old extent -- and `CustomMinimumSize = _qr.Size`
        // would then latch that clamped value forever. The extent no longer varies, so the two can no
        // longer disagree, but the order is kept because it is the correct order.
        _qr.CustomMinimumSize = new Vector2(extent, extent);
        _qr.Size = new Vector2(extent, extent);

        var urlTop = QrTop + (_qr.Visible ? extent : 0f) + UrlGap;
        _url.Position = new Vector2(padding, urlTop);
        _url.Size = new Vector2(textWidth, UrlHeight);

        _notice.Position = new Vector2(padding, urlTop + UrlHeight + NoticeGap);
        _notice.Size = new Vector2(textWidth, NoticeHeight);
    }

    // An open option list is the nearer "layer": dismiss that first rather than tearing down the whole
    // dialog, so changing your mind about the address does not cost you the QR.
    protected override bool OnScrimPressed()
    {
        if (!_select.IsOpen)
        {
            return false;
        }

        _select.Close();
        return true;
    }

    // The card is NOT a close surface: only the scrim and the close button dismiss the dialog. A click on
    // the card background at most collapses the open option list.
    protected override void OnCardPressed() => _select.Close();
}
