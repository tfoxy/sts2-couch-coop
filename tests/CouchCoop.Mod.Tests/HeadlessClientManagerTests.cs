using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using System.Diagnostics;

// Unit checks for HeadlessClientManager's slot bookkeeping: allocation, same-name reuse (the dedup that
// stops a reconnect duplicating a lobby player), Release teardown (immediate SIGKILL — the game ignores
// SIGTERM — returning the freed netId so the host can evict the now-dead ENet peer, or null on a no-op /
// reuse-transfer), and reaping of orphaned/dead headless processes whose Release never ran. A fake
// IHeadlessProcess + instant readiness probe keep these pure (no real game process, no HTTP server).
internal static class HeadlessClientManagerTests
{
    public static async Task RunAsync()
    {
        await AllocatesDistinctSlotsAndPorts();
        await SameNameReusesSlotWithoutSpawning();
        await SameNameReuseIsTrimAndCaseInsensitive();
        await ReleaseHardKillsFreesSlotAndReturnsFreedNetId();
        await ReleaseReturnsNullWhenNoSession();
        await ReuseTransfersOwnershipSoOldReleaseIsNoOp();
        await DeadOrphanIsReapedAndNameFreedOnNextEnsure();
        await SlotsAreCappedAtThree();
        await DisposeHardKillsAllLiveProcesses();
        await MarkDetachedKeepsProcessAliveUntilReap();
        await DetachedSlotIsReusedLiveOnReconnect();
        await SlotBindingIsReportedBeforeTheLauncherRuns();
        await ReconnectReportsSlotBindingOnBothReuseBranches();
        await NameClaimSurvivesReleaseAndIsDroppedByReap();
        NetIdToSlotOnlyMapsRealSeats();
        NetIdToSlotFollowsTheLobbyCap();
        await RaisingTheLobbyCapOpensMoreSeats();
        await NetIdBoundJoinTakesTheSeatsSlotNotTheAllocatorsChoice();
        await NetIdBoundJoinReportsTheBindingAndReusesALiveInstance();
        await NetIdBoundJoinIsRefusedForANonSeatNetId();
        await NetIdBoundJoinOnAnUnclaimedSeatObeysAllowNewSlot();
        await DescribeSeatsReportsClaimsAndLiveness();
        await ReapSeatKillsTheInstanceAndDropsTheClaim();
        await DescribeSeatsDoesNotHoldTheLockAcrossTheSeatCapProbe();
        await EnsureHeadlessDoesNotHoldTheLockAcrossTheSeatCapProbe();
        await NetIdBoundEnsureDoesNotHoldTheLockAcrossTheSeatCapProbe();
        WindowsBridgeEndpointUsesNamedPipe();
        UnixBridgeEndpointUsesSocket();
        SeatLaunchIsCommandLineFree();
        SeatWithoutIsolationIsGivenItsOwnLogFile();
        OnlySeatsScopeTheBrowserPortFile();
        SeatBuildMismatchExplainsAnUnisolatedHost();
        HostWatchdogIdentityRule();
        SeatEnvironmentCarriesTheJoinContract();
        SeatIsToldTheSteamHostsNetId();
        SeatMemoryTuningIsSeparateFromTheJoinContract();
        SeatMemoryTuningFillsOnlyUnsetKeys();

        // What survives the retired host connectivity log: this suite used to assert the ORDERED sentences a
        // host read on the lobby panel for every seat lifecycle step. The panel and the ring are gone, so the
        // sentences are not a contract any more — but one of those tests was reading a REAL behaviour through
        // them, and it keeps its own observable.
        await ARespawnAfterADeadHandleLaunchesAFreshProcess();
    }

    // A controllable fake process. RequestGracefulStop optionally "exits" the process (simulating a clean
    // SIGTERM-driven shutdown) so the manager doesn't escalate to a hard Kill.
    private sealed class FakeProcess : IHeadlessProcess
    {
        private readonly bool _gracefulStopExits;

        public FakeProcess(int slot, bool gracefulStopExits)
        {
            Slot = slot;
            _gracefulStopExits = gracefulStopExits;
        }

        public int Slot { get; }
        public bool Exited { get; private set; }
        public bool GracefulStopRequested { get; private set; }
        public bool HardKilled { get; private set; }
        public bool Disposed { get; private set; }

        public int Id => 10000 + Slot;
        public bool HasExited => Exited;
        public int ExitCode => 0;

        public void ForceExit() => Exited = true; // simulate an external crash / kill

        public bool RequestGracefulStop()
        {
            GracefulStopRequested = true;
            if (!_gracefulStopExits) return false; // e.g. non-Unix: no graceful signal
            Exited = true;
            return true;
        }

        public void Kill() { HardKilled = true; Exited = true; }
        public void Dispose() => Disposed = true;
    }

    private sealed class Harness
    {
        public readonly List<FakeProcess> Spawned = [];
        // Ordered trace of manager side effects ("bind:<netId>:<name>", "launch:<slot>"), so a test can assert that
        // the name→netId binding is reported BEFORE the headless process is launched — the ordering the host
        // nameplate fix depends on.
        public readonly List<string> Events = [];
        public bool GracefulStopExits = true;
        public readonly HeadlessClientManager Manager;
        // The seat capacity the manager probes, standing in for the live lobby's player cap minus the host seat.
        // Mutable so a test can raise it the way a multiplayer limit mod does mid-session. NULLABLE because the
        // real probe reports null when there is no lobby to ask, which is a different answer from any number.
        public int? MaxSeats = 3;

        public Harness(int? maxSeats = 3)
        {
            // The host connectivity log is a process-global ring, so every harness starts from empty. (A
            // test that builds TWO harnesses therefore clears the first one's narration — none of the
            // narration tests below do that.)
            MaxSeats = maxSeats;
            Manager = new HeadlessClientManager(
                launcher: slot =>
                {
                    Events.Add($"launch:{slot}");
                    var p = new FakeProcess(slot, GracefulStopExits);
                    Spawned.Add(p);
                    return p;
                },
                // Instant "ready" so EnsureHeadlessAsync returns the port without a real HTTP poll.
                readinessProbe: (_, _) => Task.FromResult(true),
                maxSeatsProbe: () => MaxSeats);
        }

        // Records the slot-bound callback into the same ordered trace as the launcher.
        public Action<ulong, string?> RecordBinding
            => (netId, name) => Events.Add($"bind:{netId}:{name}");
    }

    private static async Task AllocatesDistinctSlotsAndPorts()
    {
        var h = new Harness();
        var p1 = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        var p2 = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Bob", default);
        Assert(p1 == HeadlessClientManager.SlotToPort(2), "first join takes slot 2's port");
        Assert(p2 == HeadlessClientManager.SlotToPort(3), "second distinct join takes slot 3's port");
        Assert(h.Spawned.Count == 2, "two distinct names spawn two processes");
    }

    private static async Task SameNameReusesSlotWithoutSpawning()
    {
        var h = new Harness();
        var first = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        var second = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        Assert(first == second, "same-name rejoin reuses the same port");
        Assert(h.Spawned.Count == 1, "same-name rejoin does NOT spawn a second process (no duplicate lobby player)");
    }

    private static async Task SameNameReuseIsTrimAndCaseInsensitive()
    {
        var h = new Harness();
        var first = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        var second = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "  aNN ", default);
        Assert(first == second, "name dedup ignores case and surrounding whitespace");
        Assert(h.Spawned.Count == 1, "case/whitespace variant of a name reuses the slot");
    }

    private static async Task ReleaseHardKillsFreesSlotAndReturnsFreedNetId()
    {
        var h = new Harness();
        var session = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(session, "Ann", default);
        var proc = h.Spawned[0];

        var freed = h.Manager.Release(session);
        // The game ignores SIGTERM, so Release SIGKILLs immediately (no graceful grace) and returns the freed
        // netId so the caller can evict that now-dead peer from the host's ENet server.
        Assert(freed == HeadlessClientManager.SlotToNetId(2), "Release returns the freed netId when it kills the slot's process");
        Assert(proc.HardKilled, "Release hard-kills immediately (SIGTERM is ignored by the game, so no graceful wait)");
        Assert(!proc.GracefulStopRequested, "Release no longer attempts a graceful stop");
        Assert(proc.Disposed, "the process handle is disposed after teardown");

        // Slot 2 KEEPS Ann's name claim (netId 1002 reserved for her mid-run reconnect), so a DIFFERENT name
        // does NOT steal it while another slot is free — it takes slot 3 instead.
        var caraPort = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Cara", default);
        Assert(caraPort == HeadlessClientManager.SlotToPort(3), "a different name takes a free slot, not the reserved one");

        // Ann's reconnect re-spawns on the SAME slot 2 (same netId 1002) so the host's run-in-progress rejoin
        // accepts her, and a fresh process is launched (the old one was hard-killed on Release).
        var spawnedBefore = h.Spawned.Count;
        var annPort = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        Assert(annPort == HeadlessClientManager.SlotToPort(2), "the same name reconnects to its reserved slot (same netId)");
        Assert(h.Spawned.Count == spawnedBefore + 1, "the reconnect re-spawns a fresh headless on the reserved slot");
    }

    private static async Task ReleaseReturnsNullWhenNoSession()
    {
        var h = new Harness();
        // No headless was ever spawned for this session → nothing to kill, no netId freed.
        var freed = h.Manager.Release(Guid.NewGuid());
        Assert(freed is null, "Release returns null (no eviction) when the session has no headless instance");
        Assert(h.Spawned.Count == 0, "a Release with no matching session spawns/kills nothing");
    }

    private static async Task ReuseTransfersOwnershipSoOldReleaseIsNoOp()
    {
        var h = new Harness();
        var oldSession = Guid.NewGuid();
        var newSession = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(oldSession, "Ann", default);
        await h.Manager.EnsureHeadlessAsync(newSession, "Ann", default); // reconnect transfers slot ownership
        var proc = h.Spawned[0];

        // The OLD session's socket closes after the reconnect already took over — must NOT kill the live process.
        var staleFreed = h.Manager.Release(oldSession);
        Assert(staleFreed is null, "the reuse-transfer (stale old-session) Release returns null — no peer to evict");
        Assert(!proc.GracefulStopRequested && !proc.HardKilled && !proc.Exited,
            "stale old-session Release is a no-op once a same-name reconnect owns the slot");

        // The active session still owns it; releasing it does tear down and frees the netId.
        var freed = h.Manager.Release(newSession);
        Assert(freed == HeadlessClientManager.SlotToNetId(2), "the active session's Release returns the freed netId");
        Assert(proc.Exited, "the active session's Release tears the process down");
    }

    private static async Task DeadOrphanIsReapedAndNameFreedOnNextEnsure()
    {
        var h = new Harness();
        var session = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(session, "Ann", default);
        var dead = h.Spawned[0];
        dead.ForceExit(); // headless crashed / was killed externally; Release never ran (orphaned)

        // A same-name rejoin must NOT reuse the dead instance: it is reaped and a fresh process spawned.
        var port = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        Assert(h.Spawned.Count == 2, "a same-name rejoin after the headless died spawns a fresh process (no stale reuse)");
        Assert(dead.Disposed, "the dead orphan's handle is reaped/disposed");
        Assert(port == HeadlessClientManager.SlotToPort(2), "reaping frees slot 2 for the fresh instance");
    }

    private static async Task SlotsAreCappedAtThree()
    {
        var h = new Harness();
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "A", default);
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "B", default);
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "C", default);
        var overflow = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "D", default);
        Assert(overflow is null, "a fourth distinct join is rejected (only slots 2-4 exist)");
        Assert(h.Spawned.Count == 3, "no process is spawned when all slots are occupied");
    }

    private static async Task DisposeHardKillsAllLiveProcesses()
    {
        var h = new Harness();
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "A", default);
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "B", default);
        h.Manager.Dispose();
        Assert(h.Spawned.TrueForAll(p => p.Exited && p.Disposed), "Dispose tears down every live headless");
        // After dispose, no further allocation.
        var after = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "C", default);
        Assert(after is null, "a disposed manager allocates nothing");
    }

    // Mid-run disconnect: MarkDetached keeps the headless ALIVE (so the browser can reconnect to the live run);
    // it's only killed when the run ends, via ReapDetachedSlots (which returns the freed netId for eviction).
    private static async Task MarkDetachedKeepsProcessAliveUntilReap()
    {
        var h = new Harness();
        var session = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(session, "Ann", default);
        var proc = h.Spawned[0];

        h.Manager.MarkDetached(session);
        Assert(!proc.Exited && !proc.HardKilled, "MarkDetached keeps the headless alive (not killed) mid-run");

        var freed = h.Manager.ReapDetachedSlots();
        Assert(freed.Count == 1 && freed[0] == HeadlessClientManager.SlotToNetId(2),
            "ReapDetachedSlots returns the freed netId for the kept-alive slot");
        Assert(proc.HardKilled && proc.Disposed, "ReapDetachedSlots kills + disposes the detached headless on run-end");

        // Reaping dropped the name claim → the slot is free for a brand-new player.
        var reused = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Cara", default);
        Assert(reused == HeadlessClientManager.SlotToPort(2), "the reaped slot is free for the next player");
    }

    // A browser that reconnects (same name) BEFORE the run ends re-claims the SAME live headless — no respawn,
    // and it's no longer detached, so a later reap won't touch it.
    private static async Task DetachedSlotIsReusedLiveOnReconnect()
    {
        var h = new Harness();
        var first = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(first, "Ann", default);
        var proc = h.Spawned[0];
        h.Manager.MarkDetached(first);

        // Reconnect: same name, new session → reuse the LIVE process (no new spawn).
        var port = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        Assert(port == HeadlessClientManager.SlotToPort(2), "reconnect re-claims the same live slot");
        Assert(h.Spawned.Count == 1, "reconnect to a kept-alive headless does NOT spawn a new process");

        // It's re-attached → a run-end reap must NOT kill it.
        var freed = h.Manager.ReapDetachedSlots();
        Assert(freed.Count == 0 && !proc.Exited, "a reconnected (re-attached) headless is not reaped on run-end");
    }

    // THE point of the slot-bound callback: the caller learns this player's netId → display name BEFORE the
    // headless process is launched, so it can register the SetClientName override while the instance is still
    // loading. The host writes NRemoteLobbyPlayer's label once, from PlatformUtil.GetPlayerNameRaw, the moment the
    // headless completes its ENet handshake; a name registered only after the readiness wait (20-60s) always lost
    // that race and the widget kept the mp_names.json fallback — a name from a PREVIOUS host session.
    private static async Task SlotBindingIsReportedBeforeTheLauncherRuns()
    {
        var h = new Harness();
        var port = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, onSlotBound: h.RecordBinding);

        Assert(port == HeadlessClientManager.SlotToPort(2), "the join is served on slot 2's port");
        Assert(h.Events.Count == 2, "a new join reports exactly one binding and one launch");
        Assert(h.Events[0] == $"bind:{HeadlessClientManager.SlotToNetId(2)}:Ann",
            "the binding is reported with the slot's netId and the trimmed display name");
        Assert(h.Events[1] == "launch:2", "the binding is reported BEFORE the headless process is launched");
    }

    // Both branches that BIND a slot must report it: the reconnect that re-spawns on a claimed-but-dead slot, and
    // the reuse of a still-live instance (a returning browser whose netId may have lost its name override).
    private static async Task ReconnectReportsSlotBindingOnBothReuseBranches()
    {
        var h = new Harness();
        var session = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(session, "Ann", default, onSlotBound: h.RecordBinding);
        var netId = HeadlessClientManager.SlotToNetId(2);

        // Live instance, new session (second tab / immediate reconnect) → reuse, no spawn, but still reported.
        h.Events.Clear();
        var reusedPort = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, onSlotBound: h.RecordBinding);
        Assert(reusedPort == HeadlessClientManager.SlotToPort(2), "the live instance is reused on the same port");
        Assert(h.Events.Count == 1 && h.Events[0] == $"bind:{netId}:Ann",
            "reusing a live instance reports the binding and launches nothing");

        // Now the headless dies and the same name returns → respawn on the SAME slot/netId, reported first.
        h.Spawned[^1].ForceExit();
        h.Events.Clear();
        var respawnPort = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, onSlotBound: h.RecordBinding);
        Assert(respawnPort == HeadlessClientManager.SlotToPort(2), "the reconnect respawns on the reserved slot");
        Assert(h.Events.Count == 2 && h.Events[0] == $"bind:{netId}:Ann" && h.Events[1] == "launch:2",
            "the reconnect respawn reports the binding before re-launching");
    }

    // Gate for the disconnect-side ClearClientName rule: the name override may only be dropped once NOTHING claims
    // the netId. Release keeps the claim (the netId stays reserved for a reconnect), so clearing there would fall
    // the nameplate back to the stale mp_names.json snapshot; only a run-end reap genuinely frees the seat.
    private static async Task NameClaimSurvivesReleaseAndIsDroppedByReap()
    {
        var h = new Harness();
        var session = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(session, "Ann", default);
        var netId = HeadlessClientManager.SlotToNetId(2);
        Assert(h.Manager.HasClaimForNetId(netId), "a joined player claims their netId");
        Assert(!h.Manager.HasClaimForNetId(HeadlessClientManager.SlotToNetId(3)), "an unused slot's netId is unclaimed");

        h.Manager.Release(session);
        Assert(h.Manager.HasClaimForNetId(netId), "a lobby disconnect KEEPS the claim (netId reserved for reconnect)");

        // Mid-run detach also keeps it; only the run-end reap drops the claim.
        var second = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(second, "Ann", default);
        h.Manager.MarkDetached(second);
        Assert(h.Manager.HasClaimForNetId(netId), "a mid-run detach KEEPS the claim (process stays alive too)");

        h.Manager.ReapDetachedSlots();
        Assert(!h.Manager.HasClaimForNetId(netId), "the run-end reap drops the claim — the seat is genuinely gone");
    }

    // ---- netId-BOUND spawn (the rejoin path) -------------------------------------------------------------------
    //
    // The game gates a rejoin on netId: the load-run lobby disconnects any client whose netId is not in the loaded
    // save, and a running RunLobby rejects any peer not already in the run. A headless spawned on a NAME-chosen slot
    // therefore almost never carries the seat's netId and is bounced on arrival, however the picker labelled it.
    // These pin that the seat — not the allocator, and not the name — decides the slot.

    private static void NetIdToSlotOnlyMapsRealSeats()
    {
        var stock = new Harness().Manager;
        Assert(stock.TryNetIdToSlot(1002, out var slot2) && slot2 == 2, "1002 → slot 2");
        Assert(stock.TryNetIdToSlot(1004, out var slot4) && slot4 == 4, "1004 → slot 4");
        // Everything outside the manager's own slot range is refused rather than clamped: spawning a clamped
        // instance would impersonate somebody else's peer.
        Assert(!stock.TryNetIdToSlot(1001, out _), "1001 is below the first slot");
        Assert(!stock.TryNetIdToSlot(1005, out _), "1005 is past the stock lobby's last slot");
        Assert(!stock.TryNetIdToSlot(1, out _), "the HOST's netId is not a slot");
        Assert(!stock.TryNetIdToSlot(1000, out _), "a genuine remote player's netId is not a slot");
    }

    // The slot range is NOT a constant — it follows the live lobby's player cap, which the multiplayer limit mods
    // raise. A seat netId that is out of range under the stock four-player lobby must become a real seat once the
    // lobby says there is room for it, and the guard band must still be the outer wall.
    private static void NetIdToSlotFollowsTheLobbyCap()
    {
        var raised = new Harness(maxSeats: 15).Manager;
        Assert(raised.TryNetIdToSlot(1005, out var slot5) && slot5 == 5, "1005 is a seat once the lobby holds 16");
        Assert(raised.TryNetIdToSlot(1016, out var slot16) && slot16 == 16, "1016 → slot 16 (the last of 15 seats)");
        Assert(!raised.TryNetIdToSlot(1017, out _), "1017 is past the raised cap");
        Assert(HeadlessClientManager.SlotToPort(5) == 13387, "slot 5 serves its browser on 13387");

        // A cap wider than the couch-seat netId reservation (MirrorSeatNetIds 1001..1099) is clamped to it: past
        // 1099 a "seat" would be indistinguishable from a genuine remote player to every picker.
        var absurd = new Harness(maxSeats: 5000).Manager;
        Assert(absurd.TryNetIdToSlot(1099, out var slot99) && slot99 == 99, "1099 is the last seat in the guard band");
        Assert(!absurd.TryNetIdToSlot(1100, out _), "1100 is outside the guard band whatever the lobby claims");

        // A probe that reports NO cap is not the same as no probe at all. It means there IS a host but no lobby
        // to ask right now — mid-run, or on the main menu — and mid-run is exactly when the netId-BOUND respawn
        // path runs. Substituting the stock three there refused a rejoin by seat 1005 of an eight-player run as
        // "not a seat", so an unknown cap leaves the guard band as the only limit, which is the only one that is
        // really ours. (Nothing here widens the NEW-peer window: MayLaunchNewHeadless still shuts it whenever
        // there is no lobby.)
        var unknown = new Harness(maxSeats: null).Manager;
        Assert(unknown.TryNetIdToSlot(1005, out var unknown5) && unknown5 == 5,
            "1005 is still a seat while the lobby cap is unknown");
        Assert(unknown.TryNetIdToSlot(1099, out var unknown99) && unknown99 == 99,
            "…all the way to the last netId in the guard band");
        Assert(!unknown.TryNetIdToSlot(1100, out _), "…and never past it");
    }

    // A lobby that grows mid-session (Limit Break writes its raised cap from its own join/connect hooks, well
    // after the host mod is built) must be picked up, not cached from whatever was true at construction.
    private static async Task RaisingTheLobbyCapOpensMoreSeats()
    {
        var h = new Harness(maxSeats: 3);
        Assert(await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default) is not null, "seat 1 of 3");
        Assert(await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Bea", default) is not null, "seat 2 of 3");
        Assert(await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Cal", default) is not null, "seat 3 of 3");
        Assert(
            await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Dee", default) is null,
            "a fourth player is refused while the lobby only holds four");

        h.MaxSeats = 15;
        Assert(
            await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Dee", default) == HeadlessClientManager.SlotToPort(5),
            "the same player gets slot 5 once the lobby cap is raised");
    }

    private static async Task NetIdBoundJoinTakesTheSeatsSlotNotTheAllocatorsChoice()
    {
        var h = new Harness();
        // The name-based allocator would hand out slot 2 (the first free one). The seat says 1004 → slot 4.
        var port = await h.Manager.EnsureHeadlessAsync(
            Guid.NewGuid(), "Bea", default, onSlotBound: h.RecordBinding, targetNetId: 1004);
        Assert(port == HeadlessClientManager.SlotToPort(4), "the seat's netId picks slot 4, not the free slot 2");
        Assert(h.Manager.HasClaimForNetId(1004), "the rejoining name claims the seat it landed on");
        Assert(!h.Manager.HasClaimForNetId(1002), "…and nothing is claimed on the slot the allocator would have used");
    }

    private static async Task NetIdBoundJoinReportsTheBindingAndReusesALiveInstance()
    {
        var h = new Harness();
        var port = await h.Manager.EnsureHeadlessAsync(
            Guid.NewGuid(), "Bea", default, onSlotBound: h.RecordBinding, targetNetId: 1003);
        Assert(port == HeadlessClientManager.SlotToPort(3), "the netId-bound join is served on slot 3's port");
        // WS-2's ordering contract holds on this path too: the display name is registered for the netId BEFORE the
        // process launches, so it beats the host building that peer's nameplate.
        Assert(h.Events.Count == 2 && h.Events[0] == "bind:1003:Bea" && h.Events[1] == "launch:3",
            "the binding is reported before the launcher runs");

        // A second device picking the SAME seat shares the live instance instead of respawning it.
        var reused = await h.Manager.EnsureHeadlessAsync(
            Guid.NewGuid(), "Bea", default, onSlotBound: h.RecordBinding, targetNetId: 1003);
        Assert(reused == HeadlessClientManager.SlotToPort(3), "a live instance on the seat is reused");
        Assert(h.Spawned.Count == 1, "…and no second process is launched");
    }

    private static async Task NetIdBoundJoinIsRefusedForANonSeatNetId()
    {
        var h = new Harness();
        var host = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Hosty", default, targetNetId: 1);
        Assert(host is null, "the host's own netId is never spawned into");
        var remote = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Remote", default, targetNetId: 1000);
        Assert(remote is null, "a genuine remote player's netId is never spawned into");
        Assert(h.Spawned.Count == 0, "no process is launched for either");
    }

    private static async Task NetIdBoundJoinOnAnUnclaimedSeatObeysAllowNewSlot()
    {
        // allowNewSlot is the caller's spawn window. An UNCLAIMED seat is a fresh instance and respects it; the
        // caller widens the window itself for a netId that already has a seat in the run/save
        // (CouchCoopLobbyParticipation.MirrorJoinContext.MayRejoinNetId).
        var closed = new Harness();
        var refused = await closed.Manager.EnsureHeadlessAsync(
            Guid.NewGuid(), "Bea", default, allowNewSlot: false, targetNetId: 1003);
        Assert(refused is null, "an unclaimed seat is not spawned outside the window");
        Assert(closed.Spawned.Count == 0, "…and nothing is launched");

        // An ALREADY-CLAIMED seat whose process died is a reconnect, which is always allowed — the same rule the
        // name-reuse branch has always followed.
        var h = new Harness();
        var first = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(first, "Bea", default, targetNetId: 1003);
        h.Manager.Release(first); // keeps the claim, kills the process
        var respawn = await h.Manager.EnsureHeadlessAsync(
            Guid.NewGuid(), "Bea", default, allowNewSlot: false, targetNetId: 1003);
        Assert(respawn == HeadlessClientManager.SlotToPort(3), "a claimed seat respawns even with the window shut");
    }

    private static async Task DescribeSeatsReportsClaimsAndLiveness()
    {
        var h = new Harness();
        var seats = h.Manager.DescribeSeats();
        Assert(seats.Count == 3, "every slot is described, used or not — an unused seat is still joinable");
        Assert(seats[0].NetId == 1002 && seats[2].NetId == 1004, "seats are described in slot order");
        Assert(seats.All(seat => seat.ClaimedName is null && !seat.ProcessLive), "a fresh manager owns nothing");

        var session = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(session, "Ann", default);
        var live = h.Manager.DescribeSeats().First(seat => seat.NetId == 1002);
        Assert(live.ProcessLive && live.ClaimedName == "Ann", "a joined seat reports its live process and claim");

        // An EXITED process is not a live instance, even while the manager still holds the handle (an orphaned or
        // crashed headless whose Release never ran) — otherwise the seat would look like a zombie forever.
        h.Spawned[0].ForceExit();
        var dead = h.Manager.DescribeSeats().First(seat => seat.NetId == 1002);
        Assert(!dead.ProcessLive, "an exited process does not count as live");
        Assert(dead.ClaimedName == "Ann", "…but the reconnect claim survives it");
    }

    private static async Task ReapSeatKillsTheInstanceAndDropsTheClaim()
    {
        var h = new Harness();
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        Assert(h.Manager.ReapSeat(1002), "reaping a live seat reports that it killed something");
        Assert(h.Spawned[0].HardKilled, "the zombie is SIGKILLed (the game ignores SIGTERM)");
        // Unlike Release — which reserves the netId for a reconnect — the reap leaves NOTHING behind, so the next
        // netId-bound spawn on this seat starts clean instead of being short-circuited into sharing the zombie.
        Assert(!h.Manager.HasClaimForNetId(1002), "the reap drops the seat's name claim");
        Assert(!h.Manager.DescribeSeats().First(seat => seat.NetId == 1002).ProcessLive, "the seat reports no instance");

        Assert(!h.Manager.ReapSeat(1002), "reaping again is a no-op");
        Assert(!h.Manager.ReapSeat(1), "a netId outside the seat range is a no-op");

        var fresh = await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, targetNetId: 1002);
        Assert(fresh == HeadlessClientManager.SlotToPort(2), "a netId-bound spawn re-takes the reaped seat");
        Assert(h.Spawned.Count == 2, "…with a genuinely new process");
    }

    // ---- seat-cap probe vs the manager lock --------------------------------------------------------------------
    //
    // The max-seats probe is CouchCoopLobbyParticipation.MaxCouchSeats: a state pull that BLOCKS on a marshal to
    // the game's main thread. The main thread itself takes this manager's lock (DescribeSeats via the screen-change
    // session resend, Dispose at shutdown), so any entry point that evaluates the probe while holding the lock is
    // an ABBA deadlock that freezes the whole game — which is exactly what happened on room loads with a mirror
    // viewer connected (the scene-watcher thread held the lock waiting for the main thread, while the main thread's
    // own resend waited for the lock). These pin the cure: while the probe is BLOCKED mid-call, another thread must
    // still be able to enter the manager, i.e. the probe runs before the lock, never under it.

    private static HeadlessClientManager BlockingProbeManager(ManualResetEventSlim probeEntered, ManualResetEventSlim release)
        => new(
            launcher: slot => new FakeProcess(slot, gracefulStopExits: true),
            readinessProbe: (_, _) => Task.FromResult(true),
            maxSeatsProbe: () =>
            {
                probeEntered.Set();
                release.Wait(TimeSpan.FromSeconds(10));
                return 3;
            });

    // Asserts that `entry` reaches the seat-cap probe WITHOUT holding the manager's lock: while the probe is
    // parked, a lock-taking call (HasNameClaim) from another thread must complete promptly.
    private static async Task AssertLockFreeWhileProbeBlocked(
        Func<HeadlessClientManager, Task> entry, string label)
    {
        using var probeEntered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var manager = BlockingProbeManager(probeEntered, release);

        var call = Task.Run(() => entry(manager));
        Assert(probeEntered.Wait(TimeSpan.FromSeconds(10)), $"{label}: the call reaches the seat-cap probe");

        var lockUser = Task.Run(() => manager.HasNameClaim("ann"));
        Assert(await Task.WhenAny(lockUser, Task.Delay(TimeSpan.FromSeconds(2))) == lockUser,
            $"{label}: the manager lock is free while the seat-cap probe runs (held = the room-load freeze)");

        release.Set();
        await call;
    }

    private static Task DescribeSeatsDoesNotHoldTheLockAcrossTheSeatCapProbe()
        => AssertLockFreeWhileProbeBlocked(
            m => Task.Run(() => Assert(m.DescribeSeats().Count == 3, "describe completes once the probe returns")),
            "DescribeSeats");

    private static Task EnsureHeadlessDoesNotHoldTheLockAcrossTheSeatCapProbe()
        => AssertLockFreeWhileProbeBlocked(
            async m => Assert(
                await m.EnsureHeadlessAsync(Guid.NewGuid(), "Bea", default) == HeadlessClientManager.SlotToPort(2),
                "the plain-name join completes once the probe returns"),
            "EnsureHeadlessAsync (name-allocated)");

    private static Task NetIdBoundEnsureDoesNotHoldTheLockAcrossTheSeatCapProbe()
        => AssertLockFreeWhileProbeBlocked(
            async m => Assert(
                await m.EnsureHeadlessAsync(Guid.NewGuid(), "Bea", default, targetNetId: 1003)
                    == HeadlessClientManager.SlotToPort(3),
                "the netId-bound join completes once the probe returns"),
            "EnsureHeadlessAsync (netId-bound)");

    // WS-1: a seat is launched with NO game CLI args — everything travels in the environment. The launch contract
    // is what makes a normally-hosted (non -fastmp) session possible, so it is asserted explicitly.
    private static void SeatLaunchIsCommandLineFree()
    {
        Assert(HeadlessClientManager.SeatGameArguments(null) == "--headless",
            "a seat is launched with --headless ONLY: no -fastmp (which would mark the session as the local-"
            + "multiplayer test path) and no --clientId (argv is unreliable in the embedded host)");
        Assert(HeadlessClientManager.SeatGameArguments("   ") == "--headless",
            "a blank log path adds nothing — the argument list stays what it was");
    }

    // A seat launched with no user-dir isolation is handed its OWN log file, because Godot truncates the log it
    // opens on every process start: without this, each macOS seat spawn erased the host's live godot.log, which
    // is why the bug report that started this work arrived with no log attached.
    private static void SeatWithoutIsolationIsGivenItsOwnLogFile()
    {
        var path = HeadlessClientManager.SeatLogPath(
            Path.Combine("/home", "p", ".local", "share", "SlayTheSpire2", "logs", "godot.log"), 3);
        Assert(path == Path.Combine("/home", "p", ".local", "share", "SlayTheSpire2", "couch-coop", "seat-logs", "slot-3.log"),
            "the seat's log lands under the mod's own couch-coop/ folder in the user dir it shares, named by slot");
        Assert(HeadlessClientManager.SeatLogPath(
                Path.Combine("/home", "p", ".local", "share", "SlayTheSpire2", "logs", "godot.log"), 2)
            != path, "two slots never resolve to one file");

        Assert(HeadlessClientManager.SeatGameArguments(path) == $"--headless --log-file \"{path}\"",
            "--log-file follows --headless and is quoted");

        // The macOS user dir contains a space (~/Library/Application Support/…). An unquoted path would split
        // into two arguments and the seat would refuse to start.
        var spaced = Path.Combine("/Users", "p", "Library", "Application Support", "SlayTheSpire2", "couch-coop", "seat-logs", "slot-2.log");
        Assert(HeadlessClientManager.SeatGameArguments(spaced).EndsWith($"\"{spaced}\"", StringComparison.Ordinal),
            "a path with a space stays one argument");

        // A path that cannot be quoted loses the flag rather than producing a command line that mis-splits:
        // a seat with no log file is what shipped; a seat that does not launch is not.
        Assert(HeadlessClientManager.SeatGameArguments("/tmp/we\"ird/godot.log") == "--headless",
            "a path containing a double quote is refused, not escaped");

        // A host that never resolved its own log path cannot derive one for a seat, and must not guess.
        Assert(HeadlessClientManager.SeatLogPath(null, 2) is null, "no host log path ⇒ no seat log path");
        Assert(HeadlessClientManager.SeatLogPath("   ", 2) is null, "a blank host log path ⇒ no seat log path");
        Assert(HeadlessClientManager.SeatLogPath("godot.log", 2) is null,
            "a host log path with no directory above it ⇒ no seat log path");
    }

    // The seat's browser-port record. With an isolated user dir it is already per-instance; without one, every
    // process on the machine resolves the same path, so the seats — never the host — are the ones scoped.
    private static void OnlySeatsScopeTheBrowserPortFile()
    {
        Assert(BrowserPortFile.FileNameFor(null) == "browser-port",
            "a HOST keeps the name scripts/lib/instance-port.mjs and the bring-up scripts read");
        Assert(BrowserPortFile.FileNameFor("") == "browser-port" && BrowserPortFile.FileNameFor("  ") == "browser-port",
            "an absent or blank slot is a host, not a seat");
        Assert(BrowserPortFile.FileNameFor("2") == "browser-port-slot-2"
            && BrowserPortFile.FileNameFor(" 3 ") == "browser-port-slot-3",
            "a seat scopes the record by its slot");
        Assert(BrowserPortFile.FileNameFor("2") != BrowserPortFile.FileNameFor("3"),
            "two seats never share one record");
        Assert(BrowserPortFile.FileNameFor("nonsense") == "browser-port"
            && BrowserPortFile.FileNameFor("0") == "browser-port"
            && BrowserPortFile.FileNameFor("-1") == "browser-port",
            "an unparseable or non-positive slot falls back to the host name rather than inventing one");
    }

    // A host that could not isolate its seats cannot pin which copy of the mod they load either, so the build
    // mismatch it can produce says why. Every other host reports exactly what it reported before.
    private static void SeatBuildMismatchExplainsAnUnisolatedHost()
    {
        const string reported = "Host CouchCoop build: 1.0.0+abc. This player's game loaded CouchCoop build: 0.9.0, from: /x.";
        Assert(HeadlessClientManager.SeatBuildMismatchDetail(reported, seatsShareTheHostProfile: false) == reported,
            "an isolating host's detail is untouched");
        Assert(HeadlessClientManager.SeatBuildMismatchDetail(null, seatsShareTheHostProfile: false)
            == "The client game did not report which build it loaded.",
            "a seat that said nothing still gets the existing sentence");

        var shared = HeadlessClientManager.SeatBuildMismatchDetail(reported, seatsShareTheHostProfile: true);
        Assert(shared.StartsWith(reported, StringComparison.Ordinal),
            "the seat's own report stays first — it is the line that names the file");
        Assert(shared.Contains("per-player game profile", StringComparison.Ordinal)
            && shared.Contains("picks one per process", StringComparison.Ordinal),
            "…followed by why a host with no per-seat profile can hit this at all");
    }

    private static void SeatEnvironmentCarriesTheJoinContract()
    {
        var env = HeadlessClientManager.SeatLaunchEnvironment(
            slot: 3, port: 13367, netId: 1003, hostNetId: 1, hostPid: 4242, hostModBuild: "1.0.0+abc123");

        Assert(env["COUCHCOOP_HEADLESS_CLIENT"] == "1", "the seat identifies itself as a headless couch client");
        Assert(env["COUCHCOOP_HEADLESS_SLOT"] == "3", "the seat carries its slot");
        Assert(env["COUCHCOOP_PREFERRED_PORT"] == "13367", "the seat carries its browser-server port");
        Assert(env["COUCHCOOP_HOST_PID"] == "4242", "the seat carries the host pid for its crash-proof self-reaper");
        // These three replace the old command line.
        Assert(env["COUCHCOOP_CLIENT_ID"] == "1003",
            "the seat's netId travels as COUCHCOOP_CLIENT_ID (re-materialized as --clientId inside the seat)");
        Assert(env["COUCHCOOP_HOST_NETID"] == "1", "the seat is told the host's netId");
        Assert(env["COUCHCOOP_JOIN_HOST"] == "127.0.0.1:33771",
            "the seat is told its join target explicitly (the game's own FastMpJoin hardcodes this address)");
        // A dev machine can have two copies of this mod installed and the game picks between them per
        // process, so the seat is told which build the host is and refuses to be a different one.
        Assert(env["COUCHCOOP_HOST_MOD_BUILD"] == "1.0.0+abc123",
            "the seat carries the host's own CouchCoop build for HeadlessSeatBuildGuard to compare against");
    }

    private static void SeatIsToldTheSteamHostsNetId()
    {
        // On a Steam-hosted session the host answers to its SteamID64, NOT 1. A seat that isn't told would echo
        // every heartbeat to netId 1 and NetClientGameService.SendMessage would throw ~5x a second.
        const ulong steamId = 76561198000000123UL;
        var env = HeadlessClientManager.SeatLaunchEnvironment(
            slot: 2, port: 13357, netId: 1002, hostNetId: steamId, hostPid: 7, hostModBuild: "1.0.0+abc123");
        Assert(env["COUCHCOOP_HOST_NETID"] == "76561198000000123",
            "a Steam-hosted session hands the seat the host's real (SteamID64) netId");
        Assert(env["COUCHCOOP_CLIENT_ID"] == "1002", "…while the seat keeps its own couch netId");
    }

    // The allocator/GC settings are TUNING, not contract, and the two must not bleed into each other: a seat
    // launched without the tuning still joins and plays, and a profiling run overrides any of it by exporting
    // its own value (LaunchReal only fills a key the launching environment left empty). Asserting the split
    // keeps a future edit from parking a join-critical variable in the overridable bucket.
    private static void SeatMemoryTuningIsSeparateFromTheJoinContract()
    {
        var tuning = HeadlessClientManager.SeatMemoryTuningEnvironment();

        Assert(tuning["MALLOC_ARENA_MAX"] == "2",
            "seats cap glibc thread arenas (a measured seat spread 283MB over 42 arenas, 62MB of it free slack)");
        Assert(tuning["DOTNET_GCConserveMemory"] == "5",
            "seats ask the CLR GC to favour a tighter heap over collection throughput");

        var contract = HeadlessClientManager.SeatLaunchEnvironment(
            slot: 3, port: 13367, netId: 1003, hostNetId: 1, hostPid: 4242, hostModBuild: "1.0.0+abc123");
        foreach (var key in tuning.Keys)
        {
            Assert(!contract.ContainsKey(key),
                $"{key} is tuning and must stay out of the join contract (the contract is applied unconditionally, "
                + "the tuning only where the launching environment is silent)");
        }
    }

    // Regression: the fill rule must run against a REAL ProcessStartInfo, not a Dictionary stand-in.
    // ProcessStartInfo.EnvironmentVariables is typed as StringDictionary (whose indexer returns null for an
    // absent key) but is actually a StringDictionaryWrapper forwarding to a Dictionary<string, string> — whose
    // indexer THROWS KeyNotFoundException. A read-and-test "don't clobber" check therefore threw out of
    // LaunchReal for the ordinary case where the variable is unset, killing seat spawning entirely; the browser
    // saw `invalid-action-message: The given key 'MALLOC_ARENA_MAX' was not present in the dictionary`.
    // A mock dictionary would have passed. This asserts against the real type on purpose.
    private static void SeatMemoryTuningFillsOnlyUnsetKeys()
    {
        var tuning = HeadlessClientManager.SeatMemoryTuningEnvironment();
        var (firstKey, firstDefault) = (tuning.Keys.First(), tuning.Values.First());

        // 1. Every key absent — the case that used to throw.
        var fresh = new ProcessStartInfo();
        foreach (var key in tuning.Keys)
        {
            fresh.EnvironmentVariables.Remove(key);
        }

        HeadlessClientManager.ApplyMemoryTuning(fresh);
        foreach (var (key, value) in tuning)
        {
            Assert(fresh.EnvironmentVariables[key] == value,
                $"an unset {key} is filled with the seat default (and reading it must not throw)");
        }

        // 2. An inherited value wins — that export is how the tuning is A/B'd.
        var inherited = new ProcessStartInfo();
        inherited.EnvironmentVariables[firstKey] = "99";
        HeadlessClientManager.ApplyMemoryTuning(inherited);
        Assert(inherited.EnvironmentVariables[firstKey] == "99",
            $"an inherited {firstKey} is never overwritten by the seat default ({firstDefault})");
    }

    // The seat's crash-proof self-reaper, on the platform with no /proc: it decides whether the HOST is still
    // alive, and the only mistake it can make — calling a live host gone — SIGKILLs a healthy seat. Both probes
    // are injected so every branch is reachable without a second process to kill.
    private static void HostWatchdogIdentityRule()
    {
        const string armed = "638600000000000000";

        Assert(!HeadlessHostWatchdog.HostAliveByIdentity(armed, () => false, () => armed),
            "no process with that pid → the host is gone");
        Assert(HeadlessHostWatchdog.HostAliveByIdentity(armed, () => true, () => armed),
            "the same pid with the same start time → the same host, still running");
        Assert(!HeadlessHostWatchdog.HostAliveByIdentity(armed, () => true, () => "638699999999999999"),
            "the pid was RECYCLED onto another process → the host is gone, which is the whole point of pinning it");

        // Two "can't tell" cases, both resolved toward NOT killing: a watchdog that guesses wrong here takes
        // down a seat whose host is fine, and the next poll is two seconds away.
        Assert(HeadlessHostWatchdog.HostAliveByIdentity(armed, () => true, () => null),
            "an unreadable start time on a live pid is not evidence of a dead host");
        Assert(HeadlessHostWatchdog.HostAliveByIdentity(null, () => true, () => "anything"),
            "no identity pinned at arm → fall back to bare existence");
        Assert(!HeadlessHostWatchdog.HostAliveByIdentity(null, () => false, () => "anything"),
            "…but bare existence still decides when the pid is gone");

        var identityReads = 0;
        Assert(!HeadlessHostWatchdog.HostAliveByIdentity(armed, () => false, () => { identityReads++; return armed; }),
            "a dead pid short-circuits");
        Assert(identityReads == 0, "the identity probe is not run for a pid that does not exist");
    }

    private static void WindowsBridgeEndpointUsesNamedPipe()
    {
        var env = HeadlessClientManager.SpirectlBridgeEndpointEnvironment(2, isWindows: true);
        Assert(env.TryGetValue("SPIRECTL_BRIDGE_PIPE_NAME", out var pipe) && pipe == "spirectl-bridge-slot-2",
            "windows headless bridge uses a per-slot named pipe");
        Assert(env.TryGetValue("SPIRECTL_BRIDGE_SOCKET_PATH", out var socket) && socket is null,
            "windows headless bridge clears the Unix socket endpoint");
        Assert(env.TryGetValue("SPIRECTL_BRIDGE_TCP_ADDRESS", out var tcp) && tcp is null,
            "windows headless bridge clears the TCP endpoint");
    }

    private static void UnixBridgeEndpointUsesSocket()
    {
        var env = HeadlessClientManager.SpirectlBridgeEndpointEnvironment(3, isWindows: false);
        Assert(env.TryGetValue("SPIRECTL_BRIDGE_SOCKET_PATH", out var socket) && socket == "/tmp/spirectl-bridge-slot-3.sock",
            "unix headless bridge uses a per-slot Unix socket");
        Assert(env.TryGetValue("SPIRECTL_BRIDGE_PIPE_NAME", out var pipe) && pipe is null,
            "unix headless bridge clears the named pipe endpoint");
        Assert(env.TryGetValue("SPIRECTL_BRIDGE_TCP_ADDRESS", out var tcp) && tcp is null,
            "unix headless bridge clears the TCP endpoint");
    }

    // ---- host connectivity log: the seat channel ---------------------------------------------------------






    private static async Task ARespawnAfterADeadHandleLaunchesAFreshProcess()
    {
        // The reconnect path must not hand back a dead instance. This used to be read through the narration
        // ("…is no longer running." then a plain relaunch, never a "reconnected" line); with the log gone the
        // observable is the launcher itself — a SECOND process, not a reuse of the exited one.
        var h = new Harness();
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        Assert(h.Spawned.Count == 1, "the first join launches one instance");
        h.Spawned[0].ForceExit();

        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        Assert(h.Spawned.Count == 2, "a join whose instance has exited launches a fresh one rather than reusing the dead handle");
        Assert(!h.Spawned[1].HasExited, "…and the replacement is live");
    }





    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"HeadlessClientManagerTests failed: {label}.");
        }
    }
}
