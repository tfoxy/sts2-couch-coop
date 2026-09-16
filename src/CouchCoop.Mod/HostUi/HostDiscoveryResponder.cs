using System.Net;
using System.Net.Sockets;
using CouchCoop.MirrorProtocol.Discovery;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.HostUi;

// M3 WS-T host-discovery responder. Binds a UDP socket on the SAME numeric port the TCP browser server chose
// (port-walk parity: host A owns UDP 13337, a second host on the same machine that took TCP 13338 owns UDP
// 13338 — no bind conflict) and answers each well-formed discovery probe with a UNICAST reply built by
// `replyFactory` (advertised LAN IPv4 + real port + machine name). It NEVER broadcasts and NEVER inspects run
// state: it always answers with the stateless host identity; the join dance does any rejecting.
//
// Bind failure never crashes the host — it logs `host-discovery-unavailable` and leaves discovery off; the
// QR/manual-entry join path is unaffected. Lifecycle is tied 1:1 to the browser server (see
// CouchCoopHostUiServices).
public sealed class HostDiscoveryResponder : IAsyncDisposable
{
    public const string UnavailableCode = "host-discovery-unavailable";

    private readonly Func<HostDiscoveryReply> _replyFactory;
    private readonly Action<string> _log;
    private readonly UdpClient? _udp;
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _loop;

    public HostDiscoveryResponder(int listenPort, Func<HostDiscoveryReply> replyFactory, Action<string>? log = null)
    {
        _replyFactory = replyFactory ?? throw new ArgumentNullException(nameof(replyFactory));
        _log = log ?? CouchCoopLog.Stderr;

        try
        {
            var udp = new UdpClient(AddressFamily.InterNetwork);
            // Set reuse BEFORE Bind, so a duplicate bind of this exact wildcard port is permitted rather than
            // refused. That matters on a fast restart (a dying process still holding the socket) and whenever
            // something else already took UDP <port> while TCP <port> was free — the port-walk only checks TCP,
            // so the two can disagree and discovery is the half that loses.
            //
            // BOTH options are needed, and the comment that used to sit here ("two hosts on one machine never
            // fight over the socket") was Linux-true and macOS-false. SO_REUSEADDR alone permits a duplicate
            // UDP bind on Linux; on BSD it does not, so on macOS the second bind failed and that host simply
            // had no LAN discovery. See SocketReusePort.
            //
            // What it does NOT buy, on either OS: two live responders both receiving the same datagram. Linux
            // hashes a reuseport group and BSD delivers to one socket, so co-located hosts still rely on the
            // port-walk giving them different numeric ports (which it does — UDP follows the TCP port choice).
            udp.Client.ExclusiveAddressUse = false;
            udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            SocketReusePort.TryEnable(udp.Client, "host-discovery", _log);
            udp.Client.Bind(new IPEndPoint(IPAddress.Any, listenPort));
            _udp = udp;
        }
        catch (SocketException exception)
        {
            _log($"host-ui diagnostic code={UnavailableCode} detail={exception.SocketErrorCode}");
            _udp = null;
        }

        _loop = _udp is null ? Task.CompletedTask : Task.Run(() => ReceiveLoopAsync(_cts.Token));
    }

    // The bound UDP port (0 when discovery is unavailable). Used by tests binding on an ephemeral port.
    public int Port => _udp?.Client.LocalEndPoint is IPEndPoint endPoint ? endPoint.Port : 0;

    public bool IsListening => _udp is not null;

    private async Task ReceiveLoopAsync(CancellationToken token)
    {
        var udp = _udp!;
        while (!token.IsCancellationRequested)
        {
            UdpReceiveResult received;
            try
            {
                received = await udp.ReceiveAsync(token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (SocketException)
            {
                // A transient receive error (e.g. an ICMP port-unreachable from a prior send) must not kill the loop.
                continue;
            }

            if (!HostDiscovery.TryDecodeProbe(received.Buffer))
            {
                continue;
            }

            try
            {
                var reply = HostDiscovery.EncodeReply(_replyFactory());
                await udp.SendAsync(reply, reply.Length, received.RemoteEndPoint).ConfigureAwait(false);
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (SocketException)
            {
                // Best-effort unicast reply; a send failure to one prober never affects the others.
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            _cts.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }

        _udp?.Dispose();

        try
        {
            await _loop.ConfigureAwait(false);
        }
        catch
        {
            // The loop swallows its own shutdown exceptions; guard here against any race on dispose.
        }

        _cts.Dispose();
    }
}
