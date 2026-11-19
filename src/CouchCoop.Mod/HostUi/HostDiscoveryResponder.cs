using CouchCoop.MirrorProtocol.Discovery;

namespace CouchCoop.Mod.HostUi;

// Answers well-formed discovery probes with the stateless host identity. Discovery never inspects run
// state or broadcasts: the join dance does any rejecting. Lifecycle follows the browser server.
public sealed class HostDiscoveryResponder : IAsyncDisposable
{
    public const string UnavailableCode = "host-discovery-unavailable";

    private readonly Func<HostDiscoveryReply> _replyFactory;

    public HostDiscoveryResponder(int listenPort, Func<HostDiscoveryReply> replyFactory, Action<string>? log = null)
    {
        _replyFactory = replyFactory ?? throw new ArgumentNullException(nameof(replyFactory));
        UdpSocket = new BrowserPortUdpSocket(listenPort, CreateReply, log);
    }

    public BrowserPortUdpSocket UdpSocket { get; }
    public int Port => UdpSocket.Port;
    public bool IsListening => UdpSocket.IsListening;

    private byte[]? CreateReply(ReadOnlyMemory<byte> datagram)
        => HostDiscovery.TryDecodeProbe(datagram.Span) ? HostDiscovery.EncodeReply(_replyFactory()) : null;

    public ValueTask DisposeAsync() => UdpSocket.DisposeAsync();
}
