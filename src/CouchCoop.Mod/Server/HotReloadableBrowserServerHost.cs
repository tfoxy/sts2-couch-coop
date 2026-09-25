using System.Net;
using System.Net.Sockets;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Server;

public sealed class HotReloadableBrowserServerHost : IHotServerHost, IHotBrowserDemandHost, IAsyncDisposable
{
    private readonly CouchCoopRuntimeHost _runtime;
    private readonly IPAddress _bindAddress;
    private readonly int _preferredPort;
    private readonly Action<string> _log;
    private readonly object _generationGate = new();
    private readonly HeadlessClientManager? _headlessManager;
    private readonly CouchCoop.Mod.Connections.BrowserDemandLedger _browserDemand;
    private readonly Action<int, long> _inputGuardDemand = RootWindowEmbeddingGuard.CreateBrowserDemandReporter();
    private TcpListener? _listener;
    private CancellationTokenSource? _stop;
    private Task? _acceptLoop;
    private ICouchCoopHotGeneration? _generation;
    private int _generationNumber;
    private SecureBrowserListener? _secureListener;
    private CouchCoop.Mod.Connections.ConnectionHostingTracker? _connectionHosting;
    public NetworkAdmissionLimiter Admission { get; }

    public HotReloadableBrowserServerHost(
        CouchCoopRuntimeHost runtime,
        string staticRoot,
        IPAddress? bindAddress = null,
        int preferredPort = 13337,
        string? resourceCacheRoot = null,
        Action<string>? log = null)
    {
        _runtime = runtime ?? throw new ArgumentNullException(nameof(runtime));
        StaticRoot = string.IsNullOrWhiteSpace(staticRoot) ? throw new ArgumentException("Static root is required.", nameof(staticRoot)) : staticRoot;
        _bindAddress = bindAddress ?? IPAddress.Loopback;
        _preferredPort = preferredPort;
        ResourceCacheRoot = resourceCacheRoot;
        _log = log ?? CouchCoopLog.Stderr;
        var lobby = new CouchCoopLobbyParticipation(_runtime);
        _headlessManager = CouchCoopMod.IsHeadlessClient
            ? null
            : HeadlessClientManager.TryCreate(
                netId => lobby.DisconnectClient(netId, requireSuccess: true),
                lobby.MaxCouchSeats,
                // Once the host is in a run its netcode refuses any client that is not already connected, so no
                // seat process may be launched — see HeadlessClientManager.RunInProgress.
                lobby.IsRunInProgress,
                (count, generation) => _connectionHosting?.SetOwnedSeatDemand(count, generation));
        _headlessManager?.ConfigureConnectionMonitoring(lobby.IsGamePlayerConnected, () => BaseUri?.Port ?? 0);
        Admission = new NetworkAdmissionLimiter(() => new CouchCoopLobbyParticipation(_runtime).MaxLobbyPlayers());
        _browserDemand = new((count, generation) =>
        {
            _inputGuardDemand(count, generation);
            _connectionHosting?.SetBrowserDemand(count, generation);
        });
        if (!IsHeadlessClient) _connectionHosting = new(_runtime, _headlessManager);
        _generation = new BuiltInBrowserServerGeneration(this);
    }

    public Action<int, long> CreateBrowserDemandReporter() => _browserDemand.CreateReporter();

    public object RuntimeHost => _runtime;

    public object? HeadlessManager => _headlessManager;

    public string StaticRoot { get; }

    public string? ResourceCacheRoot { get; }

    public bool IsHeadlessClient => CouchCoopMod.IsHeadlessClient;

    public Uri? BaseUri { get; private set; }

    public bool IsRunning => _listener is not null && BaseUri is not null;

    /// <summary>
    /// The port the OPT-IN TLS listener actually bound, or <c>0</c> when the secure origin is not running.
    /// </summary>
    /// <remarks>
    /// Callers must advertise THIS, never <see cref="SecureBrowserListener.PreferredPortOffset"/> applied to
    /// the HTTP port — the secure listener port-walks exactly like the HTTP one, and the QR must carry the
    /// port we bound, not the one we wanted.
    /// </remarks>
    public int SecurePort => _secureListener?.Port ?? 0;

    public void Log(string message) => _log(message);

    /// <summary>
    /// Bring up the opt-in TLS listener beside the running HTTP one. Best-effort and idempotent: returns
    /// <see langword="false"/> without touching anything when there is no certificate or no free port.
    /// </summary>
    /// <remarks>
    /// Separate from <see cref="StartAsync"/> on purpose. Certificate acquisition is a network round-trip
    /// that must NEVER delay the browser server coming up, so the host starts HTTP first and calls this
    /// later, once <see cref="SecureOriginCertificates"/> has an answer.
    /// </remarks>
    public bool TryStartSecureListener(SecureOriginCertificates certificates, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(certificates);

        if (_secureListener?.IsRunning == true)
        {
            return true;
        }

        if (BaseUri is null || certificates.Certificate is null)
        {
            return false;
        }

        var listener = new SecureBrowserListener(_bindAddress, DispatchSecureClientAsync, _log, Admission);
        if (!listener.TryStart(
                certificates.Certificate,
                BaseUri.Port + SecureBrowserListener.PreferredPortOffset,
                certificates.Intermediates,
                cancellationToken))
        {
            return false;
        }

        _secureListener = listener;
        // Published so the /secure-port route can report it: a HOST that redirects a TLS viewer to this
        // instance has no other way to learn the port we actually walked to.
        SecureOriginEndpoint.Publish(listener.Port);
        _log($"secure-origin listening port={listener.Port}");
        return true;
    }

    // The TLS twin of DispatchClientAsync. The stream is already decrypted and the socket is owned by the
    // secure listener, so this only has to find the live generation and hand the stream over.
    //
    // A generation that predates the secure origin (any hot-reloaded logic assembly, whose
    // ICouchCoopHotGeneration comes from the shared contracts assembly and therefore cannot know about
    // streams) is answered honestly with 503 rather than being handed a socket it would try to re-read from
    // scratch. Hot-reload is a development path; the shipped built-in generation implements the stream seam.
    private async Task DispatchSecureClientAsync(TcpClient client, Stream stream, CancellationToken cancellationToken)
    {
        ICouchCoopHotGeneration? generation;
        lock (_generationGate)
        {
            generation = _generation;
        }

        if (generation is BuiltInBrowserServerGeneration builtIn)
        {
            await builtIn.ServeAsync(
                stream,
                isSecure: true,
                (client.Client.RemoteEndPoint as IPEndPoint)?.Address ?? IPAddress.None,
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (generation is ICouchCoopStreamGeneration streamGeneration)
        {
            await streamGeneration.ServeAsync(stream, isSecure: true, cancellationToken).ConfigureAwait(false);
            return;
        }

        try
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.ServiceUnavailable,
                generation is null ? "hot-reload-generation-unavailable" : "secure-origin-unsupported-generation",
                generation is null
                    ? "The CouchCoop browser server generation has not loaded yet."
                    : "The active hot-reload generation cannot serve the secure origin; use the plain-HTTP address.",
                cancellationToken).ConfigureAwait(false);
        }
        catch
        {
        }
    }

    // A hot-reload GENERATION SWAP is not a restart: the listener, the port and every open socket survive
    // it. Anything this class reports as a start or a stop would therefore be describing an event that did
    // not happen to anyone holding a connection.
    public async Task<Uri> StartAsync(CancellationToken cancellationToken = default)
    {
        if (_listener is not null && BaseUri is not null)
        {
            return BaseUri;
        }

        TcpListener listener;
        try
        {
            // A HOST still walks upward when its preferred port is taken: several game instances share one
            // machine, and `scripts/lib/instance-port.mjs` reads the walked port back out of BrowserPortFile for
            // exactly that reason. A SEAT may NOT — the host hands the browser the port it assigned and probes
            // that same port, so a walked seat serves an address nobody will ever ask for. See
            // HeadlessSeatPortGuard, which owns both halves of that rule.
            listener = HeadlessSeatPortGuard.Bind(_bindAddress, _preferredPort, IsHeadlessClient, cancellationToken);
        }
        catch (SeatPortUnavailableException failure)
        {
            // Names the cause to the host over the authenticated control channel, then terminates this process.
            // Never returns; the rethrow exists so the compiler (and a future non-exiting variant) sees a path.
            HeadlessSeatPortGuard.ReportAndExit(failure);
            throw;
        }

        _listener = listener;
        _stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        BaseUri = new Uri($"http://{_bindAddress}:{((IPEndPoint)listener.LocalEndpoint).Port}/");
        // …and say which port we actually BOUND. THIS is the listener a real game binds — the twin in
        // `CouchCoopBrowserServer.StartAsync` serves the standalone/test path — so publishing only there
        // left the file missing on exactly the process anything outside would want to find.
        BrowserPortFile.Publish(BaseUri.Port);
        // The same number, over the authenticated heartbeat, because the file is the wrong channel for the one
        // reader that most needs it: the host. It is written into THIS process's Godot user dir, which the host
        // does not open (only tooling does), so the host used to have no way to notice it was about to hand a
        // browser a port this process is not serving — until the 75-second deadline.
        HeadlessConnectionReporter.PublishBrowserPort(BaseUri.Port);
        _acceptLoop = AcceptLoopAsync(_stop.Token);
        return BaseUri;
    }

    public async Task ReplaceGenerationAsync(
        ICouchCoopHotGeneration generation,
        int generationNumber,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(generation);

        ICouchCoopHotGeneration? previous;
        int previousNumber;
        lock (_generationGate)
        {
            previous = _generation;
            previousNumber = _generationNumber;
            _generation = generation;
            _generationNumber = generationNumber;
        }

        if (previous is not null)
        {
            await StopAndDisposeGenerationAsync(
                previous,
                new HotReloadShutdownContext("server-reload", generationNumber),
                cancellationToken).ConfigureAwait(false);
            _log($"hot-reload generation swapped previous={previousNumber} active={generationNumber}");
        }
        else
        {
            _log($"hot-reload generation activated active={generationNumber}");
        }
    }

    /// <summary>
    /// Send every attached browser a <c>server-reload</c> envelope carrying <paramref name="reason"/> and close
    /// its socket, WITHOUT tearing down the listener or the generation itself. Used as the headless instance's
    /// last gasp before it exits on a permanent host disconnect: the viewers learn why their view is going away
    /// (and can act on the reason) instead of only seeing a bare TCP close.
    /// <para>
    /// Reuses the hot-reload shutdown path deliberately — it is the one code path that already broadcasts to and
    /// closes every connection in order. Best-effort: a no-op when no generation is loaded, and safe to call from
    /// any thread.
    /// </para>
    /// </summary>
    public Task CloseConnectionsAsync(string reason, CancellationToken cancellationToken = default)
    {
        ICouchCoopHotGeneration? generation;
        int generationNumber;
        lock (_generationGate)
        {
            generation = _generation;
            generationNumber = _generationNumber;
        }

        return generation?.StopAsync(new HotReloadShutdownContext(reason, generationNumber), cancellationToken)
            ?? Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        _inputGuardDemand(0, long.MaxValue);
        _connectionHosting?.Dispose();
        _connectionHosting = null;
        if (_secureListener is not null)
        {
            await _secureListener.DisposeAsync().ConfigureAwait(false);
            _secureListener = null;
        }

        _stop?.Cancel();
        _listener?.Stop();
        // Before the accept loop is awaited: from here nothing is served on that port, and a reader that trusted
        // a stale file would hang on a socket that will never answer.
        BrowserPortFile.Clear();

        if (_acceptLoop is not null)
        {
            try
            {
                await _acceptLoop.ConfigureAwait(false);
            }
            catch
            {
            }
        }

        ICouchCoopHotGeneration? generation;
        lock (_generationGate)
        {
            generation = _generation;
            _generation = null;
        }

        if (generation is not null)
        {
            await StopAndDisposeGenerationAsync(
                generation,
                new HotReloadShutdownContext("server-stop", _generationNumber),
                CancellationToken.None).ConfigureAwait(false);
        }

        _headlessManager?.Dispose();
        _stop?.Dispose();
        _stop = null;
        _acceptLoop = null;
        _listener = null;
        BaseUri = null;
    }

    private async Task AcceptLoopAsync(CancellationToken cancellationToken)
    {
        var listener = _listener ?? throw new InvalidOperationException("Server has not started.");
        while (!cancellationToken.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }

            // Before admission, deliberately: even a connection our own limiter turns away proves that inbound
            // packets reach this listener, which is the single thing HostReachabilityWatch is asking about.
            //
            // AND THIS IS THE LOOP A REAL HOST RUNS. There are three accept loops carrying this call; the twin
            // in CouchCoopBrowserServer.StartAsync serves the standalone/test path that a shipped host never
            // reaches (the `_mirrorSeats` note at the top of that file records the last feature wired only
            // there and dead in production). While this third loop was missing it, every plain-HTTP arrival on
            // a shipped host was invisible to the watch: the 90s "no phone or browser has connected" row was
            // measured live, twice, behind a phone that had already made three inbound requests — which the
            // arrival log recorded, because ConnectionArrivalLog is written deeper, inside the generation's
            // request handling. A false "nobody can reach this host" is the exact wrong signal this whole
            // diagnostic exists to delete, so HostReachabilityAcceptLoopTests pins the call from outside.
            CouchCoop.Mod.Connections.HostReachabilityWatch.Shared.NoteInboundConnection();

            var lease = Admission.TryAcquireHttp((client.Client.RemoteEndPoint as IPEndPoint)?.Address);
            if (lease is null)
            {
                client.Dispose();
                continue;
            }
            Admission.AttachHttp(client, lease);
            try
            {
                _ = Task.Run(() => DispatchClientAsync(client, cancellationToken), CancellationToken.None);
            }
            catch
            {
                Admission.TakeAttachedHttp(client)?.Dispose();
                client.Dispose();
                throw;
            }
        }
    }

    private async Task DispatchClientAsync(TcpClient client, CancellationToken cancellationToken)
    {
        try
        {
            ICouchCoopHotGeneration? generation;
            lock (_generationGate)
            {
                generation = _generation;
            }

            if (generation is null)
            {
                using var disposeClient = client;
                try
                {
                    await using var stream = client.GetStream();
                    await HttpResponseWriter.WriteJsonErrorAsync(
                        stream,
                        HttpStatusCode.ServiceUnavailable,
                        "hot-reload-generation-unavailable",
                        "The CouchCoop browser server generation has not loaded yet.",
                        cancellationToken).ConfigureAwait(false);
                }
                catch
                {
                }

                return;
            }

            await generation.HandleClientAsync(client, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            // A generation normally takes ownership of the attached lease. If it failed before doing so (or no
            // generation was active), reclaim it here so the listener's bounded task slot cannot leak.
            Admission.TakeAttachedHttp(client)?.Dispose();
        }
    }

    private static async Task StopAndDisposeGenerationAsync(
        ICouchCoopHotGeneration generation,
        HotReloadShutdownContext context,
        CancellationToken cancellationToken)
    {
        try
        {
            await generation.StopAsync(context, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            await generation.DisposeAsync().ConfigureAwait(false);
        }
    }

    private sealed class BuiltInBrowserServerGeneration(HotReloadableBrowserServerHost host)
        : ICouchCoopHotGeneration, ICouchCoopStreamGeneration
    {
        private readonly CouchCoopBrowserServer _server = new(
            new StaticSpaFileProvider(host.StaticRoot),
            new CachedSpirectlAssetHttpAdapter(new SpirectlAssetHttpAdapter(host._runtime.Assets, host._runtime), new SpirectlAssetBinaryCache()),
            new BrowserStateEnvelopeFactory(host._runtime),
            resourceCacheRoot: host.ResourceCacheRoot,
            headlessManager: host._headlessManager,
            isHeadlessClient: host.IsHeadlessClient,
            log: host.Log,
            admission: host.Admission,
            onBrowserDemandChanged: host.CreateBrowserDemandReporter());

        public string DescribeOverlayLayoutJson()
            => string.Empty;

        public Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken)
            => _server.HandleClientAsync(client, cancellationToken);

        public Task ServeAsync(Stream stream, bool isSecure, CancellationToken cancellationToken)
            => _server.ServeAsync(stream, isSecure, cancellationToken);

        public Task ServeAsync(Stream stream, bool isSecure, IPAddress remoteAddress, CancellationToken cancellationToken)
            => _server.ServeAsync(stream, isSecure, remoteAddress, cancellationToken);

        public Task StopAsync(HotReloadShutdownContext context, CancellationToken cancellationToken)
            => _server.StopGenerationAsync(context.Reason, cancellationToken);

        public async ValueTask DisposeAsync()
        {
            await _server.StopGenerationAsync("built-in-generation-dispose").ConfigureAwait(false);
        }
    }
}
