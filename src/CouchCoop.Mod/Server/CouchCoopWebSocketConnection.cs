using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Session;
using CouchCoop.MirrorProtocol.Envelopes;
using Spirectl.Sts2.Core.SceneInspection;

namespace CouchCoop.Mod.Server;

public sealed class CouchCoopWebSocketConnection
{
    private static readonly RateLimitedDiagnosticLog MessageDiagnostics = new(Console.Error.WriteLine);
    internal const int MaxInputMessageBytes = 4 * 1024;
    internal const string InvalidInputMessageCode = "invalid-input-message";
    private readonly BrowserStateEnvelopeFactory _envelopeFactory;
    private readonly BrowserActionExecutor _actionExecutor;
    private readonly BrowserInputExecutor _inputExecutor;
    private readonly CouchCoopLobbyParticipation _lobby;
    private readonly ConcurrentDictionary<Guid, CouchCoopWebSocketConnection> _connections;
    private readonly Func<CouchCoopStateObserver?> _getStateObserver;
    private readonly Func<CouchCoopSceneObserver?> _getSceneObserver;
    private readonly Action _onConnectionOpened;
    private readonly Action _onConnectionClosed;
    // Raised (true/false, always balanced) as THIS connection's scene stream is gated on/off, so the server can
    // count STREAMING mirror connections and stop the scene observer entirely when every viewer is gated.
    private readonly Action<bool> _onSceneStreamingChanged;
    // Stage-B walk skip: raised when THIS connection's staticBg declaration flips via the `settings` message (the
    // onSceneStreamingChanged shape). The server recomputes its unanimity aggregate from the live connections on
    // every notification, so — unlike the streaming count — no balanced bookkeeping is required here (disconnects
    // recompute through UnregisterConnection). Optional because only server owners that track static-background
    // unanimity need to receive this notification.
    private readonly Action<bool>? _onStaticBgChanged;
    // Whether this viewer declares it shows the STATIC combat background (so it does not need the live bg subtree
    // streamed). Seeded at accept from the required canonical `?staticBg=0|1` selector; a missing or non-canonical
    // selector rejects the WebSocket contract. Later `settings` messages can flip it live. `volatile`: written on
    // the receive loop, read by
    // the server's aggregate recompute under its own gate.
    private volatile bool _wantsStaticBg;
    // A socket cannot be written concurrently; this gate serializes the scene fan-out (background thread)
    // against the connection's own replies (session / action-result).
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    // Per-connection COALESCING outbound for scene state. Scene state is a snapshot stream (intermediate
    // frames are disposable), so unlike combat events we never queue a FIFO of deltas — a slow client would
    // otherwise build an unbounded backlog and a click's resulting delta would land seconds late. Instead we
    // accumulate the set of changed/removed node ids (and structure/full flags) since the last send; the drain
    // resolves them to their LATEST state from the retained scene map and sends ONE coalesced delta, then
    // repeats. In-flight is bounded to 1 and end-to-end latency to a single send. Guarded by `_sceneLock`.
    private readonly object _sceneLock = new();
    private readonly SceneDeltaCoalescer _sceneCoalescer = new();
    // Defensive placeholder for the (unreachable) case where the coalescer asks for structure indices with no live
    // observer: an empty index makes the Stage 4 self-check fall back to the full array.
    private static readonly SceneStructureIndex EmptyStructureIndex = new()
    {
        RootIds = [],
        ChildIdsByParent = new Dictionary<string, IReadOnlyList<string>>(),
    };
    private bool _scenePending;
    private bool _scenePumpRunning;
    // Gate so the coalescing drain doesn't run until the Full keyframe has been sent (on connect, and again on
    // every re-enable of the stream gate below); incremental deltas accumulated meanwhile are drained, coalesced,
    // AFTER it — never before.
    private bool _sceneReady;
    // WS-B STREAM GATE. Whether this connection currently wants scene bytes at all. Set from the required canonical
    // `?watch=0|1` selector on connect and flipped live by the
    // `{"type":"watch","on":bool}` control message. While false the fan-out skips this connection entirely, nothing
    // is folded, nothing is queued, and the server stops counting us as a STREAMING mirror connection — which is
    // what lets it shut the (expensive) scene-tree producer down while every viewer sits on the join picker.
    // `volatile` because the broadcast thread reads it through WantsSceneStream without taking _sceneLock.
    private volatile bool _sceneStreaming;
    // Whether the server currently counts this connection in its streaming total. Guarded by _streamCountLock (NOT
    // _sceneLock): the notification runs the server's observer start/stop, which can synchronously deliver a delta
    // back into QueueSceneDelta — so _sceneLock must never be held across it.
    private readonly object _streamCountLock = new();
    private bool _streamingCounted;
    // APPLICATION-LEVEL FLOW CONTROL (the fix for the unbounded-lag runaway on a slow client): send the next
    // coalesced scene delta ONLY when the client has acked rendering the previous one. On localhost the kernel
    // accepts sends far faster than a weak client can parse+render them, so without this the client buffers an
    // ever-growing backlog (RTT climbing to many seconds). With it, exactly ONE delta is in flight; while the
    // client renders, new deltas COALESCE, so the next send is the latest — the stream self-paces to the
    // client's real frame rate, always showing newest state, never backing up. Starts granted (one free send);
    // a self-heal timeout (driven by incoming deltas) re-grants if an ack is ever lost so a client can't stall.
    private bool _sceneCredit = true;
    private long _lastSceneSendMs;
    private const long SceneAckTimeoutMs = 500;
    // Per-connection INPUT drain (the fix for the residual client→server lag). The receive loop must NOT inject
    // inline: `_inputExecutor.Execute` marshals to the game thread and blocks for up to a frame, and the loop
    // reads strictly serially — so the browser's continuous hover stream (one input per animation frame while
    // the cursor moves, 40-80/s) would stall the loop, and a `ping`/`scene-ack`/`click` arriving AFTER those
    // hovers in the TCP byte stream would wait seconds to even be read (the residual multi-second RTT). Instead
    // the loop just parses + enqueues here (microseconds) and this single worker injects off-loop. Hover/
    // drag-motion is a snapshot stream (only the latest cursor position matters), so CONSECUTIVE hovers coalesce
    // to the latest — the queue stays tiny and a click is never stuck behind stale hovers. Discrete events
    // (press/release/click/key) are never dropped and keep their order. Guarded by `_inputLock`.
    private readonly object _inputLock = new();
    private readonly BoundedInputQueue _inputQueue = new(256);
    private bool _inputPumpRunning;
    private Task _inputPumpTask = Task.CompletedTask;
    private readonly ConnectionJoinOperation _joinOperation;
    private readonly MainThreadPingGate _mainThreadPingGate = new();
    // Outbound SEAT NOTICES, chained. The hub calls us on the seat monitor's 250 ms loop, which must never block
    // on a socket, so each notice is handed to a task — and each task waits for the one before it, because the
    // whole point of a withdrawal is that it lands AFTER the accusation it cancels. Guarded by _seatNoticeLock.
    private readonly object _seatNoticeLock = new();
    private Task _seatNoticeSends = Task.CompletedTask;
    internal const int MaxInboundMessageBytes = 256 * 1024;
    private readonly Guid _id = Guid.NewGuid();
    private WebSocket? _socket;
    private readonly HeadlessClientManager? _headlessManager;
    private readonly bool _isHeadlessClient;
    // TRUE when this browser arrived on the opt-in TLS listener. Load-bearing for exactly one decision: an
    // https page may only be handed a wss redirect target, so a joined seat must be sent its headless
    // instance's SECURE port, never the plain-HTTP one (a browser blocks ws: from an https: page outright).
    private readonly bool _isSecure;

    // How long a TLS join waits for a freshly spawned headless instance to publish its secure port. The
    // instance has already passed its HTTP readiness gate by this point and the certificate is normally warm
    // in the shared cache, so this is the cold-start tail, not the expected cost. Short enough that a
    // genuinely certificate-less instance rejects promptly instead of leaving the picker spinning.
    private static readonly TimeSpan SecurePortResolveTimeout = TimeSpan.FromSeconds(8);
    // The live session handle + last viewer name, retained so the server can RE-SEND this connection's session
    // envelope when the lobby roster / run status changes (keeps the shared join screen live without the full
    // state). Set in AcceptCoreAsync; _viewerName updated on a successful join.
    private BrowserSessionHandle? _session;
    private string? _viewerName;
    // Where this connection's pre-WebSocket half is recorded: the visit id the browser sends on `join` is
    // merged into THIS connection's row here, rather than left as a second, ownerless arrival.
    private readonly ConnectionArrivalLog _arrivals;

    private CouchCoopWebSocketConnection(
        BrowserStateEnvelopeFactory envelopeFactory,
        ConcurrentDictionary<Guid, CouchCoopWebSocketConnection> connections,
        Func<CouchCoopStateObserver?> getStateObserver,
        Func<CouchCoopSceneObserver?> getSceneObserver,
        Action onConnectionOpened,
        Action onConnectionClosed,
        Action<bool> onSceneStreamingChanged,
        Action<bool>? onStaticBgChanged,
        HeadlessClientManager? headlessManager,
        bool isHeadlessClient,
        bool sceneStreaming,
        bool wantsStaticBg,
        bool isSecure,
        ConnectionArrivalLog arrivals)
    {
        _envelopeFactory = envelopeFactory ?? throw new ArgumentNullException(nameof(envelopeFactory));
        _connections = connections ?? throw new ArgumentNullException(nameof(connections));
        _getStateObserver = getStateObserver ?? throw new ArgumentNullException(nameof(getStateObserver));
        _getSceneObserver = getSceneObserver ?? throw new ArgumentNullException(nameof(getSceneObserver));
        _onConnectionOpened = onConnectionOpened ?? throw new ArgumentNullException(nameof(onConnectionOpened));
        _onConnectionClosed = onConnectionClosed ?? throw new ArgumentNullException(nameof(onConnectionClosed));
        _onSceneStreamingChanged = onSceneStreamingChanged ?? throw new ArgumentNullException(nameof(onSceneStreamingChanged));
        _onStaticBgChanged = onStaticBgChanged;
        _headlessManager = headlessManager;
        _isHeadlessClient = isHeadlessClient;
        _sceneStreaming = sceneStreaming;
        _wantsStaticBg = wantsStaticBg;
        _isSecure = isSecure;
        _arrivals = arrivals ?? throw new ArgumentNullException(nameof(arrivals));
        _actionExecutor = new BrowserActionExecutor(envelopeFactory.RuntimeHost);
        _inputExecutor = new BrowserInputExecutor(envelopeFactory.RuntimeHost);
        _lobby = new CouchCoopLobbyParticipation(envelopeFactory.RuntimeHost);
        _joinOperation = new ConnectionJoinOperation(exception =>
        {
            if (_session is { } session)
                ConnectionRegistry.Shared.Fail(session.Id, "join-failed",
                    "The host could not finish sending the game connection result.",
                    "Reconnect this browser. If it repeats, copy the report.", exception.ToString());
            // End the receive pump so the browser can reconnect and the owned seat is cleaned up.
            _socket?.Abort();
        });
    }

    /// <summary>
    /// True when this connection currently wants the `scene-delta` stream (the WS-B watch gate). The scene fan-out
    /// consults this per connection, so a viewer parked on the join picker receives ZERO scene bytes.
    /// </summary>
    public bool WantsSceneStream => _sceneStreaming;

    /// <summary>
    /// Stage-B walk skip: true when this viewer declared through the required `?staticBg=1` connect selector or a
    /// later `settings` message that it shows the STATIC combat background image, i.e. it does not need the live bg subtree
    /// streamed. The server's unanimity aggregate reads this per streaming mirror connection; false keeps
    /// the subtree flowing for everyone.
    /// </summary>
    public bool WantsStaticBg => _wantsStaticBg;

    private static bool ParseRequiredBoolean(string? raw, string name) => raw switch
    {
        "0" => false,
        "1" => true,
        _ => throw new FormatException($"Missing or non-canonical `{name}` WebSocket contract selector."),
    };

    public static async Task AcceptAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        BrowserStateEnvelopeFactory envelopeFactory,
        ConcurrentDictionary<Guid, CouchCoopWebSocketConnection> connections,
        Func<CouchCoopStateObserver?> getStateObserver,
        Func<CouchCoopSceneObserver?> getSceneObserver,
        Action onConnectionOpened,
        Action onConnectionClosed,
        Action<bool> onSceneStreamingChanged,
        Action<bool>? onStaticBgChanged = null,
        bool isSecure = false,
        HeadlessClientManager? headlessManager = null,
        bool isHeadlessClient = false,
        ConnectionArrivalLog? arrivals = null,
        CancellationToken cancellationToken = default)
    {
        if (request.QueryValues.ContainsKey("view"))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream, HttpStatusCode.BadRequest, "invalid-websocket-contract",
                "The obsolete `view` selector is not part of the current WebSocket contract.", cancellationToken).ConfigureAwait(false);
            return;
        }

        bool watch, staticBg;
        try
        {
            watch = ParseRequiredBoolean(request.QueryValues.GetValueOrDefault("watch"), "watch");
            staticBg = ParseRequiredBoolean(request.QueryValues.GetValueOrDefault("staticBg"), "staticBg");
            _ = ParseRequiredBoolean(request.QueryValues.GetValueOrDefault("cardFlight"), "cardFlight");
            _ = ParseRequiredBoolean(request.QueryValues.GetValueOrDefault("handTween"), "handTween");
            _ = ParseRequiredBoolean(request.QueryValues.GetValueOrDefault("trailDrive"), "trailDrive");
        }
        catch (FormatException exception)
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream, HttpStatusCode.BadRequest, "invalid-websocket-contract", exception.Message, cancellationToken).ConfigureAwait(false);
            return;
        }

        // These required selectors make the current query contract explicit. Only watch/staticBg shape this
        // connection; the current producer emits animation data consistently for every admitted viewer.
        await new CouchCoopWebSocketConnection(
                envelopeFactory,
                connections,
                getStateObserver,
                getSceneObserver,
                onConnectionOpened,
                onConnectionClosed,
                onSceneStreamingChanged,
                onStaticBgChanged,
                headlessManager,
                isHeadlessClient,
                watch,
                staticBg,
                isSecure,
                arrivals ?? ConnectionArrivalLog.Shared)
            .AcceptCoreAsync(stream, request, cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task AcceptCoreAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(request.Path, "/ws", StringComparison.Ordinal))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.NotFound,
                "not-found",
                "WebSocket upgrades are only accepted on /ws.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        if (!request.IsWebSocketUpgrade
            || !request.Headers.TryGetValue("Sec-WebSocket-Key", out var key)
            || string.IsNullOrWhiteSpace(key))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(
                stream,
                HttpStatusCode.BadRequest,
                "invalid-websocket-upgrade",
                "Missing required WebSocket upgrade headers.",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        await WriteHandshakeAsync(stream, key, cancellationToken).ConfigureAwait(false);
        using var socket = WebSocket.CreateFromStream(stream, true, null, TimeSpan.FromSeconds(30));
        _socket = socket;
        using var session = _envelopeFactory.CreateSession();
        _session = session;
        if (CouchCoopMod.IsHeadlessClient) HeadlessConnectionReporter.BrowserOpened();
        else
        {
            ConnectionRegistry.Shared.Connected(session.Id, ConnectionDeviceLabel.FromUserAgent(request.Header("User-Agent")));
            ConnectionRegistry.Shared.RecordDiagnostic(session.Id, "transport", _isSecure ? "Host WebSocket over TLS" : "Host WebSocket over HTTP");
            ConnectionRegistry.Shared.RecordDiagnostic(session.Id, "gameVersion", _envelopeFactory.RuntimeHost.Capabilities.GameVersion);
            // Offer this socket as the way to reach this viewer with their seat's readiness verdict. Registered
            // HERE, before any join: the seat is bound to the session id, and the monitor's next tick finds
            // whoever is listening for it. It is also why the socket a redirected viewer keeps open (gated, but
            // open — closing it would Release() and kill their seat) is still useful to the host: on the one
            // failure where the browser cannot reach the seat it was sent to, this is the only channel left.
            SeatNoticeHub.Shared.Subscribe(session.Id, OnSeatNotice);
        }
        // A seat's connect URL carries the visit id the host's page minted (the host's own does not — that one
        // arrives on the `join` message below), so a seat can bind its arrival to this socket immediately.
        PromoteVisit(session, request.QueryValues.GetValueOrDefault(CouchCoopBrowserServer.MirrorVisitSelector));
        _connections[_id] = this;
        try
        {
            // `/ws` carries no `?name=`: the client connects anonymously and joins explicitly. Send a
            // one-time `session` reply (identity + capabilities/notices). Roster / run-status changes arrive
            // as later `session` re-sends; the scene itself arrives as `scene-delta` frames.
            await SendEnvelopeAsync(await _envelopeFactory.CreateSessionEnvelope(
                viewerName: null,
                "session",
                session,
                cancellationToken: cancellationToken).ConfigureAwait(false)).ConfigureAwait(false);
            ConnectionRegistry.Shared.Advance(session.Id, ConnectionStage.Choosing);

            var cachedSceneObserver = _sceneStreaming ? _getSceneObserver() : null;
            _onConnectionOpened();
            // Count this connection as STREAMING before the keyframe below, mirroring the "register first, then
            // keyframe, then release the pump" discipline: the fan-out must already be reaching us so a delta
            // emitted between the keyframe and EnableScenePump is folded (and drained after it), never lost.
            // A `?watch=0` connection reports nothing here, so a host whose every viewer is on the join picker
            // never starts the scene producer at all.
            SyncStreamingRegistration();

            // Mirror clients render off the `scene-delta` stream; send a FULL keyframe of the retained scene
            // on connect (when the scene-watch capability is present) so a fresh mirror client has the whole
            // tree before incremental deltas arrive. Sent AFTER registering in `_connections` so any delta
            // broadcast in between is also delivered (idempotent on the client). SKIPPED ENTIRELY for a
            // `?watch=0` connection: suppressing
            // this keyframe is the whole reason the gate rides the query string rather than a post-connect
            // message — by the time a message could arrive, the (multi-MB) keyframe is already on the wire.
            var keyframe = cachedSceneObserver?.BuildKeyframe();
            if (keyframe is not null)
            {
                await SendStateBytesAsync(BrowserSceneDeltaMessage.Serialize(keyframe)).ConfigureAwait(false);
            }

            // Release the coalescing scene pump: any incremental deltas that arrived during connect were
            // buffered (not sent) and now drain — coalesced — strictly AFTER the keyframe above. A gated
            // connection leaves the pump shut; `watch:on` opens it (with its own fresh keyframe) later.
            if (_sceneStreaming)
            {
                EnableScenePump();
            }

            await ReceiveLoopAsync(socket, session, cancellationToken).ConfigureAwait(false);
        }
        catch (WebSocketException exception) when (!cancellationToken.IsCancellationRequested)
        {
            ConnectionRegistry.Shared.Fail(session.Id, "browser-transport-lost", "The browser connection ended unexpectedly.",
                "Check this device's network connection and reload the browser tab.", exception.ToString());
        }
        finally
        {
            await _joinOperation.CancelAndWaitAsync().ConfigureAwait(false);
            _joinOperation.Dispose();
            if (CouchCoopMod.IsHeadlessClient) HeadlessConnectionReporter.BrowserClosed();
            else
            {
                // Before anything else in this branch: nothing may be handed a dead socket, and the hub's record
                // of what this viewer has been told dies with the session it belonged to — a phone that comes
                // back does so as a NEW session and must be told the verdict again rather than debounced against
                // a conversation held over a socket that no longer exists.
                SeatNoticeHub.Shared.Unsubscribe(session.Id);
                if (_headlessManager is not null) await _headlessManager.FinishReportedFailureAsync(session.Id).ConfigureAwait(false);
                ConnectionRegistry.Shared.Disconnected(session.Id);
            }
            // Every input admitted before disconnect is an edge the game must observe. The bounded queue applies
            // backpressure to the peer; teardown waits for its single ordered drain instead of discarding it.
            Task inputDrain;
            lock (_inputLock) inputDrain = _inputPumpTask;
            try { await inputDrain.ConfigureAwait(false); } catch { }
            _connections.TryRemove(_id, out _);
            // Give the streaming count back BEFORE the connection count so the server sees a consistent
            // (streaming <= mirror) pair on every RefreshObserversLocked pass. Idempotent: a connection that was
            // already gated off (or never streamed) reports nothing.
            _sceneStreaming = false;
            SyncStreamingRegistration();
            _onConnectionClosed();

            // Headless lifecycle on browser disconnect, gated on whether a RUN is in progress:
            //  - DURING A RUN: KEEP the headless alive (mark it detached). It stays ENet-joined to the host's run
            //    as its netId, so when the browser reconnects it re-claims the SAME live headless and instantly
            //    sees the live run — no respawn, no ENet rejoin. The detached headless is reaped when the host
            //    quits the run (host state observer → ReapDetachedSlots) or the game (HeadlessClientManager.Dispose).
            //  - IN THE LOBBY (or main menu): kill it now and evict its ENet peer, freeing the netId and removing
            //    the phantom lobby player (the original behavior).
            if (_headlessManager is not null)
            {
                if (_lobby.IsRunInProgress())
                {
                    _headlessManager.MarkDetached(session.Id);
                }
                else
                {
                    var freedNetId = _headlessManager.Release(session.Id);
                    if (freedNetId is ulong evictNetId)
                    {
                        // The SIGKILL'd headless leaves its peer registered in the host's ENet server holding this
                        // netId until ENet's ~20-40s timeout; evicting frees it immediately so a same-name rejoin
                        // isn't rejected at the handshake (IdCollision → timeout).
                        _lobby.DisconnectClient(evictNetId);
                        // Drop the display-name override ONLY when this seat is genuinely gone — i.e. no name still
                        // CLAIMS the slot behind this netId.
                        //
                        // The rule, and why it isn't just "always clear on disconnect": clearing hands the nameplate
                        // back to the game's fallback source, PlatformUtil.GetPlayerNameRaw → the durable
                        // mp_names.json roster as this host process parsed it at ITS start, which may still name an
                        // EARLIER holder of this netId. So a premature clear doesn't blank the name, it resurrects
                        // an older one. (The roster itself is intentionally persistent — it is the only netId→name
                        // memory a saved run can be relabelled from — so the fix is to keep the override, never to
                        // erase the file.) Release() above deliberately keeps the departing player's name→slot claim
                        // (their netId stays reserved for a reconnect), and the mid-run branch (MarkDetached) keeps
                        // the claim AND the process, so in both cases the seat is "vacant, still theirs" and the
                        // override must stay. A netId that is genuinely taken over by a DIFFERENT player needs no
                        // clear either: EnsureHeadlessAsync reports the new binding (onSlotBound) and we
                        // SetClientName it before that headless starts.
                        // What remains — a claim that was actually dropped (run-end reap, slot steal) — is the only
                        // case that clears, and CouchCoopBrowserServer's run-end reap already covers the reap half.
                        if (!_headlessManager.HasClaimForNetId(evictNetId))
                        {
                            _lobby.ClearClientName(evictNetId);
                        }
                    }
                }
            }

            // When the last browser for a synthetic lobby player disconnects, remove that player from the
            // live game lobby (its leave action force-refreshes state → the removal is rebroadcast to all).
            var removedPlayerId = _envelopeFactory.DisconnectSession(session);
            if (removedPlayerId is not null)
            {
                _lobby.LeaveLobbyPlayer(removedPlayerId);
            }
        }
    }

    /// <summary>
    /// Register the browser-chosen display name for a headless slot's netId at SLOT-BIND time — the callback
    /// <see cref="HeadlessClientManager.EnsureHeadlessAsync"/> fires before it launches the instance.
    /// <para>
    /// Dispatched to the thread pool on purpose. The manager invokes this while holding its internal slot lock
    /// (that is what makes "before the spawn" possible), whereas <c>SetClientName</c> executes a semantic action
    /// that marshals to — and blocks on — the Godot main thread. The main thread takes that same slot lock when it
    /// disposes the manager at game shutdown, so blocking here would be a lock-order inversion (a hang on exit).
    /// Handing the action off keeps the lock held for microseconds; the action itself still lands many seconds
    /// before the headless finishes loading and the host builds its nameplate.
    /// </para>
    /// </summary>
    private void RegisterClientNameAtSlotBind(ulong netId, string? displayName)
    {
        _ = Task.Run(() =>
        {
            try
            {
                _lobby.SetClientName(netId, displayName);
            }
            catch (Exception exception)
            {
                // Naming is cosmetic: never let it surface as a failed join.
                Console.Error.WriteLine($"[couchcoop] early SetClientName({netId}) failed: {exception.GetType().Name}: {exception.Message}");
            }
        });
    }

    /// <summary>
    /// Merge a visit id into THIS connection, so the HTTP arrivals that preceded the socket belong to the
    /// same attempt instead of forming a second, ownerless record. Untrusted input: anything that is not a
    /// minted visit id is dropped, and a value that matches nothing is simply a no-op.
    /// </summary>
    private void PromoteVisit(BrowserSessionHandle session, string? visitId)
    {
        var visit = ConnectionArrivalLog.NormalizeVisitId(visitId);
        if (visit is null) return;
        _arrivals.Promote(visit, session.Id);
        // A seat has no registry rows of its own — it reports through HeadlessConnectionReporter — so only the
        // host records the correlation as a fact on the row.
        if (!CouchCoopMod.IsHeadlessClient)
            ConnectionRegistry.Shared.RecordDiagnostic(session.Id, "visit", visit);
    }

    private bool TryStartJoin(BrowserSessionHandle session, BrowserJoinRequestEnvelope join, CancellationToken cancellationToken)
        => _joinOperation.TryStart(cancellationToken, token => RunJoinAsync(session, join, token));

    private async Task RunJoinAsync(BrowserSessionHandle session, BrowserJoinRequestEnvelope join, CancellationToken cancellationToken)
    {
        var requestId = string.IsNullOrWhiteSpace(join.RequestId) ? Guid.NewGuid().ToString("N") : join.RequestId;
        _viewerName = join.Name;
        var connectionAttemptId = ConnectionRegistry.Shared.BeginAttempt(session.Id);
        ConnectionRegistry.Shared.SetDisplayName(session.Id, join.Name);
        ConnectionRegistry.Shared.RecordDiagnostic(session.Id, "transport", _isSecure ? "Host WebSocket over TLS" : "Host WebSocket over HTTP");
        ConnectionRegistry.Shared.RecordDiagnostic(session.Id, "gameVersion", _envelopeFactory.RuntimeHost.Capabilities.GameVersion);

        int? headlessPort = null;
        bool? directView = null;
        string? joinRejection = null;
        // Server-fault text carried to the viewer when the block below throws. Null on every ordinary path.
        string? joinRejectionDetail = null;

        // TELL THE VIEWER WHAT THIS IS DOING. Everything below can take 20-60 seconds (a cold seat spawn is
        // awaited inline), and until this ticker existed the browser had a bare spinner for all of it — the same
        // spinner a join that had already died showed for the full deadline. The registry rows above are the
        // single source of the stage/step/elapsed it streams; the `finally` stops it before the terminal reply
        // below, so progress can never arrive after the answer it was describing.
        var progress = JoinProgressTicker.Start(
            ConnectionRegistry.Shared, session.Id, requestId, SendJoinProgressAsync, cancellationToken);

        // An unexpected fault in the join decision below must reach the VIEWER, not just the log. Everything
        // here — the lobby context read, the spawn, the secure-port resolution — used to run bare inside the
        // receive loop's own try, whose catch answers with an `action-result`; the mirror client does not read
        // that message type, so a throw was delivered, discarded, and the join screen spun on "Joining…"
        // forever with nothing in the host log either. Converting it into `joinRejection` puts it on the one
        // channel the client already treats as TERMINAL, so any future fault here fails visibly by default.
        try
        {
            if (_headlessManager is null)
            {
                // No manager (this process IS a headless client, or the host couldn't resolve its exe):
                // there is nothing to spawn — the current connection already serves a game stream.
                directView = true;
            }
            else
            {
                var ctx = _lobby.DescribeMirrorJoinContext();
                // Publish who the HOST can name (itself — a SteamID64 on a Steam-hosted session — plus
                // every remote player) to the durable roster BEFORE any spawn decision below, so the
                // seat we may be about to launch reads a complete mp_names.json at construction and
                // every ALREADY-RUNNING seat picks the newcomers up on its next name-sync tick. Without
                // this a seat can only name the couch slots this host allocated, and renders everyone
                // else — the host included — as a raw netId.
                if (ctx.RosterNames is { Count: > 0 } rosterNames)
                {
                    _headlessManager.PublishRosterNames(rosterNames);
                }

                var trimmedName = join.Name?.Trim();
                // A roster BUTTON tap carries the option's player id, so the seat is known exactly; a
                // free-text name submit carries none and falls through to name resolution as before.
                // Only a couch-coop SEAT netId is honoured — the host's own id (netId 1) and a genuine
                // remote player are outside the guard band and must never be spawned into.
                ulong? targetNetId = null;
                if (MirrorSeatNetIds.TryParsePlayerId(join.PlayerId?.Trim(), out var pickedNetId)
                    && MirrorSeatNetIds.IsMirrorSeat(pickedNetId))
                {
                    targetNetId = pickedNetId;
                }

                if (ctx.IsSingleplayerRun)
                {
                    // Rule 1: a true singleplayer run — nothing can join it. Enter directly (host stream).
                    directView = true;
                }
                else if (string.IsNullOrWhiteSpace(trimmedName))
                {
                    // No selection: reply screen-only so the client shows the picker/name field. No spawn.
                }
                else if (ctx.HostName is not null
                    && string.Equals(trimmedName, ctx.HostName, StringComparison.OrdinalIgnoreCase))
                {
                    // Rule 4: the HOST seat was selected — never spawn; watch the host's own stream.
                    directView = true;
                }
                else if (_envelopeFactory.RefuseSeatJoin(
                    // WHICH SEAT IS BEING JUDGED. A roster tap says so outright; a free-text submit does not,
                    // so the name's own slot claim answers for it. That second half is not a nicety: the
                    // browser's automatic reconnect re-joins with the REMEMBERED NAME and no player id, so with
                    // only `targetNetId` this rule was skipped for precisely the join that most needed it — a
                    // device coming back to a seat whose process had died. It would fall through, be allowed to
                    // spawn, and the host would refuse the instance ~30s later. A name with no claim here is
                    // still unjudged and still falls through to name resolution below, exactly as before.
                    targetNetId ?? _headlessManager.NetIdForClaimedName(trimmedName)) is { } seatRejection)
                {
                    // Rule 6: the picked SEAT is not joinable right now (mid-run with no game-connected
                    // instance, or a lobby zombie awaiting its reap — MirrorSeatDirectory's matrix). The
                    // picker already renders those rows disabled; enforcing it here too means a stale
                    // roster, a retried request or a hand-crafted client cannot drive a join the picker
                    // would not offer — which would spawn an instance the game then refuses, i.e. a join
                    // that silently fails.
                    joinRejection = seatRejection;
                }
                else
                {
                    // A non-host seat / new remote player. SPAWN only while the host accepts joins
                    // (allowNewSlot), else REUSE an already-claimed slot (mid-run reconnect). A brand-new
                    // name with no spawn window / no claim returns null → rejected below.
                    //
                    // A picked SEAT widens that window: a netId that already has a seat in the live run
                    // or in the loaded save is a RESPAWN of an existing peer, which is exactly what the
                    // game's netId-gated rejoin accepts (see MirrorJoinContext.MayRejoinNetId). Without
                    // this, a player who dropped out of a run could see their seat and still not take
                    // it — the roster filter was only half of that defect.
                    var isSeatRejoin = targetNetId is ulong wantedSeat && ctx.MayRejoinNetId(wantedSeat);
                    headlessPort = await _headlessManager.EnsureHeadlessAsync(
                        session.Id,
                        trimmedName,
                        cancellationToken,
                        allowNewSlot: ctx.SpawnAllowed || isSeatRejoin,
                        // Name the netId the INSTANT its slot is bound — before the headless process even
                        // starts, and 20-60s before EnsureHeadlessAsync returns (it waits for the instance
                        // to ENet-join, preload ~770 assets and serve HTTP). The host builds this player's
                        // NRemoteLobbyPlayer nameplate ONCE, from PlatformUtil.GetPlayerNameRaw, as soon as
                        // the headless completes its handshake — so naming only after readiness (what the
                        // post-readiness call below used to be the ONLY source of) always lost that race
                        // and left the widget showing GetPlayerNameRaw's fallback: the durable
                        // mp_names.json roster as this host process read it at ITS start, which can name
                        // an earlier holder of the netId. The override below wins wherever it exists,
                        // which is why registering it early — not blanking the roster — is the fix.
                        onSlotBound: RegisterClientNameAtSlotBind,
                        // Bind the instance to the PICKED seat's netId rather than letting the allocator
                        // choose by name. Null for a free-text name submit (no seat yet).
                        targetNetId: targetNetId).ConfigureAwait(false);
                    if (headlessPort is int readyPort)
                    {
                        // The headless's REAL ENet player IS this browser's player. Name that real netId
                        // so the host lobby AND the per-viewer mirror show the chosen display name instead
                        // of the raw netId ("1002"). No synthetic host-local seat is added (that produced
                        // the old "phantom" second lobby player). Redundant with the slot-bound
                        // registration above and kept deliberately: it is idempotent, costs one action,
                        // and re-asserts the name if the early attempt was dropped (e.g. the semantic
                        // action ran before the peer existed).
                        _lobby.SetClientName(HeadlessClientManager.NetIdForPort(readyPort), trimmedName);
                    }
                    else
                    {
                        var failure = ConnectionRegistry.Shared.Snapshot().Rows
                            .FirstOrDefault(row => row.Id == session.Id)?.Issue;
                        if (failure?.Code == Session.HeadlessDisconnectReason.RunInProgressCode)
                        {
                            // The allocator refused to LAUNCH into a running run. Rule 6 above catches this
                            // for every join the seat table has an opinion on; reaching here means it did
                            // not (no seat table, or a seat whose verdict had not been evaluated yet), so
                            // the same answer is given from the same code the picker's disabled rows carry.
                            // Not "spawn-failed": nothing failed and a retry changes nothing until the host
                            // reloads the save, so copy that invites an immediate retry would be a lie.
                            joinRejection = MirrorSeatStatuses.UnavailableRejection;
                            joinRejectionDetail = failure.Detail ?? failure.Summary;
                        }
                        else if (ctx.SpawnAllowed || isSeatRejoin)
                        {
                            // Spawn window (or an allowed seat rejoin), but no port: the respawn failed, else
                            // the pool is full. A seat rejoin is a respawn by definition, so it reports
                            // "spawn-failed" rather than pretending the name was unknown.
                            joinRejection = failure is not null || isSeatRejoin || _headlessManager.HasNameClaim(trimmedName)
                                ? "spawn-failed"
                                : "no-free-instance";
                            joinRejectionDetail = failure?.Detail ?? failure?.Summary;
                        }
                        else
                        {
                            // Not a spawn window (a run is active), not a seat that exists here, and no
                            // existing claim to reuse (rules 2 & 5).
                            joinRejection = "not-a-session-player";
                        }
                    }
                }
            }

            // TLS viewers must be redirected to the headless instance's SECURE port. The client
            // builds its redirect URL from the PAGE's scheme (buildHeadlessMirrorWebSocketUrl picks
            // wss: for an https: page) and this port verbatim, so handing an https page the
            // plain-HTTP port produces `wss://host:<http-port>` — a socket that cannot complete,
            // which is how a secure-origin viewer could watch but never take a seat.
            //
            // FAIL CLOSED. If the instance has no secure port we refuse the join rather than send
            // the HTTP one: a redirect the browser will block (mixed content) or hang on is a
            // silent dead end, whereas a rejection reaches the picker with copy the player can act
            // on. "spawn-failed" is reused deliberately — it is the one existing code whose
            // frontend copy ("Couldn't start your game view — please try again.") is both honest
            // and accurate, since a retry moments later usually succeeds once the certificate has
            // landed. An unrecognised code would render as "That name is not from a session
            // player", which would be a lie.
            if (_isSecure && headlessPort is int insecurePort && joinRejection is null)
            {
                var securePort = await HeadlessClientManager
                    .TryResolveSecurePortAsync(insecurePort, SecurePortResolveTimeout, cancellationToken)
                    .ConfigureAwait(false);

                if (securePort is int resolved)
                {
                    headlessPort = resolved;
                }
                else
                {
                    headlessPort = null;
                    joinRejection = "spawn-failed";
                    Console.Error.WriteLine(
                        "[couchcoop] secure-origin join refused: headless instance on port "
                        + $"{insecurePort.ToString(System.Globalization.CultureInfo.InvariantCulture)} reported no secure port.");
                }
            }
        }
        catch (Exception joinException) when (!cancellationToken.IsCancellationRequested)
        {
            // Shutdown is excluded by the filter above: a cancelled token means the socket is going away, which
            // is not a join failure and has no viewer left to tell.
            headlessPort = null;
            directView = null;
            joinRejection = "join-failed";
            joinRejectionDetail = "The game could not complete the join. Try again.";
            ConnectionRegistry.Shared.Fail(session.Id, "launch-exception", "The host could not complete the game launch.",
                "Retry this connection. If it fails again, copy this report.", joinException.ToString());
            MessageDiagnostics.Write("join-failed",
                $"[couchcoop] mirror join failed for '{join.Name}': {joinException}");
        }
        finally
        {
            // The attempt is decided — by a port, a direct view, a rejection, a throw or the socket going away.
            // Awaited, not just cancelled: the viewer must never be told "still starting" after being told how
            // this ended.
            await progress.StopAsync().ConfigureAwait(false);
        }

        // A close can arrive just after readiness. Do not reply to a tab that is already gone;
        // teardown below owns its slot release.
        cancellationToken.ThrowIfCancellationRequested();

        if (joinRejection is not null)
        {
            ConnectionRegistry.Shared.Fail(session.Id, joinRejection,
                "The game could not complete the connection.", "Try reconnecting this device.", joinRejectionDetail);
        }
        else if (headlessPort is not null || directView == true)
        {
            if (directView == true) ConnectionRegistry.Shared.UseShortPath(session.Id);
            ConnectionRegistry.Shared.Advance(session.Id, ConnectionStage.LoadingView);
            var expectedAttempt = connectionAttemptId;
            _ = ConnectionRegistry.Shared.NoticeSlowViewWhenDueAsync(session.Id, expectedAttempt, cancellationToken);
        }

        await SendEnvelopeAsync(await _envelopeFactory.CreateSessionEnvelope(
            join.Name,
            requestId,
            session,
            headlessPort,
            directView,
            joinRejection,
            joinRejectionDetail,
            connectionAttemptId,
            cancellationToken).ConfigureAwait(false)).ConfigureAwait(false);
    }

    private async Task ReceiveLoopAsync(WebSocket socket, BrowserSessionHandle session, CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            using var memory = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    if (!CouchCoopMod.IsHeadlessClient && (result.CloseStatus is null or WebSocketCloseStatus.NormalClosure
                        or WebSocketCloseStatus.EndpointUnavailable or WebSocketCloseStatus.Empty))
                        ConnectionRegistry.Shared.TransportClosing(session.Id);
                    await CloseBoundedAsync(socket, WebSocketCloseStatus.NormalClosure, "closed", cancellationToken).ConfigureAwait(false);
                    return;
                }

                if (result.MessageType == WebSocketMessageType.Binary)
                {
                    await CloseBoundedAsync(socket, WebSocketCloseStatus.InvalidMessageType, "binary-not-supported", cancellationToken).ConfigureAwait(false);
                    return;
                }

                if (result.Count > MaxInboundMessageBytes - memory.Length)
                {
                    await CloseBoundedAsync(socket, WebSocketCloseStatus.MessageTooBig, "message-too-large", cancellationToken).ConfigureAwait(false);
                    return;
                }

                memory.Write(buffer, 0, result.Count);
            }
            while (!result.EndOfMessage);

            if (result.MessageType != WebSocketMessageType.Text)
            {
                await SendResultAsync(new BrowserActionResultEnvelope(
                    "action-result",
                    Guid.NewGuid().ToString("N"),
                    BrowserActionErrorCodes.InvalidMessage,
                    "Only text WebSocket messages are supported.")).ConfigureAwait(false);
                continue;
            }

            var text = Encoding.UTF8.GetString(memory.ToArray());
            // The inbound message's own requestId, hoisted out of the try so the catch below can CORRELATE its
            // error reply to the request that caused it. It used to mint a fresh GUID for every fault, which made
            // an escaping error impossible to tie back to anything the client had sent.
            string? inboundRequestId = null;
            try
            {
                using var document = JsonDocument.Parse(text);
                var type = document.RootElement.TryGetProperty("type", out var typeElement)
                    ? typeElement.GetString()
                    : null;
                if (document.RootElement.TryGetProperty("requestId", out var requestIdElement)
                    && requestIdElement.ValueKind == JsonValueKind.String)
                {
                    inboundRequestId = requestIdElement.GetString();
                }
                if (string.Equals(type, "join", StringComparison.Ordinal))
                {
                    var join = document.Deserialize<BrowserJoinRequestEnvelope>(BrowserJson.Options);
                    if (join is null)
                    {
                        await SendResultAsync(InvalidMessage(null, "WebSocket join message was invalid.")).ConfigureAwait(false);
                    }
                    else
                    {
                        // PROMOTION, NOT A GHOST. The browser read this id out of the document the host served
                        // it and sends it back here; merging it into this connection's row is what makes the
                        // `GET /` that preceded this socket part of the same attempt. Done before the join is
                        // started so a join that fails still carries its arrivals into the report.
                        PromoteVisit(session, join.Visit);

                        // Mirror join gating (rules: only instance a NEW headless client while the host accepts
                        // joins — MP character-select / load-saved-game — and never for the host seat or a
                        // singleplayer run; a run-active brand-new name is rejected; an existing player still
                        // reconnects/reuses). One of three outcomes rides the session reply:
                        //  - DirectView: watch the host's own stream in place (no redirect) — singleplayer run,
                        //    host selected, or this process IS a headless client (serves its own stream).
                        //  - HeadlessMirrorPort: SPAWN or REUSE this player's headless; the client redirects to it.
                        //  - JoinRejection: the name isn't servable → client shows the picker with a message.
                        if (!TryStartJoin(session, join, cancellationToken))
                        {
                            var requestId = string.IsNullOrWhiteSpace(join.RequestId) ? null : join.RequestId;
                            await SendResultAsync(InvalidMessage(requestId, "A join is already in progress.")).ConfigureAwait(false);
                        }
                    }

                    continue;
                }

                if (string.Equals(type, "client-frame-presented", StringComparison.Ordinal))
                {
                    var attemptId = document.RootElement.TryGetProperty("attemptId", out var attempt)
                        && attempt.ValueKind == JsonValueKind.String ? attempt.GetString() : null;
                    ConnectionRegistry.Shared.Presented(session.Id, attemptId);
                    continue;
                }

                if (string.Equals(type, "client-view-error", StringComparison.Ordinal))
                {
                    var attemptId = document.RootElement.TryGetProperty("attemptId", out var attempt)
                        && attempt.ValueKind == JsonValueKind.String ? attempt.GetString() : null;
                    var code = document.RootElement.TryGetProperty("code", out var codeElement)
                        && codeElement.ValueKind == JsonValueKind.String ? codeElement.GetString() : null;
                    var detail = document.RootElement.TryGetProperty("detail", out var detailElement)
                        && detailElement.ValueKind == JsonValueKind.String ? detailElement.GetString() : null;
                    ConnectionRegistry.Shared.ClientViewError(session.Id, attemptId, code, detail);
                    continue;
                }

                if (string.Equals(type, "scene-ack", StringComparison.Ordinal))
                {
                    // Flow control: the client finished rendering the last scene delta → release the next one.
                    GrantSceneCredit();
                    continue;
                }

                if (string.Equals(type, "watch", StringComparison.Ordinal))
                {
                    // WS-B stream gate, flipped live: `{"type":"watch","on":true|false}`. The CLIENT owns this
                    // decision because the client is what already computes the join mode — it turns the stream on
                    // when the host is NOT on a multiplayer screen (JoinModel.ComputeMirrorJoinMode == TitleOnly)
                    // or once its own join/direct-view has been granted, and off again when the picker returns.
                    // A malformed/absent `on` is read as false: a client that asks to watch says so explicitly.
                    var on = document.RootElement.TryGetProperty("on", out var onElement)
                        && onElement.ValueKind == JsonValueKind.True;
                    if (on && !CouchCoopMod.IsHeadlessClient && ConnectionRegistry.Shared.AttemptId(session.Id) is null)
                    {
                        var attemptId = ConnectionRegistry.Shared.BeginAttempt(session.Id);
                        ConnectionRegistry.Shared.ConfigureView(session.Id, requiresChild: false);
                        ConnectionRegistry.Shared.Advance(session.Id, ConnectionStage.LoadingView);
                        _ = ConnectionRegistry.Shared.NoticeSlowViewWhenDueAsync(session.Id, attemptId, cancellationToken);
                        await SendEnvelopeAsync(await _envelopeFactory.CreateSessionEnvelope(_viewerName, "watch", session,
                            directView: true, connectionAttemptId: attemptId, cancellationToken: cancellationToken).ConfigureAwait(false)).ConfigureAwait(false);
                    }
                    await SetSceneStreamingAsync(on).ConfigureAwait(false);
                    continue;
                }

                if (string.Equals(type, "ping", StringComparison.Ordinal))
                {
                    // Latency probe: echo the client's `t0` back through the SAME send path as scene deltas (so the
                    // measured RTT reflects real send congestion). No game interaction.
                    var t0 = document.RootElement.TryGetProperty("t0", out var t0Element)
                        && t0Element.TryGetDouble(out var t0Value)
                        ? t0Value
                        : 0;
                    // `mainThread:true` = the "game end-to-end" probe: answer only AFTER the game main thread
                    // services a deferred callback, so the RTT also captures the game's per-frame processing delay
                    // (governed by the refresh-rate setting). Done OFF the receive loop (like input) so the wait
                    // never stalls other messages.
                    var mainThread = document.RootElement.TryGetProperty("mainThread", out var mtElement)
                        && mtElement.ValueKind == JsonValueKind.True;
                    if (mainThread)
                    {
                        if (_mainThreadPingGate.TryBegin())
                        {
                            _ = Task.Run(() => AnswerMainThreadPingAsync(t0));
                        }
                    }
                    else
                    {
                        await SendBytesAsync(Encoding.UTF8.GetBytes(BrowserJson.Serialize(new BrowserPongEnvelope("pong", t0)))).ConfigureAwait(false);
                    }

                    continue;
                }

                if (string.Equals(type, "settings", StringComparison.Ordinal))
                {
                    // Browser Settings panel → toggle THIS GAME PROCESS's optimization levers at runtime. Which
                    // process that is depends on how the viewer got here: a joined seat's own per-viewer headless
                    // instance, or — for a direct-view/host-watch viewer, who has no instance of their own — the
                    // HOST's own game. No reply; the effect is observable in the stream.
                    var settings = document.Deserialize<BrowserSettingsRequestEnvelope>(BrowserJson.Options);
                    if (settings is not null)
                    {
                        // Stage-B walk skip: `staticBg` is PER-CONNECTION state (an input to the server's unanimity
                        // aggregate), not a process lever, so it is handled here rather than in the static
                        // ApplyBrowserSettings. Notify only on a REAL flip — the server recomputes its aggregate
                        // (and possibly re-stamps the live bg root) on every notification.
                        if (settings.StaticBg is bool staticBg && staticBg != _wantsStaticBg)
                        {
                            _wantsStaticBg = staticBg;
                            _onStaticBgChanged?.Invoke(staticBg);
                        }

                        ApplyBrowserSettings(settings);
                    }

                    continue;
                }

                if (string.Equals(type, "input", StringComparison.Ordinal))
                {
                    if (!ConnectionInputAvailability.IsAvailable) continue;
                    if (memory.Length > MaxInputMessageBytes)
                    {
                        await SendResultAsync(new BrowserActionResultEnvelope(
                            "input-result",
                            string.IsNullOrWhiteSpace(inboundRequestId) ? Guid.NewGuid().ToString("N") : inboundRequestId,
                            InvalidInputMessageCode,
                            "WebSocket input messages must not exceed 4 KiB.")).ConfigureAwait(false);
                        continue;
                    }

                    var input = document.Deserialize<BrowserInputRequestEnvelope>(BrowserJson.Options);
                    if (input is null)
                    {
                        await SendResultAsync(InvalidMessage(null, "WebSocket input message was invalid.")).ConfigureAwait(false);
                    }
                    else
                    {
                        // Enqueue + return immediately; a single worker injects off-loop and coalesces the hover
                        // flood, so the receive loop stays responsive to the ping/scene-ack/click that follow in
                        // the stream. Injecting inline here would block the loop on the game thread (the lag bug).
                        await QueueInputAsync(input, cancellationToken).ConfigureAwait(false);
                    }

                    continue;
                }

                if (!ConnectionInputAvailability.IsAvailable) continue;
                var action = document.Deserialize<BrowserActionRequestEnvelope>(BrowserJson.Options);
                BrowserActionResultEnvelope response;
                if (action is null || !string.Equals(action.Type, "action", StringComparison.Ordinal))
                {
                    response = InvalidMessage(action?.RequestId, "WebSocket message type must be action or join.");
                }
                else
                {
                    // Every connection here is a MIRROR connection: it holds no bound browser identity (see the executor's
                    // note), and the game process this socket serves IS its seat.
                    response = await _actionExecutor.ExecuteAsync(action, cancellationToken).ConfigureAwait(false);
                }

                await SendResultAsync(response).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                MessageDiagnostics.Write("invalid-message", $"[couchcoop] websocket message failed: {ex}");
                await SendResultAsync(InvalidMessage(inboundRequestId, "The game could not process this message.")).ConfigureAwait(false);
            }
        }
    }

    private static BrowserActionResultEnvelope InvalidMessage(string? requestId, string message)
        => new(
            "action-result",
            string.IsNullOrWhiteSpace(requestId) ? Guid.NewGuid().ToString("N") : requestId,
            BrowserActionErrorCodes.InvalidMessage,
            message);

    // Apply a browser Settings-panel change to the game instance THIS SERVER runs in. Each field is optional; a null
    // field leaves that lever unchanged. All Godot touches are marshalled onto the main thread inside the suspender
    // setters, so this is safe to call from the receive loop's thread.
    //
    // WHICH instance (the panel copy depends on this):
    //   * a JOINED mirror seat is redirected to its own headless instance, whose server handles its settings — one
    //     viewer, one game, invisible to everyone else;
    //   * a DIRECT-VIEW viewer (singleplayer run, or the [Host] row) stays on the HOST socket, so these levers apply
    //     to the host's OWN game — the one on the TV. Freezing there is VISIBLE, and the host socket is SHARED by
    //     every direct-view watcher, so the last writer wins for all of them. Both are acceptable and fully
    //     reversible (the freezes resume their nodes on the way back off), and the panel labels the direct-view case
    //     so nobody is told "doesn't change what you see" while they watch the host's particles stop.
    // The freezes are no longer headless-only: SetFreeze* installs the rescan machinery on demand for an instance
    // that never had it (see CouchCoopHeadlessVisualSuspender.EnsureFreezeMachinery), and the `session` envelope
    // reports the effective per-instance state so the panel seeds from the truth instead of assuming defaults.
    //
    // `staticBg` is connection-scoped and updates the combat-background walk-skip aggregate. Animation replay
    // settings are no longer producer switches: the current producer emits its complete hint stream.
    private static void ApplyBrowserSettings(BrowserSettingsRequestEnvelope settings)
    {
        // A browser server can also run in the hermetic HostedServerHarness, where GodotSharp is deliberately
        // absent. The same EngineAvailable latch that keeps static-background work out of that process must gate
        // these game-side settings too. In every actual Godot host CouchCoopMod.Init sets it before serving /ws,
        // so production settings retain their existing behavior and errors.
        if (!CouchCoopMod.EngineAvailable)
        {
            return;
        }

        ApplyBrowserSettingsInGodot(settings);
    }

    // Keep Godot-typed calls in their own JIT body: a Godot-less harness must be able to parse a settings message
    // and take the guard above without resolving the suspender's GodotSharp dependencies.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ApplyBrowserSettingsInGodot(BrowserSettingsRequestEnvelope settings)
    {
        if (settings.RefreshRate is int fps && fps is >= 4 and <= 60)
        {
            CouchCoopHeadlessVisualSuspender.SetBaselineMaxFps(fps);
        }

        if (settings.FreezeParticles is bool freezeParticles)
        {
            CouchCoopHeadlessVisualSuspender.SetFreezeParticles(freezeParticles);
        }

        if (settings.FreezeSpines is bool freezeSpines)
        {
            CouchCoopHeadlessVisualSuspender.SetFreezeSpines(freezeSpines);
        }

        if (settings.FreezeDecor is bool freezeDecor)
        {
            CouchCoopHeadlessVisualSuspender.SetFreezeDecor(freezeDecor);
        }
    }

    // Answer a `mainThread:true` latency probe: wait for the game main thread to service a deferred callback, then
    // reply. The elapsed time includes the game's per-frame scheduling delay (governed by the refresh-rate setting),
    // so the client can show game-processing latency separately from raw network RTT. Runs off the receive loop.
    private async Task AnswerMainThreadPingAsync(double t0)
    {
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            Godot.Callable.From(() =>
            {
                _mainThreadPingGate.Complete();
                tcs.TrySetResult();
            }).CallDeferred();
        }
        catch
        {
            _mainThreadPingGate.Complete();
            tcs.TrySetResult(); // no game main loop (e.g. tests) → answer immediately
        }

        try
        {
            // Backstop so a stuck/paused main loop never leaks the probe forever.
            await tcs.Task.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
        }
        catch
        {
            // Timed out — answer anyway; the measured RTT will simply be large.
        }

        await SendBytesAsync(Encoding.UTF8.GetBytes(BrowserJson.Serialize(
            new BrowserPongEnvelope("pong", t0, true)))).ConfigureAwait(false);
    }

    // One join-progress frame, serialized exactly like the pong above (BrowserJson: web camelCase, nulls omitted)
    // and pushed through the same send gate, so it interleaves safely with the join's own reply.
    private Task SendJoinProgressAsync(BrowserJoinProgressEnvelope progress)
        => SendBytesAsync(Encoding.UTF8.GetBytes(BrowserJson.Serialize(progress)));

    // SeatNoticeHub's delivery callback. Called on the seat monitor's 250 ms loop, which must not block on a
    // socket and whose own exception handler tears the seat down — so this returns immediately and the send it
    // starts swallows everything (a closing socket is the expected failure, and teardown unregisters us anyway).
    // Chained rather than fired independently so a withdrawal can never overtake the notice it withdraws.
    private void OnSeatNotice(SeatNotice? notice)
    {
        lock (_seatNoticeLock)
        {
            _seatNoticeSends = _seatNoticeSends
                .ContinueWith(_ => SendSeatNoticeAsync(notice), CancellationToken.None,
                    TaskContinuationOptions.None, TaskScheduler.Default)
                .Unwrap();
        }
    }

    // One seat-notice frame. A null notice is the WITHDRAWAL: the same envelope with the `none` cause and no
    // detail, rather than a second type, so a client has one parse path and an older one drops both identically.
    private async Task SendSeatNoticeAsync(SeatNotice? notice)
    {
        try
        {
            await SendBytesAsync(Encoding.UTF8.GetBytes(BrowserJson.Serialize(new BrowserSeatNoticeEnvelope(
                "seat-notice",
                notice?.Cause ?? BrowserSeatNoticeCauses.None,
                notice?.Detail)))).ConfigureAwait(false);
        }
        catch
        {
            // Socket closing/closed. A diagnostic may never be the thing that fails a connection.
        }
    }

    // Fire-and-forget frame send used by the scene keyframe path: a send failure means the socket is gone, and
    // the receive loop's teardown unregisters this connection.
    public async Task SendStateBytesAsync(byte[] bytes)
    {
        try
        {
            await SendBytesAsync(bytes).ConfigureAwait(false);
        }
        catch
        {
            // Socket closing/closed mid-broadcast; teardown removes this connection.
        }
    }

    // Re-send this connection's `session` envelope (identity + roster + run status). The server calls it when
    // the lobby roster / run status changes so the shared join screen stays live. Best-effort: no-op if the session handle isn't set yet or the socket is gone.
    public async Task ResendSessionAsync(CancellationToken cancellationToken)
    {
        var session = _session;
        if (session is null || _socket is not { State: WebSocketState.Open })
        {
            return;
        }

        try
        {
            await SendEnvelopeAsync(await _envelopeFactory.CreateSessionEnvelope(
                _viewerName,
                "session",
                session,
                cancellationToken: cancellationToken).ConfigureAwait(false)).ConfigureAwait(false);
        }
        catch
        {
            // Socket closing/closed, or a transient classify failure — the next change re-sends.
        }
    }

    public async Task CloseForServerReloadAsync(string reason, CancellationToken cancellationToken)
    {
        var socket = _socket;
        if (socket is null || socket.State != WebSocketState.Open)
        {
            return;
        }

        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(2));
            await SendBytesAsync(Encoding.UTF8.GetBytes(BrowserJson.Serialize(new BrowserServerReloadEnvelope(
                "server-reload",
                "server-reload",
                reason))), deadline.Token).ConfigureAwait(false);
            await socket.CloseAsync(WebSocketCloseStatus.EndpointUnavailable, reason, deadline.Token).ConfigureAwait(false);
        }
        catch
        {
            try
            {
                socket.Abort();
            }
            catch
            {
            }
        }
    }

    // Enqueue a parsed input for off-loop injection. Coalesces CONSECUTIVE hovers (a hover replaces a trailing
    // hover — intermediate cursor positions are disposable), so a continuous hover/drag stream never grows the
    // queue or delays a following click; discrete events (press/release/click/key) always append, preserving
    // order. Non-blocking: kicks the single drain worker if it isn't already running.
    private async Task QueueInputAsync(BrowserInputRequestEnvelope input, CancellationToken cancellationToken)
    {
        var startPump = false;
        await _inputQueue.EnqueueAsync(input, cancellationToken).ConfigureAwait(false);
        lock (_inputLock)
        {
            if (_inputPumpRunning)
            {
                return;
            }

            _inputPumpRunning = true;
            startPump = true;
        }

        if (startPump)
        {
            lock (_inputLock)
            {
                _inputPumpTask = Task.Run(DrainInputAsync, CancellationToken.None);
            }
        }
    }

    private async Task DrainInputAsync()
    {
        while (true)
        {
            BrowserInputRequestEnvelope? input;
            lock (_inputLock)
            {
                input = _inputQueue.Take();
                if (input is null)
                {
                    _inputPumpRunning = false;
                    return;
                }
            }

            try
            {
                // The slow part (game-thread injection) runs here, OFF the receive loop. Fire-and-forget on
                // success; surface an injection failure as an input-result so a controller can diagnose.
                if (!ConnectionInputAvailability.IsAvailable) continue;
                var inputResult = _inputExecutor.Execute(input);
                if (inputResult is not null)
                {
                    await SendResultAsync(inputResult).ConfigureAwait(false);
                }
            }
            catch
            {
                // The socket may already be gone, but every accepted edge after this one still has to reach
                // the executor. Continue draining; result delivery is best-effort during teardown.
            }
        }
    }

    private static async Task CloseBoundedAsync(
        WebSocket socket,
        WebSocketCloseStatus status,
        string description,
        CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(2));
        try { await socket.CloseOutputAsync(status, description, deadline.Token).ConfigureAwait(false); }
        catch { socket.Abort(); }
    }

    // Broadcast entry point for a scene delta (the mirror transport). Coalescing + non-blocking: fold the
    // delta's changed/removed ids into the pending accumulator and (once the keyframe is sent) kick the drain
    // if it isn't already running. The producer runs on the game thread and must not stall on a slow client.
    public void QueueSceneDelta(RuntimeSceneDelta delta)
    {
        var startPump = false;
        lock (_sceneLock)
        {
            // Closes the fan-out race: BroadcastSceneDelta reads WantsSceneStream without a lock, so a delta can
            // still arrive here microseconds after the gate shut. Dropping it under the lock guarantees a gated
            // connection accumulates NOTHING (no fold, no queue, no send) — the "zero scene bytes" invariant.
            if (!_sceneStreaming)
            {
                return;
            }

            _sceneCoalescer.Fold(delta);
            _scenePending = true;

            // Self-heal: if a render-ack was lost, re-grant credit after the timeout so the stream can't stall.
            if (!_sceneCredit && Environment.TickCount64 - _lastSceneSendMs > SceneAckTimeoutMs)
            {
                _sceneCredit = true;
            }

            if (!_sceneReady || _scenePumpRunning || !_sceneCredit)
            {
                return;
            }

            _scenePumpRunning = true;
            startPump = true;
        }

        if (startPump)
        {
            _ = Task.Run(DrainSceneAsync, CancellationToken.None);
        }
    }

    /// <summary>
    /// Turn this connection's scene stream on or off (the WS-B watch gate). Idempotent.
    /// <para>
    /// OFF is a hard stop: the fan-out predicate stops reaching us, the pending accumulator AND the order baseline
    /// are dropped (never hold a stale coalesced delta — or a stale order to diff against — across a gap), the pump
    /// is shut, and the server stops counting us as a streaming viewer (which shuts the scene producer down once
    /// the last viewer gates off).
    /// </para>
    /// <para>
    /// ON re-runs the connect sequence exactly, and in the same order, because the reasons are the same:
    /// <list type="number">
    /// <item>reset the coalescer — the incremental state is meaningless across a gap, and `_lastSentOrder` MUST go
    /// with it or the next order patch diffs against an order the client no longer holds;</item>
    /// <item>open the gate (so the fan-out reaches us) while keeping the pump SHUT, so deltas emitted from here on
    /// are folded but not sent;</item>
    /// <item>register as streaming — this is what (re)starts the scene observer, so it must precede the keyframe
    /// that reads from it;</item>
    /// <item>send a FULL keyframe: the client's retained tree is arbitrarily stale, so only a whole-tree re-seed
    /// is correct;</item>
    /// <item>release the pump — the deltas folded in step 2 now drain, coalesced, strictly AFTER the keyframe.</item>
    /// </list>
    /// </para>
    /// </summary>
    private async Task SetSceneStreamingAsync(bool on)
    {
        if (!on)
        {
            lock (_sceneLock)
            {
                if (!_sceneStreaming)
                {
                    return;
                }

                _sceneStreaming = false;
                _sceneReady = false;
                _scenePending = false;
                _sceneCoalescer.Reset();
            }

            SyncStreamingRegistration();
            return;
        }

        lock (_sceneLock)
        {
            if (_sceneStreaming)
            {
                return;
            }

            _sceneCoalescer.Reset();
            _scenePending = false;
            // A gate-off mid-flight can strand the single send credit; re-grant it so the re-enabled stream
            // isn't stalled until the 500ms self-heal.
            _sceneCredit = true;
            _sceneReady = false;
            _sceneStreaming = true;
        }

        SyncStreamingRegistration();

        var keyframe = _getSceneObserver()?.BuildKeyframe();
        if (keyframe is not null)
        {
            await SendStateBytesAsync(BrowserSceneDeltaMessage.Serialize(keyframe)).ConfigureAwait(false);
        }

        EnableScenePump();
    }

    // Report this connection's CURRENT streaming state to the server, at most once per real transition (the count
    // must stay balanced across gate flips, disconnects and teardown). Deliberately outside `_sceneLock`: the
    // callback runs the server's observer start/stop, and starting the scene observer can synchronously deliver a
    // delta straight back into QueueSceneDelta — which takes `_sceneLock`.
    private void SyncStreamingRegistration()
    {
        lock (_streamCountLock)
        {
            var desired = _sceneStreaming;
            if (_streamingCounted == desired)
            {
                return;
            }

            _streamingCounted = desired;
            _onSceneStreamingChanged(desired);
        }
    }

    // Allow the coalescing drain to run; called AFTER the Full keyframe is sent (on connect and on every gate
    // re-enable). Kicks the drain if deltas accumulated meanwhile.
    private void EnableScenePump()
    {
        var startPump = false;
        lock (_sceneLock)
        {
            if (!_sceneStreaming)
            {
                return; // gated off again while the keyframe was in flight — leave the pump shut
            }

            _sceneReady = true;
            if (_scenePending && !_scenePumpRunning && _sceneCredit)
            {
                _scenePumpRunning = true;
                startPump = true;
            }
        }

        if (startPump)
        {
            _ = Task.Run(DrainSceneAsync, CancellationToken.None);
        }
    }

    // The client acked rendering the last scene delta → grant credit for the next one (flow control). Kicks the
    // drain if a coalesced delta is pending. Driven by the mirror client's `scene-ack` after each rendered frame.
    private void GrantSceneCredit()
    {
        var startPump = false;
        lock (_sceneLock)
        {
            _sceneCredit = true;
            if (_sceneReady && _scenePending && !_scenePumpRunning)
            {
                _scenePumpRunning = true;
                startPump = true;
            }
        }

        if (startPump)
        {
            _ = Task.Run(DrainSceneAsync, CancellationToken.None);
        }
    }

    private async Task DrainSceneAsync()
    {
        try
        {
            while (true)
            {
                CoalescedSceneDelta? toSend;
                lock (_sceneLock)
                {
                    // Stop when the stream is gated off, nothing is pending, OR the client hasn't acked the last
                    // frame (flow control) — an ack (or the self-heal timeout) re-kicks the pump.
                    if (!_sceneStreaming || !_scenePending || !_sceneCredit)
                    {
                        _scenePumpRunning = false;
                        return;
                    }

                    _scenePending = false;
                    toSend = _sceneCoalescer.Take(
                        () => _getSceneObserver()?.BuildKeyframe(),
                        requests => _getSceneObserver()?.ResolveUpserts(requests) ?? [],
                        (oldOrder, newOrder) => _getSceneObserver() is { } observer
                            ? observer.BuildStructureIndexes(oldOrder, newOrder)
                            : (EmptyStructureIndex, EmptyStructureIndex));
                    if (toSend is not null)
                    {
                        // Consume the credit: no further send until the client acks this frame rendered.
                        _sceneCredit = false;
                        _lastSceneSendMs = Environment.TickCount64;
                    }
                }

                if (toSend is null)
                {
                    continue;
                }

                byte[] bytes;
                try
                {
                    bytes = BrowserSceneDeltaMessage.Serialize(toSend.Delta, toSend.OrderPatch);
                }
                catch (Exception exception) when (exception is JsonException or NotSupportedException)
                {
                    continue;
                }

                // Last check before the wire: the gate can shut while this frame was being resolved/serialized,
                // and a gated connection must not receive it (the loop's top check then parks the pump).
                if (!_sceneStreaming)
                {
                    continue;
                }

                await SendBytesAsync(bytes).ConfigureAwait(false);
            }
        }
        catch
        {
            // Socket closing/closed mid-drain; teardown removes this connection.
            lock (_sceneLock)
            {
                _scenePumpRunning = false;
            }
        }
    }

    private Task SendEnvelopeAsync(BrowserEnvelope envelope)
        => SendBytesAsync(Encoding.UTF8.GetBytes(BrowserJson.Serialize(envelope)));

    private Task SendResultAsync(BrowserActionResultEnvelope envelope)
        => SendBytesAsync(Encoding.UTF8.GetBytes(BrowserJson.Serialize(envelope)));

    private Task SendBytesAsync(byte[] bytes)
        => SendBytesAsync(bytes, CancellationToken.None);

    private async Task SendBytesAsync(byte[] bytes, CancellationToken cancellationToken)
    {
        var socket = _socket;
        if (socket is null || socket.State != WebSocketState.Open)
        {
            return;
        }

        await _sendGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                const int fragmentBytes = 64 * 1024;
                if (bytes.Length == 0)
                {
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    deadline.CancelAfter(HttpResponseWriter.NetworkWriteTimeout);
                    await socket.SendAsync(bytes, WebSocketMessageType.Text, WebSocketMessageFlags.EndOfMessage, deadline.Token).ConfigureAwait(false);
                }
                else
                {
                    for (var offset = 0; offset < bytes.Length; offset += fragmentBytes)
                    {
                        var count = Math.Min(fragmentBytes, bytes.Length - offset);
                        var flags = offset + count == bytes.Length
                            ? WebSocketMessageFlags.EndOfMessage
                            : WebSocketMessageFlags.None;
                        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                        deadline.CancelAfter(HttpResponseWriter.NetworkWriteTimeout);
                        await socket.SendAsync(bytes.AsMemory(offset, count), WebSocketMessageType.Text, flags, deadline.Token).ConfigureAwait(false);
                    }
                }
            }
        }
        finally
        {
            _sendGate.Release();
        }
    }

    private static Task WriteHandshakeAsync(Stream stream, string key, CancellationToken cancellationToken)
    {
        var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(
            key.Trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        return HttpResponseWriter.WriteRawAsync(
            stream,
            101,
            "Switching Protocols",
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Upgrade"] = "websocket",
                ["Connection"] = "Upgrade",
                ["Sec-WebSocket-Accept"] = accept
            },
            cancellationToken: cancellationToken);
    }
}
