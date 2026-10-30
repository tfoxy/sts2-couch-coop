using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

// "Use new renderer (Beta)" turned on while the viewer's seat already runs (MIR-4; handoff-mirror-new-renderer.md §8):
// the host restarts that viewer's own seat as the streaming seat.
//
// What must hold:
//   * in the lobby the seat is stopped and launched again as the streaming seat on the SAME slot (same netId, the name
//     claim kept, the stale peer evicted), and the state the page sees goes restarting -> nothing;
//   * mid-run nothing is killed: the request is staged, applied once when the roster shows a lobby with no run, and a
//     respawn of the slot in the meantime honours it;
//   * every refusal (no capture, another seat streaming, the hub port taken, no steady seat) leaves the old process
//     running untouched and says why;
//   * a relaunch that fails, or comes up without its capture, falls back to a normal seat and reports the reason;
//   * turning the renderer off withdraws a staged request and never restarts a seat.
//
// The manager over a fake launcher, as RenderStreamPairingTests; no engine, no game.
internal static class StreamingSeatRestartTests
{
    public const string Verb = "streaming-seat-restart";

    public static async Task RunAsync()
    {
        await ALobbySeatRestartsAsTheStreamingSeatAsync();
        await MidRunTheRestartIsStagedUntilTheRunEndsAsync();
        await AStagedWishRidesTheSlotsNextLaunchAsync();
        await TurningItOffWithdrawsAStagedRestartAsync();
        await RefusalsKillNothingAsync();
        await AnAlreadyStreamingSeatIsLeftAloneAsync();
        await ACapturelessRelaunchFallsBackToANormalSeatAsync();
        await AFailedRelaunchFallsBackToANormalSeatAsync();
        await AnotherPlayerDoesNotInheritTheRequestAsync();
        TheRosterHookAppliesStagedRestartsOnALobbyWithoutARun();
    }

    private static async Task ALobbySeatRestartsAsTheStreamingSeatAsync()
    {
        var h = new Harness();
        var ann = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(ann, "Ann", default);
        var old = h.Spawned[0];

        var state = await h.Manager.RequestStreamingSeatAsync(ann, default);
        Assert(state is { State: SeatRendererStates.Restarting }, "the page is told the seat is restarting");
        Assert(old.HasExited && old.Killed, "the old seat is stopped by its own handle");
        await h.Settle();

        Assert(h.Launches is [(2, false), (2, true)], $"the same slot is launched again as the streaming seat: {Show(h.Launches)}");
        Assert(h.Manager.StreamingSlot == 2, "slot 2 now streams");
        Assert(h.Manager.NetIdForClaimedName("Ann") == HeadlessClientManager.SlotToNetId(2), "the player keeps their netId");
        Assert(h.Evicted.Contains(HeadlessClientManager.SlotToNetId(2)), "the old seat's peer is evicted for the same-netId rejoin");
        Assert(h.Manager.SeatRendererStateFor(ann) is null, "a finished restart leaves nothing to say");
        Assert(h.Changes > 0, "the server was told the state changed (it re-sends the sessions)");
        Assert(await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default) is not null && h.Launches.Count == 2,
            "the reconnecting browser re-attaches to the restarted seat without another launch");
    }

    private static async Task MidRunTheRestartIsStagedUntilTheRunEndsAsync()
    {
        var h = new Harness();
        var ann = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(ann, "Ann", default);
        h.InRun = true;

        var state = await h.Manager.RequestStreamingSeatAsync(ann, default);
        Assert(state is { State: SeatRendererStates.Pending }, "mid-run the restart is staged");
        Assert(!h.Spawned[0].HasExited && h.Launches.Count == 1, "mid-run nothing is killed and nothing launched");
        Assert(h.Manager.SeatRendererStateFor(ann) is { State: SeatRendererStates.Pending }, "the page keeps seeing it pending");
        Assert(await h.Manager.RequestStreamingSeatAsync(ann, default) is { State: SeatRendererStates.Pending } && h.Launches.Count == 1,
            "asking again mid-run changes nothing");

        h.Manager.ApplyStagedStreamingSeats();
        await h.Settle();
        Assert(h.Launches.Count == 1, "a roster read while the run still goes on does not apply it");

        h.InRun = false;
        h.Manager.ApplyStagedStreamingSeats();
        await h.Settle();
        Assert(h.Spawned[0].HasExited && h.Launches is [(2, false), (2, true)], $"the run ended: restarted once: {Show(h.Launches)}");
        h.Manager.ApplyStagedStreamingSeats();
        await h.Settle();
        Assert(h.Launches.Count == 2 && h.Manager.StreamingSlot == 2, "and only once");
    }

    private static async Task AStagedWishRidesTheSlotsNextLaunchAsync()
    {
        var h = new Harness();
        var ann = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(ann, "Ann", default);
        h.InRun = true;
        await h.Manager.RequestStreamingSeatAsync(ann, default);

        // The run ends and the host's quit disconnects the seat: it exits by itself. Its browser comes back in the next
        // lobby without asking (a page that cannot draw the stream asks for nothing in its join).
        h.Spawned[0].ForceExit();
        h.InRun = false;
        h.Manager.ApplyStagedStreamingSeats();
        await h.Settle();
        Assert(h.Launches.Count == 1, "no restart of a seat that is gone");
        var back = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(back, "Ann", default);
        Assert(h.Launches is [(2, false), (2, true)] && h.Manager.StreamingSlot == 2, "its next launch is the streaming seat");
        Assert(h.Manager.SeatRendererStateFor(back) is null, "the staged request is settled by that launch");
    }

    private static async Task TurningItOffWithdrawsAStagedRestartAsync()
    {
        var h = new Harness();
        var ann = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(ann, "Ann", default);
        h.InRun = true;
        await h.Manager.RequestStreamingSeatAsync(ann, default);
        Assert(h.Manager.CancelStreamingSeatRequest(ann) is null, "off withdraws the staged request");
        Assert(h.Manager.SeatRendererStateFor(ann) is null, "nothing pending any more");
        h.InRun = false;
        h.Manager.ApplyStagedStreamingSeats();
        await h.Settle();
        Assert(h.Launches.Count == 1 && !h.Spawned[0].HasExited, "the run ends and nothing restarts");

        // A streaming seat turned off is not restarted either: it serves the old renderer too.
        var g = new Harness();
        var bob = Guid.NewGuid();
        await g.Manager.EnsureHeadlessAsync(bob, "Bob", default, wantsStreamingSeat: true);
        Assert(g.Manager.CancelStreamingSeatRequest(bob) is null && g.Launches.Count == 1 && !g.Spawned[0].HasExited,
            "turning it off never restarts the streaming seat");
    }

    private static async Task RefusalsKillNothingAsync()
    {
        var unconfigured = new Harness(configured: false);
        var ann = Guid.NewGuid();
        await unconfigured.Manager.EnsureHeadlessAsync(ann, "Ann", default);
        var noCapture = await unconfigured.Manager.RequestStreamingSeatAsync(ann, default);
        Assert(noCapture is { State: SeatRendererStates.Refused, Reason: SeatRendererStates.NoCapture },
            "a host with no capture refuses with a reason");
        Assert(!unconfigured.Spawned[0].HasExited && unconfigured.Launches.Count == 1, "and kills nothing");

        var taken = new Harness();
        await taken.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Bob", default, wantsStreamingSeat: true);
        var cat = Guid.NewGuid();
        await taken.Manager.EnsureHeadlessAsync(cat, "Cat", default);
        var other = await taken.Manager.RequestStreamingSeatAsync(cat, default);
        Assert(other is { State: SeatRendererStates.Refused, Reason: SeatRendererStates.AnotherSeatStreaming },
            "another player's seat streams: refused, the role is not taken over");
        Assert(taken.Spawned.All(p => !p.HasExited) && taken.Launches.Count == 2 && taken.Manager.StreamingSlot == 2,
            "both seats run on untouched");
        Assert(taken.Manager.SeatRendererStateFor(cat) is { Reason: SeatRendererStates.AnotherSeatStreaming },
            "the refusal stays on the page's session");

        var port = new Harness(hubPortOwner: "another program");
        var dan = Guid.NewGuid();
        await port.Manager.EnsureHeadlessAsync(dan, "Dan", default);
        var busy = await port.Manager.RequestStreamingSeatAsync(dan, default);
        Assert(busy is { State: SeatRendererStates.Refused, Reason: SeatRendererStates.HubPortTaken }
               && busy.Detail!.Contains("another program", StringComparison.Ordinal), "a taken hub port refuses, naming its owner");
        Assert(!port.Spawned[0].HasExited && port.Launches.Count == 1, "and kills nothing");

        var dead = new Harness();
        var eve = Guid.NewGuid();
        await dead.Manager.EnsureHeadlessAsync(eve, "Eve", default);
        dead.Spawned[0].ForceExit();
        Assert(await dead.Manager.RequestStreamingSeatAsync(eve, default) is { State: SeatRendererStates.Refused, Reason: SeatRendererStates.SeatBusy },
            "a seat that is not running steadily is not restarted");
        Assert(dead.Launches.Count == 1, "and nothing is launched for it");

        Assert(await dead.Manager.RequestStreamingSeatAsync(Guid.NewGuid(), default) is null,
            "a session that holds no seat (the host's own view) asks for nothing");
    }

    private static async Task AnAlreadyStreamingSeatIsLeftAloneAsync()
    {
        var h = new Harness();
        var ann = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(ann, "Ann", default, wantsStreamingSeat: true);
        Assert(await h.Manager.RequestStreamingSeatAsync(ann, default) is null && h.Launches.Count == 1 && !h.Spawned[0].HasExited,
            "the seat already streams: nothing to do");
    }

    private static async Task ACapturelessRelaunchFallsBackToANormalSeatAsync()
    {
        var h = new Harness(hubListens: false);
        var ann = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(ann, "Ann", default);
        await h.Manager.RequestStreamingSeatAsync(ann, default);
        await h.Settle();
        Assert(h.Launches is [(2, false), (2, true), (2, false)], $"no hub: relaunched as a normal seat: {Show(h.Launches)}");
        Assert(h.Spawned[1].HasExited && !h.Spawned[2].HasExited, "the capture-less streaming process is stopped, the normal one runs");
        Assert(h.Manager.StreamingSlot is null, "no seat streams");
        Assert(h.Manager.SeatRendererStateFor(ann) is { State: SeatRendererStates.Failed, Reason: SeatRendererStates.CaptureNotStarted },
            "the page is told why");
        Assert(h.Manager.NetIdForClaimedName("Ann") == HeadlessClientManager.SlotToNetId(2), "on the same netId");
    }

    private static async Task AFailedRelaunchFallsBackToANormalSeatAsync()
    {
        var h = new Harness();
        var ann = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(ann, "Ann", default);
        h.FailStreamingLaunch = true;
        await h.Manager.RequestStreamingSeatAsync(ann, default);
        await h.Settle();
        Assert(h.Launches is [(2, false), (2, true), (2, false)], $"the streaming launch failed: a normal one follows: {Show(h.Launches)}");
        Assert(h.Spawned.Count == 2 && !h.Spawned[1].HasExited, "the player is back on a normal seat");
        Assert(h.Manager.SeatRendererStateFor(ann) is { State: SeatRendererStates.Failed, Reason: SeatRendererStates.LaunchFailed },
            "and the page says the restart failed");
        Assert(h.Manager.NetIdForClaimedName("Ann") == HeadlessClientManager.SlotToNetId(2), "on the same netId");
    }

    private static async Task AnotherPlayerDoesNotInheritTheRequestAsync()
    {
        var h = new Harness(maxSeats: 1);
        var ann = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(ann, "Ann", default);
        h.InRun = true;
        await h.Manager.RequestStreamingSeatAsync(ann, default);
        h.InRun = false;
        h.Spawned[0].ForceExit();
        // Ann is gone and the only seat is reclaimed by a new player.
        var zed = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(zed, "Zed", default);
        Assert(h.Launches is [(2, false), (2, false)], $"the new player's seat is a normal one: {Show(h.Launches)}");
        Assert(h.Manager.SeatRendererStateFor(zed) is null, "and carries no earlier request");
    }

    private static void TheRosterHookAppliesStagedRestartsOnALobbyWithoutARun()
    {
        var applied = 0;
        var reaction = new CouchCoopRosterReaction(null, () => { }, null, _ => { }, () => applied++);
        reaction.Apply(CouchCoopRosterObserverTests.InRun());
        Assert(applied == 0, "not during a run");
        reaction.Apply(CouchCoopRosterObserverTests.Menu());
        Assert(applied == 0, "not on the main menu (no lobby to launch into)");
        var lobby = new RosterFacts(RosterRootScenes.Run, new RosterLobby("host", "p:1", true,
            [new RosterLobbySeat("p:1", "Host", "IRONCLAD", true)], ["p:1", "p:1002"]), null);
        reaction.Apply(lobby);
        Assert(applied == 1, "on a lobby with no run (the load-saved-run lobby)");
    }

    private static string Show(IEnumerable<(int Slot, bool Streaming)> launches)
        => string.Join(' ', launches.Select(l => $"({l.Slot},{(l.Streaming ? "stream" : "normal")})"));

    private sealed class Harness
    {
        public readonly List<(int Slot, bool Streaming)> Launches = [];
        public readonly List<FakeProcess> Spawned = [];
        public readonly List<ulong> Evicted = [];
        public readonly HeadlessClientManager Manager;
        public volatile bool InRun;
        public bool FailStreamingLaunch;
        public int Changes;

        public Harness(bool configured = true, string? hubPortOwner = null, bool hubListens = true, int? maxSeats = null)
        {
            HeadlessClientManager? manager = null;
            Manager = manager = new HeadlessClientManager(
                launcher: slot =>
                {
                    var streaming = manager!.IsStreamingLaunch(slot);
                    Launches.Add((slot, streaming));
                    if (streaming && FailStreamingLaunch) return null;
                    var process = new FakeProcess(slot, Spawned.Count);
                    Spawned.Add(process);
                    return process;
                },
                readinessProbe: (_, _) => Task.FromResult(true),
                evictStalePeer: Evicted.Add,
                maxSeatsProbe: maxSeats is null ? null : () => maxSeats,
                seatPortProbe: (port, _) => Task.FromResult(
                    port == StreamingSeatLaunch.HubPortForSlot(2) ? hubPortOwner : null),
                runInProgressProbe: () => InRun,
                streamingConfig: configured
                    ? new StreamingSeatLaunch.Config("/opt/capture/render_stream_capture.gdextension", "/opt/capture/calibration.json")
                    : null,
                streamingHubProbe: (_, _) => Task.FromResult(hubListens));
            Manager.SeatRendererChanged += () => Interlocked.Increment(ref Changes);
        }

        // The relaunch (and any fallback) runs off the request; the staged restarts start on the thread pool.
        public async Task Settle()
        {
            for (var i = 0; i < 30; i++)
            {
                if (Manager.StreamingRestartTask is { } task) await task.ConfigureAwait(false);
                await Task.Delay(10).ConfigureAwait(false);
            }
        }
    }

    private sealed class FakeProcess(int slot, int index) : IHeadlessProcess
    {
        private volatile bool _exited;
        public bool Killed { get; private set; }
        public int Id => 30000 + slot * 10 + index;
        public bool HasExited => _exited;
        public int ExitCode => 0;
        public void ForceExit() => _exited = true;
        public bool RequestGracefulStop() { _exited = true; return true; }
        public void Kill() { Killed = true; _exited = true; }
        public void Dispose() { }
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition) throw new Exception($"[StreamingSeatRestartTests] FAILED: {label}");
    }
}
