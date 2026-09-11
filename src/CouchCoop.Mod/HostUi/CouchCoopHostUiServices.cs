using System.Net;
using System.Net.Sockets;
using CouchCoop.Mod.Activity;
using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.MirrorProtocol.Discovery;

namespace CouchCoop.Mod.HostUi;

public sealed class CouchCoopHostUiServices : IAsyncDisposable
{
    public const string BrowserServerUnavailableCode = "browser-server-unavailable";
    public const string HostUiStartupFailedCode = "host-ui-startup-failed";
    public const string HostUiStartupDisposeFailedCode = "host-ui-startup-dispose-failed";
    public const string HostUiOverlayStartupFailedCode = "host-ui-overlay-startup-failed";
    public const string NoAdvertisableHostAddressCode = "no-advertisable-host-address";

    // Advertised in the discovery reply when there is no LAN address at all. See the comment at its use site.
    public const string DiscoveryFallbackHost = "127.0.0.1";

    private readonly CouchCoopRuntimeHost _runtime;
    private readonly string _staticRoot;
    private readonly IPAddress _bindAddress;
    private readonly int _preferredPort;
    private readonly Action<string> _log;
    private readonly bool _deferDiscoveryServices;
    private readonly List<CouchCoopHostUiDiagnostic> _diagnostics = [];
    private readonly object _discoveryGate = new();
    private HotReloadableBrowserServerHost? _browserServer;
    private HostDiscoveryResponder? _discovery;
    private MdnsResponder? _mdns;
    private SecureOriginCertificates? _secureCertificates;
    private CouchCoopHostUiSnapshot _snapshot = CouchCoopHostUiSnapshot.Unavailable([]);

    // The URIs StartAsync resolved, kept so a DEFERRED discovery start can answer with exactly the same
    // addresses the listener and the QR already agreed on. Null until StartAsync has bound.
    private Uri? _listenerBaseUri;
    private Uri? _joinBaseUri;
    private bool _discoveryStarted;

    /// <param name="deferDiscoveryServices">
    /// When <see langword="true"/>, <see cref="StartAsync"/> brings up ONLY the browser listener and leaves
    /// the LAN discovery responder, the mDNS name and the secure-origin fetch for
    /// <see cref="StartDiscoveryServices"/>. See that method for why.
    /// <para>
    /// Defaults to <see langword="false"/> so every existing caller — the test suites, the hosted harness,
    /// and a headless SEAT, which is spawned only when co-op is already in use and must have its secure
    /// listener up before the browser is redirected to it — keeps the original all-at-once startup.
    /// </para>
    /// </param>
    public CouchCoopHostUiServices(
        CouchCoopRuntimeHost runtime,
        string? staticRoot = null,
        IPAddress? bindAddress = null,
        int preferredPort = 13337,
        Action<string>? log = null,
        bool deferDiscoveryServices = false)
    {
        _runtime = runtime ?? throw new ArgumentNullException(nameof(runtime));
        _staticRoot = staticRoot ?? DefaultStaticRoot();
        _bindAddress = bindAddress ?? IPAddress.Any;
        _preferredPort = preferredPort;
        _log = log ?? (message => Console.Error.WriteLine(message));
        _deferDiscoveryServices = deferDiscoveryServices;
    }

    public CouchCoopHostUiSnapshot Snapshot => _snapshot;

    public async Task<CouchCoopHostUiSnapshot> StartAsync(CancellationToken cancellationToken = default)
    {
        if (_browserServer?.IsRunning == true)
        {
            return _snapshot;
        }

        _diagnostics.Clear();
        _browserServer = new HotReloadableBrowserServerHost(
            _runtime,
            _staticRoot,
            _bindAddress,
            _preferredPort,
            log: _log);

        try
        {
            var listenerBaseUri = await _browserServer.StartAsync(cancellationToken).ConfigureAwait(false);
            var joinBaseUri = TryCreateAdvertisedJoinBaseUri(listenerBaseUri);
            if (joinBaseUri is null)
            {
                AddDiagnostic(NoAdvertisableHostAddressCode, "No LAN-reachable host address was available for the browser server.");
                _log($"[couch-coop] host-discovery falling back to {DiscoveryFallbackHost} — no LAN address to advertise");
                // B2: the server IS up, so this is a warning rather than a failure — a phone on the same
                // machine can still reach it, and the QR dialog still offers the `.local` name.
                Narrate(CouchCoopActivitySeverity.Warn, CouchCoopActivityMessages.BrowserServerNoAddress);
            }

            _snapshot = new CouchCoopHostUiSnapshot(
                Available: joinBaseUri is not null,
                JoinBaseUri: joinBaseUri,
                ListenerBaseUri: listenerBaseUri,
                Diagnostics: [.. _diagnostics]);

            _listenerBaseUri = listenerBaseUri;
            _joinBaseUri = joinBaseUri;

            if (!_deferDiscoveryServices)
            {
                StartDiscoveryServices();
            }

            if (joinBaseUri is not null)
            {
                _log($"[couch-coop] browser server available url={joinBaseUri}");
                // B1: the ADVERTISED url, never the wildcard the listener bound — this is a line a host may
                // read out loud to somebody typing it into a phone.
                Narrate(
                    CouchCoopActivitySeverity.Good,
                    CouchCoopActivityMessages.BrowserServerReady(joinBaseUri.ToString()));
            }
        }
        catch (Exception exception) when (exception is SocketException or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            AddDiagnostic(BrowserServerUnavailableCode, "The browser server could not be started.", exception.GetType().Name);
            // B3: THE event this whole panel exists for. It is also why the panel's gate is IsHostLobby and
            // not ShouldShow — a host with no listener has no QR either, and would otherwise see nothing at
            // all on the one screen where the failure matters.
            Narrate(CouchCoopActivitySeverity.Bad, CouchCoopActivityMessages.BrowserServerFailed);
            _snapshot = CouchCoopHostUiSnapshot.Unavailable([.. _diagnostics]);
            await DisposeBrowserServerAsync().ConfigureAwait(false);
        }

        return _snapshot;
    }

    /// <summary>
    /// Bring up the LAN discovery responder, the <c>.local</c> mDNS name and the secure-origin fetch. Safe to
    /// call repeatedly and from any thread; the first call wins and the rest return immediately.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY THIS IS NOT PART OF <see cref="StartAsync"/> ANY MORE. These three are the only things the mod
    /// does to the machine's NETWORK, and until now every one of them started at mod init — so a player who
    /// installed the mod and never opened a co-op lobby still had a multicast socket parsing every mDNS
    /// datagram on their LAN, a UDP responder, a 30s interface re-enumeration for the whole session, and one
    /// outbound WAN request to the certificate provider on every single launch. None of that is needed until
    /// somebody is actually about to hand out a join address, and that moment has a name: a HOST lobby on
    /// screen. <c>CouchCoopQrHostPanelController.HostLobbyPresented</c> is the trigger.
    /// </para>
    /// <para>
    /// The browser LISTENER deliberately stays in <see cref="StartAsync"/>. It is a parked
    /// <c>AcceptTcpClientAsync</c> that costs nothing while idle, it is the "idle server" the product accepts,
    /// and the port file plus every QA harness expect the port to exist from launch.
    /// </para>
    /// <para>
    /// ONCE UP, NEVER TORN DOWN — not even when the lobby closes. A phone that drops mid-run has to be able
    /// to re-resolve <c>&lt;machine&gt;.local</c> and re-discover the host long after the lobby is gone, so
    /// tying these to the lobby's LIFETIME (rather than to its first appearance) would break exactly the
    /// reconnect they exist to serve.
    /// </para>
    /// <para>
    /// No-op when the listener never bound: with no <c>_listenerBaseUri</c> there is no port to advertise,
    /// and a discovery reply pointing at nothing is worse than none.
    /// </para>
    /// </remarks>
    public void StartDiscoveryServices()
    {
        Uri? listenerBaseUri;
        Uri? joinBaseUri;
        lock (_discoveryGate)
        {
            if (_discoveryStarted || _listenerBaseUri is null)
            {
                return;
            }

            _discoveryStarted = true;
            listenerBaseUri = _listenerBaseUri;
            joinBaseUri = _joinBaseUri;
        }

        // M3 WS-T: answer LAN host-discovery probes on the SAME numeric port the TCP listener chose (port-walk
        // parity). The reply is connect-ready — the advertised LAN IPv4 the QR already computed + the real port
        // + this machine's name. A bind failure logs `host-discovery-unavailable` and leaves the host unharmed.
        //
        // WS-F: the fallback host used to be `listenerBaseUri.Host`, which in this branch is ALWAYS the
        // wildcard the listener bound ("0.0.0.0"/"::") — joinBaseUri is only null when the listener is
        // wildcard-bound and no LAN address was found. The Godot client uses reply.Host verbatim as a connect
        // target (ConnectScreen fills "{Host}:{Port}" into the address field), so we were advertising a
        // tappable row that can never connect. Loopback is the honest answer instead: a host with no LAN
        // address is unreachable from off-box by definition, so the only prober that can still reach us is on
        // THIS machine — and 127.0.0.1 is exactly right for it. The lobby QR stays `Available: false` with the
        // `no-advertisable-host-address` diagnostic; we do not paint loopback onto a QR a phone might scan.
        _discovery = new HostDiscoveryResponder(
            listenerBaseUri!.Port,
            () => new HostDiscoveryReply(
                joinBaseUri?.Host ?? DiscoveryFallbackHost,
                listenerBaseUri.Port,
                joinBaseUri?.ToString(),
                Environment.MachineName,
                HostDiscovery.ProtocolVersion),
            _log);

        // WS8: publish `<machine>.local` ourselves. The QR dialog's default row is that name, and until now
        // we only PREDICTED that the OS would publish it — true for avahi/Bonjour, false on a stock Windows
        // box (no `.local` responder at all, and Environment.MachineName is the NetBIOS name, so even a
        // Bonjour install may publish a DIFFERENT string than the QR shows). Feeding the responder the exact
        // output of QrHostOptions.ToMdnsHostName makes the published name byte-identical to the rendered one.
        //
        // The fallback address is only used when a query's arrival interface is indeterminate; it is the
        // same ranked LAN IPv4 the QR advertises, so the two can never disagree. Any socket failure leaves
        // the responder inert (see MdnsResponder) — the QR's literal-IP rows are unaffected.
        _mdns = new MdnsResponder(
            QrHostOptions.ToMdnsHostName(Environment.MachineName),
            joinBaseUri is not null && IPAddress.TryParse(joinBaseUri.Host, out var advertisedAddress)
                ? advertisedAddress
                : null,
            _log);

        // WS6: the OPT-IN secure origin. Started DETACHED and after everything above, because acquiring the
        // certificate is a WAN round-trip and this feature must never delay — let alone fail — the thing that
        // actually serves the game. A host with no internet reaches "unavailable" a few seconds later and
        // nothing else here ever notices: the plain-HTTP listener, the discovery responder and the mDNS name
        // are all already up and are untouched by the outcome. The QR dialog already renders a Pending
        // "checking…" state, which is what makes arriving at the lobby (rather than at launch) invisible.
        StartSecureOriginAsync(joinBaseUri);

        _log("[couch-coop] host discovery services started (lan discovery + mdns + secure origin)");
    }

    public async ValueTask DisposeAsync()
    {
        await DisposeBrowserServerAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// Acquire the published wildcard certificate and, if it lands, bring the TLS listener up beside the
    /// HTTP one — then republish the snapshot so the QR dialog can offer the checkbox.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Fire-and-forget by design. This is the only part of host startup that talks to the internet, and the
    /// requirement is that LAN-only play is completely unaffected by it: nothing awaits this task, no caller
    /// can observe it failing, and the only trace of a failure is a diagnostic line plus a disabled checkbox
    /// carrying <see cref="SecureOriginStatus.Text"/>.
    /// </para>
    /// <para>
    /// The snapshot is REPLACED rather than mutated when the certificate lands, so a dialog opened before it
    /// arrived simply reads the old value (checkbox disabled, "checking…") and a dialog opened afterwards
    /// reads the new one. The dialog recomputes on every open, so no invalidation is needed.
    /// </para>
    /// </remarks>
    private void StartSecureOriginAsync(Uri? joinBaseUri)
    {
        if (!SecureOriginCertificates.Enabled)
        {
            _snapshot = _snapshot with
            {
                SecureUnavailableReason = CouchCoopSecureText.Disabled(SecureOriginCertificates.EnabledEnvironmentVariable),
            };
            NarrateSecureUnavailable(_snapshot.SecureUnavailableReason);
            return;
        }

        // Nothing to derive a secure name from: the wildcard maps a dashed IPv4 label, so the fetch is
        // only worth a WAN round-trip when SOME adapter owns an address a phone could come back to. The
        // advertised address is checked first (cheap, and the common case), but it no longer decides
        // alone — the QR dialog offers a secure row PER ADAPTER, so a machine advertising a `.local`
        // name or an odd override still wants the certificate for its ordinary wifi adapter's row.
        var advertisedEligible = joinBaseUri is not null
            && IPAddress.TryParse(joinBaseUri.Host, out var advertised)
            && SecureOriginHost.IsSecureOriginEligible(advertised);
        if (!advertisedEligible
            && !QrHostOptions.BestPerAdapter(LanAddressRanking.GatherFromOs())
                .Any(candidate => SecureOriginHost.IsSecureOriginEligible(candidate.Address)))
        {
            _snapshot = _snapshot with { SecureUnavailableReason = CouchCoopSecureText.AddressIneligible };
            NarrateSecureUnavailable(_snapshot.SecureUnavailableReason);
            return;
        }

        var certificates = new SecureOriginCertificates(log: _log);
        _secureCertificates = certificates;
        _snapshot = _snapshot with { SecureDomain = certificates.Domain };

        _ = Task.Run(async () =>
        {
            try
            {
                await certificates.StartAsync().ConfigureAwait(false);

                var status = certificates.Status;
                if (!status.IsReady || _browserServer is null)
                {
                    _snapshot = _snapshot with { SecureUnavailableReason = status.Text };
                    // A Pending status is the QR dialog's "still checking…" progress copy, not an outcome.
                    // The activity log narrates OUTCOMES only — B4 when the link comes up, or a final
                    // unavailable reason — so a still-pending acquisition stays silent here rather than
                    // reading as an outage on the TV (and rather than racing a stray Info line into
                    // whatever the ring's readers assert next).
                    if (status.State != SecureOriginState.Pending)
                    {
                        NarrateSecureUnavailable(_snapshot.SecureUnavailableReason);
                    }
                    return;
                }

                if (_browserServer.TryStartSecureListener(certificates))
                {
                    _snapshot = _snapshot with
                    {
                        SecurePort = _browserServer.SecurePort,
                        SecureDomain = certificates.Domain,
                        SecureUnavailableReason = null,
                    };
                    // B4. Arrives SECONDS after B1 by design (the certificate is a WAN round-trip), which is
                    // precisely why it is its own line rather than a field on the startup one.
                    Narrate(CouchCoopActivitySeverity.Good, CouchCoopActivityMessages.SecureOriginReady);
                }
                else
                {
                    _snapshot = _snapshot with { SecureUnavailableReason = CouchCoopSecureText.PortFailed };
                    NarrateSecureUnavailable(_snapshot.SecureUnavailableReason);
                }
            }
            catch (Exception exception)
            {
                // Catch-all on a detached task: an escaping exception here would be an unobserved
                // TaskException, and the whole contract of this feature is that it cannot hurt the host.
                _snapshot = _snapshot with { SecureUnavailableReason = CouchCoopSecureText.SetupFailed };
                NarrateSecureUnavailable(_snapshot.SecureUnavailableReason);
                _log($"[couch-coop] host-ui diagnostic code={SecureOriginCertificates.UnavailableCode} "
                    + $"detail={exception.GetType().Name}: {exception.Message}");
            }
        });
    }

    public IHotServerHost? HotServerHost => _browserServer;

    public Task ActivateHotReloadGenerationAsync(
        ICouchCoopHotGeneration generation,
        int generationNumber,
        CancellationToken cancellationToken = default)
        => _browserServer is null
            ? throw new InvalidOperationException("The browser server has not been started.")
            : _browserServer.ReplaceGenerationAsync(generation, generationNumber, cancellationToken);

    /// <summary>Write one SERVER line to the host connectivity log. See <c>CouchCoopActivityLog</c>.</summary>
    private static void Narrate(CouchCoopActivitySeverity severity, CouchCoop.Mod.Localization.CouchCoopText message)
        => CouchCoopActivityLog.Append(CouchCoopActivityCategory.Server, severity, message);

    /// <summary>
    /// B5 — the secure origin is not on offer. <c>SecureUnavailableReason</c> is a semantic player-facing
    /// value shared by the QR dialog and activity feed, so both resolve the same fact in the active locale.
    /// <para>Info, not Warn: LAN play is completely unaffected, which is the whole design of that feature.</para>
    /// </summary>
    private static void NarrateSecureUnavailable(CouchCoopText? reason)
        => Narrate(CouchCoopActivitySeverity.Info, CouchCoopActivityMessages.SecureOriginUnavailable(reason));

    private async ValueTask DisposeBrowserServerAsync()
    {
        // B6. Gated on IsRunning, not on non-null: this method is also the unwind path for a FAILED start
        // (see the catch in StartAsync), where "Phone connection stopped." immediately after "Couldn't start
        // the phone connection service." would be noise contradicting itself.
        if (_browserServer is { IsRunning: true })
        {
            Narrate(CouchCoopActivitySeverity.Info, CouchCoopActivityMessages.BrowserServerStopped);
        }

        // Re-arm the one-shot latch with the services it guards, so a restarted host UI can bring them up
        // again. Also covers the unwind path of a start that threw AFTER the non-deferred
        // StartDiscoveryServices call, which would otherwise leave the latch set over disposed responders.
        lock (_discoveryGate)
        {
            _discoveryStarted = false;
            _listenerBaseUri = null;
            _joinBaseUri = null;
        }

        if (_mdns is not null)
        {
            // Disposed first so the goodbye packet (TTL 0) goes out while the network stack is still ours.
            await _mdns.DisposeAsync().ConfigureAwait(false);
            _mdns = null;
        }

        if (_discovery is not null)
        {
            await _discovery.DisposeAsync().ConfigureAwait(false);
            _discovery = null;
        }

        if (_browserServer is not null)
        {
            // Disposes the secure listener too — it is owned by the browser server host.
            await _browserServer.DisposeAsync().ConfigureAwait(false);
            _browserServer = null;
        }

        _secureCertificates?.Dispose();
        _secureCertificates = null;
    }

    private Uri? TryCreateAdvertisedJoinBaseUri(Uri listenerBaseUri)
    {
        var advertisedHost = AdvertisedHostFor(listenerBaseUri.Host);
        return advertisedHost is null
            ? null
            : new UriBuilder(listenerBaseUri)
            {
                Host = advertisedHost,
                Path = "/",
                Query = string.Empty,
                Fragment = string.Empty
            }.Uri;
    }

    // The address-selection diagnostics — and only those — also go to godot.log through STS2's logger so the
    // lines carry the [INFO] tag and remain available after launcher-side stdio capture ends. WS-F shipped a
    // ranked-candidate log precisely so that "it shows the wrong IP" is
    // falsifiable from a user's log, and it was unreadable in the field.
    //
    // Scoped to this one call site on purpose. `_log` is the shared sink for this class AND is handed to
    // HotReloadableBrowserServerHost + HostDiscoveryResponder, so repointing it would push per-request server and
    // discovery chatter into godot.log too. Startup address selection is a handful of lines, once.
    //
    // This method is unreachable from the test suite (address ranking runs solely for a WILDCARD-bound listener,
    // and every test binds loopback) — which is why CouchCoopLog's try/catch is enough: like GD.Print, an STS2
    // logger call outside an engine could fail hard, and nothing here is exercised without one. Do not call it
    // from a path the tests exercise.
    private void LogAddressSelection(string message)
    {
        _log(message);
        CouchCoop.Mod.Session.CouchCoopLog.Info(message);
    }

    private string? AdvertisedHostFor(string listenerHost)
    {
        // The env override is a safety valve: it wins over the ranking AND over an explicit bind address, because
        // its whole purpose is to rescue a machine whose topology we read wrong.
        if (LanAddressRanking.ReadAdvertisedHostOverride(LogAddressSelection) is { } overridden)
        {
            LogAddressSelection($"[couch-coop] advertised-host override host={overridden} source={LanAddressRanking.AdvertisedHostEnvironmentVariable}");
            return overridden;
        }

        if (!IPAddress.TryParse(listenerHost, out var address))
        {
            return listenerHost;
        }

        if (!IPAddress.Any.Equals(address) && !IPAddress.IPv6Any.Equals(address))
        {
            return address.ToString();
        }

        return FindLanIpv4Address()?.ToString();
    }

    // WS-F: was "first IPv4 on the first Up, non-loopback interface" — pure enumeration order, which on a Windows
    // box with Tailscale installed advertises the unreachable 100.64/10 CGNAT address. Now ranked (see
    // LanAddressRanking): default gateway first, then ethernet > wifi > other, then range penalties.
    private IPAddress? FindLanIpv4Address()
    {
        var ranked = LanAddressRanking.Rank(LanAddressRanking.GatherFromOs(LogAddressSelection));
        if (ranked.Count == 0)
        {
            LogAddressSelection("[couch-coop] lan-address none found");
            return null;
        }

        // Log the LOSERS too, not just the winner. "It shows the wrong IP" is otherwise unfalsifiable from a user's
        // log: this line set says exactly which addresses were on the table and what each one scored.
        for (var index = 0; index < ranked.Count; index++)
        {
            LogAddressSelection($"[couch-coop] lan-address candidate rank={index} {LanAddressRanking.Describe(ranked[index])}");
        }

        return ranked[0].Address;
    }

    private void AddDiagnostic(string code, string message, string? detail = null)
    {
        var diagnostic = new CouchCoopHostUiDiagnostic(code, message, detail);
        _diagnostics.Add(diagnostic);
        _log($"[couch-coop] host-ui diagnostic code={diagnostic.Code} detail={diagnostic.Detail ?? "none"}");
    }

    private static string DefaultStaticRoot()
    {
        var assemblyDirectory = Path.GetDirectoryName(typeof(CouchCoopHostUiServices).Assembly.Location);
        return Path.GetFullPath(Path.Combine(
            string.IsNullOrWhiteSpace(assemblyDirectory) ? AppContext.BaseDirectory : assemblyDirectory,
            "frontend"));
    }
}

/// <param name="SecurePort">
/// The opt-in TLS listener's REAL bound port, or <c>0</c> when the secure origin is not running. Never the
/// preferred port — the secure listener port-walks just like the HTTP one.
/// </param>
/// <param name="SecureDomain">The active certificate provider's DNS suffix, e.g. <c>my.local-ip.co</c>.</param>
/// <param name="SecureUnavailableReason">
/// Semantic text explaining why the secure origin is not on offer, or <see langword="null"/> when it is.
/// The QR dialog resolves it under the disabled row in the active locale.
/// </param>
public sealed record CouchCoopHostUiSnapshot(
    bool Available,
    Uri? JoinBaseUri,
    Uri? ListenerBaseUri,
    IReadOnlyList<CouchCoopHostUiDiagnostic> Diagnostics,
    int SecurePort = 0,
    string? SecureDomain = null,
    CouchCoopText? SecureUnavailableReason = null)
{
    public static CouchCoopHostUiSnapshot Unavailable(IReadOnlyList<CouchCoopHostUiDiagnostic> diagnostics)
        => new(Available: false, JoinBaseUri: null, ListenerBaseUri: null, Diagnostics: diagnostics);

    /// <summary>
    /// The advertised LAN IPv4 the join URI carries, or <see langword="null"/> when the advertised
    /// host is not an IPv4 literal (a <c>.local</c> name or an operator override).
    /// </summary>
    public IPAddress? AdvertisedIpv4
        => JoinBaseUri is not null && IPAddress.TryParse(JoinBaseUri.Host, out var address) ? address : null;
}

public sealed record CouchCoopHostUiDiagnostic(string Code, string Message, string? Detail = null);
