using System.Diagnostics;
using System.Security.Cryptography;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.Session;

public sealed partial class HeadlessClientManager
{
    /// <summary>
    /// The connection issue a seat that loaded a different CouchCoop build than its host is reported as.
    /// Public because the report copy, the host panel's issue mapping and the registry's confirmed-cause rule
    /// all key on the literal, and three spellings of it would drift.
    /// </summary>
    public const string SeatBuildMismatchCode = "seat-build-mismatch";

    /// <summary>
    /// The connection issue a seat that cannot be shown to be keeping its saves out of the host account's Steam
    /// Cloud storage is reported as. Public for the same reason as the code above: the report copy, the panel's
    /// issue mapping and the registry's confirmed-cause rule all key on the literal.
    /// </summary>
    /// <remarks>
    /// ONE CODE FOR BOTH SHAPES, because the player's position is identical in both and so is the remedy: a seat
    /// that said it could not install the protection (<see cref="HeadlessSeatCloudIsolationGuard.FailureErrorCode"/>),
    /// and a seat that never said it had. The two are told apart in the DETAIL, which is where a support report
    /// needs the difference; the friendly copy above it would read the same either way.
    /// </remarks>
    public const string SeatCloudIsolationCode = "seat-cloud-isolation-unconfirmed";

    /// <summary>
    /// The issue a seat is failed with when it JOINED the host's lobby and then never reported to the host at
    /// all. Public for the same reason as the code above: the report copy and the panel's issue mapping key on
    /// the literal.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY THIS IS NOT <see cref="SeatCloudIsolationCode"/>, which is what every silent seat used to be called.
    /// A seat can only appear in the host's lobby because CouchCoop put it there:
    /// <c>CommandLineOverridePatch.Apply()</c> is what re-materializes <c>fastmp=join</c> inside the seat, and
    /// <c>HeadlessSeatCloudIsolationGuard.EnforceOrExit()</c> runs BEFORE it and exits the process when the
    /// protection could not be installed. So host lobby membership PROVES the isolation guard already passed,
    /// and telling that player their saves might have been touched is not a cautious answer — it is a false one,
    /// about the one subject where a false alarm costs the most trust.
    /// </para>
    /// <para>
    /// What it does mean is narrower and more useful: the mod started, got as far as joining, and then stopped
    /// short of <c>HeadlessConnectionReporter.Initialize</c>. Everything between those two points is seat-only
    /// setup, which is exactly why the host's own game can be running perfectly while this fails — and why the
    /// remedy named below is the seat's own log and the other mods loaded beside us, not the host's firewall,
    /// its ports, or the player's network.
    /// </para>
    /// </remarks>
    public const string SeatSilentAfterJoinCode = "seat-silent-after-join";

    /// <summary>
    /// The issue a seat is failed with when it is demonstrably ALIVE AND SERVING — its browser listener answers
    /// this host, or it has written the port it bound — and still cannot get a status through the authenticated
    /// control channel. Public for the same reason as the codes above: the report copy, the panel's issue
    /// mapping and <c>CouchCoopWebSocketConnection.ClassifyFailedSpawn</c> all key on the literal.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY THIS IS NOT <see cref="SeatSilentAfterJoinCode"/>. That code's copy tells the operator their player's
    /// game "stopped responding" and its detail names another installed mod as the usual reason. Both are
    /// reasonable for a seat that went quiet and cannot be reached — and both are FALSE for a seat that is
    /// answering HTTP on its own port while it says nothing to us. Measured in the field 2026-09-18: a seat that
    /// had joined the host's lobby, bound its port and was still idling normally 74 seconds later, reported to
    /// the player as a startup timeout. Nothing in that seat stopped, and nothing in it needed disabling.
    /// </para>
    /// <para>
    /// What it does mean is one-directional and local: two processes of the same game, on one computer, over
    /// 127.0.0.1, and the seat→host direction is not getting through. So the remedy named is the machine's own
    /// filtering — a proxy, a VPN, security software — and never the player's device, their network or the
    /// router, none of which are anywhere near this wire.
    /// </para>
    /// </remarks>
    public const string SeatControlBlockedCode = "seat-control-blocked";

    /// <summary>
    /// The host-service issue a session runs under only when preparing an isolated Godot user directory failed —
    /// a WARNING, not a failure: co-op works, but every player on this machine shares one settings/save profile.
    /// A fallback seat still has its own explicit log file. Public for the same reason as the code above: the
    /// panel's copy keys on the literal.
    /// </summary>
    public const string SharedUserDirCode = "host-seat-profile-shared";

    /// <summary>
    /// The host-service issue raised when the pre-spawn survey finds a FOREIGN owner on a port in the seat range
    /// and routes the new player around it. A WARNING for the same reason as the code above: the join worked, and
    /// what the operator is being told is that something else on their machine holds a port this mod needs.
    /// Public because the panel's copy mapping keys on the literal.
    /// </summary>
    public const string SeatPortOccupiedCode = "host-seat-port-occupied";

    private readonly Dictionary<int, OwnedConnection> _ownedConnections = [];
    private readonly Dictionary<Guid, BrowserAttempt> _browserAttempts = [];
    private readonly Dictionary<int, Task> _connectionCleanup = [];
    private Func<ulong, bool>? _membershipProbe;
    // What the monitor asks once a seat has joined; null means the join-wait probe above. Separate because the
    // monitor asks every 250 ms for the seat's whole life, so it can use a cheaper question than lobby membership.
    private Func<ulong, bool>? _monitorMembershipProbe;
    private Func<int>? _controlPort;
    private long _processGeneration;

    internal void ConfigureConnectionMonitoring(
        Func<ulong, bool> membershipProbe, Func<int> controlPort, Func<ulong, bool>? monitorMembershipProbe = null)
    {
        HeadlessConnectionControl.Shared.StatusChanged -= OnChildStatus;
        HeadlessConnectionControl.Shared.StatusChanged += OnChildStatus;
        _membershipProbe = membershipProbe;
        _monitorMembershipProbe = monitorMembershipProbe;
        _controlPort = controlPort;
    }

    public async Task<int?> EnsureHeadlessAsync(Guid sessionId, string? displayName, CancellationToken ct,
        bool allowNewSlot = true, Action<ulong, string?>? onSlotBound = null, ulong? targetNetId = null)
    {
        Task[] cleanup;
        lock (_lock) cleanup = _connectionCleanup.Values.ToArray();
        await Task.WhenAll(cleanup).WaitAsync(ct).ConfigureAwait(false);
        await CleanupExitedConnectionsAsync(ct).ConfigureAwait(false);
        ConnectionRegistry.Shared.ConfigureView(sessionId, requiresChild: true, reused: true);
        var launchLogs = ConnectionAttemptLogs.CaptureStart(ConnectionRegistry.HostLogPath, null);
        // BEFORE ANY SEAT PROCESS OF THIS SESSION CAN EXIST, copy the host's own save profile aside — the last
        // line of defence behind SeatCloudSaveIsolationPatch, and the only one that survives a seat which never
        // loads our code at all (a refused lane, an assembly conflict, the loader's blanket catch). Once per host
        // process, synchronous, and best-effort to the point of being unable to fail a join.
        //
        // HERE, AND NOT AT THE SPAWN, for the same reason the three probes below are here: _lock is taken by the
        // game's MAIN THREAD on every screen change, and a whole profile copy inside it is the room-load freeze
        // all over again. This needs no slot and nothing the lock protects, so it has no business under it. The
        // trade — this entry is also reached by joins that reuse or are refused — is argued in EnsureForThisHostOnce.
        HostProfileBackup.EnsureForThisHostOnce();
        // ALL THREE of these are settled BEFORE _lock is taken, and for the same reason: the MaxSlot and
        // RunInProgress probes marshal to the game's main thread, and the port survey can block on a dropped
        // packet. The main thread takes _lock on every screen change, so any of them evaluated under it stalls
        // (the state probes deadlock) the game.
        var maxSlot = MaxSlot;
        var runInProgress = RunInProgress;
        var occupiedSeatPorts = await SurveySeatPortsAsync(maxSlot, displayName, targetNetId, ct).ConfigureAwait(false);
        foreach (var (occupiedSlot, owner) in occupiedSeatPorts)
        {
            ConnectionRegistry.Shared.RecordDiagnostic(sessionId, $"seat port {SlotToPort(occupiedSlot)}", owner);
        }
        // The diagnostic above lands on the joining player's own row, whose entire detail surface is hidden while
        // that row has no issue — so on the success this survey usually produces (the player is simply routed to
        // the next port) the host was never told anything at all. Raise it where it can be seen.
        ReportForeignSeatPortOwners(occupiedSeatPorts);
        HeadlessAllocation? allocation;
        try
        {
            allocation = AllocateHeadless(
                sessionId, displayName, ct, maxSlot, occupiedSeatPorts, runInProgress, allowNewSlot, onSlotBound,
                targetNetId);
        }
        catch
        {
            foreach (var log in await launchLogs.ReadErrorsAsync().ConfigureAwait(false))
                ConnectionRegistry.Shared.AttachLogExcerpt(sessionId, log.Source, log.Text, log.Status);
            throw;
        }
        var port = allocation?.Port;
        if (port is null)
        {
            foreach (var log in await launchLogs.ReadErrorsAsync().ConfigureAwait(false))
                ConnectionRegistry.Shared.AttachLogExcerpt(sessionId, log.Source, log.Text, log.Status);
            return null;
        }
        var slot = (port.Value - HostPort) / PortStep;
        if (_membershipProbe is null) return allocation!.NewProcess
            ? await WaitForReadyAsync(slot, sessionId, ct).ConfigureAwait(false) : port;
        OwnedConnection? owned;
        var unusable = false;
        lock (_lock)
        {
            if (!_ownedConnections.TryGetValue(slot, out owned) || !_processBySlot.TryGetValue(slot, out var process)) return null;
            owned.Process = process;
            if (owned.Quarantined)
                unusable = true;
            else if (ProcessExited(process))
            {
                owned.Failure ??= ProcessExitedIssue(process);
                unusable = true;
            }
            else
            {
                _browserAttempts[sessionId] = new(slot, owned.Generation, ConnectionRegistry.Shared.AttemptId(sessionId));
                if (!owned.MonitorStarted) { owned.MonitorStarted = true; _ = Task.Run(() => MonitorConnectionAsync(owned)); }
            }
        }
        if (unusable)
        {
            if (owned!.Quarantined)
            {
                ConnectionRegistry.Shared.Fail(sessionId, "seat-cleanup-pending",
                    "A previous client process still owns this seat.",
                    "Wait for that process to exit, or restart the host before retrying.", owned.QuarantineReason);
            }
            else await StopFailedConnectionAsync(owned).ConfigureAwait(false);
            return null;
        }
        ConnectionRegistry.Shared.BindProcess(sessionId, owned.Process.Id, owned.Generation);
        ConnectionRegistry.Shared.BindLogs(sessionId, owned.Logs);
        ConnectionRegistry.Shared.RecordDiagnostic(sessionId, "process", $"pid={owned.Process.Id}; slot={slot}; generation={owned.Generation}; netId={SlotToNetId(slot)}");
        var started = Stopwatch.GetTimestamp();
        var deadline = SeatReadyTimeout;
        // The second, much shorter deadline: not "is this seat usable yet" but "is OUR CODE in it at all". See
        // DefaultSeatContactTimeoutSeconds, including what it does NOT guarantee.
        var contactDeadline = SeatContactTimeout;
        // The verdict is rebuilt from the host's own facts on every pass and replaces the one sentence that used
        // to end in "child HTTP listener: not responding" for three unrelated causes. See SeatReadinessVerdict.
        var verdict = SeatReadinessVerdict.Describe(
            ReadinessFacts(owned, null, member: false, port.Value, started, deadline));
        while (Stopwatch.GetElapsedTime(started) < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (!IsCurrent(owned)) return null;
            if (owned.Failure is not null || owned.Quarantined) { await StopFailedConnectionAsync(owned).ConfigureAwait(false); return null; }
            var status = HeadlessConnectionControl.Shared.Snapshot(slot, owned.Generation);
            // ABOVE first contact and above the contact deadline below, so a seat whose POST never lands is
            // still HEARD — by file — inside the window that would otherwise kill it. See ObserveSeatStatusFile.
            status = ObserveSeatStatusFile(owned, status);
            LogFirstContact(owned, status);
            var member = _membershipProbe(SlotToNetId(slot));
            // NOT ONE WORD from this process, well past the point where our own guard says hello, and the
            // remaining 40 seconds of the readiness deadline buy nothing. WHICH failure that is turns first on
            // whether the host's lobby has this seat, so the membership probe above moved ahead of it:
            //   * a member — CouchCoop DID run: only CommandLineOverridePatch could have made it join, and the
            //     cloud isolation guard runs before that patch and exits on failure, so the saves are provably
            //     covered. See SeatSilentAfterJoinCode for why saying otherwise here would be a false alarm.
            //   * NOT a member — and that is NOT proof that nothing of ours ran. Membership proves CouchCoop; its
            //     absence proves nothing, because a seat joins only after the game's own asset preload, and on a
            //     slow machine a perfectly healthy seat is still outside the lobby at this deadline. So the seat's
            //     own port record is asked first: only our browser server writes it, and only after the guard.
            //     Without one, this is a game holding the account's Steam Cloud save storage with no protection
            //     this host can confirm — the exposure the deadline exists to cut short.
            // Either way the evidence is gathered rather than assumed — see ClassifySilentSeatAsync.
            if (status?.Status is null && Stopwatch.GetElapsedTime(started) >= contactDeadline)
            {
                owned.Failure ??= await ClassifySilentSeatAsync(owned, port.Value, member, contactDeadline, ct)
                    .ConfigureAwait(false);
                await StopFailedConnectionAsync(owned).ConfigureAwait(false);
                return null;
            }
            var fresh = status is not null && Fresh(status);
            verdict = SeatReadinessVerdict.Describe(ReadinessFacts(owned, status, member, port.Value, started, deadline));
            ApplyToAttempt(sessionId, owned, registry => registry.RecordDiagnostic(sessionId, "join readiness", verdict.Detail));
            LogCauseChange(owned, verdict);
            if (verdict.Cause == SeatReadinessCause.PortConflict)
            {
                // The seat says it bound a port that is not the one we hand the browser. Nothing downstream can
                // recover from that, and waiting out the deadline would only turn a one-second answer into a
                // 75-second one — this is the backstop that makes any imprecision in the pre-spawn survey
                // harmless. See SeatReadinessVerdict.PortTakenCode.
                owned.Failure ??= verdict.Issue;
                await StopFailedConnectionAsync(owned).ConfigureAwait(false);
                return null;
            }
            if (status?.Status?.NativePhase.Equals("Connecting", StringComparison.OrdinalIgnoreCase) == true)
                ApplyToAttempt(sessionId, owned, registry => registry.Advance(sessionId, ConnectionStage.Joining));
            if (member && status?.Status is { NativePhase: "Connecting" or "starting" } && fresh)
            {
                var probe = await _readinessProbe(port.Value, ct).ConfigureAwait(false);
                // Retained on the connection so the monitor below can keep naming the cause after this loop has
                // returned — that is the only place the network-path verdict can be reached.
                owned.ListenerResponding = probe.Responding;
                owned.ListenerProbeFailure = probe.Failure;
                owned.ListenerReachability = probe.Reachability;
                verdict = SeatReadinessVerdict.Describe(ReadinessFacts(owned, status, member, port.Value, started, deadline));
                ApplyToAttempt(sessionId, owned, registry => registry.RecordDiagnostic(sessionId, "join readiness", verdict.Detail));
                LogCauseChange(owned, verdict);
                if (!probe.Responding)
                {
                    await Task.Delay(200, ct).ConfigureAwait(false);
                    continue;
                }
                // The probe above is awaited, and a file-fed seat's freshness is only ever as new as this host's
                // last read — so re-read here too, or a slow probe could leave the redirect gated on a status
                // that went stale while nothing was wrong.
                var afterProbe = ObserveSeatStatusFile(
                    owned, HeadlessConnectionControl.Shared.Snapshot(slot, owned.Generation));
                if (!IsCurrent(owned) || owned.Quarantined) return null;
                SetTerminalFailure(owned, afterProbe?.Status);
                if (ProcessExited(owned.Process!)) owned.Failure ??= ProcessExitedIssue(owned.Process!);
                if (owned.Failure is not null)
                {
                    await StopFailedConnectionAsync(owned).ConfigureAwait(false);
                    return null;
                }
                if (afterProbe is null || !Fresh(afterProbe) || !_membershipProbe(SlotToNetId(slot)))
                {
                    // Readiness can change while HTTP is awaited. Keep waiting within the existing deadline;
                    // missing readiness is not a confirmed failure and cannot enter terminal cleanup.
                    await Task.Delay(200, ct).ConfigureAwait(false);
                    continue;
                }
                owned.HasJoined = true;
                // A SUCCESSFUL join says how it was heard, and only when that is worth saying. This sentence
                // replaces the verdict detail that carried the evidence tail, so a machine whose direct report
                // is blocked — and whose join therefore rests entirely on the file fallback — would otherwise
                // produce a report indistinguishable from a healthy one. Nothing is added on the healthy path.
                var carriedByFile = afterProbe!.LastChannel == HeadlessStatusChannel.File;
                ApplyToAttempt(sessionId, owned, registry => registry.RecordDiagnostic(sessionId, "join readiness",
                    "Host lobby membership, live owned process, authenticated child heartbeat and child HTTP listener confirmed."
                    + (carriedByFile ? " " + DescribeControlChannel(afterProbe) + "." : string.Empty)));
                ApplyToAttempt(sessionId, owned, registry => registry.SetReadiness(sessionId, true, afterProbe!.Status!.ConnectedChildBrowserCount > 0));
                return port;
            }
            await Task.Delay(200, ct).ConfigureAwait(false);
        }
        // The deadline names the cause it actually observed rather than always saying "startup timeout": a
        // blocked loopback and a seat that was merely slow produced byte-identical text before this.
        owned.Failure ??= verdict.Issue;
        await StopFailedConnectionAsync(owned).ConfigureAwait(false);
        return null;
    }

    /// <summary>
    /// Raise (once) the host-service warning for seat ports a FOREIGN program holds, naming each port and what
    /// answered on it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// THE HOST'S OWN LIVE SEATS ARE NOT SQUATTERS, and the survey cannot tell the difference: it asks the port
    /// whether anything answers, and a seat this host started answers. Every ordinary two-player session would
    /// otherwise raise this warning about itself. The slots with a process of ours are subtracted here rather
    /// than in <c>SurveySeatPortsAsync</c>, whose result feeds slot selection and where a live own seat is
    /// already excluded by its process handle.
    /// </para>
    /// <para>
    /// ONE ROW FOR THE WHOLE SURVEY: <see cref="ConnectionRegistry.ReportHostIssue"/> deduplicates by code, so
    /// repeated joins against the same squatter do not stack rows. The first report's detail is the one the row
    /// keeps.
    /// </para>
    /// </remarks>
    private void ReportForeignSeatPortOwners(IReadOnlyDictionary<int, string> occupiedSeatPorts)
    {
        if (occupiedSeatPorts.Count == 0) return;
        HashSet<int> ours;
        lock (_lock) ours = _processBySlot.Keys.ToHashSet();
        var foreign = occupiedSeatPorts.Where(pair => !ours.Contains(pair.Key)).OrderBy(pair => pair.Key).ToArray();
        if (foreign.Length == 0) return;
        var ports = string.Join("; ", foreign.Select(pair =>
            $"{SlotToPort(pair.Key).ToString(System.Globalization.CultureInfo.InvariantCulture)} ({pair.Value})"));
        ConnectionRegistry.Shared.ReportHostIssue(
            SeatPortOccupiedCode,
            // Word-for-word the English twin of couchcoop_connection_error_seat_port_occupied_{summary,action}, so
            // a copied report and the panel above it never read as two different findings.
            "Another program on this computer is using one of the ports Couch Co-Op gives players.",
            "Co-op still works. Players are routed around that port. Close the other program if a player later "
                + "cannot connect.",
            "Checked before starting a player's game. Ports in this mod's player range that already had an owner, "
                + $"and what answered on them: {ports}. The player who was joining got a free port instead, so "
                + "their join was unaffected. A player whose seat is pinned (a rejoin, or a returning name the "
                + "host's run knows by its seat) cannot be moved, so the same owner would fail that join outright.",
            isWarning: true);
    }

    /// <summary>
    /// Write ONE line per seat process saying how long it took to say anything at all, the first time it does.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the measurement the contact deadline is set from, and it exists because the deadline was chosen
    /// without one. It is the seat's hello (<see cref="HeadlessSeatCloudIsolationGuard"/>) landing, so what it
    /// measures is "spawn → our code is running and has closed the cloud writes" — game boot plus mod init up to
    /// the first patch — on THIS computer. A figure anywhere near
    /// <see cref="DefaultSeatContactTimeoutSeconds"/> means the default is too tight for that machine.
    /// </para>
    /// <para>
    /// One line per seat PROCESS, not per join: a reused seat has spoken long ago, and re-announcing its first
    /// contact on every rejoin would be a number about nothing. Stderr, like the readiness causes beside it.
    /// </para>
    /// </remarks>
    private static void LogFirstContact(OwnedConnection owned, HeadlessConnectionControlSnapshot? status)
    {
        if (owned.FirstContactLogged || status?.Status is not { } first) return;
        owned.FirstContactLogged = true;
        CouchCoopLog.Stderr(
            $"seat first contact slot={owned.Slot} afterMs="
            + ((long)Stopwatch.GetElapsedTime(owned.StartedTicks).TotalMilliseconds)
                .ToString(System.Globalization.CultureInfo.InvariantCulture)
            + $" phase={first.NativePhase} cloudIsolated={first.CloudSaveIsolated}");
    }

    /// <summary>
    /// Write the readiness cause to the host log the first time it becomes this cause, and not again until it
    /// changes.
    /// </summary>
    /// <remarks>
    /// <para>
    /// One line per TRANSITION, deliberately: the verdict is recomputed five times a second during a join and
    /// four times a second for as long as a seat lives, and a line per evaluation would be the flood the
    /// godot-log-hygiene rule exists to prevent. What this buys is a diagnosis that is visible WHILE a live leg
    /// is running — the copyable report is the durable record, but nobody can watch one.
    /// </para>
    /// <para>
    /// And silent while nothing is wrong. Every healthy join is "still starting" for its whole 20-60 seconds, so
    /// announcing that on each spawn would be noise in the one file a support report is read from. A transition
    /// BACK to still-starting is logged, because that is a named condition clearing rather than a seat dying,
    /// and the difference is not otherwise recoverable from the log.
    /// </para>
    /// </remarks>
    private static void LogCauseChange(OwnedConnection owned, SeatReadinessVerdictResult verdict)
    {
        var previous = owned.LoggedCause;
        if (previous == verdict.Cause) return;
        owned.LoggedCause = verdict.Cause;
        if (verdict.Cause == SeatReadinessCause.StillStarting && previous is null) return;
        CouchCoopLog.Stderr(
            $"seat readiness slot={owned.Slot} cause={verdict.Cause}: {verdict.Detail}");
    }

    /// <summary>
    /// Everything the host knows about <paramref name="owned"/>'s readiness right now, in the shape
    /// <see cref="SeatReadinessVerdict"/> reads.
    /// </summary>
    private static SeatReadinessFacts ReadinessFacts(
        OwnedConnection owned,
        HeadlessConnectionControlSnapshot? status,
        bool member,
        int expectedPort,
        long startedTicks,
        TimeSpan deadline)
        => new(
            ExpectedPort: expectedPort,
            // The seat's own word for where it is listening. 0 until it has one, which is "not up yet" and must
            // never read as a disagreement — every heartbeat from before this field existed would say 0.
            ReportedPort: status?.Status?.BrowserPort ?? 0,
            // The pre-spawn survey's finding is not carried here: a slot whose port had an owner never got
            // spawned into (AllocateHeadless fails it outright), so by this point the only port evidence left is
            // what the seat itself reports.
            PortOwner: null,
            HostMember: member,
            NativePhase: status?.Status?.NativePhase,
            HeartbeatFresh: status is not null && Fresh(status),
            ListenerResponding: owned.ListenerResponding,
            ProbeFailure: owned.ListenerProbeFailure,
            TcpReachability: owned.ListenerReachability,
            ConnectedBrowserCount: status?.Status?.ConnectedChildBrowserCount ?? 0,
            // The seat's own arrival evidence, straight off the heartbeat. NOT coalesced to 0 when it is
            // missing: null is "the seat has not said", and the verdict that reads this one accuses the
            // player's network, so it must never be reachable by a defaulted field.
            SeatViewerArrivals: status?.Status?.ViewerArrivalCount,
            ElapsedMs: (long)Stopwatch.GetElapsedTime(startedTicks).TotalMilliseconds,
            DeadlineMs: (long)deadline.TotalMilliseconds,
            // Free: the counters ride the snapshot this caller already holds, plus one locked read of the
            // host's own refusal pair. Nothing here touches the disk or the network.
            ControlChannel: DescribeControlChannel(status));

    private void PrepareConnectionLocked(int slot, Guid sessionId)
    {
        if (_membershipProbe is null) return;
        var owned = new OwnedConnection(slot, ++_processGeneration, Convert.ToHexString(RandomNumberGenerator.GetBytes(32)), _seatNoticeTime);
        _ownedConnections[slot] = owned;
        _browserAttempts[sessionId] = new(slot, owned.Generation, ConnectionRegistry.Shared.AttemptId(sessionId));
        HeadlessConnectionControl.Shared.Register(slot, owned.Generation, sessionId, owned.Token);
        ConnectionRegistry.Shared.BindProcess(sessionId, null, owned.Generation);
        ConnectionRegistry.Shared.ConfigureView(sessionId, requiresChild: true);
        ConnectionRegistry.Shared.Advance(sessionId, ConnectionStage.Initializing);
    }

    private void ApplyConnectionEnvironmentLocked(int slot, ProcessStartInfo start)
    {
        if (!_ownedConnections.TryGetValue(slot, out var owned)) return;
        var port = _controlPort?.Invoke() ?? 0;
        if (port <= 0) throw new InvalidOperationException("The host connection-control listener is unavailable.");
        start.Environment["COUCHCOOP_HEADLESS_CONTROL_URL"] = $"http://127.0.0.1:{port}/internal/client-status";
        start.Environment["COUCHCOOP_HEADLESS_CONTROL_TOKEN"] = owned.Token;
        start.Environment["COUCHCOOP_HEADLESS_CONTROL_GENERATION"] = owned.Generation.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Bind this slot's attempt to the two log FILES a failure will be explained from.
    /// </summary>
    /// <remarks>
    /// Paths, not user directories. A seat launched without user-dir isolation has no <c>logs/godot.log</c> of
    /// its own — its log is the per-slot file <c>--log-file</c> points at (see
    /// <c>HeadlessClientManager.SeatLogPath</c>), and deriving one from the shared user dir would either report
    /// the HOST's log as the client's or, as it did, report nothing at all.
    /// </remarks>
    private void CaptureConnectionLogsLocked(int slot, string? hostLogPath, string? clientLogPath)
    {
        if (_ownedConnections.TryGetValue(slot, out var owned))
            owned.Logs = ConnectionAttemptLogs.CaptureStart(hostLogPath, clientLogPath);
    }

    /// <summary>
    /// Record the two files this seat writes into its own Godot user dir — the browser port it bound, and the
    /// status record it falls back to when it cannot POST one. For the same reason the log paths above are
    /// recorded here: the launcher is the only place the seat's user directory is known, and re-deriving it
    /// later would have to re-answer a question (isolated, or fallen back to the host's profile?) that was
    /// already settled at the spawn.
    /// </summary>
    private void CaptureSeatFilePathsLocked(int slot, string? seatUserDir)
    {
        if (!_ownedConnections.TryGetValue(slot, out var owned) || string.IsNullOrWhiteSpace(seatUserDir)) return;
        // The seat resolves these as `user://couch-coop/<name>` from inside its own process
        // (CouchCoopUserFile.TryResolve); this is the same directory from outside, which is why it takes the
        // seat's Godot user dir rather than its slot base.
        var couchCoop = Path.Combine(seatUserDir, HeadlessUserDirSeeder.CouchCoopDirName);
        owned.SeatPortFilePath = Path.Combine(couchCoop, BrowserPortFile.FileNameFor(slot));
        owned.SeatStatusFilePath = Path.Combine(couchCoop, SeatStatusFile.FileNameFor(slot));
    }

    /// <summary>
    /// Point this manager at where a seat of <paramref name="slot"/> keeps its files, for a caller that started
    /// the process itself.
    /// </summary>
    /// <remarks>
    /// The unit harness injects a launcher, so the real spawn — the only place a seat's user directory is known,
    /// and therefore the only caller of <see cref="CaptureSeatFilePathsLocked"/> — never runs. Without this the
    /// host's file fallback would be reachable only from a live leg, and a channel that carries a join is not
    /// something to leave untested. Production code does not call it.
    /// </remarks>
    /// <returns>
    /// The seat's bearer token and the status-record path just derived for it — everything a harness needs to
    /// write a record the way a real seat would, since the token is the key that signs it. Null when there is no
    /// such connection.
    /// </returns>
    internal (string Token, string StatusPath)? CaptureSeatFiles(int slot, string seatUserDir)
    {
        lock (_lock)
        {
            CaptureSeatFilePathsLocked(slot, seatUserDir);
            return _ownedConnections.TryGetValue(slot, out var owned) && owned.SeatStatusFilePath is { } path
                ? (owned.Token, path)
                : null;
        }
    }

    private void ForgetConnectionLocked(int slot)
    {
        if (!_ownedConnections.Remove(slot, out var owned)) return;
        HeadlessConnectionControl.Shared.Unregister(slot, owned.Generation);
        foreach (var id in _browserAttempts.Where(p => p.Value.Slot == slot && p.Value.Generation == owned.Generation).Select(p => p.Key).ToArray())
            _browserAttempts.Remove(id);
    }

    private bool IsCurrent(OwnedConnection owned)
    {
        lock (_lock) return !_disposed && _ownedConnections.GetValueOrDefault(owned.Slot) == owned
            && _processBySlot.GetValueOrDefault(owned.Slot) == owned.Process;
    }

    private static bool Fresh(HeadlessConnectionControlSnapshot snapshot)
        => snapshot.ObservedMonotonicTick is { } at && Stopwatch.GetElapsedTime(at) < TimeSpan.FromSeconds(10);

    /// <summary>
    /// When this host has no fresh word from a seat, look for one the seat left on DISK — and put it through
    /// exactly the door a POSTed status goes through.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY. Measured in the field 2026-09-18: a seat that had joined the lobby, bound its port and was idling
    /// healthily, whose every status POST to this host was being filtered by something on that computer. The
    /// host could then name the fault but not survive it. The seat writes the same status into its own Godot
    /// user dir once its POST has failed (<see cref="SeatStatusFile"/>), and this is where the host picks it up
    /// — a path with no socket on it, which is the point when the socket is what is in doubt.
    /// </para>
    /// <para>
    /// ONLY WHEN THERE IS NOTHING FRESH, which is by construction the only time the seat has written anything.
    /// A healthy seat's snapshot short-circuits on the first line and this never touches the disk.
    /// </para>
    /// <para>
    /// NOT A PARALLEL PATH: the record goes into <c>HeadlessConnectionControl.Observe</c>, so the sequence rule,
    /// the generation check, the <c>StatusChanged</c> event and every refusal downstream — the cloud-isolation
    /// one included — are the ones that already exist. What this adds ahead of that call is only what the
    /// transport would otherwise have guaranteed: the record is signed with the token THIS host issued, and
    /// written by the process THIS host started (<see cref="BrowserPortFile"/>'s pid rule, for its reason — a
    /// record outlives a killed seat by design).
    /// </para>
    /// <para>
    /// The pid rule compares the seat's own <c>Environment.ProcessId</c> with the process handle this host
    /// holds, so a <c>COUCHCOOP_HEADLESS_WRAPPER</c> that does not <c>exec</c> the game — a QA lever, never a
    /// shipped configuration, and the documented recipes all exec — leaves the host holding the WRAPPER's pid
    /// and no record can match. That costs the fallback, never correctness: the outcome is exactly the
    /// behaviour that shipped before it.
    /// </para>
    /// <para>
    /// THE SEQUENCE IS TRACKED HERE AS WELL AS IN <c>Observe</c>, and that is not redundant. These loops run
    /// four to five times a second while the seat rewrites its file once a second, so re-submitting what has
    /// already been taken would have this host refuse its own reads — and each of those refusals lands on the
    /// process-wide counter that <see cref="DescribeControlChannel"/> reports, i.e. on the exact evidence a
    /// support report reads to tell "nothing arrived" from "this host said no". Observe stays the authority;
    /// this only keeps the host from arguing with itself.
    /// </para>
    /// </remarks>
    private HeadlessConnectionControlSnapshot? ObserveSeatStatusFile(
        OwnedConnection owned, HeadlessConnectionControlSnapshot? current)
    {
        if (!OverdueForAStatus(current)) return current;
        if (owned.SeatStatusFilePath is not { } path) return current;
        var status = SeatStatusFile.Read(path, owned.Token, ProcessId(owned.Process), owned.Generation);
        if (status is null) return current;
        var previous = Volatile.Read(ref owned.LastFileSequence);
        if (status.Sequence <= previous
            || Interlocked.CompareExchange(ref owned.LastFileSequence, status.Sequence, previous) != previous)
        {
            return current;
        }

        HeadlessConnectionControl.Shared.Observe(
            owned.Token, owned.Generation, status, HeadlessStatusChannel.File);
        return HeadlessConnectionControl.Shared.Snapshot(owned.Slot, owned.Generation) ?? current;
    }

    /// <summary>
    /// Whether this seat is late enough with a status that it is worth looking on disk for one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A seat heartbeats once a second, so two seconds means "a report that should have arrived has not". A
    /// healthy session therefore never reads the disk at all, which is the cost this whole fallback had to
    /// stay inside.
    /// </para>
    /// <para>
    /// DELIBERATELY NOT <see cref="Fresh"/>, which is ten seconds. Ten is the window after which a joined seat
    /// is failed as <c>child-status-lost</c> — so reading the file only once the snapshot had aged out of it
    /// would leave a seat the fallback is CARRYING permanently one read away from being killed, and would drive
    /// every verdict, notice and panel row off status up to ten seconds old. The two intervals answer different
    /// questions: this one is "should I look?", that one is "is this seat gone?".
    /// </para>
    /// </remarks>
    private static bool OverdueForAStatus(HeadlessConnectionControlSnapshot? snapshot)
        => snapshot?.ObservedMonotonicTick is not { } at
            || Stopwatch.GetElapsedTime(at) >= TimeSpan.FromSeconds(2);

    private void ApplyToAttempt(Guid sessionId, OwnedConnection expected, Action<ConnectionRegistry> action)
    {
        BrowserAttempt? attempt;
        lock (_lock)
        {
            if (_ownedConnections.GetValueOrDefault(expected.Slot) != expected
                || _processBySlot.GetValueOrDefault(expected.Slot) != expected.Process
                || !_browserAttempts.TryGetValue(sessionId, out attempt)
                || attempt.Slot != expected.Slot
                || attempt.Generation != expected.Generation)
                return;
        }
        ConnectionRegistry.Shared.ForAttempt(sessionId, attempt.AttemptId, action);
    }

    private void OnChildStatus(HeadlessConnectionControlSnapshot snapshot)
    {
        OwnedConnection? owned;
        Guid[] clients;
        lock (_lock)
        {
            owned = _ownedConnections.GetValueOrDefault(snapshot.Slot);
            if (owned is null || owned.Generation != snapshot.Generation) return;
            clients = _browserAttempts.Where(p => p.Value.Slot == owned.Slot && p.Value.Generation == owned.Generation).Select(p => p.Key).ToArray();
        }
        var status = snapshot.Status;
        if (SetTerminalFailure(owned, status))
        {
            var failure = owned.Failure!;
            foreach (var id in clients) ApplyToAttempt(id, owned, registry => registry.Fail(id, failure.Code, failure.Summary, failure.Action, failure.Detail));
        }
        else if (status?.NativePhase == "Connecting")
            foreach (var id in clients) ApplyToAttempt(id, owned, registry => registry.Advance(id, ConnectionStage.Joining));
    }

    public async Task FinishReportedFailureAsync(Guid sessionId)
    {
        OwnedConnection? owned;
        lock (_lock)
        {
            owned = _browserAttempts.TryGetValue(sessionId, out var attempt) ? _ownedConnections.GetValueOrDefault(attempt.Slot) : null;
        }
        if (owned is not null && IsCurrent(owned))
        {
            SetTerminalFailure(owned, HeadlessConnectionControl.Shared.Snapshot(owned.Slot, owned.Generation)?.Status);
            if (owned.Process is not null && ProcessExited(owned.Process))
                owned.Failure ??= ProcessExitedIssue(owned.Process);
        }
        if (owned?.Failure is not null) await StopFailedConnectionAsync(owned).ConfigureAwait(false);
        else if (owned?.Logs is not null && ConnectionRegistry.Shared.Snapshot().Rows
                     .Any(row => row.Id == sessionId && row.Issue is not null))
        {
            // Capture the affected process before disconnect releases its slot for reuse. A browser failure
            // must not stop a healthy process that still serves another browser or an active run.
            var logs = await owned.Logs.ReadErrorsAsync().ConfigureAwait(false);
            ApplyToAttempt(sessionId, owned, registry =>
            {
                foreach (var log in logs) registry.AttachLogExcerpt(sessionId, log.Source, log.Text, log.Status);
            });
        }
    }

    private async Task MonitorConnectionAsync(OwnedConnection owned)
    {
        try
        {
            while (IsCurrent(owned))
            {
                var status = ObserveSeatStatusFile(
                    owned, HeadlessConnectionControl.Shared.Snapshot(owned.Slot, owned.Generation));
                var native = status?.Status;
                SetTerminalFailure(owned, native);
                var member = (_monitorMembershipProbe ?? _membershipProbe!)(SlotToNetId(owned.Slot));
                // The same four-cause verdict the join wait uses, kept running after the redirect. This is the
                // only place the NETWORK PATH cause can be reached: the join returns as soon as the host itself
                // can reach the seat, so "the seat is up, the host can talk to it, and no viewer ever arrived"
                // is only observable from here. A port disagreement is terminal on this side too — it means the
                // browser is being pointed at an address this seat does not serve.
                var verdict = SeatReadinessVerdict.Describe(ReadinessFacts(
                    owned, status, member, SlotToPort(owned.Slot), owned.StartedTicks, TimeSpan.Zero));
                LogCauseChange(owned, verdict);
                Guid[] clients;
                lock (_lock) clients = _browserAttempts.Where(p => p.Value.Slot == owned.Slot && p.Value.Generation == owned.Generation).Select(p => p.Key).ToArray();
                // TELL THE PLAYER, not just the panel. Every other consumer of this verdict stops at the HOST —
                // the log line above, the registry diagnostic below, and the copyable report behind it — and the
                // one person who could act on the cause, the viewer whose seat it is, has only ever seen a
                // spinner. That is worst for the network-path cause, which is reachable only here and describes
                // a device that was handed a port it cannot open. Deliberately ABOVE the failure bail below, so
                // a port conflict (which kills this seat on this very tick) still reaches the browser before its
                // seat goes away. The speaker decides whether this cause is worth saying yet; the hub decides
                // who has not already been told, and can neither block nor fault this loop.
                // …AND THE HOST'S OWN ROW, from this same decision. Before this, the panel had no path to the
                // verdict at all: it inferred a cause of its own from the seat's child-browser count and called a
                // viewer who never arrived a lost browser tab, while the phone in that player's hand was being
                // told — correctly — that its network path was blocked. Reading the speaker's answer rather than
                // the verdict directly is what keeps the two surfaces identical: one settling delay, one
                // withdrawal, one moment. `null` means "nothing to say", and withdraws the row as it withdraws
                // the phone's notice. A WARNING, never a failure — the seat is alive and the join completed.
                var notice = owned.Notice.Observe(verdict);
                var condition = notice is null ? null : verdict.Issue;
                foreach (var id in clients)
                {
                    SeatNoticeHub.Shared.Publish(id, notice);
                    ApplyToAttempt(id, owned, registry => registry.ReportSeatCondition(id, condition));
                }
                if (verdict.Cause == SeatReadinessCause.PortConflict) owned.Failure ??= verdict.Issue;
                if (owned.Process!.HasExited)
                    owned.Failure ??= ProcessExitedIssue(owned.Process);
                if (owned.HasJoined && status is not null && !Fresh(status))
                    owned.Failure ??= new("child-status-lost", "The client game stopped responding to the host.",
                        "Retry the connection. Copy this report if the client becomes unresponsive again.", "No authenticated child heartbeat arrived for 10 seconds.");
                if (owned.Failure is not null) { await StopFailedConnectionAsync(owned).ConfigureAwait(false); return; }
                foreach (var id in clients)
                {
                    ApplyToAttempt(id, owned, registry =>
                    {
                        if (native?.NativePhase.Equals("Connecting", StringComparison.OrdinalIgnoreCase) == true)
                            registry.Advance(id, ConnectionStage.Joining);
                        // Only while something is actually diagnosable. The verdict's elapsed figure changes every
                        // second, so recording it unconditionally would bump the registry revision (and repaint the
                        // panel) once a second for every connected seat, for the whole session — and say nothing.
                        // A seat with a browser attached always classifies as "still starting", so this is silent
                        // the moment the join succeeds.
                        if (verdict.Cause != SeatReadinessCause.StillStarting)
                            registry.RecordDiagnostic(id, "view readiness", verdict.Detail);
                        registry.SetReadiness(id, member, native?.ConnectedChildBrowserCount > 0);
                        registry.NoticeSlowView(id);
                    });
                }
                await Task.Delay(250).ConfigureAwait(false);
            }
        }
        catch (Exception exception)
        {
            if (!IsCurrent(owned)) return;
            owned.Failure ??= new("process-monitor-failed", "The host could not monitor the client game.",
                "Retry the connection and copy this report if it repeats.", exception.ToString());
            await StopFailedConnectionAsync(owned).ConfigureAwait(false);
        }
    }

    private Task StopFailedConnectionAsync(OwnedConnection owned)
    {
        lock (_lock)
        {
            if (_connectionCleanup.TryGetValue(owned.Slot, out var cleanup)) return cleanup;
            if (!IsCurrent(owned)) return Task.CompletedTask;
            var task = Task.Run(() => CleanupFailedConnectionAsync(owned));
            _connectionCleanup[owned.Slot] = task;
            return task;
        }
    }

    private async Task CleanupFailedConnectionAsync(OwnedConnection owned)
    {
        Guid[] clients;
        lock (_lock) clients = _browserAttempts.Where(p => p.Value.Slot == owned.Slot && p.Value.Generation == owned.Generation).Select(p => p.Key).ToArray();
        var issue = owned.Failure!;
        foreach (var id in clients) ApplyToAttempt(id, owned, registry => registry.Fail(id, issue.Code, issue.Summary, issue.Action, issue.Detail));
        var started = Stopwatch.GetTimestamp();
        HeadlessConnectionControl.Shared.RequestShutdown(owned.Slot, owned.Generation);
        var forced = false;
        Exception? killFailure = null;
        try
        {
            while (IsCurrent(owned) && !owned.Process!.HasExited && Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(5))
                await Task.Delay(100).ConfigureAwait(false);
            if (IsCurrent(owned) && !owned.Process!.HasExited)
            {
                try
                {
                    owned.Process.Kill();
                    forced = true;
                    var killStarted = Stopwatch.GetTimestamp();
                    while (!owned.Process.HasExited && Stopwatch.GetElapsedTime(killStarted) < TimeSpan.FromSeconds(1))
                        await Task.Delay(25).ConfigureAwait(false);
                    if (!owned.Process.HasExited)
                        killFailure = new InvalidOperationException("The forced shutdown request did not terminate the client process.");
                }
                catch (Exception exception)
                {
                    killFailure = exception;
                }
            }
            var logs = owned.Logs is null
                ? new[] { new ConnectionLogExcerpt("host", "unavailable", "The attempt log path was unavailable."), new ConnectionLogExcerpt("client", "unavailable", "The attempt log path was unavailable.") }
                : await owned.Logs.ReadErrorsAsync().ConfigureAwait(false);
            foreach (var id in clients)
            {
                ApplyToAttempt(id, owned, registry =>
                {
                    registry.RecordDiagnostic(id, "cleanup", forced ? "Forced exit after the five-second graceful shutdown deadline." : "Client exited before the forced shutdown deadline.");
                    foreach (var log in logs) registry.AttachLogExcerpt(id, log.Source, log.Text, log.Status);
                    if (killFailure is not null) registry.RecordDiagnostic(id, "cleanupKillFailed", killFailure.ToString());
                });
            }
            if (killFailure is not null)
            {
                // Retain ownership when termination is indeterminate. Removing the handle would allow another
                // child to launch on this seat while the old process might still own its network peer.
                QuarantineLocked(owned, killFailure.Message);
                return;
            }
            // A concurrent release or hosting teardown can retire this generation while logs are read.
            if (!IsCurrent(owned)) return;
            // Keep the slot reserved until its peer has been removed and log capture has completed.
            try { _evictStalePeer?.Invoke(SlotToNetId(owned.Slot)); }
            catch (Exception exception)
            {
                foreach (var id in clients) ApplyToAttempt(id, owned, registry => registry.RecordDiagnostic(id, "peerCleanup", exception.ToString()));
                QuarantineLocked(owned, $"The host could not remove the prior network peer: {exception.Message}");
                return;
            }
            lock (_lock)
            {
                if (IsCurrent(owned))
                {
                    ClearQuarantineLocked(owned);
                    foreach (var id in _sessionToSlot.Where(p => p.Value == owned.Slot).Select(p => p.Key).ToArray()) _sessionToSlot.Remove(id);
                    RemoveNameForSlotLocked(owned.Slot);
                    ShutdownSlotLocked(owned.Slot, graceful: false);
                }
            }
        }
        finally { lock (_lock) _connectionCleanup.Remove(owned.Slot); }
    }

    internal void EndHosting()
    {
        lock (_lock)
        {
            foreach (var slot in _processBySlot.Keys.ToArray()) ShutdownSlotLocked(slot, graceful: false);
            _sessionToSlot.Clear(); _nameToSlot.Clear(); _detachedSlots.Clear(); _browserAttempts.Clear();
        }
    }

    private sealed class OwnedConnection(int slot, long generation, string token, TimeProvider? noticeTime = null)
    {
        public int Slot { get; } = slot;
        public long Generation { get; } = generation;
        public string Token { get; } = token;
        /// <summary>When this seat was claimed, for the elapsed figure the readiness verdict prints.</summary>
        public long StartedTicks { get; } = Stopwatch.GetTimestamp();
        public IHeadlessProcess? Process;
        public bool MonitorStarted, HasJoined, Quarantined;
        /// <summary>Whether this seat's first-contact figure has been written; see <c>LogFirstContact</c>.</summary>
        public bool FirstContactLogged;
        /// <summary>
        /// The last result of the host's own loopback probe of this seat's assigned port, and why it failed.
        /// Null until the join wait has probed at all. Retained past that wait because the monitor keeps naming
        /// the readiness cause and has no probe of its own — re-probing on its 250 ms tick would be a poll.
        /// </summary>
        public bool? ListenerResponding;
        public string? ListenerProbeFailure;
        /// <summary>What a raw TCP connect found when the HTTP probe last failed; see the probe's own doc.</summary>
        public SeatPortReachability ListenerReachability;
        /// <summary>The readiness cause already written to the host log; see <c>LogCauseChange</c>.</summary>
        public SeatReadinessCause? LoggedCause;
        /// <summary>
        /// Where this seat will write the browser port it actually bound (<c>BrowserPortFile</c>), resolved at
        /// LAUNCH because that is where the seat's user directory is known — and read only on the failure path,
        /// by <c>ClassifySilentSeatAsync</c>, as the one fact about a seat this host can learn with no network.
        /// Null when the seat's user dir could not be resolved at all.
        /// </summary>
        public string? SeatPortFilePath;
        /// <summary>
        /// Where this seat writes its status record when it cannot POST one (<c>SeatStatusFile</c>), resolved at
        /// LAUNCH for the same reason as the path above — and <see cref="LastFileSequence"/> is the highest
        /// sequence this host has already taken out of that file. See <c>TryObserveSeatStatusFileAsync</c> for
        /// why the host tracks that itself rather than letting the control channel refuse the repeats.
        /// </summary>
        public string? SeatStatusFilePath;
        public long LastFileSequence;
        /// <summary>
        /// What this seat should currently be telling its VIEWERS, and since when. Per seat rather than per
        /// viewer because the settling delay measures how long a cause has held for the seat, and a viewer that
        /// drops and reconnects mid-episode must not restart that clock.
        /// </summary>
        public readonly SeatNoticeSpeaker Notice = new(noticeTime);
        public ConnectionIssue? Failure;
        public ConnectionAttemptLogs? Logs;
        public string? QuarantineReason;
    }
    private sealed record HeadlessAllocation(int Port, bool NewProcess);
    private sealed record BrowserAttempt(int Slot, long Generation, string? AttemptId);

    private async Task CleanupExitedConnectionsAsync(CancellationToken ct)
    {
        OwnedConnection[] exited;
        lock (_lock)
        {
            exited = _ownedConnections.Values.Where(owned => owned.Process is not null && ProcessExited(owned.Process)).ToArray();
            foreach (var owned in exited) owned.Failure ??= ProcessExitedIssue(owned.Process!);
        }

        foreach (var owned in exited)
            await StopFailedConnectionAsync(owned).WaitAsync(ct).ConfigureAwait(false);
    }

    private static bool ProcessExited(IHeadlessProcess process)
    {
        try { return process.HasExited; }
        catch { return true; }
    }

    private static ConnectionIssue ProcessExitedIssue(IHeadlessProcess process)
    {
        string exitCode;
        try { exitCode = process.ExitCode.ToString(System.Globalization.CultureInfo.InvariantCulture); } catch { exitCode = "unknown"; }
        return new("process-exited", "The client game process closed unexpectedly.",
            "Retry the connection. If the game closes again, copy this report.", $"Process exit code: {exitCode}.");
    }

    /// <summary>
    /// The technical detail a <see cref="SeatBuildMismatchCode"/> row carries: what the seat reported, plus —
    /// when this host could not isolate its seats — WHY the mismatch was reachable at all.
    /// </summary>
    /// <remarks>
    /// <para>
    /// On a host with per-seat user dirs this failure should be unreachable: the seeder rewrites each seat's own
    /// <c>settings.save</c> so the row for the other installed copy of the mod is disabled
    /// (<see cref="HeadlessSeatModSelection"/>), and the seat then loads what the host loaded. That pin runs
    /// INSIDE the seeder, over a file the seat owns.
    /// </para>
    /// <para>
    /// Without isolation there is no such file — the only <c>settings.save</c> on the machine is the host's own,
    /// and rewriting it is out of the question — so the game chooses per process and can choose differently for
    /// a seat. The remedy the player is given does not change (keep one copy installed), but a support report
    /// that does not say this reads as a random failure on a machine where it is in fact deterministic.
    /// </para>
    /// </remarks>
    internal static string SeatBuildMismatchDetail(string? reportedDetail, bool seatsShareTheHostProfile)
    {
        var detail = string.IsNullOrWhiteSpace(reportedDetail)
            ? "The client game did not report which build it loaded."
            : reportedDetail;
        return seatsShareTheHostProfile
            ? detail + " This platform has no per-player game profile, so the host cannot tell a player's game "
                + "which copy of CouchCoop to load — with two copies installed, the game picks one per process "
                + "and can pick differently for each player."
            : detail;
    }

    /// <summary>
    /// The issue a seat is failed with when this host cannot confirm it is staying out of the account's Steam
    /// Cloud save storage. English here, as every issue is, and word-for-word the
    /// <c>couchcoop_connection_error_seat_cloud_isolation_*</c> catalog entries the panel and the phone render.
    /// </summary>
    internal static ConnectionIssue SeatCloudIsolationIssue(string detail)
        => new(
            SeatCloudIsolationCode,
            "This player's game could not promise to leave your Steam Cloud saves alone.",
            // NOT "before it could write anything", which this used to say. That holds for a seat whose own guard
            // refused, and not for one that never spoke: a game with no CouchCoop in it may have run its own
            // startup cloud sync inside the contact deadline (see NoSeatContactDetail). One code covers both, so
            // the copy claims only what is true of both.
            "It was stopped. Restart the game and try again, and copy this report if it happens again.",
            detail);

    /// <summary>
    /// The issue a seat is failed with when it joined the host's lobby and then went silent. English here, as
    /// every issue is, and word-for-word the <c>couchcoop_connection_error_seat_silent_*</c> catalog entries the
    /// panel and the phone render.
    /// </summary>
    /// <remarks>
    /// The action names the seat's OWN log and the other mods, and neither is a guess: every step between
    /// joining and reporting is seat-only setup, and a seat loads the same Workshop mod set as its host (see
    /// <c>SeatCloudSaveIsolationPatch</c> for why it cannot be launched without one). It deliberately does not
    /// mention ports, firewalls or the player's network — nothing on that side of the wire has been reached yet.
    /// </remarks>
    internal static ConnectionIssue SeatSilentAfterJoinIssue(string detail)
        => new(
            SeatSilentAfterJoinCode,
            "This player's game started and joined, then stopped responding.",
            "Try again. If it keeps happening, check that player's own log (its path is in this report) and try "
                + "again with other mods disabled.",
            detail);

    /// <summary>
    /// The issue a seat is failed with when it is running and serving and cannot reach the host's control
    /// channel. English here, as every issue is, and word-for-word the
    /// <c>couchcoop_connection_error_seat_control_*</c> catalog entries the panel and the phone render.
    /// </summary>
    /// <remarks>
    /// The action is addressed to whoever is at the HOST, because that is the only machine involved — and it
    /// names no port, because the seat's port is demonstrably working (that is how this cause was reached) and
    /// the request being blocked is the host's own control listener. Nothing here mentions the joining player's
    /// device or network; see <see cref="SeatControlBlockedCode"/>.
    /// </remarks>
    internal static ConnectionIssue SeatControlBlockedIssue(string detail)
        => new(
            SeatControlBlockedCode,
            "This player's game is running, but it cannot report back to your game.",
            "Allow Slay the Spire 2 through this computer's firewall and security software, turn off any VPN, "
                + "proxy or network-filtering software on this computer, then try again.",
            detail);

    /// <summary>
    /// Which of the two silences this is — a seat that STOPPED, or one that is running and cannot report —
    /// asked with the two pieces of evidence that do not depend on the channel that is already not working.
    /// </summary>
    /// <remarks>
    /// <para>
    /// ON THE FAILURE PATH ONLY, and that is what pays for it. A healthy join never reaches the contact
    /// deadline, so this costs a live-and-well seat nothing; the same trade
    /// <c>DefaultHttpReadinessAsync</c>'s follow-up TCP connect already makes for the probe in the other
    /// direction. Both facts are gathered ONCE, here, rather than on the 200 ms readiness pass.
    /// </para>
    /// <para>
    /// THE PORT FILE IS ASKED FIRST BECAUSE IT NEEDS NO NETWORK. The seat writes the port it bound into its own
    /// user dir (<see cref="BrowserPortFile"/>) — so when the suspicion is that this machine is filtering one
    /// program talking to another, the file is the one piece of evidence that suspicion cannot touch. It is
    /// believed only when its pid is the process WE started: the record outlives a killed seat by design.
    /// </para>
    /// <para>
    /// THREE ANSWERS, not two: the record can also show the seat serving on a port that is NOT the one the
    /// browser is being sent to, which is a port conflict and has the port conflict's remedy. That arm exists
    /// only because the file does — the verdict's own port-disagreement test reads the heartbeat, which is by
    /// definition absent here.
    /// </para>
    /// <para>
    /// The probe runs UNGATED BY HEARTBEAT FRESHNESS, which is the whole point. The readiness loop's own probe
    /// is reached only once a fresh status has arrived, so the host used to hold its single cheapest question —
    /// "is anything serving on the port I am about to hand out?" — behind the very report it never got, and
    /// printed `host loopback probe of the assigned port: not yet probed` on a seat that would have answered it.
    /// Its result is stored on the connection so the evidence tail and the monitor can read it afterwards.
    /// </para>
    /// <para>
    /// A SEAT OUTSIDE THE LOBBY IS NOT PROBED. Its verdict can rest only on the port record (see
    /// <see cref="ClassifySilentSeat"/>), so the probe would add a sentence to the report and nothing to the
    /// decision — and it costs up to several seconds on Windows, where a refused loopback connect takes ~2 s to
    /// say so. That is several more seconds for a game that may have no protection in it at all, which is the
    /// exposure this deadline exists to cut short.
    /// </para>
    /// </remarks>
    private async Task<ConnectionIssue> ClassifySilentSeatAsync(
        OwnedConnection owned,
        int expectedPort,
        bool member,
        TimeSpan deadline,
        CancellationToken cancellationToken)
    {
        var record = BrowserPortFile.Read(owned.SeatPortFilePath);
        SeatListenerProbeResult? probe = null;
        if (member)
        {
            var answer = await _readinessProbe(expectedPort, cancellationToken).ConfigureAwait(false);
            owned.ListenerResponding = answer.Responding;
            owned.ListenerProbeFailure = answer.Failure;
            owned.ListenerReachability = answer.Reachability;
            probe = answer;
        }

        return ClassifySilentSeat(
            owned.Slot,
            expectedPort,
            ProcessId(owned.Process),
            record,
            probe,
            DescribeControlChannel(HeadlessConnectionControl.Shared.Snapshot(owned.Slot, owned.Generation)),
            deadline,
            member);
    }

    /// <summary>
    /// The decision the two gathered facts support, and only that — no file, no socket, no clock.
    /// </summary>
    /// <remarks>
    /// Split out from <see cref="ClassifySilentSeatAsync"/> so all three answers are assertable: the file half
    /// of this cannot be reached through the unit suite's injected launcher (no real seat process ever writes a
    /// record), and a diagnosis nobody can test is how the wrong one ships. The wiring above it — which file,
    /// which port, which probe — is what the live leg proves.
    /// </remarks>
    /// <param name="probe">This host's own request to the seat's port, or <see langword="null"/> when it was not
    /// made — see <see cref="ClassifySilentSeatAsync"/> for why a seat outside the lobby is not probed.</param>
    /// <param name="member">Whether the host's lobby lists this seat. See <see cref="SeatSilentAfterJoinCode"/>
    /// for what that proves, and the non-member arm below for what its absence does not.</param>
    internal static ConnectionIssue ClassifySilentSeat(
        int slot,
        int expectedPort,
        int seatProcessId,
        (int Port, int Pid)? portRecord,
        SeatListenerProbeResult? probe,
        string controlChannel,
        TimeSpan deadline,
        bool member)
    {
        // Believed only when the record is THIS process's: it outlives a killed seat by design, so a stale one
        // must never read as a live listener. See BrowserPortFile.
        var ours = portRecord is { } written && seatProcessId > 0 && written.Pid == seatProcessId;
        var boundHere = ours && portRecord!.Value.Port == expectedPort;
        var evidence = SilentSeatEvidence(portRecord, ours, boundHere, expectedPort, probe, controlChannel);

        // A PORT DISAGREEMENT, from the seat's own record rather than from its heartbeat. The readiness verdict
        // already treats "the seat bound a port that is not the one we hand the browser" as a port conflict
        // (SeatReadinessVerdict.Classify, arm 1) — but it can only see that over the channel that is silent
        // here, so this shape used to be unreachable whenever the report never arrived. The remedy is the port
        // conflict's, not the control channel's: whatever the browser is sent to is not this player's game.
        if (ours && portRecord!.Value.Port != expectedPort)
        {
            return SeatReadinessVerdict.IssueFor(
                SeatReadinessCause.PortConflict,
                "This player's game recorded that it bound port "
                + portRecord.Value.Port.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + " rather than port "
                + expectedPort.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + ", which is the one the browser is sent to — so the address that player was given answers to "
                + "something that is not their game. " + evidence);
        }

        // OUTSIDE THE LOBBY, ONLY THE SEAT'S OWN RECORD CAN CLEAR IT. Lobby membership proves CouchCoop ran; its
        // absence proves nothing, because a seat joins only after the game's own asset preload and a healthy one
        // on a slow machine is still outside the lobby at this deadline. The record is the proof that remains:
        // only our browser server writes it, only after the cloud isolation guard has passed, and it is believed
        // only under the pid this host started. A probe answer is NOT enough here, unlike for a member — any
        // program can answer on a port, and the claim being cleared is that a player's saves were protected.
        if (!member)
        {
            return boundHere
                ? SeatControlBlockedIssue(ControlBlockedDetail(deadline, expectedPort, member: false) + " " + evidence)
                : SeatCloudIsolationIssue(NoSeatContactDetail(deadline) + " " + evidence);
        }

        return probe is { Responding: true } || boundHere
            ? SeatControlBlockedIssue(ControlBlockedDetail(deadline, expectedPort, member: true) + " " + evidence)
            : SeatSilentAfterJoinIssue(SilentAfterJoinDetail(deadline, slot) + " " + evidence);
    }

    /// <summary>
    /// What the questions above found, in one English sentence every one of those details ends with — so a
    /// report that names the wrong cause can still be re-read, exactly as the readiness verdict's tail is.
    /// </summary>
    private static string SilentSeatEvidence(
        (int Port, int Pid)? record,
        bool ours,
        bool boundHere,
        int expectedPort,
        SeatListenerProbeResult? probe,
        string controlChannel)
    {
        var port = expectedPort.ToString(System.Globalization.CultureInfo.InvariantCulture);
        // THREE readings of one record, because two of them are opposite findings. A record from OUR process on
        // another port is a live seat serving the wrong address; a record from another process is a leftover
        // from a seat that is gone. Saying "not the port and process this host started" for both — as this did
        // — accuses a running seat of being somebody else's.
        var file = record is { } written
            ? (boundHere
                ? $"this player's game recorded that it bound port {port} itself"
                : ours
                    ? "this player's game recorded that it bound port "
                        + written.Port.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + " rather than port " + port
                    : "the record on disk names port "
                        + written.Port.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + " under process "
                        + written.Pid.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + ", which is not the process this host started for this player")
            : "this player's game has recorded no bound port of its own";
        return "Observed: " + file
            + "; this computer's own request to port " + port + ": "
            + (probe is not { } asked
                ? "not made (a game outside the host's lobby is judged on its own port record alone)"
                : asked.Responding
                    ? "answered"
                    : $"no answer ({asked.Failure ?? "no failure detail was captured"})")
            + "; " + controlChannel
            + ".";
    }

    /// <summary>
    /// What this host has heard on the control channel for one seat, and what it has REFUSED across all of them.
    /// </summary>
    /// <remarks>
    /// The two halves answer different questions and only together answer the one that matters. A seat's own
    /// accepted count at zero says the host never heard it; the process-wide refusal count at zero then says
    /// the host never turned anything away either — so nothing ever arrived, and the POST is not reaching this
    /// process at all. A non-zero refusal count is the opposite finding with the opposite fix: it DID arrive,
    /// and this host rejected it (a stale generation, a token from a seat this host has replaced). Neither was
    /// observable before this; the same silence covered both.
    /// <para>
    /// The third half, since the file fallback: WHICH CHANNEL carried the last status. A seat only writes its
    /// status file after its POST has failed, so "delivered by file" is itself the finding — this computer is
    /// filtering one program's request to another and the join survived it anyway. Without this line a report
    /// from a rescued machine would look exactly like a report from a healthy one.
    /// </para>
    /// </remarks>
    internal static string DescribeControlChannel(HeadlessConnectionControlSnapshot? status)
    {
        var refusals = HeadlessConnectionControl.Shared.Refusals;
        var seat = status is null
            ? "this seat has no control-channel registration on the host"
            : "status reports accepted from this seat: "
                + status.AcceptedCount.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + ", refused: "
                + status.RefusedCount.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + (status.RefusedCount > 0 ? $" (last: {status.LastRefusal})" : string.Empty);
        return seat + "; status reports this host refused from any process: "
            + refusals.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)
            + (refusals.Count > 0 ? $" (last: {refusals.Last})" : string.Empty)
            + "; " + DescribeDeliveringChannel(status);
    }

    /// <summary>
    /// Which channel this seat's last accepted status came in on, in the same English the tail above is written
    /// in. <c>AcceptedCount</c> at zero is the case that has no answer: nothing has arrived by any route, which
    /// the sentence has to say rather than defaulting to the ordinary channel and reading as reassurance.
    /// </summary>
    private static string DescribeDeliveringChannel(HeadlessConnectionControlSnapshot? status)
    {
        if (status is null || status.AcceptedCount == 0)
            return "no status has reached this host by either the direct report or this player's status file";
        return status.LastChannel == HeadlessStatusChannel.File
            ? "the last status reached this host through this player's status file rather than a direct report ("
                + status.FileAcceptedCount.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + " of them), so the direct report is being blocked on this computer and co-op is working around it"
            : "the last status reached this host as a direct report"
                + (status.FileAcceptedCount > 0
                    ? ", after "
                        + status.FileAcceptedCount.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + " earlier ones that had to come through this player's status file"
                    : string.Empty);
    }

    private static int ProcessId(IHeadlessProcess? process)
    {
        try { return process?.Id ?? 0; }
        catch { return 0; }
    }

    /// <summary>
    /// The detail for a seat that is RUNNING AND SERVING and still cannot get a status to the host.
    /// </summary>
    /// <remarks>
    /// Says what the wire is — two processes of one game, on one computer, over the loopback address — because
    /// without that the reader has no way to know that none of the usual suspects (the router, the Wi-Fi, the
    /// player's device, the seat's own port) can be involved. See <see cref="SeatControlBlockedCode"/>.
    /// <para>
    /// The opening differs for a seat the lobby does not list yet, because what licenses "it is running" differs:
    /// for a member it is the join; outside the lobby it is only the seat's own port record, which is also what
    /// establishes that its saves were protected — the reader of this text was, until this arm existed, told the
    /// opposite about the same seat.
    /// </para>
    /// </remarks>
    internal static string ControlBlockedDetail(TimeSpan deadline, int expectedPort, bool member)
        => (member
                ? "This player's game joined the host's lobby and is serving on port "
                    + expectedPort.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + ", so it started correctly and is still running"
                : "This player's game has not joined the host's lobby yet, but it recorded that it is serving on port "
                    + expectedPort.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + ", which only CouchCoop does and only once its Steam Cloud save protection is installed — so "
                    + "CouchCoop is running inside it and your saves were protected")
            + " — but it could not report a single status to the host within "
            + ((long)deadline.TotalSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture)
            + " seconds. That report is an ordinary local request from one copy of the game to the other over "
            + "this computer's own loopback address (127.0.0.1), so nothing outside this computer is involved: "
            + "no router, no Wi-Fi and not the joining player's device. Something on this computer is stopping "
            + "one program from talking to another — a proxy setting, a VPN client, or security software. "
            // The seat falls back to a file when that request fails, and this host reads it, so reaching this
            // text means BOTH ways of being heard failed. Saying so is what keeps the remedy above honest: the
            // reader has to know the obvious workaround was already tried automatically.
            + "Couch Co-Op also looked for the status this player's game leaves in its own game folder when it "
            + "cannot report directly, and found nothing it could use either.";

    /// <summary>
    /// The detail for a seat that reached the host's lobby and then said nothing within the contact deadline.
    /// Names the slot so the reader can find that seat's log, which is the only place the reason exists.
    /// </summary>
    /// <remarks>
    /// IT NO LONGER ASSERTS THAT THE SEAT STOPPED. This text is now reached only when the host has also failed
    /// to reach that seat's port AND the seat has recorded no port of its own, which makes "it stopped" the
    /// likeliest reading but still not a measured one — a wedged listener produces the same evidence. So the
    /// cause is offered rather than stated, and the one thing that IS established (it joined, so our code ran
    /// and the saves were protected) is stated plainly. The seat that is provably still serving gets
    /// <see cref="ControlBlockedDetail"/> instead, which is what this used to be printed for as well.
    /// </remarks>
    internal static string SilentAfterJoinDetail(TimeSpan deadline, int slot)
        => "This player's game joined the host's lobby, so CouchCoop started inside it and your Steam Cloud "
            + "saves were protected, but it then reported nothing to the host within "
            + ((long)deadline.TotalSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture)
            + " seconds of being started, and this host could not reach its game view either. Everything "
            + "between joining and serving that view is setup only that player's game does — so the host's own "
            + "game is unaffected, and another installed mod failing in it is the most common reason. The "
            + "reason, if there is one, is in slot "
            + slot.ToString(System.Globalization.CultureInfo.InvariantCulture)
            + "'s own log, whose path is listed with this report.";

    /// <summary>
    /// The detail for a seat that is talking to this host and has not declared the isolation. The seat is running
    /// SOMETHING — the heartbeat is authenticated — so what this names is the one thing that matters: whatever it
    /// is running is not code that closed the cloud write paths.
    /// </summary>
    internal const string UndeclaredCloudIsolationDetail =
        "This player's game reported its status to the host without stating that CouchCoop's Steam Cloud save "
        + "protection is installed in it. A player's game shares the host account's cloud save storage, so one "
        + "that cannot state it has closed those writes is stopped rather than allowed to join.";

    /// <summary>
    /// The detail for a seat that never said anything at all within
    /// <see cref="SeatContactTimeoutEnvironmentVariable"/>'s deadline, never reached the host's lobby, AND left no
    /// port record of its own. It says the host CANNOT CONFIRM CouchCoop is running there, not that it is absent:
    /// a seat is outside the lobby until well after the game's asset preload, so a healthy seat whose reports and
    /// status file both failed ends up here too. A silent seat the lobby DOES list gets
    /// <see cref="SilentAfterJoinDetail"/>, and one that recorded its port gets <see cref="ControlBlockedDetail"/>.
    /// </summary>
    /// <remarks>
    /// HONEST ABOUT WHAT THIS IS. It SHRINKS the window; it does not close it. A seat with no CouchCoop in it
    /// runs the game's own startup cloud sync at the game's own startup time, which is inside this deadline — so
    /// stopping it here is not a guarantee that it wrote nothing, only that it stopped long before the 75-second
    /// readiness deadline would have noticed. The text says so, and points at the actual safety net,
    /// <see cref="HostProfileBackup"/>, taken before the first seat of a session is spawned. It describes what that
    /// backup does rather than claiming one was taken: the backup is best-effort and records no outcome this
    /// text could read.
    /// </remarks>
    internal static string NoSeatContactDetail(TimeSpan deadline)
        => "This player's game did not report anything to the host within "
            + ((long)deadline.TotalSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture)
            + " seconds of being started and had not joined the host's lobby, so this host cannot confirm "
            + "CouchCoop is running inside it. A game without CouchCoop in it shares this computer's Steam Cloud "
            + "save storage with the host and may already have run its own startup cloud sync, so it is stopped "
            + "instead of being given the rest of the startup deadline. Before the first player's game of a "
            + "session starts, Couch Co-Op copies the host's save profile into couch-coop/save-backups/ — look "
            + "there first if the host's progress ever looks wrong.";

    /// <summary>
    /// Whether <paramref name="code"/> is one of the catch-all native failures — the ones recorded when the seat
    /// could say only that its connection ended.
    /// </summary>
    /// <remarks>
    /// These exist to be OVERWRITTEN. The seat's transport publishes a generic drop before the game reports the
    /// reason behind it, so the generic code wins the race to the row and a plain <c>??=</c> then pins the panel
    /// to "check that game and mod versions match" — advice a player cannot act on, for a refusal that has a real
    /// remedy. A specific code arriving afterwards replaces one of these; nothing replaces a specific one.
    /// </remarks>
    private static bool IsGenericNativeFailure(string? code)
        => code is "native-join-rejected" or "native-disconnected";

    private static bool SetTerminalFailure(OwnedConnection owned, HeadlessConnectionStatus? status)
    {
        // The seat's late, specific word on a drop the host has already written down generically. Checked ahead
        // of the phase arms below because it is the one case that must be allowed to REPLACE a recorded failure.
        if (status?.ErrorCode == HeadlessDisconnectReason.RunInProgressCode
            && (owned.Failure is null || IsGenericNativeFailure(owned.Failure.Code)))
        {
            owned.Failure = new(
                HeadlessDisconnectReason.RunInProgressCode,
                "The run was already in progress, so the host refused this player's game.",
                "The host has to reload the saved run to let this player back in.",
                status.ErrorDetail ?? "The host's game refused the connection with RunInProgress.");
            return true;
        }

        // THE SEAT HAS TO SAY IT, every time, and this is where a seat that does not gets stopped. A heartbeat is
        // authenticated, so something is running in that process — but a process that does not declare the cloud
        // isolation is one whose writes reach the host account's save storage, and it is talking to us now rather
        // than in 75 seconds. Restricted to a seat that has named no cause of its own: the two guards report
        // their own terminal failures from BEFORE this declaration can be true (the build guard runs above the
        // isolation guard by design), and their named cause is the better diagnosis in both cases.
        if (status is { CloudSaveIsolated: false, ErrorCode: null }
            && (owned.Failure is null || IsGenericNativeFailure(owned.Failure.Code)))
        {
            owned.Failure = SeatCloudIsolationIssue(UndeclaredCloudIsolationDetail);
            return true;
        }

        if (status?.NativePhase.Equals("Failed", StringComparison.OrdinalIgnoreCase) == true)
            // A build mismatch is a terminal failure like any other, but it is NOT a native rejection: the seat
            // never reached the network, and "check that game and mod versions match" is the one next action a
            // player cannot act on. It has a remedy — remove one of the two installed copies of this mod — so it
            // gets its own code and says so. The detail comes from the seat and names the file it loaded.
            //
            // The port guard's refusal is mapped the same way and for the same reason: the seat could not bind
            // the port it was assigned, which is a host-side port conflict with a real remedy (restart the game
            // and free the port), not a game that refused the connection.
            owned.Failure ??= status.ErrorCode switch
            {
                HeadlessSeatBuildGuard.MismatchErrorCode =>
                    new(SeatBuildMismatchCode, "This player's game is running a different version of CouchCoop than the host.",
                        "Both copies of the mod are installed. Unsubscribe the CouchCoop item in the Steam Workshop, or redeploy the mod, so only one remains — then retry.",
                        SeatBuildMismatchDetail(status.ErrorDetail, SeatsShareTheHostProfile)),
                // The seat installed CouchCoop, ran the check, and could not close every write path. It names the
                // cause itself, so it arrives here rather than through the missing-declaration arm above, and it
                // keeps the seat's own detail — which lists the paths it could not close.
                HeadlessSeatCloudIsolationGuard.FailureErrorCode =>
                    SeatCloudIsolationIssue(
                        status.ErrorDetail
                        ?? "The client game did not report which cloud save paths it could not close."),
                HeadlessSeatPortGuard.UnavailableErrorCode =>
                    SeatReadinessVerdict.IssueFor(
                        SeatReadinessCause.PortConflict,
                        status.ErrorDetail ?? "The client game did not report which port it could not bind."),
                _ => new("native-join-rejected", "The game rejected the connection to the host.",
                    "Check that game and mod versions match, then retry. Copy this report if it continues.",
                    $"{status.ErrorCode ?? "Unknown native error"}: {status.ErrorDetail ?? "No native error detail was supplied."}"),
            };
        else if (status?.NativePhase.Equals("Disconnected", StringComparison.OrdinalIgnoreCase) == true)
            owned.Failure ??= new("native-disconnected", "The client game disconnected from the host.",
                "Reconnect this device. Copy this report if it drops again.", status.ErrorDetail ?? status.ErrorCode);
        return owned.Failure is not null;
    }

    private void QuarantineLocked(OwnedConnection owned, string reason)
    {
        lock (_lock)
        {
            if (_ownedConnections.GetValueOrDefault(owned.Slot) != owned || _processBySlot.GetValueOrDefault(owned.Slot) != owned.Process)
                return;
            owned.Quarantined = true;
            owned.QuarantineReason ??= reason;
        }
    }

    private void ClearQuarantineLocked(OwnedConnection owned)
    {
        if (_ownedConnections.GetValueOrDefault(owned.Slot) != owned || _processBySlot.GetValueOrDefault(owned.Slot) != owned.Process)
            return;
        owned.Quarantined = false;
        owned.QuarantineReason = null;
    }
}
