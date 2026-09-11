using System.Reflection;
using System.Text.Json;
using Godot;

namespace CouchCoop.Mod.HostUi;

internal static class HostLobbyQrOverlayLayoutProvider
{
    private const string ProtocolTypeName = "CouchCoop.Mod.Loader.CouchCoopHotReloadProtocol";
    private const string LayoutMethodName = "GetOverlayLayoutJson";

    public static HostLobbyQrOverlayLayout Current()
    {
        try
        {
            var protocolType = AppDomain.CurrentDomain.GetAssemblies()
                .Select(assembly => assembly.GetType(ProtocolTypeName, throwOnError: false))
                .FirstOrDefault(type => type is not null);
            var method = protocolType?.GetMethod(LayoutMethodName, BindingFlags.Public | BindingFlags.Static);
            var json = method?.Invoke(null, null) as string;
            if (string.IsNullOrWhiteSpace(json))
            {
                return HostLobbyQrOverlayLayout.Default;
            }

            return JsonSerializer.Deserialize<HostLobbyQrOverlayLayout>(json, JsonOptions)
                ?? HostLobbyQrOverlayLayout.Default;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"[couch-coop] host lobby QR overlay layout reload failed: {exception.GetType().Name}: {exception.Message}");
            return HostLobbyQrOverlayLayout.Default;
        }
    }

    private static JsonSerializerOptions JsonOptions { get; } = new(JsonSerializerDefaults.Web);
}

/// <summary>
/// Placement and styling for the lobby's couch-coop UI: the rect of the "Couch Co-Op QR Code"
/// BUTTON in the game's 1920x1080 <c>canvas_items</c> design space, the label scales, and the styling
/// of the dialog card that button opens.
/// The rect is absolute (origin = top-left of the lobby screen), so any anchor position is reachable.
/// </summary>
/// <remarks>
/// <para>
/// The rect keeps the LEFT and TOP of the QR container it replaces (the lobby's lower-left dead space,
/// derived from the live <c>NCharacterSelectScreen</c> node rects: character info panel
/// <c>x 209..909 / y 321..723</c>, ascension strip <c>x 586..1326 / y 738..874</c>, character card row
/// <c>x 619..1302 / y 871..1025</c>, back button <c>x -64..218 / y 710..875</c>, unready button
/// <c>x -244..38 / y 710..875</c>, ready-and-waiting panel <c>x 592..1328 / y 885..1007</c>) but frees
/// the bottom: 1072 -> 868. The old container reserved 340 vertical units for a QR nobody had asked to
/// see, which crowded the character list; a 352x136 button needs only what it occupies, and 352:136
/// also matches <c>event_button.png</c>'s 284:110 aspect so the art is not distorted.
/// </para>
/// <para>
/// The panel/QR fields now describe the DIALOG card, not the lobby overlay — the overlay is gone.
/// </para>
/// <para>
/// <paramref name="QuietZoneModules"/> is the margin this mod adds on top of QRCoder's own output.
/// QRCoder's <c>ModuleMatrix</c> already embeds the spec-mandated 4-module quiet zone (verified
/// against QRCoder 1.6.0: these join URLs produce a 37x37 matrix with exactly four clear rings
/// around a 29x29 version-3 core), so any value above 0 double-pads the code. 0 therefore still
/// ships a compliant 4-module zone while making the payload ~22% larger inside the same extent.
/// (<see cref="QrRasterPlan"/>'s white padding is a different thing and is NOT double-padding: it is
/// sub-module slack on the raster canvas, not extra whole modules in the matrix.)
/// </para>
/// <para>
/// <paramref name="QrDialogExtent"/> is the QR's EXACT on-screen extent, not a budget it fits inside:
/// every code renders at this size (see <see cref="QrDisplayExtent"/>). 592 is what the shipped card's
/// row stack has room for between the secure-toggle row and the URL/notice/close rows, and it is also
/// what the common 37-module code already rendered at under the old whole-number-scale scheme — so
/// nothing in the card moved when the extent became constant.
/// </para>
/// </remarks>
internal sealed record HostLobbyQrOverlayLayout(
    float Left,
    float Top,
    float Right,
    float Bottom,
    float QrDialogExtent,
    int QuietZoneModules,
    float TitleFontScale,
    float UrlFontScale,
    float ButtonFontScale,
    float PanelPadding,
    float PanelCornerRadius,
    float PanelBorderWidth,
    string? PanelColor,
    string? PanelBorderColor)
{
    /// <summary>Godot's default theme font size; every label scale below multiplies this.</summary>
    public const float BaseFontSize = 16f;

    /// <summary>Coarsest module the extent floor is willing to accept: 4 source pixels.</summary>
    public const int MinRasterPixelsPerModule = 4;

    /// <summary>Smallest sane dialog extent: a version-1 (21-module) code at 4 source px per module.</summary>
    public const float MinQrDialogExtent = 21f * MinRasterPixelsPerModule;

    /// <summary>Fallback chrome, matching the browser client's panel language.</summary>
    public const string DefaultPanelColorHtml = "#0e1117f7";

    /// <inheritdoc cref="DefaultPanelColorHtml"/>
    public const string DefaultPanelBorderColorHtml = "#ffffff33";

    public static HostLobbyQrOverlayLayout Default { get; } = new(
        Left: 226f,
        Top: 732f,
        Right: 578f,
        Bottom: 868f,
        QrDialogExtent: 592f,
        QuietZoneModules: 0,
        TitleFontScale: 1.75f,
        UrlFontScale: 1.375f,
        ButtonFontScale: 1.75f,
        PanelPadding: 24f,
        PanelCornerRadius: 16f,
        PanelBorderWidth: 3f,
        PanelColor: DefaultPanelColorHtml,
        PanelBorderColor: DefaultPanelBorderColorHtml);

    // The rect is absolute in design space, so the button anchors to the parent's top-left origin
    // and the offsets carry the full coordinates.
    public float AnchorLeft => 0f;
    public float AnchorTop => 0f;
    public float AnchorRight => 0f;
    public float AnchorBottom => 0f;
    public float OffsetLeft => Left;
    public float OffsetTop => Top;
    public float OffsetRight => Left + ButtonWidth;
    public float OffsetBottom => Top + ButtonHeight;

    public float ButtonWidth => MathF.Max(Right - Left, 1f);
    public float ButtonHeight => MathF.Max(Bottom - Top, 1f);
    public Vector2 ButtonSize => new(ButtonWidth, ButtonHeight);

    public int TitleFontSize => ScaledFontSize(TitleFontScale);
    public int UrlFontSize => ScaledFontSize(UrlFontScale);
    public int ButtonFontSize => ScaledFontSize(ButtonFontScale);

    /// <summary>On-screen QR extent for the dialog, floored at one version-1 code at 4px per module.</summary>
    public float ResolvedQrDialogExtent => MathF.Max(QrDialogExtent, MinQrDialogExtent);

    public float ResolvedPanelPadding => MathF.Max(PanelPadding, 0f);
    public int ResolvedPanelCornerRadius => (int)MathF.Round(Math.Clamp(PanelCornerRadius, 0f, 256f));
    public int ResolvedPanelBorderWidth => (int)MathF.Round(Math.Clamp(PanelBorderWidth, 0f, 64f));
    public Color ResolvedPanelColor => ParseColor(PanelColor, DefaultPanelColorHtml);
    public Color ResolvedPanelBorderColor => ParseColor(PanelBorderColor, DefaultPanelBorderColorHtml);

    /// <summary>
    /// The QR's on-screen extent. A CONSTANT — deliberately not a function of the module count.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This used to be <c>modules * raster * K</c> for the largest whole K that fit, so a longer payload
    /// silently shrank the code on screen: the plain LAN URL encodes to 37 modules and took K=4 (592
    /// units), the secure URL encodes to 41 and fell to K=3 (492). Ticking the "installable link"
    /// checkbox visibly resized the thing the player was aiming a phone at.
    /// </para>
    /// <para>
    /// The whole-number rule that forced that is still honoured — it just moved into the RASTER
    /// (<see cref="QrRasterPlan"/>), where the leftover becomes white quiet-zone padding instead of a
    /// display scale. Because the canvas is <see cref="QrRasterTargetPixels"/> = this extent, one source
    /// pixel is one design unit and each module is a whole number of design units, exactly as before.
    /// </para>
    /// <para>
    /// Everything downstream of the QR in the dialog card (the URL fallback, the notice line) therefore
    /// sits at a fixed offset too, instead of jumping whenever the payload changes length.
    /// </para>
    /// </remarks>
    public float QrDisplayExtent => ResolvedQrDialogExtent;

    /// <summary>
    /// Edge of the raster canvas in SOURCE pixels: one per design unit of <see cref="QrDisplayExtent"/>.
    /// </summary>
    /// <remarks>
    /// 1:1 is what makes the module grid land on whole design units without any display-side scaling, and
    /// it is affordable because <see cref="QrRaster"/> writes a byte buffer rather than calling
    /// <c>Image.SetPixel</c> per pixel. A coarser canvas would be cheaper but would round each module's
    /// size harder, which is precisely the shrink this design removes.
    /// </remarks>
    public int QrRasterTargetPixels => Math.Max(1, (int)MathF.Round(ResolvedQrDialogExtent));

    /// <summary>How a <paramref name="qrModules"/>-module code is packed onto the fixed raster canvas.</summary>
    public QrRasterPlan RasterPlanFor(int qrModules) => QrRasterPlan.For(qrModules, QrRasterTargetPixels);

    private static Color ParseColor(string? html, string fallbackHtml)
        => !string.IsNullOrWhiteSpace(html) && Color.HtmlIsValid(html)
            ? Color.FromHtml(html)
            : Color.FromHtml(fallbackHtml);

    private static int ScaledFontSize(float scale)
        => Math.Clamp((int)MathF.Round(BaseFontSize * scale), 1, 512);
}
