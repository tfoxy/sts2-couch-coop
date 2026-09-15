using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Session;
using CouchCoop.MirrorProtocol.Assets;
using CouchCoop.MirrorProtocol.SceneModel;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Core.State;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Server;

public sealed class CouchCoopBrowserServer(
    StaticSpaFileProvider staticFiles,
    ICouchCoopAssetHttpAdapter assets,
    BrowserStateEnvelopeFactory? envelopeFactory = null,
    IPAddress? bindAddress = null,
    int preferredPort = 13337,
    string? resourceCacheRoot = null,
    HeadlessClientManager? headlessManager = null,
    bool? isHeadlessClient = null,
    Action<string>? log = null,
    NetworkAdmissionLimiter? admission = null) : IAsyncDisposable
{
    private readonly IPAddress _bindAddress = bindAddress ?? IPAddress.Loopback;
    private readonly Action<string> _log = log ?? (message => Console.Error.WriteLine(message));
    private readonly RateLimitedDiagnosticLog _networkDiagnostics = new(log ?? (message => Console.Error.WriteLine(message)));
    private readonly bool _isHeadlessClient = isHeadlessClient ?? CouchCoopMod.IsHeadlessClient;
    private readonly bool _ownsHeadlessManager = headlessManager is null;
    private readonly BrowserSessionRegistry _sessionRegistry = new();
    private readonly ConcurrentDictionary<Guid, CouchCoopWebSocketConnection> _connections = new();
    private readonly NetworkAdmissionLimiter _admission = admission ?? new NetworkAdmissionLimiter(
        () => envelopeFactory is null ? null : new CouchCoopLobbyParticipation(envelopeFactory.RuntimeHost).MaxLobbyPlayers());
    private readonly object _observerGate = new();
    private CouchCoopStateObserver? _observer;
    private CouchCoopSceneObserver? _sceneObserver;
    // Encounter-load geoclip prerender (OFF by default — COUCHCOOP_PRERENDER_ENCOUNTER_GEOCLIPS=1). Its lifetime is
    // deliberately the scene observer's: it reads the observer's retained keyframe for its roster, and the observer
    // exists only while a mirror client is STREAMING, which is also the only condition under which anything would
    // ever ask for a geoclip.
    private CouchCoopEncounterGeoclipPrerender? _encounterGeoclips;
    // The hint collector for the MIRROR path: the hint hub fans out to every subscriber, so the mirror keeps its
    // own buffer, drained (destructively) by BroadcastSceneDelta.
    private CouchCoopAnimationHintCollector? _mirrorHintCollector;
    private int _mirrorConnectionCount;
    // WS-B stream gate: how many of the mirror connections above currently WANT the scene stream. The scene
    // observer (the producer's whole-tree walk — by far the most expensive thing this host does) is driven by
    // THIS number, not by _mirrorConnectionCount: while every viewer sits on the join picker the walk stops
    // entirely. The remainder (_mirrorConnectionCount - _streamingMirrorConnectionCount) is the GATED count,
    // which conversely keeps the (much cheaper) state observer alive — see RefreshObserversLocked.
    private int _streamingMirrorConnectionCount;
    // Stage-B walk skip: how many STREAMING mirror connections still NEED the live combat bg subtree (their
    // staticBg declaration is off). Recomputed from the live
    // connection set in RefreshObserversLocked (no balanced bookkeeping: connect/disconnect/gate-flip all funnel
    // through it, and a staticBg settings flip funnels through OnConnectionStaticBgChanged). Guarded by
    // _observerGate like the counts above.
    private int _bgStreamNeededCount;
    // The last desired-skip value handed to the tracker, so the (deferred, main-thread) stamp work is scheduled on
    // real transitions only. Guarded by _observerGate.
    private bool _bgSkipDesired;
    private TcpListener? _listener;
    // Non-null on the host (slot 1); null on headless client instances (they only serve one
    // browser player and never spawn further headless instances). The eviction callback lets a reconnect
    // respawn force-disconnect a stale ENet peer still holding its netId (so the same-netId rejoin isn't
    // rejected as an IdCollision); routed through the host's CouchCoopLobbyParticipation.DisconnectClient.
    private readonly HeadlessClientManager? _headlessManager = headlessManager ?? CreateHeadlessManager(
        envelopeFactory,
        isHeadlessClient ?? CouchCoopMod.IsHeadlessClient);
    // ONE per host, shared by every per-connection envelope factory: it holds the grace-window bookkeeping that
    // decides whether a live-but-disconnected seat is still cold-starting or is a zombie, which a per-connection
    // instance would reset on every reconnect. Built on FIRST USE (the reap needs a lobby participation object,
    // which needs the envelope factory's runtime host, so it cannot be a field initializer).
    //
    // IT USED TO BE BUILT IN StartAsync, WHICH THE SHIPPED PATH NEVER CALLS. HotReloadableBrowserServerHost owns
    // the TCP listener and hands each accepted socket straight to a generation's HandleClientAsync, so on a real
    // host this field stayed null for the process's whole life: every connection got a null directory, which is
    // the documented "no opinion" degradation — EVERY seat reports ready and RefuseJoin never refuses. The seat
    // status was therefore inert in production while the standalone server and the unit tests (both of which do
    // call StartAsync) exercised it correctly. Building it where it is USED is what makes the two agree.
    private MirrorSeatDirectory? _mirrorSeats;
    private readonly object _mirrorSeatsGate = new();
    private CancellationTokenSource? _stop;
    private Task? _acceptLoop;
    private CouchCoopSpineClipProvider? _spineClips;
    // The managed geoclip cache (the /geoclips/ route's SECOND root) and its on-demand producer, both built on
    // first use like _spineClips. Constructing the store touches no filesystem — it only resolves a path.
    private CouchCoopGeoclipStore? _geoclipStore;
    private CouchCoopGeoclipProvider? _geoclips;

    private static HeadlessClientManager? CreateHeadlessManager(
        BrowserStateEnvelopeFactory? envelopeFactory,
        bool isHeadlessClient)
    {
        if (isHeadlessClient)
        {
            return null;
        }

        if (envelopeFactory is null)
        {
            return HeadlessClientManager.TryCreate(null, null);
        }

        var runtimeHost = envelopeFactory.RuntimeHost;
        return HeadlessClientManager.TryCreate(
            netId => new CouchCoopLobbyParticipation(runtimeHost).DisconnectClient(netId, requireSuccess: true),
            // How many seats the live lobby has room for — the stock four-player cap unless a multiplayer
            // limit mod raised it.
            () => new CouchCoopLobbyParticipation(runtimeHost).MaxCouchSeats());
    }
    // Static-background image producer for the /bg/ route (lazily built like _spineClips).
    private CouchCoopStaticBackgroundProvider? _staticBackgrounds;
    // Static-background tracker: Stage-A probe/publish half (fed screen changes off the scene stream, publishes
    // the current combat bg descriptor, re-sends sessions when it changes) + Stage-B stamping half (deferred
    // main-thread walk-skip stamping driven by the unanimity aggregate). Built lazily because the resend callback
    // needs `this`; TWO creation paths now race (the scene-observer thread via BroadcastSceneDelta, and whichever
    // thread runs RefreshBgSkipLocked's first real transition), so creation is CAS-guarded — see StaticBgTracker.
    private CouchCoopStaticBackgroundTracker? _staticBgTracker;

    // The one tracker instance (CAS-guarded lazy creation; the loser's instance is discarded before it holds any
    // state). Cheap to construct — safe to call under _observerGate.
    private CouchCoopStaticBackgroundTracker StaticBgTracker
    {
        get
        {
            var existing = _staticBgTracker;
            if (existing is not null)
            {
                return existing;
            }

            var created = new CouchCoopStaticBackgroundTracker(
                onPublishedChanged: () =>
                {
                    foreach (var connection in _connections.Values)
                    {
                        _ = connection.ResendSessionAsync(CancellationToken.None);
                    }
                },
                log: _log,
                warmVariant: WarmPublishedStaticBackground);
            return Interlocked.CompareExchange(ref _staticBgTracker, created, null) ?? created;
        }
    }
    // Track F2a: content-addressed ASTC transcode cache for the /res?fmt=astc variant (lazily built like the two
    // above). Null-safe: when no transcode root resolves the route just serves the original bytes.
    private AstcTranscodeCache? _astcCache;

    public Uri? BaseUri { get; private set; }
    public bool IsRunning => _listener is not null && BaseUri is not null;

    // The opt-in TLS twin of _listener. Null unless a caller supplied a certificate via
    // TryStartSecureListener; the plain-HTTP listener above is always on and never depends on this.
    private SecureBrowserListener? _secureListener;

    /// <summary>The port the opt-in TLS listener bound, or <c>0</c> when it is not running.</summary>
    public int SecurePort => _secureListener?.Port ?? 0;

    /// <summary>
    /// Bring up the opt-in TLS listener beside this server's HTTP one, port-walking from the HTTP port plus
    /// <see cref="SecureBrowserListener.PreferredPortOffset"/>. Best-effort: returns <see langword="false"/>
    /// when there is no certificate, no HTTP listener yet, or no free port.
    /// </summary>
    /// <remarks>
    /// This is the standalone-server and test path. The SHIPPED host does not come through here — it uses
    /// <see cref="HotReloadableBrowserServerHost"/>, which owns its own listener and has its own
    /// <c>TryStartSecureListener</c>. Both exist deliberately: a feature wired only into <c>StartAsync</c>
    /// would be exercised by every test and dead in production (see the note on <c>_mirrorSeats</c> above
    /// for the last time that happened).
    /// </remarks>
    public bool TryStartSecureListener(
        System.Security.Cryptography.X509Certificates.X509Certificate2? certificate,
        System.Security.Cryptography.X509Certificates.X509Certificate2Collection? intermediates = null,
        CancellationToken cancellationToken = default)
    {
        if (_secureListener?.IsRunning == true)
        {
            return true;
        }

        if (BaseUri is null || certificate is null)
        {
            return false;
        }

        var listener = new SecureBrowserListener(
            _bindAddress,
            (client, stream, token) => ServeAsync(
                stream,
                isSecure: true,
                (client.Client.RemoteEndPoint as IPEndPoint)?.Address ?? IPAddress.None,
                token),
            _log,
            _admission);
        if (!listener.TryStart(
                certificate,
                BaseUri.Port + SecureBrowserListener.PreferredPortOffset,
                intermediates,
                cancellationToken))
        {
            return false;
        }

        _secureListener = listener;
        // Published so the /secure-port route can report it: a HOST that redirects a TLS viewer to this
        // instance has no other way to learn the port we actually walked to.
        SecureOriginEndpoint.Publish(listener.Port);
        _log($"[couchcoop] secure-origin listening port={listener.Port}");
        return true;
    }

    // NO host-connectivity-log emission on this class's Start/Stop, deliberately. This is the STANDALONE
    // twin — the unit suite, the harnesses, `HostedServerHarness` — while a real game host runs
    // HotReloadableBrowserServerHost via CouchCoopHostUiServices, which is where B1/B3/B6 are emitted. A
    // line here would put "Phone connection ready" on a host's television once per test server.
    public async Task<Uri> StartAsync(CancellationToken cancellationToken = default)
    {
        // Warm it here too so a standalone-server host pays the build before its first request rather than on it.
        // Not load-bearing any more — MirrorSeats() builds on demand — but harmless and keeps the cost off the
        // connection path.
        MirrorSeats();

        if (_listener is not null && BaseUri is not null)
        {
            return BaseUri;
        }

        for (var port = preferredPort; port <= ushort.MaxValue; port++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var listener = new TcpListener(_bindAddress, port);
            try
            {
                listener.Start();
                _listener = listener;
                _stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                BaseUri = new Uri($"http://{_bindAddress}:{((IPEndPoint)listener.LocalEndpoint).Port}/");
                // …and say which port we actually WALKED TO. `preferredPort` is a preference — the loop above is
                // the whole reason — so a launcher that only knows the instance name has no other way to find us.
                BrowserPortFile.Publish(BaseUri.Port);
                _acceptLoop = AcceptLoopAsync(_stop.Token);
                return BaseUri;
            }
            catch (SocketException)
            {
                listener.Stop();
            }
        }

        throw new InvalidOperationException($"No local port was available at or above {preferredPort}.");
    }

    private void RegisterConnection()
    {
        lock (_observerGate)
        {
            _mirrorConnectionCount++;
            RefreshObserversLocked();
        }
    }

    private void UnregisterConnection()
    {
        lock (_observerGate)
        {
            _mirrorConnectionCount = Math.Max(0, _mirrorConnectionCount - 1);
            RefreshObserversLocked();
        }
    }

    // WS-B: one mirror connection's scene stream was gated on (true) or off (false). The connection guarantees the
    // calls are balanced (it reports `false` on teardown if it was still streaming), so the total is exact across
    // gate flips and disconnects alike.
    private void RegisterSceneStreaming(bool streaming)
    {
        lock (_observerGate)
        {
            _streamingMirrorConnectionCount = streaming
                ? _streamingMirrorConnectionCount + 1
                : Math.Max(0, _streamingMirrorConnectionCount - 1);
            RefreshObserversLocked();
        }
    }

    // Mirror connections currently GATED (connected, but not asking for the scene stream) — i.e. viewers parked on
    // the join picker.
    private int GatedMirrorConnectionsLocked => Math.Max(0, _mirrorConnectionCount - _streamingMirrorConnectionCount);

    private void RefreshObserversLocked()
    {
        // A GATED mirror viewer is the ONLY thing that keeps the STATE observer alive, and it must:
        // RebroadcastSessionsIfRosterChanged is driven solely from here, and a re-sent `session` is the ONLY way a
        // viewer sitting on the picker learns the host left the multiplayer screen (its `screen.mirrorMode` is what
        // the client's gate decision reads). Without this the gate would latch shut — the scene observer it used to
        // ride on is exactly the thing the gate just switched off. This is also the fix for the picker's roster
        // going stale on an already-open connection.
        if (GatedMirrorConnectionsLocked > 0)
        {
            StartStateObserverLocked();
        }
        else
        {
            StopStateObserverLocked();
        }

        // STREAMING mirror connections — not merely connected ones — drive the scene producer.
        if (_streamingMirrorConnectionCount > 0)
        {
            // Collector BEFORE the scene observer: it must be subscribed — which enables the producer's lite
            // tween capture — before deltas start flowing so hints aren't missed.
            StartMirrorHintCollectorLocked();
            StartSceneObserverLocked();
        }
        else
        {
            StopSceneObserverLocked();
            StopMirrorHintCollectorLocked();
        }

        RefreshBgSkipLocked();
    }

    // Stage-B walk skip: recompute the unanimity aggregate and hand a CHANGED desired-skip to the tracker (whose
    // stamping half defers the actual SetMeta/RemoveMeta onto the game main thread; inert in a Godot-less host).
    // Runs under _observerGate on every connection/gate/staticBg transition. The needed count is recomputed by
    // iterating the live connection set rather than kept by balanced deltas: a connection's staticBg and streaming
    // bits flip on different threads, and iteration under the gate cannot drift. A connection that is registered
    // in _connections but not yet stream-counted only ever errs toward needed>0 — i.e. toward NOT skipping — which
    // is the safe direction.
    private void RefreshBgSkipLocked()
    {
        var needed = 0;
        foreach (var connection in _connections.Values)
        {
            if (NeedsBgStream(connection.WantsSceneStream, connection.WantsStaticBg))
            {
                needed++;
            }
        }

        _bgStreamNeededCount = needed;
        var desired = ComputeBgSkipDesired(_streamingMirrorConnectionCount, needed);
        if (desired == _bgSkipDesired)
        {
            return;
        }

        _bgSkipDesired = desired;
        StaticBgTracker.SetDesiredSkip(desired);
    }

    // Stage-B walk skip, the per-connection classification: a connection needs the live combat background subtree
    // only while it is streaming and has not declared static-background rendering. Pure so the unanimity rule is
    // unit-testable.
    internal static bool NeedsBgStream(bool wantsSceneStream, bool wantsStaticBg)
        => wantsSceneStream && !wantsStaticBg;

    // Stage-B walk skip, the unanimity decision: skip the combat bg subtree from the producer walk ONLY while
    // (a) somebody is actually streaming (zero viewers ⇒ the producer is stopped anyway, and a fresh viewer must
    // never connect into a stamped tree it did not vote for), and (b) NOBODY streaming still needs the subtree.
    // Pure so the truth table is unit-testable.
    internal static bool ComputeBgSkipDesired(int streamingMirrorConnections, int bgStreamNeededCount)
        => streamingMirrorConnections > 0 && bgStreamNeededCount == 0;

    // Scenario overload for the tuple form the tests speak: each entry is one MIRROR connection's
    // (WantsSceneStream, WantsStaticBg) pair. Composes the two pure rules above so they cannot drift.
    internal static bool ComputeBgSkipDesired(
        IReadOnlyList<(bool WantsSceneStream, bool WantsStaticBg)> mirrorConnections)
    {
        var streaming = 0;
        var needed = 0;
        foreach (var (wantsSceneStream, wantsStaticBg) in mirrorConnections)
        {
            if (wantsSceneStream)
            {
                streaming++;
            }

            if (NeedsBgStream(wantsSceneStream, wantsStaticBg))
            {
                needed++;
            }
        }

        return ComputeBgSkipDesired(streaming, needed);
    }

    // WARM-AT-PUBLISH admission: is at least one STREAMING viewer showing the static image right now? Derived
    // from the two counts the skip aggregate already keeps, with no second pass over the connection set: `needed`
    // is exactly "streaming AND NOT staticBg", so `streaming - needed` is "streaming AND staticBg". Deliberately
    // WEAKER than ComputeBgSkipDesired's unanimity: a mixed room (one viewer on the still, one on the live
    // scenery) still has somebody waiting on the picture, and warming for them is the whole point. Pure so the
    // truth table is unit-testable.
    internal static bool HasStaticBgViewer(int streamingMirrorConnections, int bgStreamNeededCount)
        => streamingMirrorConnections > bgStreamNeededCount;

    /// <summary>
    /// WARM-AT-PUBLISH (the tracker's <c>warmVariant</c> callback): render the just-published QUALIFIED variant
    /// now, so its immutable URL is backed by bytes before any client asks for it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY: the route may only RENDER the digest/frame the tracker is CURRENTLY publishing, and the host keeps no
    /// digest→layers history, so a fetch that arrives one publish late is not slow — it is a permanent
    /// <c>unknown-background-variant</c> 404 for that URL. Worse, it used to be self-sustaining: the client
    /// fail-opened on that 404, which folded <c>staticBg:false</c> onto the wire, which re-armed a deferred probe
    /// that could publish a different digest and lose the race again. Rendering at publish time takes the race off the
    /// table: the bytes land in the memory map and on disk, and the currency rule then only ever adjudicates
    /// whether to render, never whether to SERVE.
    /// </para>
    /// <para>
    /// COST: one render per room entry that publishes a qualified variant, even if nobody fetches it — measured
    /// on the live host at ~282 ms wall / ~111 ms of it blocking the game's main thread, 280 KB (see
    /// <c>/perf/bg.json</c>). Bounded three ways: only a qualified variant warms
    /// (<see cref="CouchCoopStaticBackgroundTracker.IsWarmableVariant"/>), only while somebody is actually showing
    /// a still (<see cref="HasStaticBgViewer"/>), and only through the SHARED
    /// <see cref="CouchCoopAssetExtractionGate"/>, so it can never overlap a spine bake.
    /// </para>
    /// <para>
    /// THREADING: called from the tracker's publish, which runs on the GODOT MAIN THREAD. Everything here must
    /// return immediately — hence the <c>Task.Run</c>; the render itself marshals back to the main thread inside
    /// the provider and would deadlock if awaited here. The two counts are read WITHOUT <c>_observerGate</c> on
    /// purpose: blocking the game's main thread on a lock that observer start/stop holds is not worth a warm
    /// heuristic, and a stale read costs at most one render that nobody needed (or skips one somebody did).
    /// </para>
    /// </remarks>
    private void WarmPublishedStaticBackground(CouchCoopStaticBackgroundState state)
    {
        if (_isHeadlessClient || envelopeFactory is null)
        {
            return; // a seat process cannot render; asset HTTP goes to the host origin anyway
        }

        if (!HasStaticBgViewer(_streamingMirrorConnectionCount, _bgStreamNeededCount))
        {
            return;
        }

        if (CouchCoopStaticBackgroundTracker.TryResolveVariantTarget(state) is not { } target)
        {
            return;
        }

        var provider = StaticBackgroundProvider(envelopeFactory);
        var (family, id) = target;
        // The digest and the frame are mutually exclusive by family (the provider throws on a mismatch), and the
        // layer set is only meaningful alongside a digest — pass the published state through unchanged so the
        // warmed key is byte-identical to the one the advertised URL parses back to.
        var layerPaths = state.Digest is null ? null : state.LayerPaths;
        _ = Task.Run(async () =>
        {
            try
            {
                var image = await provider
                    .GetImageAsync(family, id, state.Digest, layerPaths, allowRender: true, CancellationToken.None, state.EventFrame)
                    .ConfigureAwait(false);
                if (image.Error is not null)
                {
                    _log($"[couchcoop] static-bg-warm failed id={id} family={family} detail={image.Error.Code}");
                    return;
                }

                _log($"[couchcoop] static-bg-warm {image.CacheStatus} id={id} family={family} bytes={image.Bytes?.Length ?? 0}");
            }
            catch (Exception exception)
            {
                _log($"[couchcoop] static-bg-warm failed id={id} family={family} detail={exception.GetType().Name}: {exception.Message}");
            }
        });
    }

    // The one static-background provider instance, shared by the /bg/ route and the warm-at-publish path (which
    // reach it from different threads, hence the CAS rather than the route's old `??=`).
    private CouchCoopStaticBackgroundProvider StaticBackgroundProvider(BrowserStateEnvelopeFactory factory)
    {
        var existing = _staticBackgrounds;
        if (existing is not null)
        {
            return existing;
        }

        var created = new CouchCoopStaticBackgroundProvider(
            factory.RuntimeHost.Assets,
            new SpirectlAssetBinaryCache(resourceCacheRoot),
            _log,
            _isHeadlessClient);
        return Interlocked.CompareExchange(ref _staticBackgrounds, created, null) ?? created;
    }

    // Stage-B walk skip: one connection's staticBg declaration flipped via the `settings` message. Recompute under
    // the same gate every other transition uses.
    private void OnConnectionStaticBgChanged(bool wantsStaticBg)
    {
        _ = wantsStaticBg; // the aggregate recomputes from the live connection set
        lock (_observerGate)
        {
            RefreshBgSkipLocked();
        }
    }

    /// <summary>Test seam: the current (streaming, bg-needed, skip-desired) aggregate, read under the gate.</summary>
    internal (int StreamingMirrorConnections, int BgStreamNeeded, bool BgSkipDesired) BgSkipStateForTest()
    {
        lock (_observerGate)
        {
            return (_streamingMirrorConnectionCount, _bgStreamNeededCount, _bgSkipDesired);
        }
    }

    private void StartMirrorHintCollectorLocked()
    {
        if (envelopeFactory is null || _mirrorHintCollector is not null)
        {
            return;
        }

        var collector = new CouchCoopAnimationHintCollector(envelopeFactory.RuntimeHost, envelopeFactory.RuntimeHost);
        _mirrorHintCollector = collector;
        collector.Start();
    }

    private void StopMirrorHintCollectorLocked()
    {
        var collector = _mirrorHintCollector;
        if (collector is null)
        {
            return;
        }

        _mirrorHintCollector = null;
        collector.Dispose();
    }

    // Subscribe ONCE to the live state watcher. Nothing on this path is broadcast as game state any more — the
    // observer exists so a GATED mirror viewer's `session` envelope stays live (roster / run status /
    // `screen.mirrorMode`) and so a run end can reap detached headless seats. Lazy: it runs only while at least
    // one mirror viewer is parked on the join picker (see RefreshObserversLocked).
    private void StartStateObserverLocked()
    {
        if (envelopeFactory is null || _observer is not null)
        {
            return;
        }

        var observer = new CouchCoopStateObserver(envelopeFactory.RuntimeHost, envelopeFactory.RuntimeHost);
        observer.StateChanged += BroadcastState;
        // Host-only: when the run ends (state.Run goes null → back to lobby / main menu), reap any headless we
        // kept alive for a browser that disconnected mid-run. Otherwise those kept-alive instances would linger
        // as phantom players into the next lobby. No-op while in a run or when nothing is detached.
        observer.StateChanged += ReapDetachedHeadlessOnRunEnd;
        _observer = observer;
        observer.Start();
    }

    private void StopStateObserverLocked()
    {
        var observer = _observer;
        if (observer is null)
        {
            return;
        }

        _observer = null;
        observer.Dispose();
        // Forget the roster fingerprint with the observer that produced it: the next generation must be free to
        // re-broadcast the very first snapshot it sees rather than compare against a signature from a previous,
        // possibly long-gone generation.
        Volatile.Write(ref _lastRosterSignature, null);
    }

    // Reaps kept-alive (detached) headless instances once the host leaves a run. The HeadlessClientManager only
    // holds detached slots after a mid-run browser disconnect; a reconnect clears them, so this fires only for
    // browsers that never came back. Runs on the observer's background thread (host only — null on headless).
    private void ReapDetachedHeadlessOnRunEnd(StateSnapshot snapshot)
    {
        if (_headlessManager is null || envelopeFactory is null || snapshot.Run is not null)
        {
            return;
        }

        var freed = _headlessManager.ReapDetachedSlots();
        if (freed.Count == 0)
        {
            return;
        }

        // Evict the (already game-disconnected at run-end) ENet peers and drop their name overrides. Idempotent —
        // DisconnectClient is a no-op if the peer is already gone.
        //
        // Clearing the override IS correct here, unlike on a plain browser disconnect: ReapDetachedSlots only
        // returns netIds whose name→slot CLAIM it just dropped, so these seats are genuinely gone (the player did
        // not come back before the run ended) and nothing is reserved for them. Every other disconnect path keeps
        // the claim for a reconnect and must therefore KEEP the override — clearing it would fall the nameplate back
        // to the durable mp_names.json roster, which may still name an earlier holder of that netId. See the
        // matching comment in CouchCoopWebSocketConnection's disconnect handler for the full rule.
        var lobby = new CouchCoopLobbyParticipation(envelopeFactory.RuntimeHost);
        foreach (var netId in freed)
        {
            lobby.DisconnectClient(netId);
            lobby.ClearClientName(netId);
        }
    }

    private void BroadcastState(StateSnapshot snapshot)
    {
        // Re-send each connection's `session` envelope when the lobby roster / run status changes, so the shared
        // join screen stays live — this is what lets the mirror carry no full state and still see a later joiner /
        // a lobby→run transition. Cheap signature gate so it fires only on real change.
        RebroadcastSessionsIfRosterChanged(snapshot);
    }

    // The roster/run signature last broadcast, so RebroadcastSessionsIfRosterChanged re-sends sessions only on a
    // real change (a player joining/leaving the lobby, a name resolving, or a lobby↔run transition) rather than
    // on every 50ms state tick. Touched only from the observer's single background thread.
    private string? _lastRosterSignature;

    private void RebroadcastSessionsIfRosterChanged(StateSnapshot snapshot)
    {
        var signature = RosterSignature(snapshot);
        if (string.Equals(signature, _lastRosterSignature, StringComparison.Ordinal))
        {
            return;
        }

        _lastRosterSignature = signature;

        // Host-only: the roster just changed, so republish the netId→name map the couch seats read
        // (mp_names.json). This is what names a player the seats CANNOT resolve themselves — the host (a
        // SteamID64 on a Steam-hosted session) and any genuine remote Steam friend — on instances that are
        // already running. Free here: the snapshot is in hand, and the signature gate above means it runs on a
        // real roster change rather than every 50ms tick.
        //
        // The join handler publishes too (CouchCoopWebSocketConnection), which is the path that matters for a
        // seat about to be spawned. Between them the only uncovered case is a remote player joining while NO
        // browser is attached to the host at all — this observer is connection-driven, so there is nobody to
        // drive it then, and the next join message closes the gap. Not worth a host-side polling timer.
        if (_headlessManager is not null)
        {
            try
            {
                _headlessManager.PublishRosterNames(CouchCoopLobbyParticipation.RosterNames(snapshot));
            }
            catch (Exception exception)
            {
                // Naming is cosmetic: never let it break the session rebroadcast this method exists for.
                Console.Error.WriteLine(
                    $"[couchcoop] publishing roster names failed: {exception.GetType().Name}: {exception.Message}");
            }
        }

        foreach (var connection in _connections.Values)
        {
            _ = connection.ResendSessionAsync(CancellationToken.None);
        }
    }

    // A cheap fingerprint of the join-screen-relevant state: run-vs-lobby, the lobby roster (id + display name),
    // AND the root scene. The scene matters because the session's Screen block (the title/kind/mirrorMode the
    // pre-join gate renders) is derived from it — without it, a viewer that connected on one screen kept a STALE
    // gate title forever (e.g. "screens/main_menu" while a run streamed behind it: the run pre-dated the connect,
    // so run-vs-lobby never changed and no session was re-sent). Scene transitions are infrequent, so the extra
    // re-sends are cheap. Connection counts aren't here (they change on browser connect/disconnect, not on a
    // state tick — the session reply on connect already carries the current count).
    // The host's shared seat directory (see _mirrorSeats). On a headless client instance — or a host that could not
    // resolve its own exe — there is no seat table to read, so the directory is built without one and reports every
    // seat ready: joinability is the game's call, and we simply have nothing extra to say.
    //
    // The reap is composed HERE rather than inside HeadlessClientManager because killing the zombie is only two
    // thirds of the cleanup. The host's ENet server keeps a SIGKILL'd peer registered — it would hold the netId and
    // make the next same-netId handshake fail as an IdCollision, i.e. the reap would break the very rejoin it exists
    // to enable — so the peer is evicted too. And the seat's display-name override is cleared, which is safe here
    // for the same reason it is safe in the run-end reap and NOT safe on a plain browser disconnect: ReapSeat drops
    // the slot's name CLAIM, so nothing is reserved for that netId any more and falling the nameplate back to the
    // durable mp_names.json roster cannot mislabel a seat that is still somebody's.
    /// <summary>
    /// The one <see cref="MirrorSeatDirectory"/> for this server generation, built on first use. Connections are
    /// accepted on the thread pool, so the build is locked: two sockets arriving together must not end up with two
    /// directories, or each would keep half the grace-window bookkeeping and a cold-starting seat could be judged
    /// on a timer that never accumulated.
    /// <para>Internal so the tests can pin that it is live WITHOUT <see cref="StartAsync"/> — see the field.</para>
    /// </summary>
    internal MirrorSeatDirectory MirrorSeats()
    {
        var existing = Volatile.Read(ref _mirrorSeats);
        if (existing is not null)
        {
            return existing;
        }

        lock (_mirrorSeatsGate)
        {
            return _mirrorSeats ??= CreateMirrorSeatDirectory();
        }
    }

    private MirrorSeatDirectory CreateMirrorSeatDirectory()
    {
        var manager = _headlessManager;
        if (manager is null || envelopeFactory is null)
        {
            return new MirrorSeatDirectory();
        }

        return new MirrorSeatDirectory(
            describeSeats: manager.DescribeSeats,
            reapSeat: netId =>
            {
                if (!manager.ReapSeat(netId))
                {
                    return; // nothing was running on that seat after all — another path already cleaned it up.
                }

                var lobby = new CouchCoopLobbyParticipation(envelopeFactory.RuntimeHost);
                lobby.DisconnectClient(netId);
                lobby.ClearClientName(netId);
            });
    }

    // Per-player CONNECTEDNESS is part of the signature on both branches (and the run branch has a per-player
    // signature at all only because of it). A player dropping out of a live run is precisely the moment the join
    // screen has to change — that seat becomes reclaimable, and the mirror picker is the only way back into it — and
    // nothing else about the run roster moves when it happens, so without this the picker of an already-connected
    // viewer stayed frozen on the pre-drop roster until some unrelated scene change shook it loose.
    private static string RosterSignature(StateSnapshot snapshot)
    {
        string scene = "|scene:" + (snapshot.RootScene ?? "");
        if (snapshot.Run is { } run)
        {
            return "run:" + string.Join(",", run.Players.Select(player => $"{player.Id}={player.IsConnected}")) + scene;
        }

        var lobby = snapshot.CharacterSelect?.Lobby;
        var players = lobby?.Players;
        if (players is null || players.Count == 0)
        {
            return "lobby:" + scene;
        }

        // The saved run's seats ride along on a load-game lobby: they are roster rows too (the union in
        // BrowserAssignmentClassifier.LobbyPlayers), so a save being loaded/cleared must re-send the session.
        var saved = lobby?.SavedRun is { } savedRun
            ? "|saved:" + string.Join(",", savedRun.Players.Select(player => player.Id))
            : "";
        return "lobby:"
            + string.Join(",", players.Select(player => $"{player.Id}={player.DisplayName}:{player.IsConnected}"))
            + saved
            + scene;
    }

    // Subscribe ONCE to the live runtime scene-tree watch and fan every revision out to connected mirror
    // clients as a pure `scene-delta` message. The observer is lazy: it exists only while at least one
    // mirror client is connected.
    private void StartSceneObserverLocked()
    {
        if (envelopeFactory is null || _sceneObserver is not null)
        {
            return;
        }

        var observer = new CouchCoopSceneObserver(envelopeFactory.RuntimeHost);
        observer.SceneDeltaChanged += BroadcastSceneDelta;
        _sceneObserver = observer;

        // Rides the observer, and is INERT unless an operator armed it. Started before observer.Start() so it
        // cannot miss the first screen change; its own first-screen rule then treats that as a baseline rather
        // than as an encounter that just loaded.
        var encounterGeoclips = new CouchCoopEncounterGeoclipPrerender(
            observer,
            // THE BROWSER SERVER'S OWN PROVIDER, not a private one. The /geoclips/ route answers from this exact
            // instance, so the sweep and a client request share one store root and one single-flight map by
            // construction rather than by two constructors happening to resolve the same path.
            () => GeoclipProvider(_geoclipStore ??= new CouchCoopGeoclipStore(resourceCacheRoot)) is { } provider
                ? new CouchCoopGeoclipPrerenderJob(
                    envelopeFactory.RuntimeHost,
                    provider,
                    _log,
                    new SpirectlAssetBinaryCache(resourceCacheRoot))
                : null,
            _log);
        _encounterGeoclips = encounterGeoclips;
        encounterGeoclips.Start();

        observer.Start();
    }

    private void StopSceneObserverLocked()
    {
        var observer = _sceneObserver;
        if (observer is null)
        {
            return;
        }

        // Before the observer: it unsubscribes from the observer's event and cancels any sweep still running for
        // the encounter that was on screen. A sweep outliving the last mirror client would be spending
        // main-thread time for nobody.
        _encounterGeoclips?.Dispose();
        _encounterGeoclips = null;

        _sceneObserver = null;
        observer.Dispose();
        // Drop the screen baseline with the generation that produced it: the next generation starts because a
        // client just turned its stream on off a FRESH session, so its first delta needs no announcement.
        Volatile.Write(ref _lastSceneScreenSignature, null);
    }

    // Hand each connection the raw delta; the connection COALESCES (latest-wins per node, bounded to one
    // in-flight send) and serializes its own coalesced delta in its drain. Coalescing per-connection — rather
    // than one shared pre-serialized frame fired fire-and-forget — is what stops a slow client building an
    // unbounded send backlog (which made a click's resulting delta land ~1s late).
    private void BroadcastSceneDelta(RuntimeSceneDelta delta)
    {
        // Drain the tween hints buffered since the last scene emit and ATTACH them to this delta (identical for
        // every mirror connection), so a fire-and-forget decorative tween arrives with the frame that froze/started
        // it and the client can replay it declaratively. Drained once here on the single scene-observer thread;
        // each connection's coalescer accumulates hints across folds. Empty when no tween started this interval.
        var withHints = AttachMirrorHints(delta);
        foreach (var connection in _connections.Values)
        {
            // WS-B stream gate: a mirror viewer that has NOT asked to watch (it is sitting on the join picker,
            // or it is the host socket a joined viewer kept open after its headless redirect) is skipped here —
            // no fold, no queue, no bytes.
            if (connection.WantsSceneStream)
            {
                connection.QueueSceneDelta(withHints);
            }
        }

        ResendSessionsIfSceneScreenChanged(delta);

        // Static background (Stage A): probe the live combat bg root on the same screen-signature cadence. The
        // tracker publishes {scenePath, layerSet, digest, url} for the session envelope's descriptor and re-sends
        // sessions (the accessor's callback) when the published value changes, so already-connected viewers learn
        // the new /bg/ URL without waiting for a roster change. Stage B rides the same probe: it re-applies the
        // current walk-skip stamp on the newly located bg root (a fresh room's root is a fresh, unstamped node).
        StaticBgTracker.OnSceneDelta(delta);
    }

    // The screen fingerprint last seen on the SCENE path, so a transition re-sends sessions at most once. Null
    // means "no baseline yet" (a fresh observer generation); the first delta then only records the baseline.
    // Touched only from the scene observer's single background thread, and reset when that observer stops.
    private string? _lastSceneScreenSignature;

    // Keep `screen.mirrorMode` LIVE for a mirror-only host. The session envelope is otherwise re-sent solely from
    // BroadcastState (RebroadcastSessionsIfRosterChanged), which needs the STATE observer — and that observer does
    // not run for a host whose only clients are streaming mirrors. Without a re-send, a viewer watching the host's
    // stream would never learn the host ENTERED a multiplayer screen, so the stream gate could never close.
    // The scene delta already carries the screen discriminator, so the change is free to detect here; only the
    // (rare) transition pays for the state pull inside ResendSessionAsync. Deliberately NOT calling
    // CouchCoopLobbyParticipation.DescribeMirrorJoinContext per delta — that marshals to the game thread.
    private void ResendSessionsIfSceneScreenChanged(RuntimeSceneDelta delta)
    {
        var signature = delta.ScreenType + "|" + delta.ScreenInstanceId;
        if (string.Equals(signature, _lastSceneScreenSignature, StringComparison.Ordinal))
        {
            return;
        }

        var hadBaseline = _lastSceneScreenSignature is not null;
        _lastSceneScreenSignature = signature;
        if (!hadBaseline)
        {
            return; // first delta of this observer generation — record the baseline, don't announce it
        }

        foreach (var connection in _connections.Values)
        {
            _ = connection.ResendSessionAsync(CancellationToken.None);
        }
    }

    // WS-3: forward the declarative card flights the producer started this tick, keyed to mirror nodes by exact
    // instance id like the tween hints below. Drained from the SAME collector (they ride the tween-hint hub) on the
    // same single scene-observer thread, so the two stay in the order the game produced them.
    private static List<CardFlightHintDelta>? CollectCardFlights(
        IReadOnlyList<TweenAnimationHint> pending)
    {
        List<CardFlightHintDelta>? flights = null;
        foreach (var hint in pending)
        {
            if (hint.CardFlight is not { } flight || hint.TargetInstanceId == 0)
            {
                continue;
            }

            (flights ??= []).Add(new CardFlightHintDelta(
                // Match RuntimeSceneNodeDelta.Id exactly (the watcher builds it as `GetInstanceId().ToString()`).
                TargetId: hint.TargetInstanceId.ToString(),
                TrailId: flight.TrailInstanceId == 0 ? null : flight.TrailInstanceId.ToString(),
                Start: flight.Start,
                End: flight.End,
                Control: flight.Control,
                Basis: flight.Basis,
                Speed0: flight.Speed0,
                Accel: flight.Accel,
                Duration: flight.Duration,
                Scale0: flight.Scale0,
                // The hint's DurationMs IS the producer's suppression window for these nodes (see
                // Sts2CardFlightHooks), i.e. exactly how long the client owns their transforms.
                WindowMs: hint.DurationMs,
                // WHICH flight this is: null = the shuffle sweep, "discard" = the hand→discard fly whose mover is
                // the real card the player just played. Carried verbatim, so a kind added upstream reaches the
                // client without a host change.
                Kind: flight.Kind,
                // The mover's resting on-screen angle, the seed the discard replay turns smoothly out of. Only ever
                // meaningful for a kind that uses it, so a shuffle entry keeps writing NO rot0 key at all — under
                // the wire's omit-when-null policy its bytes stay exactly what an already-deployed client reads.
                Rot0: flight.Kind is null ? null : flight.Rot0));
        }

        return flights;
    }

    private RuntimeSceneDelta AttachMirrorHints(RuntimeSceneDelta delta)
    {
        var pending = _mirrorHintCollector?.DrainPending();
        if (pending is null || pending.Count == 0)
        {
            return delta;
        }

        var cardFlights = CollectCardFlights(pending);

        List<TweenHintDelta>? hints = null;
        foreach (var hint in pending)
        {
            // WS-3 flights are carried on their own array (CollectCardFlights above) — they are integrated, not
            // eased, and their synthetic `property` is not a Godot property the client could map.
            if (hint.CardFlight is not null)
            {
                continue;
            }

            // Correlate to a mirror node by exact instance id (the id space RuntimeSceneNodeDelta.Id uses). A hint
            // whose target didn't resolve to a Godot object (id 0) can't be joined, so drop it.
            if (hint.TargetInstanceId == 0)
            {
                continue;
            }

            // Only REPLAYABLE hints (those carrying a declarative endpoint) are useful to the mirror — it ignores
            // timing-only ones — so dropping the rest keeps mirror bandwidth minimal (Part C).
            if (hint.EndTransform is null && hint.EndOpacity is null)
            {
                continue;
            }

            (hints ??= []).Add(new TweenHintDelta(
                // Match RuntimeSceneNodeDelta.Id exactly (the watcher builds it as `GetInstanceId().ToString()`).
                TargetId: hint.TargetInstanceId.ToString(),
                Property: hint.Property,
                To: hint.To,
                DurationMs: hint.DurationMs,
                Trans: hint.Trans,
                Ease: hint.Ease,
                EndTransform: hint.EndTransform,
                EndOpacity: hint.EndOpacity,
                Group: hint.Group,
                StartTransform: hint.StartTransform,
                StartOpacity: hint.StartOpacity));
        }

        if (hints is null && cardFlights is null)
        {
            return delta;
        }

        return delta with
        {
            Hints = hints ?? delta.Hints,
            CardFlights = cardFlights ?? delta.CardFlights,
        };
    }

    /// <inheritdoc cref="StartAsync"/>
    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        await StopGenerationAsync("server-stop", cancellationToken).ConfigureAwait(false);
        if (_ownsHeadlessManager)
        {
            _headlessManager?.Dispose();
        }

        if (_secureListener is not null)
        {
            await _secureListener.DisposeAsync().ConfigureAwait(false);
            _secureListener = null;
        }

        _stop?.Cancel();
        _listener?.Stop();
        // Before the accept loop is awaited: from here nothing is served on that port, and a reader that trusted a
        // stale file would hang on a socket that will never answer.
        BrowserPortFile.Clear();

        if (_acceptLoop is not null)
        {
            try
            {
                await _acceptLoop.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
            catch (SocketException)
            {
            }
        }

        _listener = null;
        _acceptLoop = null;
        _stop?.Dispose();
        _stop = null;
        BaseUri = null;
    }

    public async Task AcceptLoopAsync(CancellationToken cancellationToken = default)
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
            CouchCoop.Mod.Connections.HostReachabilityWatch.Shared.NoteInboundConnection();

            var lease = _admission.TryAcquireHttp((client.Client.RemoteEndPoint as IPEndPoint)?.Address);
            if (lease is null)
            {
                client.Dispose();
                continue;
            }
            _admission.AttachHttp(client, lease);
            try
            {
                _ = Task.Run(() => HandleClientAsync(client, cancellationToken), CancellationToken.None);
            }
            catch
            {
                _admission.TakeAttachedHttp(client)?.Dispose();
                client.Dispose();
                throw;
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
    }

    public async Task StopGenerationAsync(
        string reason = "server-reload",
        CancellationToken cancellationToken = default)
    {
        lock (_observerGate)
        {
            _mirrorConnectionCount = 0;
            _streamingMirrorConnectionCount = 0;
            StopSceneObserverLocked();
            StopStateObserverLocked();
            StopMirrorHintCollectorLocked();
        }

        var connections = _connections.Values.ToArray();
        await Task.WhenAll(connections.Select(connection =>
            connection.CloseForServerReloadAsync(reason, cancellationToken))).ConfigureAwait(false);

        _connections.Clear();

    }

    public async Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken)
    {
        using var disposeClient = client;
        using var lease = _admission.TakeAttachedHttp(client)
            ?? _admission.TryAcquireHttp((client.Client.RemoteEndPoint as IPEndPoint)?.Address);
        if (lease is null)
        {
            return;
        }
        // Disable Nagle: mirror scene-delta frames are small single writes, and Nagle interacting with the
        // client's delayed-ACK can stall each frame up to ~40ms. Best-effort — a socket that rejects the option
        // must not fail the connection.
        try { client.NoDelay = true; } catch (SocketException) { } catch (ObjectDisposedException) { }
        using var stream = client.GetStream();
        await ServeCoreAsync(stream, isSecure: false, lease, (client.Client.RemoteEndPoint as IPEndPoint)?.Address ?? IPAddress.None, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Serve one already-established byte stream — the TLS path's entry point.
    /// </summary>
    /// <remarks>
    /// <see cref="SecureBrowserListener"/> has already accepted the socket, set <c>NoDelay</c> and completed
    /// the TLS handshake, so it owns the <see cref="TcpClient"/> and hands us only the decrypted
    /// <see cref="SslStream"/>. Everything below this point is scheme-agnostic: the request reader, the
    /// response writer and the WebSocket connection all take a bare <see cref="Stream"/>, which is why the
    /// secure origin needed no second copy of the routing table.
    /// </remarks>
    public Task ServeAsync(Stream stream, CancellationToken cancellationToken)
        => ServeAsync(stream, isSecure: false, cancellationToken);

    /// <summary>
    /// Serve one already-established byte stream, stating explicitly whether it arrived over TLS.
    /// </summary>
    /// <remarks>
    /// <paramref name="isSecure"/> is passed as a FLAG rather than re-derived further down by testing the
    /// stream's runtime type. The scheme is known exactly once — at the listener that accepted the socket —
    /// and a type test buried in the join path would be both easy to get wrong (an SslStream can be wrapped)
    /// and impossible to exercise from a test that does not stand up real TLS. It matters because a joined
    /// seat is redirected to a headless instance BY PORT, and an https page may only be sent a wss port.
    /// </remarks>
    public async Task ServeAsync(Stream stream, bool isSecure, CancellationToken cancellationToken)
        => await ServeAsync(stream, isSecure, IPAddress.None, cancellationToken).ConfigureAwait(false);

    public async Task ServeAsync(Stream stream, bool isSecure, IPAddress remoteAddress, CancellationToken cancellationToken)
    {
        using var lease = _admission.TryAcquireHttp(remoteAddress);
        if (lease is null) return;
        await ServeCoreAsync(stream, isSecure, lease, remoteAddress, cancellationToken).ConfigureAwait(false);
    }

    private async Task ServeCoreAsync(
        Stream stream,
        bool isSecure,
        NetworkAdmissionLimiter.Lease httpLease,
        IPAddress remoteAddress,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);
        CouchCoopHttpRequest? request = null;
        try
        {
            request = await CouchCoopHttpRequest.TryReadAsync(stream, cancellationToken).ConfigureAwait(false);
            NetworkAdmissionLimiter.Lease? webSocketLease = null;
            if (request?.IsWebSocketUpgrade == true)
            {
                webSocketLease = _admission.TryAcquireWebSocket();
                if (webSocketLease is null)
                {
                    await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.ServiceUnavailable,
                        "websocket-capacity", "Too many WebSocket connections are active.", cancellationToken).ConfigureAwait(false);
                    return;
                }
                httpLease.Dispose();
            }

            using (webSocketLease)
            {
                await HandleRequestAsync(stream, request, isSecure, remoteAddress, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (HttpHeaderLimitException)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, (HttpStatusCode)431,
                "headers-too-large", "HTTP headers must be complete within 32 KiB.", cancellationToken).ConfigureAwait(false);
        }
        catch (HttpHeaderTimeoutException)
        {
            try { await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.RequestTimeout,
                "header-timeout", "HTTP headers must be complete within 10 seconds.", CancellationToken.None).ConfigureAwait(false); }
            catch { }
        }
        catch (Exception exception) when (exception is OperationCanceledException or ObjectDisposedException)
        {
        }
        catch (Exception exception) when (exception is IOException or SocketException && !IsAssemblyLoadFailure(exception))
        {
            _networkDiagnostics.Write("connection-closed",
                "[couchcoop] browser-server diagnostic code=connection-closed "
                + $"target={request?.Target ?? "<unread>"} detail={exception.GetType().Name}: {exception.Message}");
        }
        catch (Exception exception)
        {
            LogInternalServerError(request, exception);
            if (request?.IsWebSocketUpgrade == true)
            {
                return;
            }

            try
            {
                await HttpResponseWriter.WriteJsonAsync(
                    stream,
                    HttpStatusCode.InternalServerError,
                    CreateInternalServerError(request, exception),
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception writeException) when (writeException is IOException or SocketException or ObjectDisposedException or OperationCanceledException)
            {
                _networkDiagnostics.Write("internal-server-error-write-failed",
                    "[couchcoop] browser-server diagnostic code=internal-server-error-write-failed "
                    + $"detail={writeException.GetType().Name}: {writeException.Message}");
            }
        }
    }

    private async Task HandleRequestAsync(
        Stream stream,
        CouchCoopHttpRequest? request,
        bool isSecure,
        IPAddress remoteAddress,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return;
        }

        // CORS preflight. The SPA's own requests should never trigger one — they are GETs whose only header
        // is a CORS-safelisted `accept` — but a preflight that 405s is an opaque failure in a browser, and
        // answering it costs four lines. `Access-Control-Allow-Origin` rides along from WriteRawAsync.
        if (string.Equals(request.Method, "OPTIONS", StringComparison.OrdinalIgnoreCase))
        {
            await HttpResponseWriter.WriteBytesAsync(
                stream,
                (int)HttpStatusCode.NoContent,
                "No Content",
                [],
                "text/plain",
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS",
                    ["Access-Control-Allow-Headers"] = "accept, content-type, range",
                    ["Access-Control-Max-Age"] = "600",
                },
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.Path, "/internal/client-status", StringComparison.Ordinal))
        {
            await HandleHeadlessClientStatusAsync(stream, request, remoteAddress, cancellationToken).ConfigureAwait(false);
            return;
        }

        if (!string.Equals(request.Method, "GET", StringComparison.OrdinalIgnoreCase))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.MethodNotAllowed, "method-not-allowed", "Only GET is supported.", cancellationToken).ConfigureAwait(false);
            return;
        }

        // How a HOST learns this process's real secure port. A joined seat is redirected to its own headless
        // instance — a separate process with its own port-walked listeners — so the host cannot derive the
        // port and must ask. Always answers (0 means "no secure origin here"), and is deliberately plain
        // HTTP-reachable: the caller is the host on loopback, before any TLS is involved.
        if (string.Equals(request.Path, SecureOriginEndpoint.Route, StringComparison.Ordinal))
        {
            await HttpResponseWriter.WriteJsonAsync(
                stream,
                HttpStatusCode.OK,
                new { securePort = SecureOriginEndpoint.LocalSecurePort },
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.Path, StaticSpaFileProvider.BootManifestPath, StringComparison.Ordinal))
        {
            await HandleBootManifestRequestAsync(stream, request, cancellationToken).ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.Path, "/ws", StringComparison.Ordinal) && !request.IsWebSocketUpgrade)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.BadRequest,
                "invalid-websocket-upgrade",
                "Missing required WebSocket upgrade headers.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (request.IsWebSocketUpgrade)
        {
            // THE capability check. Every HTTP route above serves public game content behind a wildcard CORS
            // grant; this socket joins a seat and drives input, and no browser has ever applied CORS to a
            // WebSocket. So the Origin header is checked here — see CouchCoopWebOrigin for why an ABSENT
            // Origin is allowed (non-browser clients) and why same-origin is decided against the Host header.
            if (!CouchCoopWebOrigin.IsAllowedWebSocketOrigin(request.Header("Origin"), request.Header("Host")))
            {
                _networkDiagnostics.Write("websocket-origin-refused",
                    "[couchcoop] browser-server diagnostic code=websocket-origin-refused "
                    + $"origin={request.Header("Origin")} host={request.Header("Host")} "
                    + $"detail=set {CouchCoopWebOrigin.OriginCheckEnvironmentVariable}=0 to disable this check");
                await HttpResponseWriter.WriteJsonErrorAsync(
                    stream,
                    HttpStatusCode.Forbidden,
                    "origin-not-allowed",
                    "This page's origin is not allowed to open the game socket.",
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            if (envelopeFactory is null)
            {
                await HttpResponseWriter.WriteJsonErrorAsync(
                    stream,
                    HttpStatusCode.ServiceUnavailable,
                    "runtime-unavailable",
                    "The embedded spirectl runtime is not configured.",
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            var connectionEnvelopeFactory = new BrowserStateEnvelopeFactory(
                envelopeFactory.RuntimeHost,
                _sessionRegistry,
                androidApkUrl: () => staticFiles.TryResolveAndroidApkPath() is null
                    ? null
                    : "/" + StaticSpaFileProvider.AndroidApkFileName,
                // The host's ONE seat directory (see _mirrorSeats): its grace-window bookkeeping must outlive any
                // single connection, so the same instance is shared rather than one built per socket.
                mirrorSeats: MirrorSeats());
            await CouchCoopWebSocketConnection.AcceptAsync(
                    stream,
                    request,
                    connectionEnvelopeFactory,
                    _connections,
                    () => _observer,
                    () => _sceneObserver,
                    RegisterConnection,
                    UnregisterConnection,
                    RegisterSceneStreaming,
                    OnConnectionStaticBgChanged,
                    isSecure,
                    _headlessManager,
                    _isHeadlessClient,
                    cancellationToken).ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.RawPath, "/res", StringComparison.Ordinal))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.BadRequest,
                "invalid-resource-route",
                "Resource route must include a res:// path, e.g. /res/images/icon.png.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (request.RawPath.StartsWith("/res/", StringComparison.Ordinal))
        {
            // R6 P6-F2 — A `::`-QUALIFIED SUB-RESOURCE REQUEST. Godot addresses a resource embedded inside a text
            // resource as `<parent path>::<sub id>`, and the mirror streams those qualified paths verbatim, so
            // they arrive here percent-encoded into the last path segment. Minted as-is they become a key naming a
            // file that does not exist, and the answer is a 404 the client can only report as "source unresolved".
            //
            // There is no such asset to fetch, and there does not need to be: the sub-resource's text lives INSIDE
            // the parent, which the seam serves already. So the request is split at the LAST `::` (a res:// path
            // cannot contain one, and splitting last is what makes a hypothetical nested id come out whole), the
            // PARENT is fetched through the identical path below — same guards, same 20s bound, same 503/404
            // shapes — and the named sub-resource is extracted from those bytes.
            var decodedResourcePath = Uri.UnescapeDataString(request.RawPath["/res/".Length..]);
            var subMark = decodedResourcePath.LastIndexOf("::", StringComparison.Ordinal);
            string? subResourceId = null;
            if (subMark >= 0)
            {
                subResourceId = decodedResourcePath[(subMark + 2)..];
                decodedResourcePath = decodedResourcePath[..subMark];
                if (subResourceId.Length == 0
                    || decodedResourcePath.Contains("::", StringComparison.Ordinal)
                    || !BrowserResourcePath.IsSafeSelector(subResourceId)
                    || subResourceId.Contains(':'))
                {
                    await HttpResponseWriter.WriteJsonErrorAsync(
                        stream,
                        HttpStatusCode.BadRequest,
                        "invalid-resource-route",
                        "A sub-resource request must name one: /res/{path}::{sub-resource-id}.",
                        cancellationToken).ConfigureAwait(false);
                    return;
                }

            // `?format` selects how the PARENT document is rendered (raw, PNG), which is a question that has
                // no meaning here: a sub-resource is extracted from the parent's raw text and answers as text.
                // Refused rather than ignored, so a caller asking for something impossible is told so.
                if (request.QueryValues.ContainsKey("format"))
                {
                    await HttpResponseWriter.WriteJsonErrorAsync(
                        stream,
                        HttpStatusCode.BadRequest,
                        "invalid-resource-route",
                        "?format is not supported for a ::-qualified sub-resource; it is served as raw text.",
                        cancellationToken).ConfigureAwait(false);
                    return;
                }
            }

            var key = TryMintDecodedAssetKey("res://", decodedResourcePath);
            if (key is null)
            {
                await HttpResponseWriter.WriteJsonErrorAsync(
                    stream,
                    HttpStatusCode.BadRequest,
                    "invalid-resource-route",
                    "The /res route serves res:// resources as /res/{path}; scheme-prefixed keys are not accepted.",
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            // The spirectl asset seam resolves res:// keys (scenes→GodotSceneState JSON,
            // localization→JSON, textures→PNG, fonts) behind one opaque key. The route mints the
            // scheme from the readable path and forwards; the seam validates the specific id and
            // returns structured errors.
            // Godot-native-first: resource `.tres` documents default to their raw Godot bytes; a raster consumer
            // opts into the cropped/rendered PNG with
            // `?format=png` (an AtlasTexture `.tres` rasterizes via spirectl's atlas-crop path). A query param
            // (not a header) so the route's immutable caching stays cache-key-safe with no `Vary` handling.
            // Absent or explicit `raw` is raw. Any other value is rejected rather than silently selecting raw.
            var formatValue = request.QueryValues.GetValueOrDefault("format");
            if (formatValue is not null
                && !string.Equals(formatValue, "raw", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(formatValue, "png", StringComparison.OrdinalIgnoreCase))
            {
                await HttpResponseWriter.WriteJsonErrorAsync(
                    stream,
                    HttpStatusCode.BadRequest,
                    "invalid-resource-format",
                    "Resource format must be raw or png.",
                    cancellationToken).ConfigureAwait(false);
                return;
            }
            var resourceFormat = string.Equals(formatValue, "png", StringComparison.OrdinalIgnoreCase)
                ? CouchCoopResourceFormat.Png
                : CouchCoopResourceFormat.Raw;
            // A sub-resource is read out of the parent's own text, which is what Raw is. (`?format` was already
            // refused above, so this can only be re-stating the default; stated anyway, because the extraction
            // below is only correct over raw bytes.)
            if (subResourceId is not null)
            {
                resourceFormat = CouchCoopResourceFormat.Raw;
            }

            // Bound the extraction await (missing-textures fix 2026-07-19): asset extraction runs on the game's MAIN
            // thread, so while the game loads a run / churns a transition this await can stall indefinitely — which
            // used to hang the client's untimed HttpRequests and silently wedge its fetch pipeline. A busy host now
            // answers 503 asset-busy instead; clients treat 5xx as transient and retry (AssetFetchPolicy).
            var assetTask = assets.TryGetAssetAsync(key, resourceFormat, cancellationToken: cancellationToken);
            var completed = await Task.WhenAny(assetTask, Task.Delay(TimeSpan.FromSeconds(20), cancellationToken)).ConfigureAwait(false);
            if (!ReferenceEquals(completed, assetTask))
            {
                await HttpResponseWriter.WriteJsonAsync(
                    stream,
                    HttpStatusCode.ServiceUnavailable,
                    new
                    {
                        type = "error",
                        requestId = "http",
                        code = "asset-busy",
                        message = "The host is busy (loading/transitioning); retry shortly.",
                        field = "key",
                        value = key
                    },
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            var asset = await assetTask.ConfigureAwait(false);
            if (asset.Error is not null)
            {
                // A headless seat's "I don't extract" is TRANSIENT-elsewhere, not "no such asset": the bytes
                // exist, this process just isn't the one that can make them. 404 would tell AssetFetchPolicy to
                // give up; 503 sends it back to the host origin, which renders for real.
                var status = string.Equals(
                    asset.Error.Code,
                    CachedSpirectlAssetHttpAdapter.ExtractionUnavailableCode,
                    StringComparison.Ordinal)
                    ? HttpStatusCode.ServiceUnavailable
                    : HttpStatusCode.NotFound;
                await HttpResponseWriter.WriteJsonAsync(
                    stream,
                    status,
                    new
                    {
                        type = "error",
                        requestId = "http",
                        code = asset.Error.Code,
                        message = asset.Error.Message,
                        field = asset.Error.Field,
                        value = asset.Error.Value,
                        notices = asset.Error.Notices
                    },
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            // R6 P6-F2 — the sub-resource half. The parent's bytes are in hand; read the named block out of them.
            // Before the ASTC branch on purpose: a `.tres` is not a raster and this answer is text either way.
            if (subResourceId is not null)
            {
                var parentText = asset.Bytes is { Length: > 0 } parentBytes
                    ? Encoding.UTF8.GetString(parentBytes).TrimStart('﻿')
                    : string.Empty;
                var subResourceCode = ShaderResourceParser.TryGetSubResourceShaderCode(parentText, subResourceId);
                if (subResourceCode is null)
                {
                    // The parent exists and does not contain this block: a genuine miss, and a DIFFERENT fact from
                    // "no such resource" — which is exactly what the client could not tell before this route
                    // existed. Named separately so a log says which one happened.
                    await HttpResponseWriter.WriteJsonAsync(
                        stream,
                        HttpStatusCode.NotFound,
                        new
                        {
                            type = "error",
                            requestId = "http",
                            code = "missing-subresource",
                            message = "The resource does not contain a shader sub-resource with that id.",
                            field = "key",
                            value = key + "::" + subResourceId
                        },
                        cancellationToken).ConfigureAwait(false);
                    return;
                }

                await HttpResponseWriter.WriteBytesAsync(
                    stream,
                    200,
                    "OK",
                    Encoding.UTF8.GetBytes(subResourceCode),
                    "text/plain; charset=utf-8",
                    new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                    {
                        // The same immutable cache policy every other asset answer carries: the bytes are a
                        // function of the key, and the key names a shipped file.
                        ["Cache-Control"] = "public, max-age=31536000, immutable",
                    },
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            // Track F2a: `?fmt=astc` opts a native phone client into GPU-native ASTC delivery. When the sidecar has
            // already transcoded THESE response bytes (content-addressed), serve the precompressed CCTX container
            // (8bpp, no client decode/mipgen); on a cold miss, record the source for background transcode and fall
            // through to serve the ORIGINAL bytes unchanged. `fmt` is a response-format param, never part of the
            // asset key — a request WITHOUT it is byte-identical to the raw response.
            var wantsAstc = string.Equals(request.QueryValues.GetValueOrDefault("fmt"), "astc", StringComparison.OrdinalIgnoreCase);
            if (wantsAstc && asset.Bytes is { Length: > 0 } sourceBytes && LooksLikeRaster(sourceBytes))
            {
                _astcCache ??= new AstcTranscodeCache();
                var transcoded = _astcCache.TryReadForContent(sourceBytes);
                if (transcoded is not null)
                {
                    await HttpResponseWriter.WriteBytesAsync(
                        stream,
                        200,
                        "OK",
                        transcoded,
                        CctxContainer.ContentType,
                        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                        {
                            ["Cache-Control"] = "public, max-age=31536000, immutable",
                            ["X-Cache"] = "ASTC",
                        },
                        cancellationToken).ConfigureAwait(false);
                    return;
                }

                _astcCache.RecordPending(sourceBytes); // fire-and-forget; never blocks, never execs
            }

            await HttpResponseWriter.WriteBytesAsync(
                stream,
                200,
                "OK",
                asset.Bytes ?? [],
                asset.ContentType ?? "application/octet-stream",
                asset.Headers,
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (request.RawPath.StartsWith("/spines/", StringComparison.Ordinal)
            || string.Equals(request.RawPath, "/spines", StringComparison.Ordinal))
        {
            if (envelopeFactory is null)
            {
                await HttpResponseWriter.WriteJsonErrorAsync(
                    stream,
                    HttpStatusCode.ServiceUnavailable,
                    "runtime-unavailable",
                    "The embedded spirectl runtime is not configured.",
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            // /spines/<scene-path>?node=&anim= mints the producer's canonical spine://<scene>?node=&anim=
            // SpineSprite key (the same id stamped on every mirror SpineSprite node), then streams the
            // rendered clip. Every caller forwards the same key, so one clip cache serves them all. anim is
            // required for animation clips but OPTIONAL with &still=1 (a still caller asks for a single frame it
            // cannot name; the extractor defaults the animation). node defaults to the sole SpineSprite.
            var spineKey = TryMintSpineClipKey(request);
            if (spineKey is null)
            {
                await HttpResponseWriter.WriteJsonErrorAsync(
                    stream,
                    HttpStatusCode.BadRequest,
                    "invalid-spine-route",
                    "The /spines route serves SpineSprite clips as /spines/{scene-path}?node={rel}&anim={name}; anim is required unless &still=1 is set, and scheme-prefixed paths are not accepted.",
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            // In-process clip producer (no bridge-IPC payload cap), lazily built. Shares
            // the binary-cache root with the other byte assets so a rendered clip survives across requests.
            // #14: the provider samples the live instance count (this game + every seat whose headless process is
            // up) at each bake admission, so a bake degrades to a single frame — and the producer's encode fan-out
            // shrinks — exactly while the machine is oversubscribed, with no latching.
            _spineClips ??= new CouchCoopSpineClipProvider(
                envelopeFactory.RuntimeHost.Assets,
                new SpirectlAssetBinaryCache(resourceCacheRoot),
                _log,
                () => SpineBakeBudget.CountGameInstances(
                    _headlessManager?.DescribeSeats(),
                    Environment.GetEnvironmentVariable("COUCHCOOP_HEADLESS_SLOT")));

            var clip = await _spineClips.GetClipAsync(spineKey, cancellationToken).ConfigureAwait(false);
            if (clip.Error is not null)
            {
                await HttpResponseWriter.WriteJsonAsync(
                    stream,
                    HttpStatusCode.NotFound,
                    new
                    {
                        type = "error",
                        requestId = "http",
                        code = clip.Error.Code,
                        message = clip.Error.Message,
                        field = clip.Error.Field,
                        value = clip.Error.Value,
                        notices = clip.Error.Notices
                    },
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            await HttpResponseWriter.WriteSpineClipAsync(
                stream,
                clip.Blob ?? [],
                clip.CacheStatus,
                clip.Degraded,
                cancellationToken).ConfigureAwait(false);
            return;
        }

        // DEV-ONLY baked geoclip artifacts (/geoclips/…). Off unless COUCHCOOP_GEOCLIPS_DIR names a directory;
        // with it unset this branch answers 404 and nothing else on the host changes. See
        // CouchCoopGeoclipDirectory for the filesystem policy and TryReadGeoclipAddress for the grammar.
        if (request.RawPath.StartsWith("/geoclips/", StringComparison.Ordinal)
            || string.Equals(request.RawPath, "/geoclips", StringComparison.Ordinal))
        {
            await HandleGeoclipRequestAsync(stream, request, cancellationToken).ConfigureAwait(false);
            return;
        }

        // Static background image (Stage A): /bg/<id>?layers=<digest>&v=1 (combat) and /bg/events/<id>?v=1
        // (event backdrops) serve the host-rendered 2520x1080 image of the room's background scene (the mirror's
        // "Static background" setting displays it and hides the live bg subtree), encoded per
        // CouchCoopStaticBackgroundProvider.RenderCodec — jpg@0.9 today, which is why the URL carries no
        // extension and Content-Type is authoritative. The digest names the MOUNTED combat layer variant
        // (digest-absent = the deterministic-discovery variant); event backdrops mount no variants and are always
        // digest-less. Response shape follows /spines: immutable caching + X-Cache.
        if (request.RawPath.StartsWith("/bg/", StringComparison.Ordinal)
            || string.Equals(request.RawPath, "/bg", StringComparison.Ordinal))
        {
            await HandleStaticBackgroundRequestAsync(stream, request, cancellationToken).ConfigureAwait(false);
            return;
        }

        // Perf instrument (S9/S10): the host-side halves of the shared `perf-report/1` envelope, so an A/B run
        // can put integration + server numbers next to the browser-side harness's numbers without a screenshot
        // and a guess. Read-only reporting routes; none of them changes what any client is served.
        if (request.Path.StartsWith("/perf/", StringComparison.Ordinal))
        {
            await HandlePerfReportRequestAsync(stream, request, cancellationToken).ConfigureAwait(false);
            return;
        }

        // The locally-built native Android client, deployed under the mod dir (see scripts/build-android-apk.sh).
        // Dedicated branch: the static SPA provider must not handle this path — it would buffer the ~97MB body
        // in memory per request, and its index.html fallback would serve HTML at 200 when the APK is absent.
        if (string.Equals(request.RawPath, "/" + StaticSpaFileProvider.AndroidApkFileName, StringComparison.Ordinal))
        {
            var apkPath = staticFiles.TryResolveAndroidApkPath();
            if (apkPath is null)
            {
                await HttpResponseWriter.WriteJsonErrorAsync(
                    stream,
                    HttpStatusCode.NotFound,
                    "apk-not-available",
                    "No Android client APK is deployed on this host.",
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            await HttpResponseWriter.WriteFileAsync(
                stream,
                apkPath,
                "application/vnd.android.package-archive",
                new Dictionary<string, string>
                {
                    ["Content-Disposition"] = $"attachment; filename=\"{StaticSpaFileProvider.AndroidApkFileName}\""
                },
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.RawPath, "/favicon.ico", StringComparison.Ordinal))
        {
            var asset = await assets.TryGetAssetAsync("res://images/icon.ico", cancellationToken: cancellationToken).ConfigureAwait(false);
            if (asset.Error is not null)
            {
                await HttpResponseWriter.WriteJsonAsync(
                    stream,
                    HttpStatusCode.NotFound,
                    new
                    {
                        type = "error",
                        requestId = "http",
                        code = asset.Error.Code,
                        message = asset.Error.Message,
                        field = asset.Error.Field,
                        value = asset.Error.Value,
                        notices = asset.Error.Notices
                    },
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            await HttpResponseWriter.WriteBytesAsync(
                stream,
                200,
                "OK",
                asset.Bytes ?? [],
                asset.ContentType ?? "image/x-icon",
                asset.Headers,
                cancellationToken).ConfigureAwait(false);
            return;
        }

        // The PWA home-screen icons, rendered from the GAME's own 1024px icon rather than from the
        // hand-drawn placeholders that used to ship in frontend/public/icons/. Same shape as /favicon.ico
        // above (one res:// key through the asset seam), plus a render size — see HandleAppIconRequestAsync.
        if (CouchCoopAppIcons.TryResolve(request.RawPath) is { } appIcon)
        {
            await HandleAppIconRequestAsync(stream, request, appIcon, cancellationToken).ConfigureAwait(false);
            return;
        }

        if (request.RawPath.StartsWith("/models/", StringComparison.Ordinal))
        {
            // 1–2 segment /models paths were already handled above as model JSON routes; anything
            // deeper is a readable model asset path: /models/{path} mints model://{path} and the
            // seam resolves it directly (camelCase kinds, 4-segment backgroundLayer keys, …).
            var key = TryMintAssetKey("model://", request.RawPath["/models/".Length..]);
            if (key is null)
            {
                await HttpResponseWriter.WriteJsonErrorAsync(
                    stream,
                    HttpStatusCode.BadRequest,
                    "invalid-model-route",
                    "The /models route serves model:// resources as /models/{path}; scheme-prefixed keys are not accepted.",
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            var asset = await assets.TryGetAssetAsync(key, cancellationToken: cancellationToken).ConfigureAwait(false);
            if (asset.Error is not null)
            {
                await HttpResponseWriter.WriteJsonAsync(
                    stream,
                    HttpStatusCode.NotFound,
                    new
                    {
                        type = "error",
                        requestId = "http",
                        code = asset.Error.Code,
                        message = asset.Error.Message,
                        field = asset.Error.Field,
                        value = asset.Error.Value,
                        notices = asset.Error.Notices
                    },
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            await HttpResponseWriter.WriteBytesAsync(
                stream,
                200,
                "OK",
                asset.Bytes ?? [],
                asset.ContentType ?? "application/octet-stream",
                asset.Headers,
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var file = await staticFiles.TryOpenAsync(request.Path, cancellationToken).ConfigureAwait(false);
        if (file is null)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.NotFound, "not-found", "Route was not found.", cancellationToken).ConfigureAwait(false);
            return;
        }

        await HttpResponseWriter.WriteBytesAsync(stream, 200, "OK", file.Bytes, file.ContentType, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    private static async Task HandleHeadlessClientStatusAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        IPAddress remoteAddress,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(request.Method, "POST", StringComparison.OrdinalIgnoreCase)
            || !IPAddress.IsLoopback(remoteAddress))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.NotFound, "not-found", "Route was not found.", cancellationToken).ConfigureAwait(false);
            return;
        }

        if (!TryBearer(request.Header("Authorization"), out var token)
            || !long.TryParse(request.Header("X-CouchCoop-Generation"), out var generation))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.Unauthorized, "client-status-auth", "Client status authentication failed.", cancellationToken).ConfigureAwait(false);
            return;
        }

        if (!int.TryParse(request.Header("Content-Length"), out var length) || length < 0)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.BadRequest, "client-status-body", "A valid Content-Length is required.", cancellationToken).ConfigureAwait(false);
            return;
        }
        if (length > 16 * 1024)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.RequestEntityTooLarge, "client-status-body", "Client status body exceeds 16 KiB.", cancellationToken).ConfigureAwait(false);
            return;
        }
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(2));
        string? body;
        try { body = await ReadBoundedBodyAsync(stream, length, deadline.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.RequestTimeout, "client-status-timeout", "Client status body timed out.", cancellationToken).ConfigureAwait(false);
            return;
        }
        if (body is null)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.RequestEntityTooLarge, "client-status-body", "Client status body is invalid.", cancellationToken).ConfigureAwait(false);
            return;
        }

        HeadlessConnectionStatus? status;
        try { status = JsonSerializer.Deserialize<HeadlessConnectionStatus>(body); }
        catch (JsonException) { status = null; }
        if (status is null || status.ConnectedChildBrowserCount < 0)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.BadRequest, "client-status-json", "Client status payload is invalid.", cancellationToken).ConfigureAwait(false);
            return;
        }

        var observed = HeadlessConnectionControl.Shared.Observe(token, generation, status);
        if (!observed.Accepted)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.Unauthorized, "client-status-auth", "Client status authentication failed.", cancellationToken).ConfigureAwait(false);
            return;
        }

        await HttpResponseWriter.WriteJsonAsync(stream, HttpStatusCode.OK, new { shutdown = observed.ShutdownRequested }, cancellationToken).ConfigureAwait(false);
    }

    private static bool TryBearer(string? authorization, out string token)
    {
        token = string.Empty;
        const string prefix = "Bearer ";
        if (authorization is null || !authorization.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;
        token = authorization[prefix.Length..].Trim();
        return token.Length is > 0 and <= 512;
    }

    private static async Task<string?> ReadBoundedBodyAsync(Stream stream, int length, CancellationToken cancellationToken)
    {
        var bytes = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = await stream.ReadAsync(bytes.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0) return null;
            offset += read;
        }

        return Encoding.UTF8.GetString(bytes);
    }

    /// <summary>
    /// Serve one PWA home-screen icon (<c>/icons/icon-{180,192,512}.png</c>) from the GAME's own app icon,
    /// resampled to the requested size by the asset seam.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Same shape as the <c>/favicon.ico</c> branch — one <c>res://</c> key through
    /// <see cref="ICouchCoopAssetHttpAdapter"/> — with two differences that are the whole reason it is a
    /// method rather than another inline if.
    /// </para>
    /// <para>
    /// <b>It FAILS OPEN.</b> An icon is chrome, and a manifest icon that 404s is worse than a placeholder:
    /// the phone renders the home-screen entry with no art and caches that outcome. A headless seat answers
    /// <c>asset-extraction-unavailable</c> by design (see <see cref="CachedSpirectlAssetHttpAdapter"/>), and
    /// a host mid-load answers a transient error, so ANY adapter error falls back to the PNG shipped in
    /// <c>frontend/public/icons/</c> — which is exactly why those files are still checked in. Only a failure
    /// of BOTH is a 404. <c>X-Icon-Source</c> says which one answered.
    /// </para>
    /// <para>
    /// <b>The ETag carries the asset-cache token.</b> The URL is fixed (the manifest and
    /// <c>index.html</c> name these paths literally) and <c>frontend/public/sw.js</c> cache-firsts
    /// <c>/icons/</c>, so a stale icon would otherwise be pinned in every installed PWA. The service
    /// worker's own build-stamp wipe is the layer that actually re-fetches for an installed app; this
    /// validator is what lets a plain HTTP cache — and any future revalidating consumer — notice that the
    /// bytes behind an unchanged URL moved when the extraction schema bumped.
    /// </para>
    /// </remarks>
    /// <summary>
    /// <c>/app-boot.json</c> — the build's boot manifest, plus this request's ORIGIN VERDICT.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A route rather than a plain static file for one reason: it is the only chance to tell a browser
    /// that its origin will be refused, EARLY and over a channel that works.
    /// </para>
    /// <para>
    /// <b>The failure this prevents.</b> HTTP here answers a wildcard CORS grant, so a browser on any
    /// origin can fetch the manifest and load the app perfectly — and then have its <c>/ws</c> upgrade
    /// refused with a 403 by <see cref="CouchCoopWebOrigin.IsAllowedWebSocketOrigin"/>. A browser cannot
    /// read the status code of a failed WebSocket handshake (the spec deliberately hides it), so the
    /// client sees an indistinguishable connection error and retries forever: the player gets a permanent
    /// "Waiting for the game…" with nothing to act on. That is exactly the outcome the join path already
    /// learned not to produce. Answering the verdict HERE turns it into one accurate sentence, before a
    /// megabyte of bundle has even been fetched.
    /// </para>
    /// <para>
    /// This is a realistic misconfiguration, not a hypothetical: an operator who deploys the client to
    /// their own domain, or rehearses behind a tunnel, without also setting
    /// <c>COUCHCOOP_WEB_ORIGIN</c> hits it immediately.
    /// </para>
    /// <para>
    /// Re-emitted field by field rather than string-patched, so a malformed manifest on disk fails here
    /// as a 404 instead of shipping a half-valid document to the bootstrap's parser.
    /// </para>
    /// </remarks>
    private async Task HandleBootManifestRequestAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        CancellationToken cancellationToken)
    {
        var file = await staticFiles
            .TryReadExactAsync(StaticSpaFileProvider.BootManifestDiskName, cancellationToken)
            .ConfigureAwait(false);
        if (file is null)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.NotFound,
                "boot-manifest-missing",
                "This host has no app boot manifest; use the plain LAN address instead.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var webOrigin = CouchCoopWebOrigin.Resolve();
        var origin = request.Header("Origin");
        var originAllowed = CouchCoopWebOrigin.IsAllowedWebSocketOrigin(origin, request.Header("Host"), webOrigin);

        using var buffer = new MemoryStream();
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(file.Bytes);
            using var writer = new System.Text.Json.Utf8JsonWriter(buffer);
            writer.WriteStartObject();
            foreach (var property in document.RootElement.EnumerateObject())
            {
                property.WriteTo(writer);
            }

            // Whether THIS caller's origin may open the game socket, and which origin this host expects —
            // the second so the message can name the address to go to rather than just refusing.
            writer.WriteBoolean("originAllowed", originAllowed);
            writer.WriteString("webOrigin", webOrigin);
            writer.WriteEndObject();
            writer.Flush();
        }
        catch (Exception exception) when (exception is System.Text.Json.JsonException or InvalidOperationException)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.NotFound,
                "boot-manifest-malformed",
                "This host's app boot manifest could not be read; use the plain LAN address instead.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (!originAllowed)
        {
            _networkDiagnostics.Write("boot-origin-not-allowed",
                "[couchcoop] browser-server diagnostic code=boot-origin-not-allowed "
                + $"origin={origin} expected={webOrigin} "
                + $"detail=set COUCHCOOP_WEB_ORIGIN to this origin, or {CouchCoopWebOrigin.OriginCheckEnvironmentVariable}=0");
        }

        await HttpResponseWriter.WriteBytesAsync(
            stream,
            (int)HttpStatusCode.OK,
            "OK",
            buffer.ToArray(),
            "application/json; charset=utf-8",
            // The verdict depends on the request's Origin, so this response is not shareable between
            // origins — and the manifest changes with every build besides.
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Cache-Control"] = "no-store",
                ["Vary"] = "Origin",
            },
            cancellationToken).ConfigureAwait(false);
    }

    private async Task HandleAppIconRequestAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        CouchCoopAppIcon icon,
        CancellationToken cancellationToken)
    {
        byte[]? bytes = null;
        var contentType = "image/png";
        var source = "game";
        string? failureCode = null;

        var asset = await assets.TryGetAssetAsync(
            CouchCoopAppIcons.SourceResourcePath,
            CouchCoopResourceFormat.Png,
            new CouchCoopAssetRenderSize(icon.SizePx, icon.SizePx),
            cancellationToken).ConfigureAwait(false);

        if (asset.Error is null && asset.Bytes is { Length: > 0 })
        {
            bytes = asset.Bytes;
            contentType = asset.ContentType ?? contentType;
        }
        else
        {
            failureCode = asset.Error?.Code ?? "missing-asset";
            var shipped = await staticFiles.TryReadExactAsync(icon.StaticRelativePath, cancellationToken).ConfigureAwait(false);
            if (shipped is not null)
            {
                bytes = shipped.Bytes;
                contentType = shipped.ContentType;
                source = "static";
            }
        }

        if (bytes is null)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.NotFound,
                "icon-unavailable",
                $"The app icon could not be rendered ({failureCode}) and no shipped fallback is deployed.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var etag = $"\"{SpirectlAssetBinaryCache.SchemaVersion}-{icon.SizePx.ToString(System.Globalization.CultureInfo.InvariantCulture)}-{source}-{bytes.Length.ToString(System.Globalization.CultureInfo.InvariantCulture)}\"";
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Cache-Control"] = "public, max-age=31536000, immutable",
            ["ETag"] = etag,
            ["X-Icon-Source"] = source,
        };

        var conditional = request.Header("If-None-Match");
        if (conditional is not null && IfNoneMatchMatches(conditional, etag))
        {
            await HttpResponseWriter.WriteBytesAsync(
                stream,
                304,
                "Not Modified",
                [],
                contentType,
                headers,
                cancellationToken).ConfigureAwait(false);
            return;
        }

        await HttpResponseWriter.WriteBytesAsync(
            stream,
            200,
            "OK",
            bytes,
            contentType,
            headers,
            cancellationToken).ConfigureAwait(false);
    }

    // Weak comparison per RFC 9110 §13.1.2: the header is a comma-separated list, entries may carry a `W/`
    // prefix, and `*` matches any current representation.
    internal static bool IfNoneMatchMatches(string headerValue, string etag)
    {
        foreach (var candidate in headerValue.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            if (candidate == "*")
            {
                return true;
            }

            var normalized = candidate.StartsWith("W/", StringComparison.Ordinal) ? candidate[2..] : candidate;
            if (string.Equals(normalized, etag, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// The host-side perf report routes. All three answer the SHARED `perf-report/1` envelope
    /// (<see cref="PerfReport"/>), so a couch-coop number can be laid straight next to a godot-scene-web one:
    ///
    ///   GET /perf/scene-delta.json?scenario=&amp;label=&amp;windows=5&amp;arm=1&amp;reset=1
    ///       S9 — per-frame scene-delta wire bytes + upsert/removal counts from the live send path.
    ///       `arm=1` turns the recorder on (COUCHCOOP_WIRE_METRICS=1 does the same at startup), `reset=1`
    ///       clears the ring so the next window measures only what follows.
    ///   GET /perf/bg.json?scenario=&amp;label=
    ///       S10 — every /bg/ render this host actually performed (always recorded; a render is seconds-scale).
    ///       Each render carries its PHASE breakdown (Sts2RenderPhaseProfile): which parts held the Godot main
    ///       thread (the stall a player sees) versus parked on frames, the gate queue and disk.
    ///   GET /perf/bg-render.json?id=&amp;sizes=1920x1080,2520x1080&amp;formats=png,webp@0.85,jpg@0.9&amp;repeats=3&amp;warmups=1&amp;dump=1
    ///       S10 — the size and ENCODER comparison: renders at each requested size/codec with BOTH caches
    ///       bypassed. `formats` grammar is codec[@quality][:opaque] (png|webp|jpg; webp without a quality is
    ///       LOSSLESS; jpg is always opaque). `dump=1` also writes each candidate's encoded bytes next to the
    ///       resource cache, which is the only way to pixel-diff a lossy candidate against the PNG reference.
    ///       Gated behind COUCHCOOP_BG_BENCH=1, because it is one of the two routes here that make the game do
    ///       work it would not otherwise do (and at a size/codec the shipped policy never asks for).
    ///   GET /perf/spine.json?scenario=&amp;label=&amp;reset=1
    ///       Every /spines/ bake this host performed — the still bakes the mirror's default spineMode asks for,
    ///       and any animated clip — with the same phase breakdown.
    ///   GET /perf/spine-render.json?key=spine://…&amp;repeats=3&amp;warmups=1
    ///       The bake COMPARISON: re-bakes a spine key with its cache bypassed. Gated behind
    ///       COUCHCOOP_SPINE_BENCH=1.
    /// </summary>
    private async Task HandlePerfReportRequestAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        CancellationToken cancellationToken)
    {
        var scenario = request.QueryValues.TryGetValue("scenario", out var scenarioValue) && scenarioValue.Length > 0
            ? scenarioValue
            : "live-host";
        var label = request.QueryValues.TryGetValue("label", out var labelValue) && labelValue.Length > 0 ? labelValue : null;
        // `host` by default: these numbers come out of a running game on someone's machine, which is exactly
        // what the shared enum's `host` means (and neither `ci` nor `device`). A caller may override it, but
        // only with a value the shared validator accepts — silently emitting anything else would produce a
        // report that fails validation on this one field, whatever the metrics say.
        var envKind = request.QueryValues.TryGetValue("envKind", out var envKindValue) && envKindValue.Length > 0
            ? envKindValue
            : PerfReport.DefaultEnvKind();
        if (!PerfReport.IsValidEnvKind(envKind))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.BadRequest,
                "invalid-env-kind",
                $"envKind must be one of {string.Join(", ", PerfReport.EnvKinds)} (got '{envKind}').",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.Path, "/perf/scene-delta.json", StringComparison.Ordinal))
        {
            var arm = request.QueryValues.TryGetValue("arm", out var armValue) && armValue is "1" or "true";
            var disarm = request.QueryValues.TryGetValue("arm", out var offValue) && offValue is "0" or "false";
            var reset = request.QueryValues.TryGetValue("reset", out var resetValue) && resetValue is "1" or "true";
            var windows = request.QueryValues.TryGetValue("windows", out var windowsValue)
                && int.TryParse(windowsValue, out var parsedWindows)
                ? parsedWindows
                : 5;

            var samples = SceneDeltaWireMetrics.Snapshot();
            var wasArmed = SceneDeltaWireMetrics.Enabled;
            var report = SceneDeltaWireMetrics.BuildReport(
                scenario,
                samples,
                windows,
                envKind,
                label,
                cpuThrottle: null,
                extraParams: new JsonObject
                {
                    ["source"] = "live-send-path",
                    ["armedBefore"] = wasArmed,
                });

            if (arm)
            {
                SceneDeltaWireMetrics.Enabled = true;
            }
            else if (disarm)
            {
                SceneDeltaWireMetrics.Enabled = false;
            }

            if (reset)
            {
                SceneDeltaWireMetrics.Reset();
            }

            await WritePerfReportAsync(stream, report, cancellationToken).ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.Path, "/perf/bg.json", StringComparison.Ordinal))
        {
            var reset = request.QueryValues.TryGetValue("reset", out var bgReset) && bgReset is "1" or "true";
            var report = StaticBackgroundRenderMetrics.BuildReport(
                scenario,
                StaticBackgroundRenderMetrics.Snapshot(),
                envKind,
                label,
                warmups: 0,
                extraParams: new JsonObject { ["source"] = "served-renders" });
            if (reset)
            {
                StaticBackgroundRenderMetrics.Reset();
            }

            await WritePerfReportAsync(stream, report, cancellationToken).ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.Path, "/perf/bg-render.json", StringComparison.Ordinal))
        {
            await HandleStaticBackgroundBenchAsync(stream, request, scenario, label, envKind, cancellationToken)
                .ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.Path, "/perf/spine.json", StringComparison.Ordinal))
        {
            var reset = request.QueryValues.TryGetValue("reset", out var spineReset) && spineReset is "1" or "true";
            var report = SpineBakeMetrics.BuildReport(
                scenario,
                SpineBakeMetrics.Snapshot(),
                envKind,
                label,
                warmups: 0,
                extraParams: new JsonObject { ["source"] = "served-bakes" });
            if (reset)
            {
                SpineBakeMetrics.Reset();
            }

            await WritePerfReportAsync(stream, report, cancellationToken).ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.Path, "/perf/spine-render.json", StringComparison.Ordinal))
        {
            await HandleSpineBakeBenchAsync(stream, request, scenario, label, envKind, cancellationToken)
                .ConfigureAwait(false);
            return;
        }

        await HttpResponseWriter.WriteJsonErrorAsync(
            stream,
            HttpStatusCode.NotFound,
            "unknown-perf-report",
            "Known perf reports: /perf/scene-delta.json, /perf/bg.json, /perf/bg-render.json, /perf/spine.json, "
            + "/perf/spine-render.json.",
            cancellationToken).ConfigureAwait(false);
    }

    // The S10 size comparison. Renders `id` at each requested size `repeats` times (plus `warmups` discarded
    // renders per size, since the first render of a scene pays its resource loads), with the provider's memory
    // and disk caches bypassed in BOTH directions so a non-policy render can never be served to a real client.
    private async Task HandleStaticBackgroundBenchAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        string scenario,
        string? label,
        string envKind,
        CancellationToken cancellationToken)
    {
        if (!StaticBackgroundRenderMetrics.BenchEnabled)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.NotFound,
                "bg-bench-disabled",
                $"The /bg render bench is opt-in: start the host with {StaticBackgroundRenderMetrics.BenchEnvVar}=1.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (envelopeFactory is null)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.ServiceUnavailable,
                "runtime-unavailable",
                "The embedded spirectl runtime is not configured.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var id = request.QueryValues.TryGetValue("id", out var idValue) ? idValue.Trim() : string.Empty;
        // Default: the CURRENT published variant's background, so the bench prices the picture actually on
        // screen. Falls back to an explicit ?id= for a host that is not in a combat room.
        var published = CouchCoopStaticBackgroundTracker.Published;
        if (id.Length == 0 && published is not null)
        {
            id = CouchCoopStaticBackgroundProvider.TryParseBackgroundId(published.ScenePath) ?? string.Empty;
        }

        var sizes = StaticBackgroundRenderMetrics.TryParseSizes(
            request.QueryValues.TryGetValue("sizes", out var sizesValue) ? sizesValue : "1920x1080,2520x1080");
        // The shipped policy is lossless PNG with alpha; a bench may price any `codec[@quality][:opaque]`
        // candidate, because the encode is the biggest segment of every render and "would another encoder be
        // cheaper, and at what fidelity?" should be measured, not guessed.
        var formats = StaticBackgroundRenderMetrics.TryParseFormats(
            request.QueryValues.TryGetValue("formats", out var formatsValue)
                ? formatsValue
                : CouchCoopStaticBackgroundProvider.ShippedCodec.Label);
        if (id.Length == 0 || !CouchCoopStaticBackgroundProvider.IsValidBackgroundId(id) || sizes is null || formats is null)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.BadRequest,
                "invalid-bg-bench-request",
                "Usage: /perf/bg-render.json?id={background}&sizes=1920x1080,2520x1080"
                + "&formats=png,webp,webp@0.85,jpg@0.9,png:opaque&repeats=3&warmups=1&dump=1 "
                + "(formats grammar: codec[@quality][:opaque], codec one of "
                + $"{string.Join('/', StaticBackgroundRenderMetrics.BenchFormats)}, quality in (0,1]; "
                + "id defaults to the currently published background; formats defaults to "
                + CouchCoopStaticBackgroundProvider.ShippedCodec.Label + ", the shipped policy).",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var repeats = request.QueryValues.TryGetValue("repeats", out var repeatsValue)
            && int.TryParse(repeatsValue, out var parsedRepeats)
            ? Math.Clamp(parsedRepeats, 1, 20)
            : 3;
        var warmups = request.QueryValues.TryGetValue("warmups", out var warmupsValue)
            && int.TryParse(warmupsValue, out var parsedWarmups)
            ? Math.Clamp(parsedWarmups, 0, 5)
            : 1;
        var dump = request.QueryValues.TryGetValue("dump", out var dumpValue) && dumpValue is "1" or "true";

        var backgrounds = StaticBackgroundProvider(envelopeFactory);

        // The mounted layer set of the published variant when it is the id being benched — the same input the
        // served render uses, so the bench prices the same picture rather than a discovery-order stand-in.
        var layerPaths = published is not null
            && string.Equals(CouchCoopStaticBackgroundProvider.TryParseBackgroundId(published.ScenePath), id, StringComparison.Ordinal)
            ? published.LayerPaths
            : null;

        // `dump=1` artifacts land beside the resource cache, never inside it — a bench render must not be
        // reachable as a cache entry. The filename is built from values this method already validated (the
        // background id, a parsed size, a parsed codec), never from raw query text. The root comes from the
        // CACHE's own resolved path, not the constructor argument: the host usually passes null there and lets
        // SpirectlAssetBinaryCache resolve COUCHCOOP_CACHE_ROOT / the game data dir itself.
        var dumpRoot = new SpirectlAssetBinaryCache(resourceCacheRoot).RootPath is { Length: > 0 } cacheRoot
            ? Path.Combine(cacheRoot, "..", "bench-dumps")
            : null;
        var measured = new List<StaticBackgroundRenderMetrics.Sample>();
        var dumped = new JsonArray();
        foreach (var (width, height) in sizes)
        {
            foreach (var format in formats)
            {
                for (var i = 0; i < warmups + repeats; i++)
                {
                    // Only the LAST repeat of a candidate dumps: every repeat of the same (size, codec) encodes
                    // the same picture the same way, so writing all of them would just rewrite one file N times.
                    var dumpPath = dump && dumpRoot is not null && i == warmups + repeats - 1
                        ? Path.GetFullPath(Path.Combine(
                            dumpRoot,
                            $"{id}-{width}x{height}-{format.FileLabel}.{format.FileExtension}"))
                        : null;
                    var samples = await backgrounds
                        .MeasureRenderAsync(id, layerPaths, width, height, format, dumpPath, cancellationToken)
                        .ConfigureAwait(false);
                    if (dumpPath is not null)
                    {
                        dumped.Add(dumpPath);
                    }

                    if (i >= warmups)
                    {
                        measured.AddRange(samples);
                    }
                }
            }
        }

        var parameters = new JsonObject
        {
            ["source"] = "bench-render",
            ["id"] = id,
            ["repeats"] = repeats,
            ["sizes"] = new JsonArray([.. sizes.Select(s => (JsonNode)JsonValue.Create(StaticBackgroundRenderMetrics.SizeKey(s.Width, s.Height)))]),
            ["formats"] = new JsonArray([.. formats.Select(format => (JsonNode)JsonValue.Create(format.Label))]),
            ["layerPaths"] = layerPaths?.Count ?? 0,
        };
        if (dump)
        {
            // The paths ARE the evidence for any fidelity claim made from this run, so the report names them
            // rather than leaving the reader to reconstruct where they went.
            parameters["dumps"] = dumped;
        }

        var report = StaticBackgroundRenderMetrics.BuildReport(
            scenario,
            measured,
            envKind,
            label,
            warmups,
            parameters);

        await WritePerfReportAsync(stream, report, cancellationToken).ConfigureAwait(false);
    }

    // The spine-bake bench. Re-bakes ONE spine:// key `repeats` times with its cache bypassed in both
    // directions, so the phase breakdown describes a cold bake rather than a disk read. Same doctrine as the
    // background bench: opt-in, and nothing it produces is served or stored.
    private async Task HandleSpineBakeBenchAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        string scenario,
        string? label,
        string envKind,
        CancellationToken cancellationToken)
    {
        if (!SpineBakeMetrics.BenchEnabled)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.NotFound,
                "spine-bench-disabled",
                $"The /spines bake bench is opt-in: start the host with {SpineBakeMetrics.BenchEnvVar}=1.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (envelopeFactory is null)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.ServiceUnavailable,
                "runtime-unavailable",
                "The embedded spirectl runtime is not configured.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        // Built exactly as the /spines/ route builds it, so a benched bake goes through the same admission
        // budget the served ones do (a bench that skipped it would price a bake nobody can actually get).
        _spineClips ??= new CouchCoopSpineClipProvider(
            envelopeFactory.RuntimeHost.Assets,
            new SpirectlAssetBinaryCache(resourceCacheRoot),
            _log,
            () => SpineBakeBudget.CountGameInstances(
                _headlessManager?.DescribeSeats(),
                Environment.GetEnvironmentVariable("COUCHCOOP_HEADLESS_SLOT")));

        var key = request.QueryValues.TryGetValue("key", out var keyValue) ? keyValue.Trim() : string.Empty;
        if (!key.StartsWith("spine://", StringComparison.Ordinal))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.BadRequest,
                "invalid-spine-bench-request",
                "Usage: /perf/spine-render.json?key=spine://<scene>?node=…&anim=…&…&repeats=3&warmups=1 "
                + "(the key is the same one /spines/ serves; take one from /perf/spine.json).",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var repeats = request.QueryValues.TryGetValue("repeats", out var repeatsValue)
            && int.TryParse(repeatsValue, out var parsedRepeats)
            ? Math.Clamp(parsedRepeats, 1, 20)
            : 3;
        var warmups = request.QueryValues.TryGetValue("warmups", out var warmupsValue)
            && int.TryParse(warmupsValue, out var parsedWarmups)
            ? Math.Clamp(parsedWarmups, 0, 5)
            : 1;

        var measured = new List<SpineBakeMetrics.Sample>();
        for (var i = 0; i < warmups + repeats; i++)
        {
            var samples = await _spineClips.MeasureBakeAsync(key, cancellationToken).ConfigureAwait(false);
            if (i >= warmups)
            {
                measured.AddRange(samples);
            }
        }

        var report = SpineBakeMetrics.BuildReport(
            scenario,
            measured,
            envKind,
            label,
            warmups,
            new JsonObject
            {
                ["source"] = "bench-bake",
                ["key"] = key,
                ["repeats"] = repeats,
            });

        await WritePerfReportAsync(stream, report, cancellationToken).ConfigureAwait(false);
    }

    private static Task WritePerfReportAsync(Stream stream, JsonObject report, CancellationToken cancellationToken)
        => HttpResponseWriter.WriteBytesAsync(
            stream,
            200,
            "OK",
            Encoding.UTF8.GetBytes(PerfReport.ToJson(report)),
            "application/json",
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Cache-Control"] = "no-store" },
            cancellationToken);

    private async Task HandleStaticBackgroundRequestAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        CancellationToken cancellationToken)
    {
        if (envelopeFactory is null)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.ServiceUnavailable,
                "runtime-unavailable",
                "The embedded spirectl runtime is not configured.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var route = TryParseStaticBackgroundRoute(request.RawPath);
        // `layers` must look like the digest BuildImageUrl minted (short lowercase hex); anything else is a
        // garbled URL, rejected before it can fragment the cache. `v` is accepted as an opaque cache-buster.
        // An EVENT URL carrying `layers=` is garbled too: event backdrops mount no layer variants, so no such
        // URL was ever minted — rejecting it keeps the events key space digest-free by construction.
        var digest = request.QueryValues.TryGetValue("layers", out var layersValue) ? layersValue.Trim() : null;
        if (digest is { Length: 0 })
        {
            digest = null;
        }

        var digestValid = digest is null || (digest.Length <= 32 && digest.All(ch => char.IsAsciiDigit(ch) || ch is >= 'a' and <= 'f'));
        // `frame=` is the EVENTS counterpart of `layers=`: the tracker-probed live frame spec qualifying the
        // variant. Combat URLs never carry one; a malformed spec is a garbled URL.
        var frame = request.QueryValues.TryGetValue("frame", out var frameValue) ? frameValue.Trim() : null;
        if (frame is { Length: 0 })
        {
            frame = null;
        }

        var frameValid = frame is null || CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec(frame);
        if (route is not { } bg
            || !digestValid
            || !frameValid
            || (bg.Family != StaticBackgroundFamily.Combat && digest is not null)
            || (bg.Family == StaticBackgroundFamily.Combat && frame is not null))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.BadRequest,
                "invalid-bg-route",
                "The /bg route serves background images as /bg/{id}?layers={digest}&v="
                + CouchCoopStaticBackgroundProvider.KeyVersion
                + " (combat) or /bg/events/{id}?v="
                + CouchCoopStaticBackgroundProvider.KeyVersion
                + " (event backdrops, no layers); the id is the lowercase background name and layers is an "
                + "optional combat-only hex digest. The image's Content-Type names its codec.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var id = bg.Id;

        var backgrounds = StaticBackgroundProvider(envelopeFactory);

        // Digest resolution against the tracker's CURRENT published variant: only the digest the envelope is
        // currently pointing clients at may RENDER (with that exact layer set). A stale digest serves the
        // disk-cached bytes if present, else 404 — the client fail-opens and the envelope re-points on the next
        // publish. Serving WRONG bytes under an immutable URL is the one forbidden outcome. Digest-absent = the
        // deterministic-discovery variant (spirectl picks the layers), always renderable.
        IReadOnlyList<string>? layerPaths = null;
        var allowRender = true;
        if (digest is not null)
        {
            var published = CouchCoopStaticBackgroundTracker.Published;
            var isCurrent = published is not null
                && string.Equals(published.Digest, digest, StringComparison.Ordinal)
                && string.Equals(CouchCoopStaticBackgroundProvider.TryParseBackgroundId(published.ScenePath), id, StringComparison.Ordinal);
            if (isCurrent)
            {
                layerPaths = published!.LayerPaths;
            }
            else
            {
                allowRender = false;
            }
        }

        // The stale-frame rule, the digest rule's events twin: only the frame the tracker is CURRENTLY
        // publishing may render (any other frame serves disk bytes or 404s — wrong bytes under an immutable
        // URL is the one forbidden outcome). Frame-absent = the deterministic reference variant, always
        // renderable.
        if (frame is not null)
        {
            var published = CouchCoopStaticBackgroundTracker.Published;
            var publishedId = bg.Family == StaticBackgroundFamily.Rooms
                ? CouchCoop.MirrorProtocol.SceneModel.BackgroundSceneFamilies.TryParseRoomBackgroundId(published?.ScenePath)
                : CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId(published?.ScenePath);
            var isCurrent = published is not null
                && string.Equals(published.EventFrame, frame, StringComparison.Ordinal)
                && string.Equals(publishedId, id, StringComparison.Ordinal);
            if (!isCurrent)
            {
                allowRender = false;
            }
        }

        var image = await backgrounds.GetImageAsync(bg.Family, id, digest, layerPaths, allowRender, cancellationToken, frame).ConfigureAwait(false);
        if (image.Error is not null)
        {
            await HttpResponseWriter.WriteJsonAsync(
                stream,
                image.ServiceUnavailable ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.NotFound,
                new
                {
                    type = "error",
                    requestId = "http",
                    code = image.Error.Code,
                    message = image.Error.Message,
                    field = image.Error.Field,
                    value = image.Error.Value,
                    notices = image.Error.Notices
                },
                cancellationToken).ConfigureAwait(false);
            return;
        }

        await HttpResponseWriter.WriteBytesAsync(
            stream,
            200,
            "OK",
            image.Bytes ?? [],
            image.ContentType,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Cache-Control"] = "public, max-age=31536000, immutable",
                ["X-Cache"] = image.CacheStatus,
            },
            cancellationToken).ConfigureAwait(false);
    }

    // Parses "/bg/<id>" / "/bg/events/<id>" back to (family, id) — the grammar BuildImageUrl mints. Null => 400.
    // Disambiguation is by segment count: an `events/` first segment names the EVENT family; a bare "/bg/events"
    // (no second segment) still parses as the combat id "events", exactly as it always did.
    //
    private static (StaticBackgroundFamily Family, string Id)? TryParseStaticBackgroundRoute(string rawPath)
    {
        if (!rawPath.StartsWith("/bg/", StringComparison.Ordinal))
        {
            return null;
        }

        var id = Uri.UnescapeDataString(rawPath["/bg/".Length..]);
        var family = StaticBackgroundFamily.Combat;
        const string eventsSegment = "events/";
        const string roomsSegment = "rooms/";
        if (id.StartsWith(eventsSegment, StringComparison.Ordinal))
        {
            family = StaticBackgroundFamily.Events;
            id = id[eventsSegment.Length..];
        }
        else if (id.StartsWith(roomsSegment, StringComparison.Ordinal))
        {
            family = StaticBackgroundFamily.Rooms;
            id = id[roomsSegment.Length..];
        }

        return CouchCoopStaticBackgroundProvider.IsValidBackgroundId(id) ? (family, id) : null;
    }

    private void LogInternalServerError(CouchCoopHttpRequest? request, Exception exception)
    {
        // Include the stack: an internal server error is always a defect, and the type+message alone has repeatedly
        // been too little to locate the throwing call (the Godot-typed refresh-rate read that silently killed every
        // /ws session in the hosted e2e harness took a debugger to find).
        _networkDiagnostics.Write("internal-server-error",
            "[couchcoop] browser-server diagnostic code=internal-server-error "
            + $"target={request?.Target ?? "<unread>"} detail={exception.GetType().Name}: {exception.Message}"
            + $"{Environment.NewLine}{exception}");
    }

    // Assembly/type-load failures are NEVER a closed connection, but FileNotFoundException and FileLoadException
    // DERIVE from IOException — so the benign "connection-closed" arm above used to swallow them, leaving a request
    // that produced nothing at all indistinguishable from a client that hung up (this masked the Godot-typed call in
    // the session envelope for weeks). Excluded here so they fall through to the internal-server-error arm.
    private static bool IsAssemblyLoadFailure(Exception exception)
        => exception is FileNotFoundException or FileLoadException or TypeLoadException or BadImageFormatException;

    private static BrowserErrorEnvelope CreateInternalServerError(CouchCoopHttpRequest? request, Exception exception)
        => new(
            "error",
            "http",
            "internal-server-error",
            "The browser server encountered an internal error.");

    // Asset routes carry the resource path readably (/res/images/icon.png) and the route mints the
    // scheme. Rejecting any decoded remainder that embeds its own scheme keeps the route defensive
    // against arbitrary keys (http://…, the legacy escaped res:// form); the seam still validates
    // the specific id behind the minted scheme.
    private static string? TryMintAssetKey(string scheme, string rawRemainder) =>
        TryMintDecodedAssetKey(scheme, Uri.UnescapeDataString(rawRemainder));

    // The same mint over a path the caller has ALREADY unescaped — which the `::` sub-resource route needs,
    // because it has to split the decoded path before minting. Split out rather than restated so the guards
    // (empty, and no embedded scheme) can only ever be one rule.
    private static string? TryMintDecodedAssetKey(string scheme, string path) =>
        BrowserResourcePath.IsSafeRelative(path) ? scheme + path : null;

    // Track F2a: sniff PNG (\x89PNG) / WEBP (RIFF....WEBP) magic so only RASTER responses are considered for ASTC
    // transcode (JSON scene/resource docs, fonts, and the .ico are left untouched). Content-type-agnostic to match
    // the codec-agnostic wire and the sidecar's own magic sniff.
    private static bool LooksLikeRaster(byte[] bytes)
    {
        if (bytes.Length >= 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47)
        {
            return true; // PNG
        }

        return bytes.Length >= 12 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46
            && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50; // WEBP
    }

    // Mints the canonical spine://<scene>?node=&anim= key from the readable /spines/ route. The scene path
    // (no res:// prefix, parallels /res) carries the scheme readably and is rejected if it embeds its own.
    // node/anim are taken DECODED from the query and re-emitted in a fixed node-then-anim order, so the
    // per-clip cache key is stable regardless of how the client percent-encoded them — and matches the
    // unencoded form the producer stamps on SpineSprite nodes. Returns null (=> 400) when the scene is
    // empty, embeds a scheme, or anim is missing (the route serves animation clips).
    // Host-wide Spine clip SIZE policy (codec + sample fps + webp quality), appended SERVER-SIDE to every minted
    // spine:// key. ONE policy for the whole fleet: one render -> one encode -> one cache entry, identical bytes
    // to every client; the client sends NO size parameter and NEVER gets a per-client variant (the render is the
    // expensive serialized main-thread op — multiplying it per client is the thing to avoid). webp-lossy q85 is
    // ~4x smaller than PNG and 15fps roughly halves the frame count, so the combat-start warmup burst over wifi
    // is ~8x lighter than the multi-MB PNG baseline. Because the policy rides the key, it is part of the clip
    // cache key — flipping it invalidates cleanly. PNG/full-rate stays reachable only by changing the provider policy
    // (dev/debug); a weak client degrades by fetching NOTHING (mirror quality tier), never by asking for less.
    private static string? TryMintSpineClipKey(CouchCoopHttpRequest request)
    {
        if (!request.RawPath.StartsWith("/spines/", StringComparison.Ordinal))
        {
            return null;
        }

        var scene = Uri.UnescapeDataString(request.RawPath["/spines/".Length..]).Trim().Trim('/');
        if (!BrowserResourcePath.IsSafeRelative(scene))
        {
            return null;
        }

        var query = request.QueryValues;
        var node = query.TryGetValue("node", out var nodeValue) ? nodeValue.Trim() : string.Empty;
        var anim = query.TryGetValue("anim", out var animValue) ? animValue.Trim() : string.Empty;
        if (!BrowserResourcePath.IsSafeSelector(node) || !BrowserResourcePath.IsSafeSelector(anim))
        {
            return null;
        }
        // A weak/mobile mirror tier — and the recon still tooling, which addresses a SpineSprite it cannot
        // name — request a single static frame (&still=1) instead of the animated clip; carry it into the key so
        // the extractor renders ONE frame and stills cache separately from full clips. The size policy still
        // applies (a still is one small webp). A still may OMIT anim (the extractor falls back to a default
        // preview animation); an animation clip still requires an explicit anim.
        var still = query.TryGetValue("still", out var stillValue)
            && (stillValue.Length == 0 || stillValue is "1" or "true" or "on" or "yes");
        // STATIC-SPINE BELT. Every request is minted as a STILL key regardless of
        // what the client asked for. Deliberately a degrade, not a rejection — a stale tab or the
        // recon view keeps getting a usable single frame instead of a 404, and because the still key is the one
        // the prerender job bakes, the answer is normally a cache hit. Note the ordering: forcing `still` BEFORE
        // the anim check is also what lets an anim-less request through (a still may omit anim; the extractor
        // falls back to a default preview animation), so the only remaining 400 is the genuinely empty request.
        still = true;

        if (anim.Length == 0 && !still)
        {
            return null;
        }

        // WS-spine wire contract: fold the optional clip-identity selectors into the key. `skin` (#3) rides the key
        // whenever the client sends it (the runtime skin the game has set); `skel` (#8, one-shot fallback retry) is a
        // res:// skeleton path — reject anything else defensively (the client only ever sends the streamed
        // SpineSkelResPath); `retry=1` (#4, one-shot budget-collapse escalation) is the sole retry selector. The
        // server maps it to the upstream key's version discriminator; it does not expose that discriminator on HTTP.
        var skin = query.TryGetValue("skin", out var skinValue) ? skinValue.Trim() : string.Empty;
        if (!BrowserResourcePath.IsSafeSelector(skin))
        {
            return null;
        }
        // `mat` (#8) is the shader-material signature the producer streamed on the node (`spineMat`): an opaque
        // discriminator that only ever widens the cache key, so the render is unaffected by its value. Constrained
        // to the hex signature shape Sts2SpineMaterialKey mints, so a garbled query can't fragment the cache.
        var mat = query.TryGetValue("mat", out var matValue) ? matValue.Trim() : string.Empty;
        if (mat.Length is 0 or > 32 || !mat.All(char.IsAsciiLetterOrDigit))
        {
            mat = string.Empty;
        }

        var skel = query.TryGetValue("skel", out var skelValue) ? skelValue.Trim() : string.Empty;
        if (skel.Length > 0 && !BrowserResourcePath.IsSafeResPath(skel))
        {
            return null;
        }

        var retry = false;
        if (query.TryGetValue("v", out _))
        {
            return null;
        }
        if (query.TryGetValue("retry", out var retryValue) && retryValue.Trim().Length > 0)
        {
            if (!string.Equals(retryValue.Trim(), "1", StringComparison.Ordinal))
            {
                return null;
            }

            retry = true;
        }

        // `t` (R10): the animation time a STILL should sample, in seconds. The mirror sends it only for a node the
        // GAME has PAUSED (SetTimeScale(0)) — the closed treasure chest frozen at t=0 of its lid-opening
        // "animation" — where the producer's mid-clip still heuristic renders a half-open chest. Honoured ONLY for
        // a still (an animated clip renders every frame, so a sample time there would fragment the cache for
        // nothing) and re-quantized host-side by FormatStillTime, so a client that sends more precision than the
        // policy allows still lands on the same cache entry as everyone else.
        double? stillTime = null;
        if (still
            && query.TryGetValue("t", out var stillTimeValue)
            && double.TryParse(stillTimeValue.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsedStillTime))
        {
            stillTime = parsedStillTime;
        }

        try
        {
            return CouchCoopSpineClipProvider.BuildSpineKey(
                $"res://{scene}",
                node.Length == 0 ? null : node,
                anim.Length == 0 ? null : anim,
                still,
                skin.Length == 0 ? null : skin,
                skel.Length == 0 ? null : skel,
                retry,
                mat.Length == 0 ? null : mat,
                stillTime);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    // The geoclip artifact route. A geoclip is a baked per-part mesh-geometry clip for one animation of one Spine
    // rig (manifest.json + packed sheets + verts.bin), and it is what the
    // client asks for FIRST — this is a product route, not a dev one. TWO roots, in order:
    //
    //   1. COUCHCOOP_GEOCLIPS_DIR — the OPERATOR root: a directory a human seeded with an out-of-band bake. Kept
    //      FIRST and byte-identical (predictable-sanitized directory names, map.json indirection, `no-store`), so
    //      every QA recipe that points it at a bake keeps overriding whatever the host produced for itself.
    //   2. CouchCoopGeoclipStore — the MANAGED cache the host writes. Hashed pose
    //      directories, atlas pages shared across poses by content hash.
    //
    // A cache miss addressed by the client recipe bakes through the managed store. Operator-form addresses remain
    // static lookups because they do not carry the recipe a baker needs.
    private async Task HandleGeoclipRequestAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        CancellationToken cancellationToken)
    {
        var operatorRoot = CouchCoopGeoclipDirectory.TryResolveRoot();
        var store = _geoclipStore ??= new CouchCoopGeoclipStore(resourceCacheRoot);
        if (!TryReadGeoclipAddress(request, out var key, out var fileName, out var identity))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.BadRequest,
                "invalid-geoclip-route",
                "The /geoclips route serves baked geoclip artifacts as /geoclips/{spine-key-or-directory}/{manifest.json|verts.bin|sheet-N.png|sheet-N.webp}, or as /geoclips/{scene-path}?node={rel}&anim={name}&file={artifact}.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var path = operatorRoot is null ? null : CouchCoopGeoclipDirectory.TryResolveFile(operatorRoot, key, fileName);
        path ??= store.TryResolveFile(key, fileName);

        // ON-DEMAND. Only the CLIENT addressing form can drive a bake: it is the only one that carries the
        // (scene, node, anim) identity a baker needs. The operator form addresses a key (or a bare directory
        // name), which is a lookup, not a recipe — so it stays a pure static read, exactly as today.
        // `produced` and `hasProvider` are hoisted ONLY so the 404 below can say what happened; the branch itself
        // is unchanged, provider construction included (it stays behind `path is null`, so a served request still
        // never builds one).
        CouchCoopGeoclipResult? produced = null;
        var bakeable = identity is not null;
        var hasProvider = false;
        if (path is null && bakeable)
        {
            var provider = GeoclipProvider(store);
            hasProvider = provider is not null;
            if (provider is not null)
            {
                produced = await provider.GetAsync(
                    new CouchCoopGeoclipRequest(key, identity!.SceneResPath, identity.NodePath, identity.AnimationName),
                    cancellationToken).ConfigureAwait(false);
                if (produced.Directory is not null)
                {
                    path = store.TryResolveFile(key, fileName);
                }
            }
        }

        if (path is null)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.NotFound,
                "geoclip-not-found",
                $"No geoclip artifact '{fileName}' is published for that key.",
                cancellationToken,
                GeoclipRefusalHeaders(store, key, fileName, produced, bakeable, hasProvider))
                .ConfigureAwait(false);
            return;
        }

        // A shared sheet's URL NAMES ITS OWN BYTES (sheet-<content hash>.png/.webp), so it is safe — and correct — to let
        // a browser keep it forever: a re-bake that changes the pixels changes the name, and the manifest that
        // points at it is itself `no-store`. Everything else stays `no-store`: the operator root exists to be
        // re-baked in place and reloaded, and a pose manifest is addressed by an identity that carries no policy
        // version in the CLIENT form, so a `gv` bump has to be able to change what it serves.
        var cacheControl = store.IsSharedPagePath(path)
            ? "public, max-age=31536000, immutable"
            : "no-store";
        await HttpResponseWriter.WriteFileAsync(
            stream,
            path,
            CouchCoopGeoclipDirectory.ContentTypeFor(fileName),
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Cache-Control"] = cacheControl
            },
            cancellationToken).ConfigureAwait(false);
    }

    // WHY THIS 404 MEANT WHAT IT MEANT — behind COUCHCOOP_GEOCLIP_DIAGNOSTICS, default off, body untouched.
    //
    // `geoclip-not-found` is the one answer this route gives to every one of: a bake that just ran and was refused
    // as incomplete, a bake refused EARLIER and remembered on disk, a producer that wrote no
    // manifest, an operator-form address that is a lookup rather than a recipe, and a host with no runtime to bake
    // through. Those are different facts about the host and, until now, telling them apart meant going and reading
    // refusal receipts out of the cache after the fact — which is what every live geoclip diagnosis in this
    // project has actually had to do.
    //
    // The body stays byte-identical on purpose: a client reads the code, and a generic code is the right thing to
    // hand an untrusted caller. The header is for the operator who armed it.
    private static Dictionary<string, string>? GeoclipRefusalHeaders(
        CouchCoopGeoclipStore store,
        string key,
        string fileName,
        CouchCoopGeoclipResult? produced,
        bool bakeable,
        bool hasProvider)
    {
        if (!CouchCoopGeoclipProvider.DiagnosticsEnabled)
        {
            return null;
        }

        // Ordered most-specific first: a verdict this request reached beats one read off disk, which beats a
        // statement about why no bake was attempted.
        var description = CouchCoopGeoclipProvider.TryDescribeRefusal(produced)
            ?? (store.TryReadRefusal(key) is { } record
                ? CouchCoopGeoclipProvider.DescribeCachedRefusal(record)
                : null)
            ?? DescribeNoProduction(key, fileName, produced, bakeable, hasProvider);

        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [CouchCoopGeoclipProvider.RefusalHeader] = description,
        };
    }

    private static string DescribeNoProduction(
        string key,
        string fileName,
        CouchCoopGeoclipResult? produced,
        bool bakeable,
        bool hasProvider)
    {
        if (!bakeable)
        {
            return CouchCoopGeoclipProvider.FormatRefusalHeader(
                "geoclip-address-not-bakeable",
                "the operator addressing form names a key, which is a lookup and not a recipe; use "
                + "/geoclips/<scene>?node=&anim=&file= to drive a bake");
        }

        if (!hasProvider)
        {
            return CouchCoopGeoclipProvider.FormatRefusalHeader(
                "geoclip-no-runtime-host",
                "this server has no embedded spirectl runtime to bake through");
        }

        // A bake HAPPENED and published a directory, and the requested file still is not in it — a whitelist
        // rejection, or an artifact this bake shape does not write (verts.bin on a geoclip/1 pose).
        return produced?.Directory is not null
            ? CouchCoopGeoclipProvider.FormatRefusalHeader(
                "geoclip-artifact-missing",
                $"the pose resolved but carries no '{fileName}'")
            : CouchCoopGeoclipProvider.FormatRefusalHeader(
                "geoclip-not-produced",
                $"nothing resolved for '{fileName}' and the producer reported no error (key {key})");
    }

    // The on-demand producer, built on first use like _spineClips. Null when this server has no runtime host to
    // bake through (the standalone/unit-test construction), which degrades to the static-read behaviour.
    private CouchCoopGeoclipProvider? GeoclipProvider(CouchCoopGeoclipStore store)
    {
        if (envelopeFactory is null)
        {
            return null;
        }

        return _geoclips ??= new CouchCoopGeoclipProvider(
            new CouchCoopRuntimeGeoclipBaker(envelopeFactory.RuntimeHost.SpineGeoClipBaker, envelopeFactory.RuntimeHost),
            store,
            _log);
    }

    // The route's TWO addressing forms, disambiguated by the presence of `file=` — a scene path contains slashes,
    // so "/geoclips/a/b/c" is otherwise ambiguous between a key with a slash in it and a scene path.
    //
    //   CLIENT form   /geoclips/<scene-path>?node=<rel>&anim=<name>&file=<artifact>
    //     The mirror's form, and the reason it exists: a browser cannot compute the canonical spine:// key
    //     (BuildSpineKey lives here), so it sends the same readable selectors it sends /spines/ and the SERVER
    //     mints the key — one key computation, no client-side copy to drift. `still` is deliberately not
    //     honoured: a geoclip is an ANIMATION by construction, so the key is always the animated form.
    //     skin/mat/skel/v are likewise not folded in — a geoclip bake is per (scene, node, anim).
    //
    //   OPERATOR form /geoclips/<spine-key-or-directory>/<artifact>
    //     One percent-encoded path segment carrying either the canonical key (take one from /perf/spine.json)
    //     or, for a hand-driven `curl`, the bake directory's own name. Resolution treats both the same way.
    //
    // `identity` is non-null ONLY for the client form, and it is what makes on-demand production possible: a
    // (scene, node, anim) triple is a recipe a baker can execute, while the operator form's opaque key (or bare
    // directory name) is only ever a lookup.
    private static bool TryReadGeoclipAddress(
        CouchCoopHttpRequest request,
        out string key,
        out string fileName,
        out CouchCoopGeoclipIdentity? identity)
    {
        key = string.Empty;
        fileName = string.Empty;
        identity = null;
        if (!request.RawPath.StartsWith("/geoclips/", StringComparison.Ordinal))
        {
            return false;
        }

        var rest = request.RawPath["/geoclips/".Length..].Trim('/');
        if (rest.Length == 0)
        {
            return false;
        }

        if (request.QueryValues.TryGetValue("file", out var requestedFile) && requestedFile.Trim().Length > 0)
        {
            fileName = requestedFile.Trim();
            var allowedFile = CouchCoopGeoclipDirectory.IsAllowedFileName(fileName);

            var scene = Uri.UnescapeDataString(rest).Trim().Trim('/');
            if (!BrowserResourcePath.IsSafeRelative(scene))
            {
                return false;
            }

            var node = request.QueryValues.TryGetValue("node", out var nodeValue) ? nodeValue.Trim() : string.Empty;
            var anim = request.QueryValues.TryGetValue("anim", out var animValue) ? animValue.Trim() : string.Empty;
            if (anim.Length == 0
                || !BrowserResourcePath.IsSafeSelector(node)
                || !BrowserResourcePath.IsSafeSelector(anim))
            {
                return false; // a geoclip is addressed by animation; there is no still form to fall back to
            }

            try
            {
                key = CouchCoopSpineClipProvider.BuildSpineKey(
                    $"res://{scene}",
                    node.Length == 0 ? null : node,
                    anim);
                // Preserve the route's established 404 for unknown artifact names, but never let one drive
                // production: only a whitelisted artifact request carries a bakeable identity downstream.
                identity = allowedFile
                    ? new CouchCoopGeoclipIdentity($"res://{scene}", node.Length == 0 ? null : node, anim)
                    : null;
                return true;
            }
            catch (ArgumentException)
            {
                return false;
            }
        }

        var lastSlash = rest.LastIndexOf('/');
        if (lastSlash <= 0 || lastSlash == rest.Length - 1)
        {
            return false;
        }

        key = Uri.UnescapeDataString(rest[..lastSlash]).Trim();
        fileName = Uri.UnescapeDataString(rest[(lastSlash + 1)..]).Trim();
        return key.Length > 0
            && !key.Any(char.IsControl)
            && !key.Contains('\\')
            && fileName.Length > 0
            && !fileName.Any(char.IsControl)
            && !fileName.Contains('/')
            && !fileName.Contains('\\');
    }
}

/// <summary>
/// The bakeable half of a <c>/geoclips/</c> address: the (scene, node, animation) triple the client form spells
/// out. Distinct from the key, which is a name — this is what a producer can act on.
/// </summary>
public sealed record CouchCoopGeoclipIdentity(string SceneResPath, string? NodePath, string AnimationName);
