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

public sealed record HotReloadActivationContext(
    int Generation,
    string ModDirectory,
    string ShadowAssemblyPath);

public sealed record HotReloadShutdownContext(
    string Reason,
    int NewGeneration);
