using System.Reflection;
using HarmonyLib;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Multiplayer.Transport;
using MegaCrit.Sts2.Core.Multiplayer.Transport.ENet;
using MegaCrit.Sts2.Core.Multiplayer.Transport.Steam;
using MegaCrit.Sts2.Core.Platform;

namespace CouchCoop.Mod.Session;

/// <summary>
/// The host's transport bookkeeping: what kind of net host this process is actually running right now, and the
/// identity the couch seats must dial into it with.
/// <para>
/// Historically the mod forced ENet for everybody: the old <c>FastmpPatch</c> flipped
/// <c>CommandLineHelper.HasArg("fastmp")</c> to true for every instance, and that flag is also what steers a
/// session away from Steam. A REAL Steam session was therefore impossible. The host now hosts normally — Steam
/// when Steam is up — and the couch seats attach over a
/// parallel ENet listener instead. Everything downstream of that decision (headless seat launch args, the mirror
/// picker, the QR dialog's "Steam offline" note) reads the state from here rather than assuming ENet.
/// </para>
/// </summary>
internal static class CouchCoopHostTransport
{
    internal static event Action? HostingEnded;

    // The net host this process installed for the current hosting session (dual Steam+ENet, or the ENet-only
    // fallback), dropped with the other transport facts. Written and read on the game main thread.
    private static volatile NetHost? _activeHost;
    private static int _peerReadFailureLogged;
    // StartHost(SerializableRun) records the saved local host id immediately before the game's async host path
    // calls StartSteamHost. It is a one-shot handoff: StartHostAsync consumes it before choosing Steam or ENet,
    // and every reset path clears it so a saved Steam id can never escape into a later new lobby.
    private static ulong? _pendingSavedRunHostNetId;

    // A successful offline fallback still has an ENet listener underneath it, whose native host identity is 1.
    // Keep the saved identity associated with the exact game service for the lifetime of the loaded lobby/run so
    // NetHostGameService.NetId can report the player the save actually contains. This is deliberately separate
    // from the pending handoff above: the handoff is consumed once at host start; this binding is live state and
    // is cleared when that hosting session ends.
    private static INetGameService? _savedRunFallbackService;
    private static ulong? _savedRunFallbackHostNetId;

    /// <summary>
    /// The UDP port the ENet side of the host binds. Fixed at 33771 by the game's own host and auto-join paths;
    /// headless seats dial the same port.
    /// </summary>
    internal const ushort EnetPort = 33771;

    /// <summary>
    /// Reports the live lobby's player cap, so the couch ENet listener is sized for everyone the lobby will
    /// actually admit. Wired by <c>CouchCoopMod.Init</c> once the runtime host exists; null before that (and in
    /// tests), which leaves the incoming <c>maxClients</c> untouched.
    /// <para>
    /// WHY THIS EXISTS RATHER THAN TRUSTING <c>maxClients</c>: both multiplayer limit mods raise the client cap
    /// with a Harmony PREFIX on <c>NetHostGameService.StartENetHost</c> / <c>StartSteamHost</c>, and only one of
    /// those two can reach us. The composite path builds its <c>ENetHost</c> directly (see
    /// <see cref="StartEnetFallback"/>) and never calls <c>StartENetHost</c>, so that patch is bypassed outright.
    /// The <c>StartSteamHost</c> half now does reach us, because our prefix registers last and therefore reads the
    /// argument those prefixes produced (see <see cref="Patches.CouchCoopHostTransportPatch"/>).
    /// </para>
    /// <para>
    /// It is still not enough on its own, which is why this probe stays. Hosting starts BEFORE the lobby exists,
    /// so at that moment there is nothing to ask and the probe reports null — a raise that only ever lands on the
    /// lobby would be invisible here. This is the backstop for everything that happens later: a cap raised after
    /// host start, or by a mod that touches the lobby alone. A listener sized for 4 while the lobby admits 16
    /// refuses the fifth seat at the transport, which is exactly the failure this avoids.
    /// </para>
    /// </summary>
    internal static Func<int?>? MaxLobbyPlayersProbe { get; set; }

    /// <summary>
    /// The client cap the CURRENT hosting session's transports were actually built for, or null when no host
    /// start has decided one. Recorded rather than recomputed, so the log line, a live probe and the tests all
    /// read the single number the host was sized from.
    /// </summary>
    internal static int? EffectiveMaxClients { get; private set; }

    /// <summary>
    /// The netId the LOCAL host answers to — <c>1</c> for an ENet host (the transport hardcodes it), the host's
    /// SteamID64 when the session is Steam-hosted. Couch seats are told this value
    /// (<c>COUCHCOOP_HOST_NETID</c>) because a seat's <c>ENetClient.HostNetId</c> is hardcoded to <c>1</c> and it
    /// would otherwise throw on every heartbeat echo — see <see cref="Patches.HostNetIdPatch"/>.
    /// </summary>
    internal static ulong HostNetId { get; set; } = 1UL;

    /// <summary>True when this host has a live ENet listener that a headless couch seat can join.</summary>
    internal static bool EnetAvailable { get; set; }

    /// <summary>The raw Steam lobby id when Steam-hosted, else null. Diagnostics / QR-dialog note only.</summary>
    internal static string? SteamLobbyId { get; set; }

    /// <summary>True when BOTH transports are live (Steam lobby + parallel ENet listener on one service).</summary>
    internal static bool IsDual { get; set; }

    /// <summary>
    /// <c>NetHostGameService._netHost</c>. We must REPLACE the service's host rather than wrap it: every outgoing
    /// message reaches a peer through this one object, so owning it is what lets a composite host route each peer
    /// over the transport that peer actually joined on.
    /// </summary>
    internal static FieldInfo? NetHostField { get; } = AccessTools.Field(typeof(NetHostGameService), "_netHost");

    /// <summary><c>NetHostGameService.Platform { get; private set; }</c> — non-public setter, reached by reflection.</summary>
    internal static MethodInfo? PlatformSetter { get; } = AccessTools.PropertySetter(typeof(NetHostGameService), "Platform");

    /// <summary>
    /// True once the bookkeeping postfixes are actually installed, i.e. <see cref="EnetAvailable"/> is a real
    /// answer rather than "nobody has told us anything". Everything that GATES on the transport state must consult
    /// this first and FAIL OPEN when it is false: if a game update renamed <c>StartENetHost</c>, the correct
    /// degradation is "behave like before this feature existed" (try the seat, let it fail loudly on its own), not
    /// "no couch player may ever join again".
    /// </summary>
    internal static bool BookkeepingInstalled { get; set; }

    /// <summary>
    /// Whether a headless couch seat may be launched. True when we KNOW there is an ENet listener, and also true
    /// when we know nothing at all (see <see cref="BookkeepingInstalled"/>).
    /// </summary>
    internal static bool MaySpawnCouchSeat => EnetAvailable || !BookkeepingInstalled;

    /// <summary>
    /// True when both reflection seams resolved. The transport patch refuses to install itself when this is false,
    /// so a game update that renames either member degrades to STOCK hosting instead of a broken host.
    /// </summary>
    internal static bool SeamsResolve => NetHostField is not null && PlatformSetter is not null;

    /// <summary>
    /// The QR dialog's transport notice for a Steam-failure fallback session (see
    /// <see cref="HostUi.CouchCoopHostUiNotices"/>). Set only when the fallback actually hosted.
    /// </summary>
    internal static readonly Localization.CouchCoopText SteamOfflineText = new("couchcoop_steam_offline");
    internal static string SteamOfflineNote => SteamOfflineText.Resolve();

    /// <summary>
    /// The mirror image of <see cref="SteamOfflineText"/>: the Steam lobby came up and the COUCH side did not,
    /// so remote friends can join and nobody on this sofa can. Raised on the same surfaces (the QR dialog's tip
    /// line and the once-per-mount lobby modal) because it answers the same question — "why can't they join?" —
    /// for the other half of the room.
    /// </summary>
    internal static readonly Localization.CouchCoopText CouchSeatsUnavailableText = new("couchcoop_couch_seats_unavailable");

    /// <summary>
    /// Say — everywhere — that this lobby cannot start couch seats. Called when the ENet side failed to bind,
    /// which is the one way a live hosting session can end up with no couch transport at all.
    /// <para>
    /// FOUR SURFACES, ONE CAUSE, and none of them used to fire. The host got nothing (the transport logged its
    /// refusal to stderr and carried on), the panel got nothing, and the player got "The process launcher
    /// returned no process handle. No further cause is available." The point of doing all four here is that the
    /// first two happen at HOST START — a host learns their lobby is couch-deaf before anyone picks up a phone,
    /// rather than after somebody's join has already failed.
    /// </para>
    /// </summary>
    private static void NoteCouchSeatsUnavailable()
    {
        var detail =
            $"The couch co-op listener could not bind UDP port {EnetPort} on this computer, so no player's game "
            + "can be started for this lobby. Another copy of Slay the Spire 2 still running on this computer is "
            + "the usual cause.";
        CouchSeatAvailability.UnavailableDetail = detail;
        HostUi.CouchCoopHostUiNotices.HostTransportNote = CouchSeatsUnavailableText;
        // A WARNING, not a failure: this host's own session is healthy and its Steam lobby is live. Couch co-op
        // is the part that is degraded, which is exactly the distinction ReportHostIssue's isWarning draws (the
        // same one HostReachabilityWatch and the shared-profile row use).
        Connections.ConnectionRegistry.Shared.ReportHostIssue(
            CouchSeatAvailability.NoCouchListenerCode,
            CouchSeatAvailability.IssueSummary,
            CouchSeatAvailability.IssueAction,
            detail,
            isWarning: true);
    }

    /// <summary>Forget the current host's transport facts.</summary>
    internal static void ResetTransportState()
    {
        ClearSavedRunHostNetId();
        ClearSavedRunFallbackHostIdentity();
        CouchSeatAvailability.Clear();
        HostNetId = 1UL;
        EnetAvailable = false;
        SteamLobbyId = null;
        IsDual = false;
        EffectiveMaxClients = null;
        _activeHost = null;
        HostUi.CouchCoopHostUiNotices.HostTransportNote = null;
    }

    /// <summary>Forget the current host's transport facts when the hosting session ends.</summary>
    internal static void ResetSession()
    {
        ResetTransportState();
        foreach (Action listener in HostingEnded?.GetInvocationList() ?? [])
        {
            try
            {
                listener();
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr($"hosting-ended callback failed: {exception.GetType().Name}: {exception.Message}");
            }
        }
    }

    /// <summary>
    /// Bookkeeping for a plain <c>StartENetHost</c> that we did NOT drive (the stock path: <c>-fastmp</c>, the
    /// debug multiplayer screen, or a Steam-uninitialized launch). <paramref name="failed"/> is true when the game
    /// reported a bind error, in which case nothing is joinable. <paramref name="maxClients"/> is the cap the game
    /// built that listener for, observed after the fact so this path states its capacity like every other.
    /// </summary>
    internal static void NoteEnetHostStarted(bool failed, int maxClients)
    {
        if (failed)
        {
            ResetTransportState();
            return;
        }

        ClearSavedRunHostNetId();
        ClearSavedRunFallbackHostIdentity();
        // This path reaches us with a listener already bound, so whatever an earlier host start concluded about
        // couch seats is stale. Cleared explicitly because this is the one success path that does NOT run
        // through ResetTransportState first.
        CouchSeatAvailability.Clear();
        HostNetId = 1UL;
        EnetAvailable = true;
        SteamLobbyId = null;
        IsDual = false;
        EffectiveMaxClients = maxClients;
        LogEffectiveCapacity(maxClients, maxClients, "stock-enet");
    }

    /// <summary>
    /// Replaces <c>NetHostGameService.StartSteamHost(int)</c> (see
    /// <see cref="Patches.CouchCoopHostTransportPatch"/>). Hosts the session the way the player asked for, and
    /// keeps the lobby reachable when Steam can't deliver:
    /// <list type="number">
    ///   <item><b>Steam host succeeds</b>: a real friends-only lobby, exactly like the stock game.</item>
    ///   <item><b>Steam host fails</b> (the "Lobby creation failed: k_EResultNoConnection" case — Steam client up
    ///     but offline): silently fall back to an ENet host so couch/LAN players can still play, and log the
    ///     original EResult. Per the user's decision this is deliberately NOT a popup.</item>
    /// </list>
    /// A DOUBLE failure is never swallowed: if the ENet fallback also fails to bind, its error is returned and the
    /// game shows its normal error popup.
    /// </summary>
    internal static async Task<NetErrorInfo?> StartHostAsync(NetHostGameService service, int maxClients)
    {
        ArgumentNullException.ThrowIfNull(service);

        var savedRunHostNetId = ConsumeSavedRunHostNetId();
        ResetTransportState();
        // Decided ONCE, before the transport branch, so Steam, dual and the ENet fallback below are all sized from
        // this same number — and the log names it whichever of them ends up running.
        maxClients = Capacity.Resolve(maxClients);

        // The composite host lets remote Steam friends and local couch seats share one lobby.
        var dualHost = new DualNetHost(service);
        SteamHost steamHost = dualHost;
        AssignNetHost(service, steamHost);
        SetPlatform(service, PlatformType.Steam);

        NetErrorInfo? steamError;
        try
        {
            steamError = await steamHost.StartHost(maxClients).ConfigureAwait(true);
        }
        catch (Exception exception)
        {
            // Steam threw rather than reporting an error (uninitialized API, disposed callback token, ...). The
            // fallback exists precisely so a broken Steam never costs the player their couch session.
            Log($"steam host threw ({exception.GetType().Name}: {exception.Message}) — falling back to a couch/LAN-only ENet host.");
            return StartEnetFallback(service, maxClients, savedRunHostNetId);
        }

        if (steamError.HasValue)
        {
            Log($"steam host failed ({steamError.Value}) — falling back to a couch/LAN-only ENet host on port {EnetPort}. "
                + "Remote Steam friends cannot join this session.");
            return StartEnetFallback(service, maxClients, savedRunHostNetId);
        }

        HostNetId = ReadNetId(steamHost);
        SteamLobbyId = ReadLobbyId(steamHost);

        // Bring the couch side up beside the live lobby. A bind failure degrades to Steam-only rather than
        // failing the host: the remote players who just got a lobby must not lose it because port 33771 is busy.
        EnetAvailable = dualHost.TryStartEnetSide(EnetPort, maxClients);
        IsDual = EnetAvailable;

        Log($"steam host started lobby={SteamLobbyId ?? "<none>"} hostNetId={HostNetId} "
            + $"couchSeats={(EnetAvailable ? $"ENet:{EnetPort}" : "unavailable")}.");
        if (!EnetAvailable)
        {
            NoteCouchSeatsUnavailable();
        }

        return null;
    }

    /// <summary>
    /// The host's client-cap decision, in a type of its own for one reason: <c>WithLobbyCapacity</c> is PRIVATE to
    /// it, and C# does not let an enclosing class reach a nested type's private members. So the only way for
    /// <see cref="StartHostAsync"/> — or anything added here later — to obtain an effective cap is
    /// <see cref="Resolve"/>, which states it and records it. "The transport was built with the number we logged"
    /// is therefore something the compiler keeps true, not a convention the next edit can quietly drop.
    /// </summary>
    internal static class Capacity
    {
        /// <summary>
        /// Settles the cap this host start sizes every transport for, states it once and records it in
        /// <see cref="EffectiveMaxClients"/>. <paramref name="requestedMaxClients"/> is whatever actually reached
        /// our prefix — including a raise another mod's earlier prefix already wrote into the argument.
        /// </summary>
        internal static int Resolve(int requestedMaxClients)
        {
            var effective = WithLobbyCapacity(requestedMaxClients);
            EffectiveMaxClients = effective;
            LogEffectiveCapacity(effective, requestedMaxClients, "host-start");
            return effective;
        }

        /// <summary>
        /// Widens <paramref name="maxClients"/> to whatever the live lobby will admit (see
        /// <see cref="MaxLobbyPlayersProbe"/>). Only ever raises: a caller asking for MORE than the lobby cap is
        /// left alone, and with no probe — or one that reports no cap, which is what "hosting has not built a
        /// lobby yet" looks like — the argument passes through untouched. So on the stock game, where the probe
        /// reports the same 4 the caller already passed, nothing changes at all. That one-way contract is what
        /// makes it safe to keep running after a limit mod has already raised the argument: it can never undo
        /// that raise, and it never substitutes a cap of its own for one it could not read.
        /// </summary>
        private static int WithLobbyCapacity(int maxClients)
        {
            if (MaxLobbyPlayersProbe is not { } probe)
            {
                return maxClients;
            }

            int? lobbyMax;
            try { lobbyMax = probe(); }
            catch (Exception exception)
            {
                Log($"could not read the lobby player cap ({exception.GetType().Name}: {exception.Message}) — hosting for {maxClients} clients.");
                return maxClients;
            }

            if (lobbyMax is not { } cap || cap <= maxClients)
            {
                return maxClients;
            }

            Log($"lobby admits {cap} players but hosting was asked for {maxClients} — sizing the transport for {cap} so every seat can connect.");
            return cap;
        }
    }

    /// <summary>
    /// The Steam-failure fallback: hosts on ENet alone and, when that actually worked, raises the QR dialog's
    /// "Steam offline" notice.
    /// </summary>
    private static NetErrorInfo? StartEnetFallback(NetHostGameService service, int maxClients, ulong? savedRunHostNetId)
    {
        var error = StartEnetOnly(service, maxClients, savedRunHostNetId);
        if (error is null)
        {
            HostUi.CouchCoopHostUiNotices.HostTransportNote = SteamOfflineText;
        }

        return error;
    }

    /// <summary>
    /// Hosts on ENet alone and records it for the Steam-failure fallback. Any
    /// error here is returned unchanged — with no transport left there is nothing to degrade to, and the player
    /// must see the game's normal failure popup.
    /// </summary>
    private static NetErrorInfo? StartEnetOnly(NetHostGameService service, int maxClients, ulong? savedRunHostNetId)
    {
        ENetHost enetHost = savedRunHostNetId is { } netId
            ? new SavedRunEnetHost(service, netId)
            : new ENetHost(service);
        AssignNetHost(service, enetHost);
        SetPlatform(service, PlatformType.None);

        var error = enetHost.StartHost(EnetPort, maxClients);
        if (error.HasValue)
        {
            Log($"ENet host failed to bind port {EnetPort} ({error.Value}) — no transport left, surfacing the error.");
            ResetTransportState();
            return error;
        }

        HostNetId = ReadNetId(enetHost);
        if (savedRunHostNetId is { } savedNetId)
        {
            ActivateSavedRunFallbackHostIdentity(service, savedNetId);
        }
        EnetAvailable = true;
        SteamLobbyId = null;
        IsDual = false;
        Log($"ENet host started on port {EnetPort} hostNetId={HostNetId}.");
        return null;
    }

    /// <summary>
    /// Returns the saved local host id only when it identifies a current player in the saved run. ENet's native
    /// host id is already 1, so it intentionally needs no override.
    /// </summary>
    internal static ulong? ResolveSavedRunHostNetId(ulong localPlayerId, IEnumerable<ulong>? savedPlayerIds)
    {
        if (localPlayerId <= 1 || savedPlayerIds is null)
        {
            return null;
        }

        foreach (var savedPlayerId in savedPlayerIds)
        {
            if (savedPlayerId == localPlayerId)
            {
                return localPlayerId;
            }
        }

        return null;
    }

    /// <summary>Arms the narrow saved-run handoff. Passing null also clears any stale handoff.</summary>
    internal static void ArmSavedRunHostNetId(ulong? savedRunHostNetId)
        => _pendingSavedRunHostNetId = savedRunHostNetId is > 1 ? savedRunHostNetId : null;

    /// <summary>Consumes the saved-run handoff exactly once.</summary>
    internal static ulong? ConsumeSavedRunHostNetId()
    {
        var savedRunHostNetId = _pendingSavedRunHostNetId;
        _pendingSavedRunHostNetId = null;
        return savedRunHostNetId;
    }

    /// <summary>Clears the saved-run handoff without changing live transport bookkeeping.</summary>
    internal static void ClearSavedRunHostNetId() => _pendingSavedRunHostNetId = null;

    /// <summary>
    /// Binds the saved Steam host id to the one game service that successfully started an offline ENet fallback.
    /// The transport itself remains ENet; this is the game-level identity used when the loaded lobby registers its
    /// local player and resolves the saved player record.
    /// </summary>
    internal static void ActivateSavedRunFallbackHostIdentity(INetGameService service, ulong savedRunHostNetId)
    {
        ArgumentNullException.ThrowIfNull(service);
        if (savedRunHostNetId <= 1)
        {
            throw new ArgumentOutOfRangeException(nameof(savedRunHostNetId));
        }

        _savedRunFallbackService = service;
        _savedRunFallbackHostNetId = savedRunHostNetId;
    }

    /// <summary>
    /// Returns the identity a game service must expose to loaded-lobby code. Only the exact service created for a
    /// successful saved-run ENet fallback is remapped; every other host, including plain ENet, keeps its native id.
    /// </summary>
    internal static ulong ResolveSavedRunFallbackHostNetId(INetGameService service, ulong nativeNetId)
    {
        ArgumentNullException.ThrowIfNull(service);
        return ReferenceEquals(_savedRunFallbackService, service) && _savedRunFallbackHostNetId is { } savedNetId
            ? savedNetId
            : nativeNetId;
    }

    internal static bool TryGetSavedRunFallbackHostNetId(INetGameService service, out ulong savedRunHostNetId)
    {
        ArgumentNullException.ThrowIfNull(service);
        if (ReferenceEquals(_savedRunFallbackService, service) && _savedRunFallbackHostNetId is { } savedNetId)
        {
            savedRunHostNetId = savedNetId;
            return true;
        }

        savedRunHostNetId = 0;
        return false;
    }

    private static void ClearSavedRunFallbackHostIdentity()
    {
        _savedRunFallbackService = null;
        _savedRunFallbackHostNetId = null;
    }

    private static ulong ReadNetId(NetHost host)
    {
        try
        {
            return host.NetId;
        }
        catch (Exception exception)
        {
            // SteamHost.NetId calls SteamUser.GetSteamID(); never let a native hiccup abort a started host.
            Log($"could not read host netId ({exception.GetType().Name}) — assuming 1.");
            return 1UL;
        }
    }

    private static string? ReadLobbyId(NetHost host)
    {
        try
        {
            return host.GetRawLobbyIdentifier();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Swaps the service's <c>_netHost</c>. Callers must have checked <see cref="SeamsResolve"/> — the patch
    /// refuses to install itself otherwise, so this throwing means a genuinely broken install.
    /// </summary>
    private static void AssignNetHost(NetHostGameService service, NetHost host)
    {
        (NetHostField ?? throw new InvalidOperationException("NetHostGameService._netHost is unavailable."))
            .SetValue(service, host);
        _activeHost = host;
    }

    /// <summary>
    /// Whether <paramref name="netId"/> is a peer currently connected to the host this process installed, or null
    /// when there is no such host (hosting has not started through this transport, or it has ended) or its peer
    /// list cannot be read. Game main thread only: the peer list is the net layer's live state.
    /// </summary>
    /// <remarks>
    /// This is what lets the seat monitor ask "does the host still have this seat connected?" without a full
    /// game-state read. The peer list is the same source the state read's connectivity falls back to; a null here
    /// tells the caller to use that read instead.
    /// </remarks>
    internal static bool? IsPeerConnected(ulong netId)
    {
        var host = _activeHost;
        if (host is null)
        {
            return null;
        }

        try
        {
            foreach (var peerId in host.ConnectedPeerIds)
            {
                if (peerId == netId)
                {
                    return true;
                }
            }

            return false;
        }
        catch (Exception exception)
        {
            // Asked every 250 ms per seat, so say it once rather than flood the log.
            if (Interlocked.Exchange(ref _peerReadFailureLogged, 1) == 0)
            {
                CouchCoopLog.Stderr($"host peer read failed ({exception.GetType().Name}: {exception.Message}); using the state read.");
            }

            return null;
        }
    }

    private static void SetPlatform(NetHostGameService service, PlatformType platform)
        => (PlatformSetter ?? throw new InvalidOperationException("NetHostGameService.Platform setter is unavailable."))
            .Invoke(service, [platform]);

    /// <summary>
    /// The one sentence that states what a hosting session's transports were sized for. Emitted on EVERY path that
    /// brings a listener up — Steam, the composite Steam+ENet host, the Steam-failure ENet fallback, and the stock
    /// <c>StartENetHost</c> the game drives itself — so a host log answers "how many clients could actually have
    /// connected?" without inference, whichever path ran and whatever mods adjusted the cap on the way in.
    /// <para>
    /// <c>effective maxClients=</c> is the token live probes grep for. Keep it stable.
    /// </para>
    /// </summary>
    private static void LogEffectiveCapacity(int effective, int requested, string source)
        => Log($"effective maxClients={effective} (requested={requested}, source={source})");

    /// <summary>
    /// A host-transport line, in BOTH sinks.
    /// <para>
    /// stderr stays because it is a contract: <c>scripts/probe-steam-host-join.mjs</c> parses
    /// <c>[couchcoop] host-transport</c> lines out of the host's captured stderr (<c>--host-stderr</c>) to grade
    /// which branch a host took. But a STEAM-launched game has no stderr capture, so on the copy a player
    /// actually runs every one of these lines used to evaporate — including the two that name the reason couch
    /// co-op is unavailable. <c>godot.log</c> is the file a support report harvests and the one a host can be
    /// asked for, so the same sentence now lands there too. (<see cref="CouchCoopLog.Info"/> no-ops without a
    /// Godot engine, which keeps the unit suites silent.)
    /// </para>
    /// </summary>
    internal static void Log(string message)
    {
        CouchCoopLog.Stderr("host-transport " + message);
        CouchCoopLog.Info("host-transport " + message);
    }

    /// <summary>
    /// The same line, tagged <c>[WARN]</c> in <c>godot.log</c>: a hosting session that came up DEGRADED. Kept
    /// byte-identical on stderr so the probe's parser sees no difference between this and <see cref="Log"/>.
    /// </summary>
    internal static void LogWarning(string message)
    {
        CouchCoopLog.Stderr("host-transport " + message);
        CouchCoopLog.Warn("host-transport " + message);
    }
}

/// <summary>
/// The host's peer list, for code compiled into the hot-reload assembly as well (which cannot see the internal
/// <see cref="CouchCoopHostTransport"/>). Same contract as <see cref="CouchCoopHostTransport.IsPeerConnected"/>.
/// </summary>
public static class CouchCoopHostPeers
{
    public static bool? IsPeerConnected(ulong netId) => CouchCoopHostTransport.IsPeerConnected(netId);
}
