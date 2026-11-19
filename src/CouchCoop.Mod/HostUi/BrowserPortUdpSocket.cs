using System.Net;
using System.Net.Sockets;
using CouchCoop.Mod.Server.LanRtc;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.HostUi;

// Shares the TCP browser listener's numeric port. Discovery and STUN/DTLS use the same UDP bind;
// a missing RTC sink simply drops RTC traffic. Receive is event-driven and sends need no receive lock.
public sealed class BrowserPortUdpSocket : IAsyncDisposable
{
    private readonly Func<ReadOnlyMemory<byte>, byte[]?> _discoveryReply;
    private readonly Action<string> _log;
    private readonly Socket? _socket;
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _loop;
    private ILanRtcDatagramSink? _sink;
    private int _disposed;

    public BrowserPortUdpSocket(int listenPort, Func<ReadOnlyMemory<byte>, byte[]?> discoveryReply,
        Action<string>? log = null, IPAddress? listenAddress = null)
    {
        _discoveryReply = discoveryReply ?? throw new ArgumentNullException(nameof(discoveryReply));
        _log = log ?? CouchCoopLog.Stderr;
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        try
        {
            // Set BOTH reuse options BEFORE bind: BSD requires SO_REUSEPORT for a duplicate wildcard bind.
            // Reuse permits fast restarts and UDP/TCP occupancy disagreements; it delivers to one socket,
            // not every socket. Co-located hosts still rely on UDP following TCP's port-walk choice.
            socket.ExclusiveAddressUse = false;
            socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            SocketReusePort.TryEnable(socket, "host-discovery", _log);
            socket.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.PacketInformation, true);
            socket.Bind(new IPEndPoint(listenAddress ?? IPAddress.Any, listenPort));
            _socket = socket;
            Port = ((IPEndPoint)socket.LocalEndPoint!).Port;
        }
        catch (SocketException exception)
        {
            socket.Dispose();
            _log($"host-ui diagnostic code={HostDiscoveryResponder.UnavailableCode} detail={exception.SocketErrorCode}");
        }
        catch
        {
            socket.Dispose();
            throw;
        }

        _loop = _socket is null ? Task.CompletedTask : Task.Run(() => ReceiveLoopAsync(_cts.Token));
    }

    public int Port { get; }
    public bool IsListening => _socket is not null && Volatile.Read(ref _disposed) == 0;

    // Replacing a sink is atomic. Unregister only removes that registration, never a newer replacement.
    // A callback already in progress may finish after unregister returns.
    public void RegisterSink(ILanRtcDatagramSink sink)
    {
        ArgumentNullException.ThrowIfNull(sink);
        Interlocked.Exchange(ref _sink, sink);
    }

    public void UnregisterSink(ILanRtcDatagramSink sink)
    {
        ArgumentNullException.ThrowIfNull(sink);
        Interlocked.CompareExchange(ref _sink, null, sink);
    }

    // Safe to call from the RTC thread, including concurrently with receive. Socket errors are the caller's
    // to handle; no lock or queued send on the receive loop can delay the next incoming datagram.
    public void SendTo(IPEndPoint destination, ReadOnlySpan<byte> datagram)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        if (_socket is null) throw new InvalidOperationException("The browser-port UDP socket is unavailable.");
        _socket.SendTo(datagram, SocketFlags.None, destination);
    }

    private async Task ReceiveLoopAsync(CancellationToken token)
    {
        var socket = _socket!;
        var buffer = new byte[65535];
        while (!token.IsCancellationRequested)
        {
            SocketReceiveMessageFromResult received;
            try
            {
                received = await socket.ReceiveMessageFromAsync(buffer.AsMemory(), SocketFlags.None,
                    new IPEndPoint(IPAddress.Any, 0), token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { break; }
            catch (ObjectDisposedException) { break; }
            catch (SocketException)
            {
                // A transient receive error (e.g. ICMP port-unreachable from a prior send) must not kill the loop.
                continue;
            }

            if (received.ReceivedBytes == 0) continue;
            var remote = (IPEndPoint)received.RemoteEndPoint;
            var datagram = buffer.AsMemory(0, received.ReceivedBytes);
            if (buffer[0] == 0x7B)
            {
                var reply = _discoveryReply(datagram);
                if (reply is null) continue;
                try
                {
                    await socket.SendToAsync(reply.AsMemory(), SocketFlags.None, remote, token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { break; }
                catch (ObjectDisposedException) { break; }
                catch (SocketException)
                {
                    // Best-effort unicast reply; a failed send to one prober never affects the others.
                }
            }
            else if ((buffer[0] <= 3 || buffer[0] is >= 20 and <= 63) && IsRtcSource(remote.Address))
            {
                try
                {
                    Volatile.Read(ref _sink)?.ReceiveDatagram(remote, received.PacketInformation.Address, datagram.Span);
                }
                catch (Exception exception) when (exception is not (OutOfMemoryException or StackOverflowException or AccessViolationException))
                {
                    // A pluggable sink must not take down discovery or the rest of the receive loop.
                    _log($"host-ui diagnostic code=browser-port-udp-sink-failed detail={exception.GetType().Name}");
                }
            }
        }
    }

    internal static bool IsRtcSource(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address)
            || address.Equals(IPAddress.Any)) return false;
        var first = address.GetAddressBytes()[0];
        return first is < 224 or > 239;
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _cts.Cancel();
            _socket?.Dispose();
        }
        try
        {
            await _loop.ConfigureAwait(false);
        }
        catch
        {
            // Preserve best-effort teardown even if an unexpected failure faulted the receive loop.
        }
        finally
        {
            // Keep the CTS until the receive loop has relinquished its cancellation registration.
            _cts.Dispose();
        }
    }
}
