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
