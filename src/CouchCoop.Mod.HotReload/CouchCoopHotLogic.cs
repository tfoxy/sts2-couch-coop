using System.Net.Sockets;
using System.Text.Json;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.HotReload;

public static class CouchCoopHotLogic
{
    public static ICouchCoopHotGeneration CreateGeneration(
        IHotServerHost host,
        HotReloadActivationContext context)
        => new CouchCoopHotServerGeneration(host, context);

    /// <summary>
    /// Hot-reloadable placement for the lobby's couch-coop UI: the rect of the "Show Couch Co-Op QR
    /// Code" BUTTON, absolute in the game's 1920x1080 <c>canvas_items</c> design space (origin =
    /// top-left), plus the label scales and the dialog card's styling. Font scales multiply Godot's
    /// default 16px theme size.
    /// </summary>
    /// <remarks>
    /// ONE OF FOUR COPIES of this contract. Must stay in sync with
    /// <c>HostLobbyQrOverlayLayout.Default</c>, <c>CouchCoopHotReloadProtocol.DefaultOverlayLayoutJson</c>
    /// and <c>CouchCoopHotReloadProtocol.ValidateOverlayLayout</c>. Drift between them is caught by
    /// <c>CouchCoopQrLayoutContractTests</c>, which is the only reason four copies is survivable —
    /// add a field here and that test fails until every copy has it.
    /// <para>
    /// The rect keeps the old QR container's left/top and frees its bottom (1072 -> 868) so the
    /// character list is no longer crowded. <c>quietZoneModules: 0</c> is deliberate — QRCoder already
    /// embeds the spec's 4-module quiet zone, so anything higher double-pads the code.
    /// </para>
    /// </remarks>
    public static string DescribeOverlayLayoutJson()
        => JsonSerializer.Serialize(new CouchCoopOverlayLayout(
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
            PanelColor: "#0e1117f7",
            PanelBorderColor: "#ffffff33"),
            JsonOptions);

    private static JsonSerializerOptions JsonOptions { get; } = new(JsonSerializerDefaults.Web);
}

public sealed class CouchCoopHotServerGeneration : ICouchCoopHotGeneration
{
    private readonly CouchCoopBrowserServer _server;

    public CouchCoopHotServerGeneration(IHotServerHost host, HotReloadActivationContext context)
    {
        ArgumentNullException.ThrowIfNull(host);
        ArgumentNullException.ThrowIfNull(context);

        var runtime = host.RuntimeHost as CouchCoopRuntimeHost
            ?? throw new InvalidOperationException($"Hot server host runtime must be {typeof(CouchCoopRuntimeHost).FullName}.");
        var headlessManager = host.HeadlessManager as HeadlessClientManager;
        _server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(host.StaticRoot),
            new CachedSpirectlAssetHttpAdapter(new SpirectlAssetHttpAdapter(runtime.Assets, runtime), new SpirectlAssetBinaryCache()),
            new BrowserStateEnvelopeFactory(runtime),
            resourceCacheRoot: host.ResourceCacheRoot,
            headlessManager: headlessManager,
            isHeadlessClient: host.IsHeadlessClient,
            log: host.Log,
            admission: (host as HotReloadableBrowserServerHost)?.Admission);
    }

    public string DescribeOverlayLayoutJson() => CouchCoopHotLogic.DescribeOverlayLayoutJson();

    public Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken)
        => _server.HandleClientAsync(client, cancellationToken);

    public Task StopAsync(HotReloadShutdownContext context, CancellationToken cancellationToken)
        => _server.StopGenerationAsync(context.Reason, cancellationToken);

    public async ValueTask DisposeAsync()
    {
        await _server.StopGenerationAsync("server-generation-dispose").ConfigureAwait(false);
    }
}

public sealed record CouchCoopOverlayLayout(
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
    string PanelColor,
    string PanelBorderColor);
