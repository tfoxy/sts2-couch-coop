using System.Collections.Concurrent;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Threading.Channels;
using CouchCoop.MirrorProtocol.Discovery;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Server.LanRtc;

internal static class BrowserPortUdpSocketTests
{
    private static readonly HostDiscoveryReply Reply = new("127.0.0.1", 13337, null, "shared-udp", HostDiscovery.ProtocolVersion);

    public static async Task RunAsync()
    {
        await LoopbackDiscoveryAndSourceFilter();
        await ConcurrentSendToDelivers();
        await DisposeStopsPendingReceive();
        await DisposeSwallowsLoopFault();
        SourceAddressRules();
        var lan = NetworkInterface.GetAllNetworkInterfaces()
            .Where(adapter => adapter.OperationalStatus == OperationalStatus.Up)
            .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses)
            .Select(entry => entry.Address)
            .FirstOrDefault(BrowserPortUdpSocket.IsRtcSource);
        if (lan is null)
        {
            Console.WriteLine("BrowserPortUdpSocketTests: 5 passed, 5 skipped (no non-loopback IPv4 address)");
            return;
        }

        await RoutesRtcWithDestination(lan, IPAddress.Any, lan);
        await RoutesRtcWithDestination(lan, IPAddress.Loopback, IPAddress.Loopback);
        await DropsOtherFirstBytes(lan);
        await SinkRegistration(lan);
        await ThrowingSinkDoesNotStopDiscovery(lan);
        Console.WriteLine("BrowserPortUdpSocketTests: 10 passed, 0 skipped");
    }

    private static BrowserPortUdpSocket CreateOwner(IPAddress? bind = null)
        => new(0, datagram => HostDiscovery.TryDecodeProbe(datagram.Span) ? HostDiscovery.EncodeReply(Reply) : null,
            Console.WriteLine, bind);

    private static UdpClient CreateClient(IPAddress address)
    {
        var client = new UdpClient(AddressFamily.InterNetwork);
        client.Client.Bind(new IPEndPoint(address, 0));
        return client;
    }

    private static async Task LoopbackDiscoveryAndSourceFilter()
    {
        await using var owner = CreateOwner(IPAddress.Loopback);
        Expect(owner.IsListening, "loopback socket binds with packet-info enabled");
        using var client = CreateClient(IPAddress.Loopback);
        var sink = new FakeSink();
        owner.RegisterSink(sink);
        var destination = new IPEndPoint(IPAddress.Loopback, owner.Port);
        await client.SendAsync(new byte[] { 0x00, 0x01, 0, 0 }, destination);
        await client.SendAsync(new byte[] { 0x16, 0xFE, 0xFD }, destination);
        await Probe(client, destination);
        Expect(!sink.HasDatagram, "loopback-source STUN and DTLS are dropped, while discovery is answered");
    }

    private static async Task RoutesRtcWithDestination(IPAddress source, IPAddress bind, IPAddress destinationAddress)
    {
        await using var owner = CreateOwner(bind);
        Expect(owner.IsListening, $"socket binds on {bind} with packet-info and reuse enabled");
        using var client = CreateClient(source);
        var remote = (IPEndPoint)client.Client.LocalEndPoint!;
        var sink = new FakeSink();
        owner.RegisterSink(sink);
        var destination = new IPEndPoint(destinationAddress, owner.Port);
        foreach (var first in new byte[] { 0, 1, 2, 3, 20, 0x16, 63 })
        {
            var payload = new byte[] { first, 0x01, 0xFE, 0xFD };
            await client.SendAsync(payload, destination);
            var received = await sink.Receive();
            Expect(received.Remote.Equals(remote), "sink gets the sender's real address and port");
            Expect(received.LocalDestination.Equals(destinationAddress), "sink gets the packet's destination, not the wildcard bind");
            Expect(received.Payload.AsSpan().SequenceEqual(payload), "sink gets the complete STUN/DTLS payload");
        }
        await Probe(client, destination);
        Expect(!sink.HasDatagram, "discovery is kept out of the RTC sink");
    }

    private static async Task DropsOtherFirstBytes(IPAddress lan)
    {
        await using var owner = CreateOwner();
        using var client = CreateClient(lan);
        var sink = new FakeSink();
        owner.RegisterSink(sink);
        var destination = new IPEndPoint(lan, owner.Port);
        await client.SendAsync(ReadOnlyMemory<byte>.Empty, destination);
        for (var first = 4; first <= byte.MaxValue; first++)
        {
            if (first is >= 20 and <= 63) continue;
            // Includes an invalid discovery JSON packet (0x7B); none may reach the sink.
            await client.SendAsync(new byte[] { (byte)first, 0xFF }, destination);
        }
        await Probe(client, destination);
        Expect(!sink.HasDatagram, "all unassigned first bytes, empty and invalid discovery datagrams are dropped");
    }

    private static async Task SinkRegistration(IPAddress lan)
    {
        await using var owner = CreateOwner();
        using var client = CreateClient(lan);
        var destination = new IPEndPoint(lan, owner.Port);
        byte[] payload = [0, 1, 0, 0];
        // No sink registered: traffic is discarded and the receive loop stays available for discovery.
        await client.SendAsync(payload, destination);
        await Probe(client, destination);

        var first = new FakeSink();
        var replacement = new FakeSink();
        owner.RegisterSink(first);
        owner.RegisterSink(replacement);
        owner.UnregisterSink(first);
        await client.SendAsync(payload, destination);
        await replacement.Receive();
        Expect(!first.HasDatagram, "unregistering an old sink preserves its replacement");

        owner.UnregisterSink(replacement);
        await client.SendAsync(payload, destination);
        await Probe(client, destination);
        Expect(!replacement.HasDatagram, "unregistered sink receives nothing");
        owner.RegisterSink(first);
        await client.SendAsync(payload, destination);
        await first.Receive();
    }

    private static async Task ConcurrentSendToDelivers()
    {
        await using var owner = CreateOwner(IPAddress.Loopback);
        using var client = CreateClient(IPAddress.Loopback);
        var destination = (IPEndPoint)client.Client.LocalEndPoint!;
        await Task.WhenAll(Enumerable.Range(0, 16).Select(value => Task.Run(() => owner.SendTo(destination, new byte[] { (byte)value }))));
        var seen = new HashSet<byte>();
        for (var i = 0; i < 16; i++)
        {
            var received = await Receive(client);
            Expect(received.RemoteEndPoint.Port == owner.Port, "SendTo uses the shared bound port");
            Expect(received.Buffer.Length == 1 && seen.Add(received.Buffer[0]), "concurrent sends deliver distinct payloads");
        }
        await Probe(client, new IPEndPoint(IPAddress.Loopback, owner.Port));
    }

    private static async Task ThrowingSinkDoesNotStopDiscovery(IPAddress lan)
    {
        var logged = new ConcurrentQueue<string>();
        await using var owner = new BrowserPortUdpSocket(0,
            datagram => HostDiscovery.TryDecodeProbe(datagram.Span) ? HostDiscovery.EncodeReply(Reply) : null,
            logged.Enqueue);
        using var client = CreateClient(lan);
        var destination = new IPEndPoint(lan, owner.Port);
        owner.RegisterSink(new ThrowingSink());
        await client.SendAsync(new byte[] { 0, 1, 0, 0 }, destination);
        await Probe(client, destination);
        Expect(logged.Any(diagnostic => diagnostic.Contains("browser-port-udp-sink-failed", StringComparison.Ordinal)
            && diagnostic.Contains(nameof(InvalidOperationException), StringComparison.Ordinal)),
            "sink failure logs its diagnostic code and exception type");

        var replacement = new FakeSink();
        owner.RegisterSink(replacement);
        await client.SendAsync(new byte[] { 0, 1, 0, 0 }, destination);
        await replacement.Receive();
        await owner.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(3));
    }

    private static async Task DisposeSwallowsLoopFault()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var owner = new BrowserPortUdpSocket(0, _ =>
        {
            entered.TrySetResult();
            throw new InvalidOperationException("Discovery reply factory failed.");
        }, _ => { }, IPAddress.Loopback);
        using var client = CreateClient(IPAddress.Loopback);
        await client.SendAsync(HostDiscovery.EncodeProbe(), new IPEndPoint(IPAddress.Loopback, owner.Port));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        await owner.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(3));
        Expect(!owner.IsListening, "disposal succeeds even when the receive loop has faulted");
    }

    private static async Task DisposeStopsPendingReceive()
    {
        var owner = CreateOwner(IPAddress.Loopback);
        using var client = CreateClient(IPAddress.Loopback);
        var destination = new IPEndPoint(IPAddress.Loopback, owner.Port);
        await Probe(client, destination);
        await owner.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(3));
        await owner.DisposeAsync();
        Expect(!owner.IsListening, "disposed owner is no longer listening");
        using var rebound = CreateClient(IPAddress.Loopback);
        using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        socket.ExclusiveAddressUse = true;
        socket.Bind(destination);
        try
        {
            owner.SendTo((IPEndPoint)rebound.Client.LocalEndPoint!, new byte[] { 0 });
            throw new Exception("SendTo after disposal should throw");
        }
        catch (ObjectDisposedException) { }
    }

    private static void SourceAddressRules()
    {
        foreach (var address in new[] { "0.0.0.0", "127.0.0.1", "127.9.8.7", "224.0.0.1", "239.255.255.255", "::", "::1" })
            Expect(!BrowserPortUdpSocket.IsRtcSource(IPAddress.Parse(address)), $"RTC source {address} is rejected");
        foreach (var address in new[] { "192.168.1.2", "10.0.0.1", "223.255.255.255", "240.0.0.1" })
            Expect(BrowserPortUdpSocket.IsRtcSource(IPAddress.Parse(address)), $"RTC source {address} is accepted");
    }

    // A valid reply is also a receive-loop barrier after earlier packets from this same socket.
    private static async Task Probe(UdpClient client, IPEndPoint destination)
    {
        await client.SendAsync(HostDiscovery.EncodeProbe(), destination);
        var reply = await Receive(client);
        Expect(HostDiscovery.TryDecodeReply(reply.Buffer) == Reply, "discovery reply is unchanged");
    }

    private static async Task<UdpReceiveResult> Receive(UdpClient client)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        return await client.ReceiveAsync(timeout.Token);
    }

    private static void Expect(bool condition, string label)
    {
        if (!condition) throw new Exception($"BrowserPortUdpSocketTests assertion failed: {label}");
    }

    private sealed record Datagram(IPEndPoint Remote, IPAddress LocalDestination, byte[] Payload);

    private sealed class ThrowingSink : ILanRtcDatagramSink
    {
        public void ReceiveDatagram(IPEndPoint remote, IPAddress localDestination, ReadOnlySpan<byte> datagram)
            => throw new InvalidOperationException("RTC sink failed.");
    }

    private sealed class FakeSink : ILanRtcDatagramSink
    {
        private readonly Channel<Datagram> _received = Channel.CreateUnbounded<Datagram>();
        public bool HasDatagram => _received.Reader.TryPeek(out _);
        public void ReceiveDatagram(IPEndPoint remote, IPAddress localDestination, ReadOnlySpan<byte> datagram)
            => _received.Writer.TryWrite(new Datagram(remote, localDestination, datagram.ToArray()));
        public async Task<Datagram> Receive()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            return await _received.Reader.ReadAsync(timeout.Token);
        }
    }
}
