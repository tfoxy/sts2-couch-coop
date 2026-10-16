using Godot;
using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.HostUi;

/// <summary>Choose a network and connection method, then show their QR or an explanation in place.</summary>
internal sealed partial class CouchCoopQrDialog : CouchCoopModalDialog
{
    public const string NodeName = "CouchCoopQrDialog";
    public const string ScrimName = "CouchCoopQrDialogScrim";
    public const string PanelName = "CouchCoopQrDialogPanel";
    public const string TitleLabelName = "CouchCoopQrDialogTitleLabel";
    public const string QrTextureName = "CouchCoopQrDialogQrTexture";
    public const string UrlLabelName = "CouchCoopQrDialogUrlLabel";
    public const string CopyButtonName = CouchCoopQrCopyButton.NodeName;
    public const string NoticeLabelName = "CouchCoopQrDialogNoticeLabel";

    public static string TitleText => CouchCoopLocalization.Resolve("couchcoop_qr_title");
    public static string CloseButtonText => CouchCoopLocalization.Resolve("couchcoop_qr_close");

    // Only direct-IP HTTPS trades QR space for its device-setup row.
    // Constants are shared with the game-free geometry contracts.
    internal const float PanelWidth = 1000f;
    internal const float PanelHeight = 936f;
    internal const float TitleTop = 12f;
    internal const float TitleHeight = 52f;
    internal const float SelectTop = 72f;
    internal const float SelectWidth = CouchCoopQrHostSelect.RowWidth * 2f;
    internal const float QrTop = 152f;
    internal const float UrlGap = 6f;
    internal const float UrlHeight = 32f;
    internal const float SetupRowHeight = QrMethodLayout.DirectIpSetupRowHeight;
    internal const float NoticeGap = 2f;
    internal const float NoticeHeight = 40f;

    /// <summary>
    /// This dialog's close-button inset, below <see cref="CouchCoopModalDialog.DefaultDismissBottomInset"/>
    /// because its body fills the card. See the geometry note above.
    /// </summary>
    internal const float DismissBottomInset = 8f;

    private readonly Label _title = new() { Name = TitleLabelName };
    private readonly Label _url = new() { Name = UrlLabelName };
    private readonly Label _notice = new() { Name = NoticeLabelName };
    private readonly TextureRect _qr = new() { Name = QrTextureName };
    private readonly CouchCoopQrCopyButton _copy = new();
    private readonly CouchCoopQrHostSelect _select = new();
    private readonly CouchCoopQrHostSelect _methodSelect = new("CouchCoopQrMethodSelect");
    private readonly QrSelectionModel _selection = new();
    private readonly CouchCoopSetupButton _setupAction = new("CouchCoopQrSetupButton");
    private readonly Label _unavailable = new() { Name = "CouchCoopQrUnavailable" };
    private readonly CouchCoopConnectionPanel _connections = new();
    private readonly CouchCoopSeatModPanel _seatMods = new() { Source = SeatModSelectionService.Shared };

    private readonly CouchCoopDirectIpSetupDialog _directIpSetup = new();
    public new bool IsOpen => base.IsOpen || _directIpSetup.IsOpen;
    private bool _closingSetup;

    public new void Close()
    {
        _closingSetup = true;
        try { _directIpSetup.Close(); base.Close(); }
        finally { _closingSetup = false; }
    }

    private string? _qrCacheKey;
    private CouchCoopHostUiSnapshot? _lastSnapshot;
    // The row a live hover-tip set hangs off, if any. Tracked so the set can be taken down on paths
    // where the row itself never reports a hover-leave (dialog close, list collapse, row rebuild).
    private Control? _tipOwner;

    public CouchCoopQrDialog()
        : base(
            new CouchCoopModalNames(NodeName, ScrimName, PanelName, CouchCoopSkipButton.NodeName),
            new Vector2(PanelWidth, PanelHeight),
            dismissFontSize: 28,
            dismissBottomInset: DismissBottomInset)
    {
        DismissText = CloseButtonText;

        ConfigureLabel(_title, HorizontalAlignment.Center, CouchCoopGameUiTheme.ButtonFontColor);
        _title.Text = TitleText;
        _title.Position = new Vector2(0f, TitleTop);
        _title.Size = new Vector2(PanelWidth, TitleHeight);

        _select.Position = new Vector2((PanelWidth - SelectWidth) / 2f, SelectTop);
        _methodSelect.Position = _select.Position + new Vector2(CouchCoopQrHostSelect.RowWidth, 0f);
        foreach (var select in new[] { _select, _methodSelect })
        {
            select.Size = new Vector2(CouchCoopQrHostSelect.RowWidth, CouchCoopQrHostSelect.RowHeight);
            select.OptionsHidden = ClearTips;
            select.FocusChainChanged = RefreshPickerFocus;
        }
        _select.RowHover = (row, entry, hovered) =>
        {
            if (entry.Option is { } option)
                ShowTip(row, hovered, owner => CouchCoopQrHoverTips.ShowNetworkOption(owner, option));
        };
        _methodSelect.RowHover = (row, entry, hovered) =>
        {
            ShowTip(row, hovered, owner => CouchCoopQrHoverTips.ShowOption(owner, entry.Option, entry.Key));
        };
        _select.SelectionChanged = entry =>
        {
            if (_selection.ChooseNetwork(entry.Key)) OnSelectionChanged();
        };
        _methodSelect.SelectionChanged = entry =>
        {
            if (_selection.ChooseMethod(entry.Key)) OnSelectionChanged(explicitMethodSelection: true);
        };
        _select.SelectorHover = (row, hovered) => ShowTip(row, hovered && !_select.IsOpen, CouchCoopQrHoverTips.ShowSelector);
        _methodSelect.SelectorHover = (row, hovered) => ShowTip(row, hovered && !_methodSelect.IsOpen,
            owner => CouchCoopQrHoverTips.ShowMethodSelector(owner, _selection.Selected));
        _select.Opening = () => { ClearTips(); _methodSelect.Close(); };
        _methodSelect.Opening = () => { ClearTips(); _select.Close(); };
        ConfigureLabel(_unavailable, HorizontalAlignment.Center, CouchCoopGameUiTheme.ButtonFontColor);
        CouchCoopGameUiTheme.ApplyBodyFont(_unavailable, 24);
        _unavailable.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        _unavailable.VerticalAlignment = VerticalAlignment.Center;
        _unavailable.ClipText = true;
        _unavailable.Visible = false;
        _setupAction.Visible = false;
        _setupAction.Activated = OpenSetup;

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

        // Hidden until a selection has actually rendered an address, so the focus ring built at Install()
        // time cannot have a stop on a button with nothing behind it.
        _copy.Visible = false;
        // The selected option stays the single source of truth for what gets copied, exactly as it is for
        // what the QR encodes and what the label prints — the button holds no address of its own.
        _copy.Payload = () => _selection.Url?.ToString();
        _copy.Engaged = engaged => ShowTip(_copy, engaged && !_select.IsOpen && !_methodSelect.IsOpen, CouchCoopQrHoverTips.ShowCopyLink);

        Card.AddChild(_title);
        Card.AddChild(_qr);
        Card.AddChild(_unavailable);
        Card.AddChild(_setupAction);
        Card.AddChild(_url);
        Card.AddChild(_copy);
        Card.AddChild(_notice);
        // Added last so the expanded option list draws over the QR rather than under it.
        Card.AddChild(_select);
        Card.AddChild(_methodSelect);
        _connections.FocusChainChanged = RefreshFocusChain;
        // A sibling of the central card, deliberately: its fixed left edge clears the QR card rather
        // than competing for the QR, URL or close-button vertical budget.
        AddChild(_connections);
        // Its mirror on the right, a sibling for the same reason: the mods the host may turn off for the games
        // it runs for browser players. Hidden unless this machine has one to offer.
        _seatMods.FocusChainChanged = RefreshFocusChain;
        AddChild(_seatMods);
    }

    protected override void InstallBody()
    {
        GetParent().AddChild(_directIpSetup);
        _directIpSetup.Install();
        _directIpSetup.Closed = () =>
        {
            if (!_closingSetup && GodotObject.IsInstanceValid(this))
            {
                Open(CouchCoopMod.HostUiSnapshot);
                if (_setupAction.Visible) _setupAction.GrabFocus();
            }
        };
        _select.Install();
        _methodSelect.Install();
        _copy.Install();
        _setupAction.Install();
        _connections.Install();
        _seatMods.Install();
    }

    /// <summary>
    /// What a d-pad walks in this dialog, top to bottom: the selector's closed row, the selectable option
    /// rows while the list is expanded, the copy affordance under the QR, the seat-mod rows on the right-hand
    /// card, and then (appended by the base) the close button.
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
        _methodSelect.AppendFocusChain(chain);

        // Not declared while the option list is expanded over it: the rows draw on top of this row, so a
        // walk onto the copy button would light a focus ring nobody can see. Both the expand and the
        // collapse already re-pin the chain through _select.FocusChainChanged.
        if (_copy.Visible && !_select.IsOpen && !_methodSelect.IsOpen)
        {
            chain.Add(_copy);
        }

        if (_setupAction.Visible && !_select.IsOpen && !_methodSelect.IsOpen)
            chain.Add(_setupAction);

        // After the copy button, so a walk down from the QR crosses to the right-hand card before it reaches
        // close. The card declares nothing while it is hidden, and its confirm pair only while one is pending.
        _seatMods.AppendFocusChain(chain);
    }

    public void RefreshConnections()
    {
        _connections.Refresh();
        ApplyNotice();
    }

    public void RefreshLocalization(CouchCoopHostUiSnapshot snapshot)
    {
        _lastSnapshot = snapshot;
        DismissText = CloseButtonText;
        _title.Text = TitleText;
        // The copy button is wordless, so its title is the only thing a screen reader has to go on.
        _copy.AccessibilityName = CouchCoopLocalization.Resolve("couchcoop_qr_copy_link_title");
        CouchCoopGameUiTheme.ApplyFont(_title, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, Layout.TitleFontSize + 16);
        CouchCoopGameUiTheme.ApplyFont(_url, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, Layout.UrlFontSize);
        CouchCoopGameUiTheme.ApplyFont(_notice, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, Math.Max(Layout.UrlFontSize - 8, 8));
        CouchCoopGameUiTheme.ApplyBodyFont(_unavailable, Layout.UrlFontSize);
        RefreshDialogFont();
        _seatMods.RefreshLocalization();
        _directIpSetup.RefreshText();
        _setupAction.RefreshLocalization();
        if (IsOpen)
        {
            RefreshOptions(snapshot);
        }
        else
        {
            _select.RefreshLocalization();
            _methodSelect.RefreshLocalization();
        }
        RenderSelection();
    }

    protected override void ApplyBodyLayout(HostLobbyQrOverlayLayout previous, HostLobbyQrOverlayLayout next)
    {
        _title.AddThemeFontSizeOverride("font_size", next.TitleFontSize + 16);
        _url.AddThemeFontSizeOverride("font_size", next.UrlFontSize);
        _unavailable.AddThemeFontSizeOverride("font_size", next.UrlFontSize);
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
        if (_directIpSetup.IsOpen) Close();
        _lastSnapshot = snapshot;
        ApplyLayout();
        RefreshOptions(snapshot);
        RefreshConnections();
        // Here and NOT in RefreshConnections, which the lobby scan calls four times a second: the inventory can
        // read manifests off disk, and the card applies its own presses while the dialog is up.
        _seatMods.Refresh();
        OpenModal();
    }

    // ClearTips is load-bearing here, not belt-and-braces: closing HIDES the dialog rather than
    // freeing it, so the game's own TreeExiting backstop for an owner's tip set never fires.
    protected override void OnClosing()
    {
        _select.Close();
        _methodSelect.Close();
        _copy.ResetFeedback();
        ClearTips();
    }

    private void RefreshOptions(CouchCoopHostUiSnapshot snapshot)
    {
        _lastSnapshot = snapshot;
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
            CouchCoopHostUiNotices.MdnsRowTrusted(),
            secureOriginEnabled: SecureOriginCertificates.Enabled,
            directIpHttps: snapshot.DirectIpHttps);

        // Keep the player's pick across a reopen when it is still on offer (so re-scanning after a
        // failed attempt does not silently switch them back to the default), falling back to the pick
        // remembered from earlier sessions.
        var preference = _selection.Network is null ? CouchCoopQrSelectionPreference.Read() : _selection.Memory;
        _selection.Refresh(options, preference);
        RefreshSelectors();
        RenderSelection();
    }

    private void RefreshSelectors()
    {
        _select.SetOptions(_selection.Networks.Select(network => new QrSelectEntry(
            network.SelectionKey, QrSelectionModel.NetworkLabel(network),
            CouchCoopText.FromLiteral(network.Host), network)).ToArray(), _selection.Network?.SelectionKey);
        _methodSelect.SetOptions(QrSelectionModel.Methods.Select(method =>
        {
            var option = _selection.Resolve(method);
            return new QrSelectEntry(method, QrSelectionModel.MethodLabel(method),
                QrMethodPresentation.For(option, _lastSnapshot?.DirectIpHttps, _selection.PreviewUrlFor(method)).Subtitle,
                option, option?.Selectable == true);
        }).ToArray(), _selection.Method);
        _select.AccessibilityName = CouchCoopLocalization.Resolve("couchcoop_qr_network_connection_title");
        _methodSelect.AccessibilityName = CouchCoopLocalization.Resolve("couchcoop_qr_method_selector_title");
    }

    private void OnSelectionChanged(bool explicitMethodSelection = false)
    {
        CouchCoopQrSelectionPreference.Write(_selection.Memory);
        RefreshSelectors();
        RenderSelection();
        if (QrMethodPresentation.OpensSetup(_selection.Selected, explicitMethodSelection)) OpenSetup();
        if (_selection.Selected is { Kind: QrHostOptionKind.Secure, Enabled: false, Selectable: true })
        {
            CouchCoop.Mod.CouchCoopMod.RequestSecureOrigin();
            RefreshSecureAvailability(CouchCoop.Mod.CouchCoopMod.HostUiSnapshot);
        }
    }

    private void OpenSetup()
    {
        if (_selection.Selected is not { Kind: QrHostOptionKind.DirectIpSecure, Selectable: true }
            || _select.IsOpen || _methodSelect.IsOpen) return;
        ClearTips();
        base.Close();
        _directIpSetup.Open(CouchCoopMod.HostUiSnapshot.DirectIpHttps);
    }

    /// <summary>Refresh an open dialog only when the asynchronous secure-origin state changes.</summary>
    public void RefreshSecureAvailability(CouchCoopHostUiSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        _directIpSetup.Refresh(snapshot.DirectIpHttps);
        _directIpSetup.ReassertWhileOpen();
        var previous = _lastSnapshot;
        _lastSnapshot = snapshot;
        if (!IsOpen || previous is null)
        {
            return;
        }

        if (previous.SecurePort != snapshot.SecurePort
            || previous.SecureDomain != snapshot.SecureDomain
            || previous.SecureUnavailableReason != snapshot.SecureUnavailableReason
            || previous.DirectIpHttps != snapshot.DirectIpHttps)
        {
            RefreshOptions(snapshot);
        }
    }

    private void RenderSelection()
    {
        // A tick left over from the previous address would claim the clipboard holds THIS one.
        var presentation = QrMethodPresentation.For(_selection.Selected, _lastSnapshot?.DirectIpHttps);
        _setupAction.Visible = presentation.ShowsSetup;
        _setupAction.Text = presentation.SetupAction?.Resolve() ?? string.Empty;
        _setupAction.AccessibilityName = _setupAction.Text;
        _copy.ResetFeedback();

        // ONE code, whose payload is the selected row and nothing else. The URL label and the QR
        // texture are both built from this one value, so the scanned code and the typed fallback
        // cannot disagree even in principle.
        if (_selection.Url is not { } uri)
        {
            _url.Text = string.Empty;
            _unavailable.Text = presentation.UsesSetupPlaceholder
                ? CouchCoopLocalization.Resolve("couchcoop_https_qr_setup_body")
                    + (presentation.State is QrMethodReadiness.Preparing or QrMethodReadiness.NeedsAttention
                        ? "\n\n" + presentation.Subtitle.Resolve() : string.Empty)
                : presentation.State == QrMethodReadiness.Unavailable
                    ? _selection.UnavailableMessage.Resolve()
                    : _selection.Selected?.DisabledReason?.Resolve() ?? presentation.Subtitle.Resolve();
            _unavailable.Visible = true;
            _qr.Texture = null;
            _qr.Visible = false;
            // There is no address to put on a clipboard, so the affordance is not merely disabled: it is
            // gone, and out of the focus ring with it.
            _copy.Visible = false;
            _qrCacheKey = null;
            ApplyNotice();
            LayoutContent();
            RefreshPickerFocus();
            return;
        }

        _unavailable.Visible = false;
        _url.Text = uri.ToString();
        _qr.Visible = true;
        _copy.Visible = true;

        var methodLayout = QrMethodLayout.For(Layout, _selection.Method);
        var cacheKey = methodLayout.CacheKeyFor(uri);
        if (!string.Equals(_qrCacheKey, cacheKey, StringComparison.Ordinal))
        {
            // The payload's length still decides the module COUNT (37 for a plain LAN URL, 41 for the
            // longer secure one) but no longer the on-screen size: the raster plan packs whichever grid it
            // gets onto one fixed canvas and pads the remainder with white quiet zone. See QrRasterPlan.
            var code = OfflineQrCode.EncodeJoinUrl(uri, Layout.QuietZoneModules);
            _qr.Texture = QrCodeTextureFactory.Create(code, methodLayout.RasterPlanFor(code.Size));
            _qrCacheKey = cacheKey;
        }

        ApplyNotice();
        LayoutContent();
        RefreshPickerFocus();
    }

    private void RefreshPickerFocus()
    {
        var optionsOpen = _select.IsOpen || _methodSelect.IsOpen;
        foreach (var action in new Control[] { _copy, _setupAction })
        {
            var reachable = action.Visible && !optionsOpen;
            if (!reachable && action.HasFocus()) action.ReleaseFocus();
            action.FocusMode = reachable ? FocusModeEnum.All : FocusModeEnum.None;
        }
        RefreshFocusChain();
    }

    /// <summary>
    /// Put <paramref name="owner"/>'s tip set up on hover-enter and take it down on hover-leave.
    /// </summary>
    /// <remarks>
    /// Always tears down FIRST: hover-enter can arrive twice without a leave (mouse plus controller
    /// focus), and the game throws on a second set for the same owner. Then <see cref="ClearTips"/>,
    /// because one set is on screen at a time — a stale set on another control, whose leave got swallowed
    /// by a relayout, must not stack beside the fresh one.
    /// </remarks>
    private void ShowTip(Control owner, bool hovered, Func<Control, bool> show)
    {
        CouchCoopQrHoverTips.Remove(owner);
        if (_tipOwner == owner)
        {
            _tipOwner = null;
        }

        if (!hovered || !base.IsOpen || !owner.IsVisibleInTree())
        {
            return;
        }

        ClearTips();
        if (show(owner))
        {
            _tipOwner = owner;
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

        // Only direct-IP HTTPS reserves a setup row. Payload length never changes QR size.
        var methodLayout = QrMethodLayout.For(Layout, _selection.Method);
        var extent = methodLayout.Extent;
        _qr.Position = new Vector2((PanelWidth - extent) / 2f, QrTop);
        // Minimum first: Godot clamps Size against the CURRENT minimum, so assigning Size while a larger
        // minimum is still in place would silently keep the old extent -- and `CustomMinimumSize = _qr.Size`
        // would then latch that clamped value forever when switching to direct-IP HTTPS.
        _qr.CustomMinimumSize = new Vector2(extent, extent);
        _qr.Size = new Vector2(extent, extent);

        _unavailable.Position = _qr.Position;
        _unavailable.Size = new Vector2(extent, extent);
        if (_setupAction.Visible && !_qr.Visible)
        {
            _unavailable.Position = new Vector2(padding, QrTop + 180f);
            _unavailable.Size = new Vector2(textWidth, 190f);
        }
        var urlTop = QrTop + extent + UrlGap;
        _url.Position = new Vector2(padding, urlTop);
        _url.Size = new Vector2(textWidth, UrlHeight);

        // Inside the URL row, so the copy affordance costs the card no vertical budget at all — the stack
        // below is already tight (see the geometry note at the top). It rides the rendered width of the
        // address rather than the column's edge; CouchCoopQrCopyRowPlacement owns that arithmetic.
        var placement = CouchCoopQrCopyRowPlacement.For(
            padding,
            textWidth,
            urlTop,
            UrlHeight,
            MeasureUrlWidth(),
            CouchCoopQrCopyButton.IconEdge,
            CouchCoopQrCopyButton.TextGap);
        _copy.Position = new Vector2(placement.X, placement.Y);
        _copy.Size = new Vector2(CouchCoopQrCopyButton.IconEdge, CouchCoopQrCopyButton.IconEdge);

        _setupAction.Position = new Vector2((PanelWidth - CouchCoopSkipButton.DesignWidth) / 2f,
            _qr.Visible ? urlTop + UrlHeight + 6f : QrTop + 390f);
        _setupAction.Size = CouchCoopSkipButton.DesignSize;
        _notice.Position = new Vector2(padding, urlTop + UrlHeight + methodLayout.SetupRowHeight + NoticeGap);
        _notice.Size = new Vector2(textWidth, NoticeHeight);
    }

    /// <summary>
    /// How wide the address actually renders, or 0 when the engine cannot say.
    /// </summary>
    /// <remarks>
    /// Measured rather than assumed because the label centres its text in the full column: the icon's
    /// place is a function of the address's length, and the two URLs this dialog produces differ by a
    /// wide margin. Fenced because the fallback is graceful — a right-aligned icon on the correct row —
    /// and a missing font must not cost the dialog its layout pass.
    /// </remarks>
    private float MeasureUrlWidth()
    {
        try
        {
            return _url.GetThemeFont("font") is { } font
                ? font.GetStringSize(_url.Text, HorizontalAlignment.Left, -1f, _url.GetThemeFontSize("font_size")).X
                : 0f;
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"qr url measure failed detail={exception.GetType().Name}: {exception.Message}");
            return 0f;
        }
    }

    // An open option list is the nearer "layer": dismiss that first rather than tearing down the whole
    // dialog, so changing your mind about the address does not cost you the QR.
    protected override bool OnScrimPressed()
    {
        if (!_select.IsOpen && !_methodSelect.IsOpen)
        {
            return false;
        }

        _select.Close();
        _methodSelect.Close();
        return true;
    }

    // The card is NOT a close surface: only the scrim and the close button dismiss the dialog. A click on
    // the card background at most collapses the open option list.
    protected override void OnCardPressed()
    {
        _select.Close();
        _methodSelect.Close();
    }
}
