using System.Net.Sockets;

namespace CouchCoop.Mod.Contracts;

public interface ICouchCoopHotGeneration : IAsyncDisposable
{
    string DescribeOverlayLayoutJson();

    Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken);

    Task StopAsync(HotReloadShutdownContext context, CancellationToken cancellationToken);
}

public interface IHotServerHost
{
    object RuntimeHost { get; }

    object? HeadlessManager { get; }

    string StaticRoot { get; }

    string? ResourceCacheRoot { get; }

    bool IsHeadlessClient { get; }

    void Log(string message);
}

// Optional capability so older generation contracts remain loadable.
public interface IHotBrowserDemandHost
{
    Action<int, long> CreateBrowserDemandReporter();
}

// Optional capability. State and arm credentials are read together, using only BCL types.
public interface IHotRendererSwapHost
{
    (string State, string? Reason,
        (string Listen, string Token, string CertificateHash, string RootSize, int StreamVersion)? Snapshot) RendererStatus { get; }

    // Completion follows presentation and visual-suspender restoration, independently of early fallback state.
    bool MirrorRestoreComplete => true;
    bool WantsRenderStream(string pageId);
    void RequestRenderer(string pageId, bool wantsStream, double? aspect);
    void ReleaseRenderer(string pageId);
    IDisposable SubscribeRendererChanged(Action handler);
}

// Optional capability. Route identity belongs to the persistent seat host, across hot generations.
public interface IHotRenderStreamRelayHost
{
    bool SupportsRenderStreamRelay { get; }
    string? RenderStreamSeatRoute { get; }
}

// Optional capability; all arguments are shared BCL types across reload assembly boundaries.
public interface IHotDirectIpHttpsHost
{
    Task<int?> PrepareDirectIpSeatAsync(int port, string address, CancellationToken token);
    Task<int?> EnableDirectIpSeatAsync(string bundleId, string address, string caFingerprint, int hostPort, CancellationToken token);
    Task<bool> RefreshDirectIpSeatMaterialAsync(string bundleId, string address, string caFingerprint, int hostPort, CancellationToken token);
}

public sealed record HotReloadActivationContext(
    int Generation,
    string ModDirectory,
    string ShadowAssemblyPath);

public sealed record HotReloadShutdownContext(
    string Reason,
    int NewGeneration);

// Optional presentation contract; page leases and demand survive hot generation replacement.
public interface IHotPresentationHost
{
    (long Epoch, bool Ready, int Width, int Height) PresentationStatus { get; }
    void ClaimPresentationPage(string pageId, string owner);
    void UpdatePresentationPage(string pageId, string owner, bool watch, bool? stream, double? aspect);
    void ReleasePresentationPage(string pageId, string owner);
    // Older hosts cannot validate a replacement connection's lease; fail closed until reloaded.
    bool IsPresentationPageOwner(string pageId, string owner) => false;
}
