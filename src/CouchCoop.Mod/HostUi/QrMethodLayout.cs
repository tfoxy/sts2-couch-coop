namespace CouchCoop.Mod.HostUi;

/// <summary>One sizing decision shared by the QR rectangle, raster canvas, and cache.</summary>
internal readonly record struct QrMethodLayout(float Extent, float SetupRowHeight, int QuietZoneModules)
{
    public const float DirectIpSetupRowHeight = 88f;

    public static QrMethodLayout For(HostLobbyQrOverlayLayout layout, string method)
    {
        var setupHeight = method == "direct-https" ? DirectIpSetupRowHeight : 0f;
        return new(MathF.Max(HostLobbyQrOverlayLayout.MinQrDialogExtent,
            layout.ResolvedQrDialogExtent - setupHeight), setupHeight, layout.QuietZoneModules);
    }

    public QrRasterPlan RasterPlanFor(int modules) => QrRasterPlan.For(modules, (int)MathF.Round(Extent));
    public string CacheKeyFor(Uri uri) => FormattableString.Invariant($"{uri}|quiet={QuietZoneModules}|extent={Extent}");
}
