using System.Net;
using System.Net.Sockets;
using CouchCoop.Mod.HostUi;
using CouchCoop.MirrorProtocol.Discovery;

// M3 WS-T: real-UDP loopback round-trip against the server responder. Binds the responder on an ephemeral port
// (127.0.0.1), fires a probe from a throwaway UdpClient, and asserts one unicast reply decoding to the expected
// connect-ready host:port. Assert-or-throw, matching the repo's custom Exe runner.
internal static class HostDiscoveryResponderTests
{
    public static async Task RunAsync()
    {
        await RepliesToProbe();
        await IgnoresNonProbeTraffic();
        BindFailureIsSurvivable();
        await ADuplicateBindOfTheSamePortIsPermitted();
        Console.WriteLine("HostDiscoveryResponderTests: ok");
    }

    /// <summary>
    /// WS4 macOS: a second responder on the SAME wildcard port must bind rather than be refused.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This socket used to set <c>SO_REUSEADDR</c> only, under a comment claiming two hosts on one machine
    /// "never fight over the socket". That is Linux-true and BSD-false: on macOS a duplicate bind of the
    /// identical <c>0.0.0.0:port</c> needs <c>SO_REUSEPORT</c> on every socket in the group, so the second bind
    /// failed and that host silently had no LAN discovery at all. The case that actually reaches a player is
    /// not two hosts — the port-walk gives them different numbers — but a restart racing a dying process, and
    /// anything holding UDP &lt;port&gt; while TCP &lt;port&gt; was free, since only TCP is walked.
    /// </para>
    /// <para>
    /// What this does NOT assert is that both sockets receive the datagram: Linux hashes a reuseport group and
    /// BSD picks one. Exactly one reply is the correct expectation, and it is what a prober needs.
    /// </para>
    /// </remarks>
    private static async Task ADuplicateBindOfTheSamePortIsPermitted()
    {
        if (!SocketReusePort.IsSupportedOnThisPlatform)
        {
            // Windows has no SO_REUSEPORT; SO_REUSEADDR already carries the sharing semantics there.
            return;
        }

        var reply = new HostDiscoveryReply("127.0.0.1", 13337, null, "dup-bind", HostDiscovery.ProtocolVersion);
        await using var first = new HostDiscoveryResponder(0, () => reply, _ => { });
        Expect(first.IsListening, "the first responder binds an ephemeral port");
        var port = first.Port;

        var logged = new List<string>();
        await using var second = new HostDiscoveryResponder(port, () => reply, logged.Add);
        Expect(second.IsListening,
            $"a second responder binds the SAME port ({port}) instead of logging {HostDiscoveryResponder.UnavailableCode}");
        Expect(!logged.Exists(line => line.Contains(HostDiscoveryResponder.UnavailableCode, StringComparison.Ordinal)),
            "…and reports no bind failure");

        // Whichever socket the stack hands it to, a probe is still answered exactly once.
        using var client = new UdpClient(AddressFamily.InterNetwork);
        client.Client.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        var probe = HostDiscovery.EncodeProbe();
        await client.SendAsync(probe, probe.Length, new IPEndPoint(IPAddress.Loopback, port));

        var buffer = await ReceiveWithTimeout(client, TimeSpan.FromSeconds(3));
        Expect(buffer is not null && HostDiscovery.TryDecodeReply(buffer!)?.Name == "dup-bind",
            "one of the two co-bound responders answers the probe");
        Expect(await ReceiveWithTimeout(client, TimeSpan.FromMilliseconds(400)) is null,
            "and only one of them does — a reuseport group delivers a datagram once");
    }

    private static async Task RepliesToProbe()
    {
        var reply = new HostDiscoveryReply("127.0.0.1", 13337, "http://127.0.0.1:13337/", "test-host", HostDiscovery.ProtocolVersion);
        await using var responder = new HostDiscoveryResponder(0, () => reply, _ => { });
        Expect(responder.IsListening, "responder binds a UDP socket");
        var port = responder.Port;
        Expect(port > 0, "responder exposes its ephemeral port");

        using var client = new UdpClient(AddressFamily.InterNetwork);
        client.Client.Bind(new IPEndPoint(IPAddress.Loopback, 0));

        var probe = HostDiscovery.EncodeProbe();
        await client.SendAsync(probe, probe.Length, new IPEndPoint(IPAddress.Loopback, port));

        var buffer = await ReceiveWithTimeout(client, TimeSpan.FromSeconds(3));
        Expect(buffer is not null, "responder answered the probe within the timeout");

        var decoded = HostDiscovery.TryDecodeReply(buffer!);
        Expect(decoded is not null, "the reply decodes");
        Expect(decoded!.Host == "127.0.0.1", "reply carries the advertised host");
        Expect(decoded.Port == 13337, "reply carries the connect-ready port");
        Expect(decoded.Name == "test-host", "reply carries the host name");
        Expect(decoded.Url == "http://127.0.0.1:13337/", "reply carries the join url");
    }

    private static async Task IgnoresNonProbeTraffic()
    {
        var reply = new HostDiscoveryReply("127.0.0.1", 13337, null, "ignore-test", HostDiscovery.ProtocolVersion);
        await using var responder = new HostDiscoveryResponder(0, () => reply, _ => { });
        Expect(responder.IsListening, "responder binds");
        var port = responder.Port;

        using var client = new UdpClient(AddressFamily.InterNetwork);
        client.Client.Bind(new IPEndPoint(IPAddress.Loopback, 0));

        // Junk that is not a valid probe must NOT elicit a reply.
        var junk = System.Text.Encoding.UTF8.GetBytes("hello, this is not a probe");
        await client.SendAsync(junk, junk.Length, new IPEndPoint(IPAddress.Loopback, port));

        var buffer = await ReceiveWithTimeout(client, TimeSpan.FromMilliseconds(400));
        Expect(buffer is null, "responder stays silent for non-probe traffic");

        // ...but a real probe still gets answered afterwards (the loop survived the junk datagram).
        var probe = HostDiscovery.EncodeProbe();
        await client.SendAsync(probe, probe.Length, new IPEndPoint(IPAddress.Loopback, port));
        var replyBuffer = await ReceiveWithTimeout(client, TimeSpan.FromSeconds(3));
        Expect(replyBuffer is not null && HostDiscovery.TryDecodeReply(replyBuffer!) is not null,
            "responder still answers a valid probe after ignoring junk");
    }

    private static void BindFailureIsSurvivable()
    {
        // Two responders on the SAME explicit non-zero port: with ReuseAddress both may bind, but even if the second
        // fails it must construct cleanly (IsListening=false) and never throw — the host stays up.
        using var hog = new UdpClient(AddressFamily.InterNetwork);
        hog.Client.ExclusiveAddressUse = true;
        hog.Client.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        var takenPort = ((IPEndPoint)hog.Client.LocalEndPoint!).Port;

        var reply = new HostDiscoveryReply("127.0.0.1", takenPort, null, "bind-test", HostDiscovery.ProtocolVersion);
        var logged = new List<string>();
        var responder = new HostDiscoveryResponder(takenPort, () => reply, logged.Add);
        // Whether the bind succeeds or logs unavailable is OS-dependent; the invariant is: no throw, and if it did
        // fail, it logged the diagnostic code and reports not-listening.
        if (!responder.IsListening)
        {
            Expect(logged.Exists(m => m.Contains(HostDiscoveryResponder.UnavailableCode)), "bind failure logs the diagnostic code");
        }

        responder.DisposeAsync().AsTask().GetAwaiter().GetResult();
    }

    private static async Task<byte[]?> ReceiveWithTimeout(UdpClient client, TimeSpan timeout)
    {
        // Cancel the receive on timeout (rather than abandoning it) so a later ReceiveAsync on the same client
        // isn't shadowed by a still-pending receive that would swallow the next datagram.
        using var cts = new CancellationTokenSource(timeout);
        try
        {
            var result = await client.ReceiveAsync(cts.Token);
            return result.Buffer;
        }
        catch (OperationCanceledException)
        {
            return null;
        }
    }

    private static void Expect(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"HostDiscoveryResponderTests assertion failed: {label}");
        }
    }
}
