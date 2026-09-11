using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// A minimal in-process RFC 6762 (mDNS) responder that publishes ONE name — this machine's
/// <c>&lt;host&gt;.local</c> — as an A record, so the address printed on the lobby QR actually resolves
/// on phones.
/// </summary>
/// <remarks>
/// <para>
/// WHY THIS EXISTS. The QR dialog defaults to <c>http://&lt;name&gt;.local:port/</c>, and
/// <see cref="QrHostOptions.ToMdnsHostName"/> used to only PREDICT the name an OS responder publishes.
/// That prediction holds on Linux (avahi) and macOS (Bonjour) and fails on Windows in three separate
/// ways: many Windows machines have no <c>.local</c> responder at all (Bonjour ships with iTunes and
/// friends; Windows' own name advertising is LLMNR/NetBIOS, which phones do not speak, and its
/// built-in mDNS behaviour is version/profile dependent); <see cref="Environment.MachineName"/> is the
/// NetBIOS name, uppercased and truncated to 15 characters, so even a working responder can publish a
/// DIFFERENT name than the QR shows; and inbound UDP 5353 is commonly blocked by the firewall profile.
/// Publishing the name ourselves fixes the first two outright — we answer for exactly the string the
/// dialog renders, so QR text and published name are byte-identical by construction.
/// </para>
/// <para>
/// COEXISTENCE. On Linux avahi already owns port 5353 and already publishes the same name. That is
/// explicitly legal (RFC 6762 §8.2, "simultaneous probe tiebreaking" applies to CONFLICTING data): two
/// responders publishing IDENTICAL rdata for a name are not in conflict, so no probing and no conflict
/// protocol is needed here, and avahi will not rename the host. The name we answer for is derived from
/// this machine's own hostname and the address is this machine's own interface address, so we can
/// never publish a different answer for a name someone else owns. <c>SO_REUSEPORT</c> is what lets us
/// share the port with avahi on Linux.
/// </para>
/// <para>
/// SAFETY. Everything is best-effort. A bind refusal, a missing multicast route, a hostile firewall or
/// a mid-run NIC teardown logs once and leaves the responder inert — it must never take down the host
/// UI or the browser server, which are what actually serve the game. Set
/// <c>COUCHCOOP_MDNS_RESPONDER=0</c> to disable it entirely.
/// </para>
/// <para>
/// SCOPE. IPv4 A records only (the join URL, QR and discovery reply are all IPv4-shaped), no PTR/SRV/TXT
/// service advertisement, no known-answer suppression, no probing. See <see cref="MdnsWire"/> for the
/// wire format.
/// </para>
/// </remarks>
public sealed class MdnsResponder : IAsyncDisposable
{
    /// <summary>Kill-switch. Set to <c>0</c>/<c>false</c>/<c>off</c>/<c>no</c> to never open the socket.</summary>
    public const string EnabledEnvironmentVariable = "COUCHCOOP_MDNS_RESPONDER";

    /// <summary>Logged once when the responder cannot run; the host is unaffected.</summary>
    public const string UnavailableCode = "mdns-responder-unavailable";

    /// <summary>Logged once when the kill-switch turned the responder off.</summary>
    public const string DisabledCode = "mdns-responder-disabled";

    /// <summary>The mDNS port. Fixed by the spec — there is no port-walk fallback for multicast DNS.</summary>
    public const int MdnsPort = 5353;

    /// <summary>TTL published for the A record (RFC 6762 §10 recommends 120s for host records).</summary>
    public const uint RecordTtlSeconds = 120;

    // RFC 6762 §6.7: a legacy unicast response must carry a TTL of at most 10 seconds, because the
    // querier is a plain DNS resolver that knows nothing about goodbye packets or cache-flush.
    private const uint LegacyTtlSeconds = 10;

    private const int AnnouncementCount = 2;
    private static readonly TimeSpan AnnouncementInterval = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan InterfaceRefreshInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan GoodbyeTimeout = TimeSpan.FromMilliseconds(500);

    // Cap on consecutive receive failures before we give up. A permanently broken socket that keeps
    // failing instantly would otherwise spin a core for the rest of the session.
    private const int MaxConsecutiveReceiveFailures = 32;

    /// <summary>The IPv4 mDNS group address.</summary>
    public static readonly IPAddress MulticastGroup = new([224, 0, 0, 251]);

    private static readonly IPEndPoint MulticastEndPoint = new(MulticastGroup, MdnsPort);

    private readonly Action<string> _log;
    private readonly string? _hostName;
    private readonly IPAddress? _fallbackAddress;
    private readonly Socket? _socket;
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly Task _receiveLoop = Task.CompletedTask;
    private readonly Task _maintenanceLoop = Task.CompletedTask;

    // Interface index -> the IPv4 we answer with for queries that arrived on it. Replaced wholesale on
    // refresh so readers on the receive loop never see a half-updated map and need no lock.
    private volatile IReadOnlyDictionary<int, IPAddress> _answerByInterface =
        new Dictionary<int, IPAddress>();

    // Interfaces we have an active multicast membership on, so a refresh only touches what changed.
    private readonly Dictionary<int, IPAddress> _joined = [];

    private int _disposed;

    /// <summary>
    /// Whether this responder is actually reaching the network — the observation the QR dialog needs
    /// before it defaults to the <c>.local</c> row. See <see cref="MdnsHealth"/>.
    /// </summary>
    public MdnsHealth Health { get; } = new();

    /// <param name="hostName">
    /// The name to publish, normally <see cref="QrHostOptions.ToMdnsHostName"/> of
    /// <see cref="Environment.MachineName"/> — i.e. EXACTLY the string the QR dialog shows. Null or blank
    /// leaves the responder inert.
    /// </param>
    /// <param name="fallbackAddress">
    /// The ranked LAN IPv4 (see <c>LanAddressRanking.Rank</c>), used only when the arrival interface of a
    /// query cannot be determined. May be null.
    /// </param>
    public MdnsResponder(string? hostName, IPAddress? fallbackAddress = null, Action<string>? log = null)
    {
        _log = log ?? (message => Console.Error.WriteLine(message));
        _fallbackAddress = fallbackAddress?.AddressFamily == AddressFamily.InterNetwork ? fallbackAddress : null;

        if (!IsEnabledByEnvironment())
        {
            _log($"[couch-coop] host-ui diagnostic code={DisabledCode} detail={EnabledEnvironmentVariable}");
            return;
        }

        var trimmed = hostName?.Trim().TrimEnd('.');
        if (string.IsNullOrEmpty(trimmed))
        {
            _log($"[couch-coop] host-ui diagnostic code={UnavailableCode} detail=no-host-name");
            return;
        }

        try
        {
            // Fail here rather than on every query if the name cannot be encoded as DNS labels.
            MdnsWire.EncodeName(trimmed);
        }
        catch (ArgumentException exception)
        {
            _log($"[couch-coop] host-ui diagnostic code={UnavailableCode} detail=bad-host-name:{exception.GetType().Name}");
            return;
        }

        _hostName = trimmed;
        _socket = TryOpenSocket();
        if (_socket is null)
        {
            return;
        }

        RefreshInterfaces();
        _receiveLoop = Task.Run(() => ReceiveLoopAsync(_cts.Token));
        _maintenanceLoop = Task.Run(() => MaintenanceLoopAsync(_cts.Token));
        _log($"[couch-coop] mdns-responder publishing name={_hostName} interfaces={_joined.Count}");
    }

    /// <summary>True when the socket is open and the responder is answering queries.</summary>
    public bool IsListening => _socket is not null;

    /// <summary>The published name, or null when the responder is inert.</summary>
    public string? HostName => _hostName;

    /// <summary>How many interfaces currently hold a multicast membership (diagnostics/tests).</summary>
    public int JoinedInterfaceCount
    {
        get
        {
            lock (_joined)
            {
                return _joined.Count;
            }
        }
    }

    /// <summary>Reads the kill-switch. Anything other than an explicit falsey value means enabled.</summary>
    public static bool IsEnabledByEnvironment()
        => IsEnabled(Environment.GetEnvironmentVariable(EnabledEnvironmentVariable));

    /// <summary>Pure half of the kill-switch, so the parsing is testable without touching the environment.</summary>
    public static bool IsEnabled(string? rawValue)
    {
        var value = rawValue?.Trim();
        if (string.IsNullOrEmpty(value))
        {
            return true;
        }

        return !(value.Equals("0", StringComparison.Ordinal)
            || value.Equals("false", StringComparison.OrdinalIgnoreCase)
            || value.Equals("off", StringComparison.OrdinalIgnoreCase)
            || value.Equals("no", StringComparison.OrdinalIgnoreCase));
    }

    private Socket? TryOpenSocket()
    {
        Socket? socket = null;
        try
        {
            socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);

            // Reuse BEFORE Bind, exactly like HostDiscoveryResponder: 5353 is a SHARED port by design
            // (RFC 6762 §15.1), and on Linux avahi is already sitting on it.
            socket.ExclusiveAddressUse = false;
            socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            TrySetReusePort(socket);

            socket.Bind(new IPEndPoint(IPAddress.Any, MdnsPort));

            // We must know which interface a query arrived on to answer with a routable address, so ask
            // the stack for per-packet interface info (IP_PKTINFO).
            TrySetSocketOption(socket, SocketOptionLevel.IP, SocketOptionName.PacketInformation, 1, "pktinfo");

            // RFC 6762 §11: mDNS packets are sent with TTL 255 and receivers may check for it.
            TrySetSocketOption(socket, SocketOptionLevel.IP, SocketOptionName.MulticastTimeToLive, 255, "mcast-ttl");

            // Keep loopback on so a querier on THIS machine (and our own diagnostics) can see us.
            TrySetSocketOption(socket, SocketOptionLevel.IP, SocketOptionName.MulticastLoopback, 1, "mcast-loop");

            return socket;
        }
        catch (Exception exception) when (exception is SocketException
            or ObjectDisposedException
            or System.Security.SecurityException
            or UnauthorizedAccessException
            or PlatformNotSupportedException
            or NotSupportedException)
        {
            // The overwhelmingly common failures are "5353 already exclusively bound" (a Bonjour/avahi
            // build that does not share) and "denied by policy". Both are survivable: the QR's IP rows
            // still work, so we log the code once and stay quiet.
            _log($"[couch-coop] host-ui diagnostic code={UnavailableCode} detail=bind:{DescribeError(exception)}");
            socket?.Dispose();
            return null;
        }
    }

    // Rebuild the interface -> answer-address map and reconcile multicast memberships against it. Called
    // at startup and every InterfaceRefreshInterval so a wifi adapter that comes up after the game
    // started still gets a membership (without one we would never RECEIVE its queries).
    private void RefreshInterfaces()
    {
        var socket = _socket;
        if (socket is null)
        {
            return;
        }

        var current = GatherInterfaces();
        var map = new Dictionary<int, IPAddress>(current.Count);
        foreach (var entry in current)
        {
            map[entry.Index] = entry.Address;
        }

        _answerByInterface = map;

        lock (_joined)
        {
            foreach (var entry in current)
            {
                if (_joined.TryGetValue(entry.Index, out var joinedAddress))
                {
                    if (joinedAddress.Equals(entry.Address))
                    {
                        continue;
                    }

                    // The interface kept its index but changed address (DHCP renew, VPN flap): the old
                    // membership is bound to the old local address, so swap it.
                    TryDropMembership(socket, joinedAddress);
                    _joined.Remove(entry.Index);
                }

                if (TryAddMembership(socket, entry.Address))
                {
                    _joined[entry.Index] = entry.Address;
                }
            }

            foreach (var index in _joined.Keys.ToArray())
            {
                if (!map.ContainsKey(index))
                {
                    TryDropMembership(socket, _joined[index]);
                    _joined.Remove(index);
                }
            }
        }
    }

    // One IPv4 per usable interface: the best-scoring address on it, reusing the advertised-address
    // ranking so a docker/Tailscale alias on a real NIC does not become that NIC's answer.
    private static List<MdnsInterface> GatherInterfaces()
    {
        var result = new List<MdnsInterface>();

        NetworkInterface[] interfaces;
        try
        {
            interfaces = NetworkInterface.GetAllNetworkInterfaces();
        }
        catch (Exception exception) when (exception is NetworkInformationException or PlatformNotSupportedException)
        {
            return result;
        }

        foreach (var networkInterface in interfaces)
        {
            try
            {
                if (networkInterface.OperationalStatus != OperationalStatus.Up
                    || !networkInterface.SupportsMulticast)
                {
                    continue;
                }

                var properties = networkInterface.GetIPProperties();
                var ipv4 = properties.GetIPv4Properties();
                if (ipv4 is null)
                {
                    continue;
                }

                var hasGateway = properties.GatewayAddresses.Any(gateway =>
                    gateway.Address is { AddressFamily: AddressFamily.InterNetwork } address
                    && !IPAddress.Any.Equals(address));

                LanAddressCandidate? best = null;
                var bestScore = int.MinValue;
                foreach (var unicast in properties.UnicastAddresses)
                {
                    if (unicast.Address is not { AddressFamily: AddressFamily.InterNetwork } address
                        || IPAddress.Any.Equals(address))
                    {
                        continue;
                    }

                    var candidate = new LanAddressCandidate(
                        networkInterface.Name,
                        networkInterface.NetworkInterfaceType,
                        networkInterface.OperationalStatus,
                        networkInterface.NetworkInterfaceType == NetworkInterfaceType.Loopback,
                        address,
                        PrefixOrigin.Other,
                        hasGateway);

                    var score = LanAddressRanking.ScoreOf(candidate);
                    if (score > bestScore)
                    {
                        best = candidate;
                        bestScore = score;
                    }
                }

                if (best is null)
                {
                    continue;
                }

                result.Add(new MdnsInterface(ipv4.Index, best.Address, best.IsLoopbackInterface));
            }
            catch (Exception exception) when (exception is NetworkInformationException
                or PlatformNotSupportedException
                or ObjectDisposedException
                or NotSupportedException)
            {
                // One flaky adapter must not cost us the rest of the list (same rule as LanAddressRanking).
            }
        }

        return result;
    }

    private bool TryAddMembership(Socket socket, IPAddress interfaceAddress)
    {
        try
        {
            socket.SetSocketOption(
                SocketOptionLevel.IP,
                SocketOptionName.AddMembership,
                new MulticastOption(MulticastGroup, interfaceAddress));
            return true;
        }
        catch (Exception exception) when (exception is SocketException or ObjectDisposedException or NotSupportedException)
        {
            // Interfaces that cannot carry multicast (some VPN/tunnel adapters) simply do not participate.
            return false;
        }
    }

    private static void TryDropMembership(Socket socket, IPAddress interfaceAddress)
    {
        try
        {
            socket.SetSocketOption(
                SocketOptionLevel.IP,
                SocketOptionName.DropMembership,
                new MulticastOption(MulticastGroup, interfaceAddress));
        }
        catch (Exception exception) when (exception is SocketException or ObjectDisposedException or NotSupportedException)
        {
        }
    }

    // SO_REUSEPORT. Port 5353 is shared by every mDNS participant on the box (RFC 6762 §15.1), and on Linux
    // avahi is already there; SO_REUSEADDR alone happens to be enough for UDP on Linux today, but a peer that
    // sets only SO_REUSEPORT would still lock us out, and macOS's mDNSResponder does exactly that.
    //
    // This MUST go through SetRawSocketOption: the managed SetSocketOption translates SocketOptionName values
    // through a known-options table on Unix, so a `(SocketOptionName)15` cast never reaches setsockopt — it
    // fails with OperationNotSupported (observed, not theorised). SetRawSocketOption passes the numbers down
    // verbatim, which is why the level/option constants are spelled out per OS here.
    private void TrySetReusePort(Socket socket)
    {
        const int LinuxSolSocket = 1;
        const int LinuxSoReusePort = 15;
        const int BsdSolSocket = 0xFFFF;
        const int BsdSoReusePort = 0x0200;

        var (level, option) = OperatingSystem.IsLinux()
            ? (LinuxSolSocket, LinuxSoReusePort)
            : OperatingSystem.IsMacOS() || OperatingSystem.IsFreeBSD()
                ? (BsdSolSocket, BsdSoReusePort)
                : (0, 0);

        if (option == 0)
        {
            // Windows has no SO_REUSEPORT; SO_REUSEADDR already carries the sharing semantics there.
            return;
        }

        try
        {
            socket.SetRawSocketOption(level, option, BitConverter.GetBytes(1));
        }
        catch (Exception exception) when (exception is SocketException or ObjectDisposedException or NotSupportedException)
        {
            _log($"[couch-coop] mdns-responder option-unavailable option=so-reuseport detail={DescribeError(exception)}");
        }
    }

    private void TrySetSocketOption(Socket socket, SocketOptionLevel level, SocketOptionName name, int value, string label)
    {
        try
        {
            socket.SetSocketOption(level, name, value);
        }
        catch (Exception exception) when (exception is SocketException or ObjectDisposedException or NotSupportedException)
        {
            _log($"[couch-coop] mdns-responder option-unavailable option={label} detail={DescribeError(exception)}");
        }
    }

    private async Task ReceiveLoopAsync(CancellationToken token)
    {
        var socket = _socket!;
        var hostName = _hostName!;
        var buffer = new byte[2048];
        EndPoint remote = new IPEndPoint(IPAddress.Any, 0);
        var consecutiveFailures = 0;

        while (!token.IsCancellationRequested)
        {
            SocketReceiveMessageFromResult received;
            try
            {
                received = await socket
                    .ReceiveMessageFromAsync(buffer, SocketFlags.None, remote, token)
                    .ConfigureAwait(false);
                consecutiveFailures = 0;
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (SocketException exception)
            {
                // A transient receive error (an ICMP unreachable from a prior send is the usual one) must
                // not kill the loop; a permanently broken socket must not spin it either.
                if (++consecutiveFailures >= MaxConsecutiveReceiveFailures)
                {
                    _log($"[couch-coop] host-ui diagnostic code={UnavailableCode} detail=receive:{exception.SocketErrorCode}");
                    break;
                }

                continue;
            }

            if (received.ReceivedBytes <= 0
                || !MdnsWire.TryParseQuery(buffer.AsSpan(0, received.ReceivedBytes), out var query))
            {
                continue;
            }

            var question = query.FindAddressQuestion(hostName);
            if (question is null)
            {
                continue;
            }

            var answer = ResolveAnswerAddress(received.PacketInformation.Interface);
            if (answer is null)
            {
                continue;
            }

            try
            {
                await RespondAsync(query, question, answer, received.RemoteEndPoint as IPEndPoint, token)
                    .ConfigureAwait(false);
                // Counted only once the answer is on the wire, so the tally means "queries we served",
                // not "datagrams we saw". Zero here across every interface, on a host that is otherwise
                // healthy, is the fingerprint of inbound UDP 5353 being dropped before it reaches us.
                Health.NoteAnswered(received.PacketInformation.Interface);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
        }
    }

    // The address a querier on `interfaceIndex` can actually reach us at. Falls back to the ranked LAN
    // address when the arrival interface is unknown (no IP_PKTINFO support, or an interface that came up
    // after the last refresh).
    private IPAddress? ResolveAnswerAddress(int interfaceIndex)
        => _answerByInterface.TryGetValue(interfaceIndex, out var address) ? address : _fallbackAddress;

    private async Task RespondAsync(
        MdnsQuery query,
        MdnsQuestion question,
        IPAddress answer,
        IPEndPoint? remoteEndPoint,
        CancellationToken token)
    {
        // RFC 6762 §6.7: a query from a port other than 5353 comes from a plain DNS resolver that happens
        // to be pointed at the multicast address (this is what `dig @224.0.0.251 -p 5353` does). It gets a
        // conventional DNS response: same id, question echoed, short TTL, no cache-flush bit, unicast.
        var isLegacy = remoteEndPoint is not null && remoteEndPoint.Port != MdnsPort;
        if (isLegacy)
        {
            var legacy = MdnsWire.BuildARecordResponse(
                _hostName!,
                answer,
                LegacyTtlSeconds,
                cacheFlush: false,
                query.TransactionId,
                question);
            await SendAsync(legacy, remoteEndPoint!, viaInterface: null, token).ConfigureAwait(false);
            return;
        }

        // RFC 6762 §18.1 / §6: multicast responses carry id 0 and an EMPTY question section. The record is
        // unique to us, so it is answered immediately (the 20-120ms delay is for shared records only).
        var payload = MdnsWire.BuildARecordResponse(_hostName!, answer, RecordTtlSeconds, cacheFlush: true);

        if (question.UnicastResponse && remoteEndPoint is not null)
        {
            // QU bit (RFC 6762 §5.4): the querier asked for the answer directly, typically because it just
            // woke up and cannot rely on its multicast cache yet.
            await SendAsync(payload, remoteEndPoint, viaInterface: null, token).ConfigureAwait(false);
            return;
        }

        await SendAsync(payload, MulticastEndPoint, answer, token).ConfigureAwait(false);
    }

    private async Task SendAsync(byte[] payload, IPEndPoint destination, IPAddress? viaInterface, CancellationToken token)
    {
        var socket = _socket;
        if (socket is null)
        {
            return;
        }

        // IP_MULTICAST_IF is socket-wide state, so setting it and sending must not interleave with another
        // send that wants a different interface.
        try
        {
            await _sendGate.WaitAsync(token).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is OperationCanceledException or ObjectDisposedException)
        {
            return;
        }

        try
        {
            if (viaInterface is not null)
            {
                try
                {
                    socket.SetSocketOption(
                        SocketOptionLevel.IP,
                        SocketOptionName.MulticastInterface,
                        viaInterface.GetAddressBytes());
                }
                catch (Exception exception) when (exception is SocketException or ObjectDisposedException or NotSupportedException)
                {
                    // Fall through and let the stack pick the default multicast interface.
                }
            }

            await socket.SendToAsync(payload, SocketFlags.None, destination, token).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is SocketException
            or ObjectDisposedException
            or OperationCanceledException)
        {
            // Best-effort: a send failure on one interface never affects the others, and never the host.
        }
        finally
        {
            try
            {
                _sendGate.Release();
            }
            catch (ObjectDisposedException)
            {
            }
        }
    }

    private async Task MaintenanceLoopAsync(CancellationToken token)
    {
        try
        {
            // RFC 6762 §8.3: announce the record unsolicited so caches learn it without being asked. Two
            // announcements one second apart is the spec's minimum and is plenty on a home LAN.
            for (var index = 0; index < AnnouncementCount && !token.IsCancellationRequested; index++)
            {
                if (index > 0)
                {
                    await Task.Delay(AnnouncementInterval, token).ConfigureAwait(false);
                }

                await AnnounceAsync(RecordTtlSeconds, token).ConfigureAwait(false);
            }

            // Only now: the probe asks the group for our own name, so it has to run after we are actually
            // in a position to answer. It is a REAL query over the real socket rather than an in-process
            // shortcut, because an in-process check passes in exactly the firewalled case it exists to
            // catch — see MdnsHealth.
            await RunSelfCheckAsync(token).ConfigureAwait(false);

            using var timer = new PeriodicTimer(InterfaceRefreshInterval);
            while (await timer.WaitForNextTickAsync(token).ConfigureAwait(false))
            {
                RefreshInterfaces();
            }
        }
        catch (Exception exception) when (exception is OperationCanceledException or ObjectDisposedException)
        {
        }
    }

    private async Task RunSelfCheckAsync(CancellationToken token)
    {
        if (_hostName is null)
        {
            return;
        }

        // Our OWN addresses, so a foreign responder answering for this name reads as a conflict rather
        // than a pass. The fallback is included because it is the address we answer with when a query's
        // arrival interface cannot be determined.
        var ownAddresses = new HashSet<IPAddress>(_answerByInterface.Values);
        if (_fallbackAddress is not null)
        {
            ownAddresses.Add(_fallbackAddress);
        }

        if (ownAddresses.Count == 0)
        {
            return;
        }

        var outcome = await MdnsHealth.ProbeAsync(_hostName, ownAddresses, token).ConfigureAwait(false);
        Health.NoteSelfCheck(outcome);

        // Push rather than let the dialog pull: the QR dialog must render fine on a host where this
        // responder never started at all, so it cannot hold a reference to it.
        CouchCoopHostUiNotices.MdnsNameResolves = Health.NameLikelyResolves;

        _log($"[couch-coop] mdns-responder self-check {Health.Describe()} name={_hostName}");
    }

    // One announcement per interface, each carrying THAT interface's address — a single announcement with
    // one address would be wrong for every other subnet the host sits on.
    private async Task AnnounceAsync(uint ttlSeconds, CancellationToken token)
    {
        KeyValuePair<int, IPAddress>[] targets;
        lock (_joined)
        {
            targets = [.. _joined];
        }

        foreach (var target in targets)
        {
            if (token.IsCancellationRequested)
            {
                return;
            }

            byte[] payload;
            try
            {
                payload = MdnsWire.BuildARecordResponse(_hostName!, target.Value, ttlSeconds, cacheFlush: true);
            }
            catch (ArgumentException)
            {
                continue;
            }

            await SendAsync(payload, MulticastEndPoint, target.Value, token).ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        // RFC 6762 §10.1: say goodbye (the same record with TTL 0) BEFORE tearing anything down, so phones
        // and routers drop the cached name immediately instead of pointing at a dead host for two minutes.
        if (_socket is not null)
        {
            try
            {
                using var goodbye = new CancellationTokenSource(GoodbyeTimeout);
                await AnnounceAsync(0, goodbye.Token).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is OperationCanceledException or ObjectDisposedException)
            {
            }
        }

        try
        {
            _cts.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }

        _socket?.Dispose();

        foreach (var loop in new[] { _receiveLoop, _maintenanceLoop })
        {
            try
            {
                await loop.ConfigureAwait(false);
            }
            catch
            {
                // The loops swallow their own shutdown exceptions; guard here against a race on dispose.
            }
        }

        _cts.Dispose();
        _sendGate.Dispose();
    }

    private static string DescribeError(Exception exception)
        => exception is SocketException socketException
            ? socketException.SocketErrorCode.ToString()
            : exception.GetType().Name;

    private readonly record struct MdnsInterface(int Index, IPAddress Address, bool IsLoopback);
}
