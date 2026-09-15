using System.Net;
using System.Net.Sockets;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Whether <see cref="MdnsResponder"/> is actually reaching the network, and the evidence for the answer.
/// </summary>
/// <remarks>
/// <para>
/// WHY THIS EXISTS. The QR dialog offers <c>&lt;machine&gt;.local</c> as its DEFAULT row, and when that name
/// does not resolve the player gets <c>ERR_NAME_NOT_RESOLVED</c> in a browser with no hint about what went
/// wrong — the reported symptom on a Windows host with an Android client. The responder's own code cannot
/// tell the difference between "working" and "silently firewalled": binding the socket, joining the group
/// and writing datagrams all succeed either way. Only two things distinguish them, and both are observations
/// rather than return codes: whether any query ever ARRIVES, and whether our own answer comes back when we
/// ask.
/// </para>
/// <para>
/// The self-check is deliberately a REAL query over the real multicast group rather than an internal call —
/// an in-process shortcut would pass in exactly the firewalled case it exists to catch. It only counts an
/// answer that names our host AND carries one of our own addresses: a foreign responder answering for our
/// name is a name conflict, not a success, and treating it as one would leave the dialog advertising a row
/// that resolves to somebody else's machine.
/// </para>
/// <para>
/// Everything here is best-effort in the responder's house style — a failure to probe is
/// <see cref="MdnsSelfCheck.NotRun"/>, never an exception into the host, and never a warning badge (an unrun
/// check must not look like a failed one).
/// </para>
/// </remarks>
public sealed class MdnsHealth
{
    /// <summary>How long to wait for our own answer before calling the probe unanswered.</summary>
    internal static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(2);

    private readonly Lock _gate = new();
    private readonly Dictionary<int, int> _queriesByInterface = [];
    private int _queriesReceived;
    private MdnsSelfCheck _selfCheck = MdnsSelfCheck.NotRun;

    /// <summary>Total address queries this responder has ANSWERED since start.</summary>
    public int QueriesAnswered
    {
        get
        {
            lock (_gate)
            {
                return _queriesReceived;
            }
        }
    }

    /// <summary>Per arrival-interface answer counts. Zero on every interface is the firewall fingerprint.</summary>
    public IReadOnlyDictionary<int, int> QueriesByInterface
    {
        get
        {
            lock (_gate)
            {
                return new Dictionary<int, int>(_queriesByInterface);
            }
        }
    }

    /// <summary>The startup probe's verdict.</summary>
    public MdnsSelfCheck SelfCheck
    {
        get
        {
            lock (_gate)
            {
                return _selfCheck;
            }
        }
    }

    /// <summary>
    /// True unless we have POSITIVE evidence the name does not resolve.
    /// </summary>
    /// <remarks>
    /// The asymmetry is the point: this drives whether the QR dialog badges the <c>.local</c> row as
    /// "didn't answer", and badging it on a probe that merely failed to run would punish a working setup
    /// for an unrelated hiccup. Only <see cref="MdnsSelfCheck.Unanswered"/> — we asked the network for our
    /// own name and nothing came back — is strong enough to warn the player.
    /// </remarks>
    public bool NameLikelyResolves => SelfCheck != MdnsSelfCheck.Unanswered;

    internal void NoteAnswered(int interfaceIndex)
    {
        lock (_gate)
        {
            _queriesReceived++;
            _queriesByInterface[interfaceIndex] = _queriesByInterface.GetValueOrDefault(interfaceIndex) + 1;
        }
    }

    internal void NoteSelfCheck(MdnsSelfCheck outcome)
    {
        lock (_gate)
        {
            _selfCheck = outcome;
        }
    }

    /// <summary>One line for the host log; also the shape the docs tell a Windows operator to look for.</summary>
    public string Describe()
    {
        lock (_gate)
        {
            var perInterface = _queriesByInterface.Count == 0
                ? "none"
                : string.Join(",", _queriesByInterface.Select(entry => $"if{entry.Key}={entry.Value}"));
            return $"selfCheck={_selfCheck} answered={_queriesReceived} byInterface={perInterface}";
        }
    }

    /// <summary>
    /// Ask the multicast group for <paramref name="hostName"/> and report whether WE answered.
    /// </summary>
    /// <remarks>
    /// The query sets the QU bit (RFC 6762 §5.4) and is sent from an EPHEMERAL port, so a responder may
    /// reply unicast straight back to this socket — which is also exactly the shape a phone's resolver uses,
    /// so a pass here exercises the same code path a phone would hit. A multicast reply is accepted too
    /// (the socket is bound to the wildcard address).
    /// </remarks>
    internal static async Task<MdnsSelfCheck> ProbeAsync(
        string hostName,
        IReadOnlyCollection<IPAddress> ownAddresses,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(hostName))
        {
            return MdnsSelfCheck.NotRun;
        }

        Socket? socket = null;
        try
        {
            socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            socket.Bind(new IPEndPoint(IPAddress.Any, 0));
            socket.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastTimeToLive, 255);

            var query = MdnsWire.BuildAQuery(hostName, unicastResponse: true);
            await socket.SendToAsync(query, SocketFlags.None, new IPEndPoint(MdnsResponder.MulticastGroup, MdnsResponder.MdnsPort), cancellationToken)
                .ConfigureAwait(false);

            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(ProbeTimeout);

            var buffer = new byte[2048];
            while (!deadline.IsCancellationRequested)
            {
                var received = await socket
                    .ReceiveFromAsync(buffer, SocketFlags.None, new IPEndPoint(IPAddress.Any, 0), deadline.Token)
                    .ConfigureAwait(false);

                if (!MdnsWire.TryParseResponse(buffer.AsSpan(0, received.ReceivedBytes), out var response))
                {
                    continue;
                }

                foreach (var answer in response.Answers)
                {
                    // A goodbye (TTL 0) names the record and asserts the opposite, and an answer from a
                    // DIFFERENT machine for our name is a conflict rather than a success.
                    if (answer.TtlSeconds > 0
                        && MdnsWire.NameEquals(answer.Name, hostName)
                        && ownAddresses.Contains(answer.Address))
                    {
                        return MdnsSelfCheck.Answered;
                    }
                }
            }

            return MdnsSelfCheck.Unanswered;
        }
        catch (OperationCanceledException)
        {
            // The linked source fires on our own deadline, which IS the unanswered verdict; an outer
            // cancellation (shutdown) is not a verdict at all.
            return cancellationToken.IsCancellationRequested ? MdnsSelfCheck.NotRun : MdnsSelfCheck.Unanswered;
        }
        catch (Exception exception) when (exception is SocketException
            or ObjectDisposedException
            or System.Security.SecurityException
            or PlatformNotSupportedException
            or NotSupportedException
            or ArgumentException)
        {
            return MdnsSelfCheck.NotRun;
        }
        finally
        {
            socket?.Dispose();
        }
    }
}

/// <summary>The startup probe's three states. Only <see cref="Unanswered"/> is evidence of a problem.</summary>
public enum MdnsSelfCheck
{
    /// <summary>Not attempted, or the attempt itself failed (no socket, shutdown mid-probe).</summary>
    NotRun,

    /// <summary>We asked the network for our own name and our own address came back.</summary>
    Answered,

    /// <summary>We asked and nothing answered — the name does not resolve from this machine's own LAN.</summary>
    Unanswered
}
