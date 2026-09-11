// The join dance, ported from frontend/src/mirror/MirrorApp.vue's makeClient wiring. Owns the host MirrorSocket
// plus any redirected (headless) socket, routing only the ACTIVE socket's scene-deltas into the single store.
//
// On each `session` envelope it acts on EXACTLY ONE directive, in this order:
//   1. directView === true         → stay on this socket, watch the host stream in place (+ one-time settings push)
//   2. headlessMirrorPort is a port → open a NEW socket to the SAME host on that port; scene-deltas now come from
//      it. CRITICAL: the OLD host socket is NOT closed — closing it triggers the server's Release() which kills
//      the headless instance before the redirect connects; old sockets close only on app shutdown / a full drop.
//   3. joinRejection → surface a mapped message (no redirect).
//
// `--name` auto-joins once on first connect. Name memory (user://settings.cfg → lastPlayerName) prefills but
// NEVER auto-joins on its own (the web rule). Disconnect / server-reload reconnect to the ORIGINAL host with
// exponential backoff (1s → 2s → 4s → max 10s) and re-run the whole dance.

using System;
using System.Collections.Generic;
using CouchCoop.GodotClient.Net;
using CouchCoop.GodotClient.Scene;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.MirrorProtocol.Join;
using Godot;

namespace CouchCoop.GodotClient.App;

public sealed class ConnectionCoordinator
{
    // Ported from MirrorApp.vue's JOIN_REJECTION_MESSAGES (default = the "wrong name" copy).
    private static readonly Dictionary<string, string> JoinRejectionMessages = new(StringComparer.Ordinal)
    {
        ["not-a-session-player"] = "That name is not from a session player.",
        ["no-free-instance"] = "No free game slot is available right now.",
        ["spawn-failed"] = "Couldn't start your game view — please try again.",
        // The picked seat's server-derived status is not "ready" (MirrorSeatStatuses). The picker renders those
        // rows disabled, so this only surfaces when the roster was stale at the moment of the tap.
        [MirrorSeatStatuses.UnavailableRejection] = "That player can't be joined right now.",
    };

    private const string SettingsPath = "user://settings.cfg";
    private const string CfgSection = "mirror";
    private const string CfgKey = "lastPlayerName";
    private const double MaxReconnectDelaySec = 10;

    private readonly MirrorStore _store;
    private readonly string _originalHostPort;
    private readonly string? _autoJoinName;
    private double _probeIntervalMs; // live-mutable (SetPingInterval re-arms every socket; new sockets inherit it)
    private readonly List<MirrorSocket> _all = new();
    private readonly HashSet<MirrorSocket> _settingsPushed = new();

    // The CURRENT retained settings payload (M1e). Starts all-null (= the M1b no-op push, every field "unchanged");
    // SubmitSettings replaces it. PushSettingsIfNeeded sends THIS once per joined/direct-view socket.
    private SettingsMessage _currentSettings = new();

    private MirrorSocket _active = null!;
    private SessionEnvelope? _lastSession;
    private bool _joined;
    private bool _directView;
    private bool _directViewRequested;
    private bool _autoJoinSent;
    private string? _pendingName;
    private string? _joinMessage;
    private string? _prefillName;

    private double _reconnectPendingSec;
    private double _reconnectDelaySec = 1;

    // "directView" / "redirect=<port>" / "rejected=<reason>" — the one-directive-per-session log.
    public event Action<string>? Directive;
    // Freeform lifecycle notices (connected / reconnect scheduling).
    public event Action<string>? Notice;
    // Latest roster/screen session (for a future join UI; M1b just tracks it).
    public event Action<SessionEnvelope>? SessionUpdated;
    // Raised on every status / join / directView / rejection / reconnect transition (coalesced from the raise points
    // below). The M1e UI (UiRoot) subscribes to re-read Status/Joined/DirectView/JoinMessage. SessionUpdated stays
    // the roster/screen channel; StateChanged is the connection/dance-state channel.
    public event Action? StateChanged;

    public ConnectionCoordinator(MirrorStore store, string hostPort, string? autoJoinName, double probeIntervalMs)
    {
        _store = store;
        _originalHostPort = NormalizeHostPort(hostPort);
        _autoJoinName = JoinModel.TrimName(autoJoinName);
        _probeIntervalMs = probeIntervalMs;
        _prefillName = ReadStoredName();
        // One lambda that always credits whichever socket is currently active (a no-op while that socket is
        // stream-gated — there is no frame to credit).
        _store.SendAck = () => _active?.SendSceneAck();
    }

    // The ORIGINAL host[:port] this coordinator was started against (already normalized to carry an explicit port).
    // Not the redirected headless socket's port: this is the address the viewer actually typed / discovered, which is
    // what the JoinPanel names in its "which host am I joining" line while the picker is up.
    public string HostPort => _originalHostPort;

    /// <summary>
    /// WS-B stream gate: whether the ACTIVE socket is currently watching the host's scene stream. False while the
    /// viewer sits on the join picker (the host is on a multiplayer screen and this device has not chosen a seat),
    /// in which case the host sends nothing and AppShell must not drain/apply/ack either.
    /// </summary>
    public bool Watching => _active?.Watch ?? false;

    public string? PrefillName => _prefillName;
    public string? PendingName => _pendingName;
    public string? JoinMessage => _joinMessage;
    public bool Joined => _joined;
    public bool DirectView => _directView;
    public SessionEnvelope? LastSession => _lastSession;
    public LatencySnapshot Network => _active?.Network ?? default;
    public LatencySnapshot Game => _active?.Game ?? default;

    // The raw connection status string used by JoinModel.JoinInfoFromSession ("connecting" | "connected" |
    // "disconnected"). A pending reconnect (the socket dropped and a retry is scheduled) reads "connecting".
    public string Status
    {
        get
        {
            if (_reconnectPendingSec > 0)
            {
                return "connecting";
            }

            return _active?.Status switch
            {
                MirrorStatus.Connected => "connected",
                MirrorStatus.Connecting => "connecting",
                _ => "disconnected",
            };
        }
    }

    public void Start()
    {
        _active = MakeSocket();
        // Connect GATED. We do not yet know which screen the host is on, and the host ships a full keyframe on
        // connect — so the only way to avoid pulling (and rendering) a multiplayer host's game behind the picker
        // is to open the socket with the stream already off. The first `session` (which arrives immediately)
        // decides; ApplyWatchGate turns it on within one round trip when the host isn't on an MP screen.
        _active.SetWatch(false);
        _active.Connect(_originalHostPort);
        StateChanged?.Invoke(); // → "connecting"
    }

    // ==============================================================================================
    // public control surface (M1e — SubmitJoin/SubmitSettings/SendInput/SetPingInterval for the UI + input shim)
    // ==============================================================================================

    // Retain `payload` as the CURRENT settings, and push it now if a JOINED (headless) or DIRECT-VIEW socket is
    // connected (web rule: settings NEVER go to the pre-join host socket). Whether or not it can send now, the
    // retained value is what PushSettingsIfNeeded sends when such a socket first connects (e.g. after a reconnect).
    public void SubmitSettings(SettingsMessage payload)
    {
        _currentSettings = payload ?? new SettingsMessage();
        if ((_joined || _directView) && _active is { Status: MirrorStatus.Connected })
        {
            _active.SendSettings(_currentSettings);
        }
    }

    // Fire-and-forget upstream input replay to the active socket (dropped silently when not connected).
    public void SendInput(InputMessage message)
    {
        if (_active is { Status: MirrorStatus.Connected })
        {
            _active.SendInput(message);
        }
    }

    // Re-arm the RTT probe cadence on every live socket (ms; 0 = off). New sockets (redirect/reconnect) inherit the
    // value via Wire(), so this is the single source of truth for the probe interval.
    public void SetPingInterval(double ms)
    {
        _probeIntervalMs = Math.Max(0, ms);
        foreach (var s in _all)
        {
            s.SetPingInterval(_probeIntervalMs);
        }
    }

    public void Poll(double deltaSeconds)
    {
        if (_reconnectPendingSec > 0)
        {
            _reconnectPendingSec -= deltaSeconds;
            if (_reconnectPendingSec <= 0)
            {
                _reconnectPendingSec = 0;
                DoReconnect();
            }
        }

        for (int i = 0; i < _all.Count; i++)
        {
            _all[i].Poll(deltaSeconds);
        }

        // Prune dead zombies (a kept-alive host socket that has since closed on its own). Never prune the active
        // socket; a closed active socket schedules a reconnect instead.
        _all.RemoveAll(s => !ReferenceEquals(s, _active) && s.Status == MirrorStatus.Disconnected);
    }

    public void Shutdown()
    {
        foreach (var s in _all)
        {
            s.Close();
        }

        _all.Clear();
    }

    // ==============================================================================================
    // socket wiring
    // ==============================================================================================

    private MirrorSocket MakeSocket()
    {
        var s = new MirrorSocket();
        Wire(s);
        return s;
    }

    private void Wire(MirrorSocket s)
    {
        s.OnOpen = () => OnSocketOpen(s);
        s.OnSession = env => OnSocketSession(s, env);
        s.OnServerReload = reason => OnSocketServerReload(s, reason);
        s.OnClosed = (code, reason) => OnSocketClosed(s, code, reason);
        // Only the active socket's scene-deltas feed the (single) retained tree; the kept-alive host zombie's are
        // dropped (and since WS-B that zombie is gated off outright, so it receives none).
        s.OnSceneDeltaBytes = bytes =>
        {
            if (ReferenceEquals(s, _active))
            {
                _store.EnqueueRawDelta(bytes);
            }
        };
        s.SetPingInterval(_probeIntervalMs);
        _all.Add(s);
    }

    // ==============================================================================================
    // socket events (all guarded by "is this the active socket?")
    // ==============================================================================================

    private void OnSocketOpen(MirrorSocket s)
    {
        if (!ReferenceEquals(s, _active))
        {
            return;
        }

        _reconnectDelaySec = 1; // a healthy connect resets the backoff ladder
        Notice?.Invoke($"connected to {_originalHostPort}");
        StateChanged?.Invoke(); // → "connected"
        PushSettingsIfNeeded(s);
        MaybeAutoJoin();
        MaybeRequestDirectView();
        ApplyWatchGate();
    }

    private void OnSocketSession(MirrorSocket s, SessionEnvelope env)
    {
        if (!ReferenceEquals(s, _active))
        {
            return;
        }

        _lastSession = env;
        SessionUpdated?.Invoke(env);
        PushSettingsIfNeeded(s);
        MaybeAutoJoin();
        MaybeRequestDirectView();

        // Exactly ONE directive, in order (mirroring MirrorApp.vue).
        if (env.DirectView)
        {
            HandleDirectView(s);
        }
        else if (env.HeadlessMirrorPort is int port)
        {
            HandleHeadlessRedirect(s, port);
        }
        else if (env.JoinRejection is { } reason)
        {
            // Terminal on its own, NOT cross-checked against Session.Joined — see the matching note in
            // mirrorClient.ts. The host derives `Session` from the name→roster assignment, which can report
            // Joined:true for a name the join handler just refused; gating on it swallowed the rejection and left
            // the join screen waiting on a seat that was never coming.
            HandleJoinRejected(reason);
        }

        // LAST: the directives above can change `_joined` / `_directView` / `_pendingName`, all of which feed the
        // gate. A `session` is also the ONLY signal that the host's screen changed, so this is the single place
        // the gate re-opens when the host leaves a multiplayer screen.
        ApplyWatchGate();
    }

    private void OnSocketServerReload(MirrorSocket s, string reason)
    {
        if (!ReferenceEquals(s, _active))
        {
            return;
        }

        ScheduleReconnect($"server-reload (reason='{reason}')");
    }

    private void OnSocketClosed(MirrorSocket s, int code, string reason)
    {
        if (!ReferenceEquals(s, _active))
        {
            // A kept-alive host zombie closed — harmless; Poll prunes it.
            return;
        }

        ScheduleReconnect($"ws closed (code={code} reason='{reason}')");
    }

    // ==============================================================================================
    // directives
    // ==============================================================================================

    private void HandleDirectView(MirrorSocket s)
    {
        _pendingName = null;
        _joinMessage = null;
        if (!_directView)
        {
            _directView = true;
            Directive?.Invoke("directView");
            StateChanged?.Invoke();
        }

        PushSettingsIfNeeded(s);
    }

    private void HandleHeadlessRedirect(MirrorSocket s, int port)
    {
        if (_joined)
        {
            return; // already redirected — prevent a double-redirect
        }

        if (_pendingName is { } name)
        {
            RememberName(name); // persist on a successful join (redirect), like rememberJoinedName
        }

        _joined = true;
        Directive?.Invoke($"redirect={port}");
        StateChanged?.Invoke();

        // WS-B free win: the old HOST socket must stay open (closing it triggers the server's Release(), killing
        // the headless before the redirect lands) but it has no reason to keep receiving bytes. Gate it off — that
        // also drops the host's streaming count, so a host whose only viewers have all redirected away stops its
        // scene producer instead of serving sockets nobody reads.
        s.SetWatch(false);

        // Open the new headless socket and make it active BEFORE it connects, so its first keyframe (and every
        // later delta) flows into the store while the old host socket's deltas are ignored. Do NOT close `s`.
        var next = s.WithPort(port);
        Wire(next);
        _active = next;
        next.Connect();
    }

    private void HandleJoinRejected(string reason)
    {
        // Only surface/log a rejection that answers an in-flight join (avoids re-logging on resent sessions).
        bool wasPending = _pendingName is not null;
        _pendingName = null;
        _joinMessage = RejectionMessage(reason);
        if (wasPending)
        {
            Directive?.Invoke($"rejected={reason}");
            StateChanged?.Invoke();
        }
    }

    // ==============================================================================================
    // auto-join / direct-view request / settings push
    // ==============================================================================================

    private void MaybeAutoJoin()
    {
        if (_autoJoinSent || _joined || _pendingName is not null || _autoJoinName is null)
        {
            return;
        }

        if (_active.Status != MirrorStatus.Connected)
        {
            return;
        }

        _autoJoinSent = true;
        SubmitJoin(_autoJoinName);
    }

    // Submit a co-op join for `name` (the UI's join button, or MaybeAutoJoin for --name). A blank/duplicate-in-flight
    // request is a no-op. Public in M1e (was private); semantics unchanged aside from the StateChanged raise so the
    // UI can collapse the form while the join is in flight.
    //
    // `playerId` is the picked SEAT's state player id ("p:1003"), passed straight through to the host so it can
    // resolve the netId exactly rather than by matching the display label. Null for a typed name (and for
    // MaybeAutoJoin's `--name`, which is a label the viewer supplied, not a seat they saw).
    public void SubmitJoin(string name, string? playerId = null)
    {
        var trimmed = JoinModel.TrimName(name);
        if (trimmed is null || _pendingName is not null)
        {
            return;
        }

        _joinMessage = null;
        _pendingName = trimmed;
        _prefillName = trimmed;
        _active.SendJoin(trimmed, playerId);
        ApplyWatchGate();
        StateChanged?.Invoke();
    }

    // ==============================================================================================
    // WS-B stream gate
    // ==============================================================================================

    // The gate decision itself lives in the shared JoinModel (with a TS twin), so the native client, the web client
    // and the tests all read the same rule: stream the host only once we're joined / direct-view, or while the host
    // isn't on a multiplayer screen at all.
    private bool ShouldWatch() => JoinModel.ShouldWatchHostStream(
        JoinModel.JoinInfoFromSession(_lastSession, Status),
        _pendingName,
        _lastSession?.Screen?.MirrorMode,
        _joined,
        _directView,
        // seatIntent: the WEB client's `?name=<seat>` URL marker. The native client has no page URL and no such
        // state, so it can never be a seat viewer waiting on a screen it did not choose — always false here.
        seatIntent: false);

    // Push the current gate decision to the active socket (idempotent — the socket only wires a control message on
    // a real change). Called from every transition that can move the answer.
    private void ApplyWatchGate() => _active?.SetWatch(ShouldWatch());

    private void MaybeRequestDirectView()
    {
        // A singleplayer run can't be joined through a form — send one empty-name join so the server replies
        // directView (which activates the settings channel). Reset off the SP-run screen so a fresh run re-arms.
        if (_lastSession?.Screen?.MirrorMode != "singleplayer-run")
        {
            _directViewRequested = false;
            return;
        }

        if (_directViewRequested || _joined || _directView || _pendingName is not null)
        {
            return;
        }

        if (_active.Status != MirrorStatus.Connected)
        {
            return;
        }

        _directViewRequested = true;
        _active.SendJoin(""); // empty name → SP-run direct-view (see the server's join gating)
    }

    private void PushSettingsIfNeeded(MirrorSocket s)
    {
        // Push the CURRENT retained payload once, the first time a JOINED (headless) or DIRECT-VIEW (host) socket is
        // connected (per-socket via _settingsPushed). Default retained value is all-null (every field absent = leave
        // unchanged), so with no SubmitSettings this stays the M1b no-op that exercises the channel; once the UI has
        // pushed real settings, a later socket (reconnect) receives them here.
        if ((_joined || _directView) && s.Status == MirrorStatus.Connected && _settingsPushed.Add(s))
        {
            s.SendSettings(_currentSettings);
        }
    }

    // ==============================================================================================
    // reconnect
    // ==============================================================================================

    private void ScheduleReconnect(string why)
    {
        if (_reconnectPendingSec > 0)
        {
            return; // already scheduled
        }

        Notice?.Invoke($"reconnecting to {_originalHostPort} in {_reconnectDelaySec:0.#}s — {why}");
        _reconnectPendingSec = _reconnectDelaySec;
        StateChanged?.Invoke(); // → "connecting" (reconnect pending)
    }

    private void DoReconnect()
    {
        // Grow the backoff for the NEXT attempt (a successful open resets it to 1 in OnSocketOpen), then tear down
        // every stale socket and re-run the whole dance.
        _reconnectDelaySec = Math.Min(MaxReconnectDelaySec, _reconnectDelaySec * 2);
        TeardownAndReconnect();
    }

    // A user-driven "Reload" (Settings → Reload): re-run the whole join dance now WITHOUT growing the backoff (unlike
    // a dropped-connection reconnect). On the fresh open the server pushes a Full=true keyframe → the store →
    // SceneReconciler.FullRebuild self-heals the view. Reuses the SAME store/reconciler (no stage teardown).
    public void Resync()
    {
        _reconnectPendingSec = 0; // cancel any scheduled reconnect so it can't also fire DoReconnect
        _reconnectDelaySec = 1;   // a manual reload resets the backoff ladder
        Notice?.Invoke($"reload: re-syncing {_originalHostPort}");
        TeardownAndReconnect();
    }

    // Close every socket (incl. any kept-alive host zombie — the "keep the old socket open" rule only guards the
    // redirect handoff, not a full re-sync), reset the per-connection dance state, and open a fresh active socket.
    private void TeardownAndReconnect()
    {
        foreach (var s in _all)
        {
            s.Close();
        }

        _all.Clear();
        _settingsPushed.Clear();

        _joined = false;
        _directView = false;
        _directViewRequested = false;
        _autoJoinSent = false;
        _pendingName = null;
        _lastSession = null;

        _active = MakeSocket();
        _active.SetWatch(false); // re-run the dance from the gated state, exactly like Start()
        _active.Connect(_originalHostPort);
        StateChanged?.Invoke(); // fresh attempt → "connecting"
    }

    // ==============================================================================================
    // name memory (user://settings.cfg — the ConfigFile analog of sessionStorage + ?name=)
    // ==============================================================================================

    private static string? ReadStoredName()
    {
        var cfg = new ConfigFile();
        if (cfg.Load(SettingsPath) != Error.Ok)
        {
            return null;
        }

        var value = cfg.GetValue(CfgSection, CfgKey, "").AsString();
        return JoinModel.TrimName(value);
    }

    private static void RememberName(string name)
    {
        var trimmed = JoinModel.TrimName(name);
        if (trimmed is null)
        {
            return;
        }

        var cfg = new ConfigFile();
        cfg.Load(SettingsPath); // ignore result — the file may not exist yet
        cfg.SetValue(CfgSection, CfgKey, trimmed);
        Error e = cfg.Save(SettingsPath);
        if (e != Error.Ok)
        {
            GD.PrintErr($"ConnectionCoordinator: failed to persist name to {SettingsPath}: {e}");
        }
    }

    // ==============================================================================================
    // helpers
    // ==============================================================================================

    private static string RejectionMessage(string code) =>
        JoinRejectionMessages.TryGetValue(code, out var m) ? m : JoinRejectionMessages["not-a-session-player"];

    private static string NormalizeHostPort(string hostPort) =>
        hostPort.Contains(':') ? hostPort : $"{hostPort}:13337";
}
