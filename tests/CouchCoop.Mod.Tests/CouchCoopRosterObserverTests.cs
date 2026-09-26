using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

// The roster observer (WP3 path 2): what turns the game's signals into one roster read, and what the server does with it.
//
// What must hold, and where it is pinned:
//   * NOTHING happens until a viewer needs it: constructing an observer attaches no signal and reads nothing, and a signal
//     with no listener is a null check;
//   * PUSH ONLY: a signal arms one read on the next frame, a burst of signals before that frame is still one read, a signal
//     that lands during a read arms the next one, and there is no timer, no retry and no backstop read;
//   * a read that fails is delivered as unavailable and is retried by the next signal only;
//   * disposing detaches every signal, and a read already scheduled does nothing;
//   * the reaction: a changed roster republishes names and re-sends sessions once, an unchanged one does nothing, and
//     detached seats are reaped only once the game has left BOTH the run and any lobby.
//
// Every game-facing piece is a seam here (the signals, the read, the next-frame deferral), so none of it needs an engine.
internal static class CouchCoopRosterObserverTests
{
    public static void Run()
    {
        NothingHappensBeforeStart();
        StartAttachesOnceAndArmsTheBaselineRead();
        ABurstOfSignalsIsOneRead();
        ASignalDuringTheReadArmsTheNextOne();
        AFailedReadIsDeliveredAsUnavailableAndOnlyTheNextSignalRetries();
        AThrowingReadIsDeliveredAsUnavailable();
        DisposeDetachesAndScheduledReadsDoNothing();
        ASchedulingFailureDoesNotSilenceLaterSignals();
        LiveCountIsBalanced();
        SignalsWithoutListenersCostNothing();
        SignalListenersAreBalancedAndSwallowFailures();
        ProductionSubscriptionIsReadOnSignalsAndReleasedOnDispose();
        ReactionRepublishesAndResendsOncePerChange();
        ReactionResendsWhenRosterDetailsChange();
        ReactionResetMakesTheNextRosterAChange();
        ReactionReapsOnlyAfterTheRunAndLobbyEnd();
        ReactionSurvivesAFailingNamePublish();
        Console.WriteLine("CouchCoopRosterObserverTests: ok");
    }

    // ---- doubles ---------------------------------------------------------------------------------------------

    /// <summary>The game's signals, as one wake the test can pull, and a record of attach and detach.</summary>
    private sealed class FakeSignals
    {
        private Action? _wake;
        public int Attached { get; private set; }
        public int Detached { get; private set; }
        public bool Live => _wake is not null;

        public IDisposable? Attach(Action wake)
        {
            Attached++;
            _wake = wake;
            return new Detach(this);
        }

        /// <summary>The game raises a signal (from any thread, including inside a game callback).</summary>
        public void Raise() => _wake?.Invoke();

        private sealed class Detach(FakeSignals owner) : IDisposable
        {
            public void Dispose()
            {
                owner.Detached++;
                owner._wake = null;
            }
        }
    }

    /// <summary>The game's next frame: work is queued by the deferral seam and runs when the test says a frame passed.</summary>
    private sealed class FakeFrames
    {
        private readonly Queue<Action> _queue = new();
        public int Scheduled { get; private set; }
        public int Pending => _queue.Count;

        public void Schedule(Action work)
        {
            Scheduled++;
            _queue.Enqueue(work);
        }

        public void RunFrame()
        {
            var batch = _queue.ToArray();
            _queue.Clear();
            foreach (var work in batch)
            {
                work();
            }
        }
    }

    private sealed class Rig
    {
        public readonly FakeSignals Signals = new();
        public readonly FakeFrames Frames = new();
        public readonly List<RosterFacts?> Delivered = [];
        public Func<RosterFacts?> Read = () => Roster(1);
        public int Reads;
        public readonly CouchCoopRosterObserver Observer;

        public Rig(Action<Action>? schedule = null)
        {
            Observer = new CouchCoopRosterObserver(
                Signals.Attach,
                () =>
                {
                    Reads++;
                    return Read();
                },
                schedule ?? Frames.Schedule,
                Delivered.Add);
        }
    }

    internal static RosterFacts Roster(int seats)
        => new(
            RosterRootScenes.CharacterSelect,
            new RosterLobby(
                NetTypeNames.Host,
                "p:1",
                false,
                [.. Enumerable.Range(0, seats).Select(i => new RosterLobbySeat($"p:{1 + i}", $"P{i}", "IRONCLAD", true))],
                []),
            null);

    /// <summary>
    /// The roster observer as the browser server sees it: a subscription it can start and stop, and a roster the test
    /// pushes in the way the game's signals would produce one. Counts subscribes and disposes, so "the observer exists
    /// only while a viewer is parked on the picker" is observable.
    /// </summary>
    internal sealed class FakeRosterFeed
    {
        private readonly object _gate = new();
        private readonly List<Action<RosterFacts?>> _handlers = [];
        private int _subscribes;
        private int _disposes;

        public int Subscribes => Volatile.Read(ref _subscribes);
        public int Disposes => Volatile.Read(ref _disposes);

        /// <summary>Whether the server holds a live subscription right now.</summary>
        public bool Active => Subscribes > Disposes;

        public IDisposable? Subscribe(Action<RosterFacts?> onRoster)
        {
            lock (_gate) _handlers.Add(onRoster);
            Interlocked.Increment(ref _subscribes);
            return new Release(this);
        }

        /// <summary>Deliver a roster to the newest subscription, as its read would.</summary>
        public void Push(RosterFacts? roster)
        {
            Action<RosterFacts?> handler;
            lock (_gate) handler = _handlers[^1];
            handler(roster);
        }

        /// <summary>Deliver a roster to an EARLIER subscription: a read that was still in flight when its observer stopped.</summary>
        public void PushToSubscription(int index, RosterFacts? roster)
        {
            Action<RosterFacts?> handler;
            lock (_gate) handler = _handlers[index];
            handler(roster);
        }

        private sealed class Release(FakeRosterFeed owner) : IDisposable
        {
            private int _released;

            public void Dispose()
            {
                if (Interlocked.Exchange(ref _released, 1) == 0)
                {
                    Interlocked.Increment(ref owner._disposes);
                }
            }
        }
    }

    // ---- the observer --------------------------------------------------------------------------------------

    private static void NothingHappensBeforeStart()
    {
        var rig = new Rig();
        Expect(rig.Signals.Attached == 0 && rig.Frames.Scheduled == 0 && rig.Reads == 0,
            "a constructed observer attaches no signal, schedules nothing and reads nothing");
        rig.Observer.Wake();
        Expect(rig.Frames.Scheduled == 1, "a wake is what arms a read");
        rig.Observer.Dispose();
        Expect(rig.Signals.Attached == 0, "disposing an observer that never started attaches nothing");
    }

    private static void StartAttachesOnceAndArmsTheBaselineRead()
    {
        var rig = new Rig();
        rig.Observer.Start();
        rig.Observer.Start();
        Expect(rig.Signals.Attached == 1, "starting twice attaches the signals once");
        Expect(rig.Frames.Pending == 1 && rig.Reads == 0, "the baseline read is armed, and waits for the next frame");
        rig.Frames.RunFrame();
        Expect(rig.Reads == 1 && rig.Delivered.Count == 1 && rig.Delivered[0] == Roster(1),
            "the baseline read is delivered on the frame, unchanged");
        rig.Frames.RunFrame();
        Expect(rig.Reads == 1 && rig.Frames.Pending == 0, "and nothing recurs: no timer, no second read");
        rig.Observer.Dispose();
    }

    // A burst of signals inside one frame (a peer connecting raises the peer event, the lobby callback and the name
    // change together) is ONE read, one frame later.
    private static void ABurstOfSignalsIsOneRead()
    {
        var rig = new Rig();
        rig.Observer.Start();
        rig.Frames.RunFrame();
        rig.Reads = 0;
        rig.Delivered.Clear();

        for (var i = 0; i < 25; i++)
        {
            rig.Signals.Raise();
        }

        Expect(rig.Frames.Scheduled == 2 && rig.Frames.Pending == 1, "25 signals before the frame arm exactly one read");
        Expect(rig.Reads == 0, "and no read happens inside the signal");
        rig.Frames.RunFrame();
        Expect(rig.Reads == 1 && rig.Delivered.Count == 1, "the burst costs one read");
        rig.Observer.Dispose();
    }

    private static void ASignalDuringTheReadArmsTheNextOne()
    {
        var rig = new Rig();
        rig.Observer.Start();
        rig.Frames.RunFrame();
        rig.Reads = 0;
        rig.Delivered.Clear();

        var seats = 1;
        rig.Read = () =>
        {
            // A change lands while the read is running.
            if (seats == 1)
            {
                seats = 2;
                rig.Signals.Raise();
            }

            return Roster(seats);
        };
        rig.Signals.Raise();
        rig.Frames.RunFrame();
        Expect(rig.Reads == 1 && rig.Frames.Pending == 1, "a signal during the read is not lost: it arms the next read");
        rig.Frames.RunFrame();
        Expect(rig.Reads == 2 && rig.Delivered.Last() == Roster(2), "the next frame reads the change");
        rig.Observer.Dispose();
    }

    // "Unavailable" is not "nobody is here": it is delivered as null so the consumer does nothing (reaps nothing), and
    // nothing retries it. Only the next signal reads again.
    private static void AFailedReadIsDeliveredAsUnavailableAndOnlyTheNextSignalRetries()
    {
        var rig = new Rig { Read = () => null };
        rig.Observer.Start();
        rig.Frames.RunFrame();
        Expect(rig.Delivered.Count == 1 && rig.Delivered[0] is null, "a failed read is delivered as null");
        Expect(rig.Frames.Pending == 0, "and nothing schedules a retry");
        rig.Frames.RunFrame();
        rig.Frames.RunFrame();
        Expect(rig.Reads == 1, "any number of frames later, still one read: there is no backstop");
        rig.Read = () => Roster(2);
        rig.Signals.Raise();
        rig.Frames.RunFrame();
        Expect(rig.Reads == 2 && rig.Delivered.Last() == Roster(2), "the next signal is what tries again");
        rig.Observer.Dispose();
    }

    private static void AThrowingReadIsDeliveredAsUnavailable()
    {
        var rig = new Rig { Read = () => throw new InvalidOperationException("the game moved") };
        rig.Observer.Start();
        rig.Frames.RunFrame();
        Expect(rig.Delivered.Count == 1 && rig.Delivered[0] is null, "a throwing read is unavailable, never an exception in the frame");
        rig.Observer.Dispose();
    }

    private static void DisposeDetachesAndScheduledReadsDoNothing()
    {
        var rig = new Rig();
        rig.Observer.Start();
        rig.Signals.Raise();
        rig.Observer.Dispose();
        Expect(rig.Signals.Detached == 1 && !rig.Signals.Live, "dispose detaches every signal");
        rig.Frames.RunFrame();
        Expect(rig.Reads == 0 && rig.Delivered.Count == 0, "a read scheduled before dispose finds the observer stopped and does nothing");
        rig.Observer.Wake();
        rig.Signals.Raise();
        Expect(rig.Frames.Pending == 0, "a late signal after dispose schedules nothing");
        rig.Observer.Dispose();
        Expect(rig.Signals.Detached == 1, "dispose is idempotent");
    }

    private static void ASchedulingFailureDoesNotSilenceLaterSignals()
    {
        var fail = true;
        var frames = new FakeFrames();
        var rig = new Rig(work =>
        {
            if (fail) throw new InvalidOperationException("no frame");
            frames.Schedule(work);
        });
        rig.Observer.Start(); // the baseline cannot be scheduled
        Expect(frames.Scheduled == 0, "the failed deferral scheduled nothing");
        fail = false;
        rig.Signals.Raise();
        Expect(frames.Pending == 1, "a later signal arms a read: the failed one did not leave the observer marked as pending");
        rig.Observer.Dispose();
    }

    private static void LiveCountIsBalanced()
    {
        var before = CouchCoopRosterObserver.LiveCount;
        var a = new Rig();
        var b = new Rig();
        Expect(CouchCoopRosterObserver.LiveCount == before, "constructing observers is not living");
        a.Observer.Start();
        b.Observer.Start();
        Expect(CouchCoopRosterObserver.LiveCount == before + 2, "each started observer is counted");
        a.Observer.Dispose();
        a.Observer.Dispose();
        Expect(CouchCoopRosterObserver.LiveCount == before + 1, "disposing twice releases once");
        b.Observer.Dispose();
        Expect(CouchCoopRosterObserver.LiveCount == before, "the count returns to where it was");
    }

    // ---- the signal hub --------------------------------------------------------------------------------------

    private static void SignalsWithoutListenersCostNothing()
    {
        Expect(CouchCoopRosterSignals.ListenerCount == 0, "nothing listens with no viewer served");
        var timers = System.Threading.Timer.ActiveCount;
        for (var i = 0; i < 1000; i++)
        {
            CouchCoopRosterSignals.NoteNameChanged();
        }

        // A raise with no listener is a null check: there is nobody to schedule a read, so nothing can have been queued.
        Expect(System.Threading.Timer.ActiveCount <= timers, "a thousand signals with no listener create no timer");
        Expect(CouchCoopRosterObserver.LiveCount == 0 && CouchCoopRosterSignals.ListenerCount == 0,
            "and leave no observer and no listener behind");
        var woken = 0;
        using (CouchCoopRosterSignals.Listen(() => woken++))
        {
            Expect(woken == 0, "a signal raised before anyone listened is not queued for a later listener");
        }
    }

    private static void SignalListenersAreBalancedAndSwallowFailures()
    {
        var woken = 0;
        using (CouchCoopRosterSignals.Listen(() => woken++))
        using (CouchCoopRosterSignals.Listen(() => throw new InvalidOperationException("a listener failed")))
        {
            Expect(CouchCoopRosterSignals.ListenerCount == 2, "each listener is counted");
            CouchCoopRosterSignals.NoteNameChanged(); // must not throw into the caller (a game callback may be the caller)
            Expect(woken == 1, "a failing listener does not stop the raise (the first still ran)");
        }

        Expect(CouchCoopRosterSignals.ListenerCount == 0, "disposing releases every listener");
        CouchCoopRosterSignals.NoteNameChanged();
        Expect(woken == 1, "a released listener is not woken");
    }

    // The production wiring, over the seams a test process has: the front's fake facts, the screen event's fake source
    // and the thread pool as the "next frame" (no engine). It shows the whole path: subscribe attaches the screen event and
    // the hook listener, the baseline and each signal make one read through the front, and dispose leaves nothing behind.
    private static void ProductionSubscriptionIsReadOnSignalsAndReleasedOnDispose()
    {
        var facts = new CouchCoopGameFactsTests.FakeFacts { RosterRead = () => Roster(1) };
        var screens = new FakeScreens();
        var previousScreens = GameScreenContext.Source;
        var delivered = new System.Collections.Concurrent.ConcurrentQueue<RosterFacts?>();
        CouchCoopGameFactsTests.WithSource(facts, () =>
        {
            GameScreenContext.Source = screens;
            try
            {
                var liveBefore = CouchCoopRosterObserver.LiveCount;
                using (var subscription = CouchCoopRosterObserver.Subscribe(delivered.Enqueue))
                {
                    Expect(CouchCoopRosterObserver.LiveCount == liveBefore + 1, "subscribing starts one observer");
                    Expect(screens.Live == 1, "the screen event is attached");
                    Expect(CouchCoopRosterSignals.ListenerCount == 1, "and so is the hook listener");
                    Expect(SpinWait.SpinUntil(() => delivered.Count == 1, TimeSpan.FromSeconds(5)), "the baseline read is delivered");
                    Expect(facts.RosterReads == 1, "one read for the baseline");

                    screens.Fire();
                    Expect(SpinWait.SpinUntil(() => delivered.Count == 2, TimeSpan.FromSeconds(5)), "a screen change is delivered");
                    CouchCoopRosterSignals.NoteNameChanged();
                    Expect(SpinWait.SpinUntil(() => delivered.Count == 3, TimeSpan.FromSeconds(5)), "a name change is delivered");
                    Expect(facts.RosterReads == 3, "each signal cost one read");
                    Expect(delivered.All(roster => roster == Roster(1)), "each delivery is the roster the front read");
                }

                Expect(CouchCoopRosterObserver.LiveCount == liveBefore, "disposing stops the observer");
                Expect(screens.Live == 0 && CouchCoopRosterSignals.ListenerCount == 0, "and detaches every signal");
                var reads = facts.RosterReads;
                screens.Fire();
                CouchCoopRosterSignals.NoteNameChanged();
                Thread.Sleep(100);
                Expect(facts.RosterReads == reads, "a signal after dispose reads nothing");
            }
            finally
            {
                GameScreenContext.Source = previousScreens;
            }
        });
    }

    private sealed class FakeScreens : IGameScreenSource
    {
        private readonly object _gate = new();
        private readonly List<Action> _handlers = [];

        public int Live { get { lock (_gate) return _handlers.Count; } }

        public IDisposable? SubscribeUpdated(Action handler)
        {
            lock (_gate) _handlers.Add(handler);
            return new Release(() => { lock (_gate) _handlers.Remove(handler); });
        }

        public object? Current => null;
        public bool IsCurrent(object? node) => false;

        public void Fire()
        {
            Action[] handlers;
            lock (_gate) handlers = [.. _handlers];
            foreach (var handler in handlers) handler();
        }

        private sealed class Release(Action release) : IDisposable
        {
            private Action? _release = release;
            public void Dispose() => Interlocked.Exchange(ref _release, null)?.Invoke();
        }
    }

    // ---- the reaction ----------------------------------------------------------------------------------------

    private sealed class ReactionRig
    {
        public int Published;
        public int Resent;
        public int Reaped;
        public IReadOnlyList<(ulong NetId, string Name)>? LastNames;
        public bool PublishThrows;
        public readonly List<string> Log = [];
        public readonly CouchCoopRosterReaction Reaction;

        public ReactionRig(bool canPublish = true, bool canReap = true)
        {
            Reaction = new CouchCoopRosterReaction(
                canPublish
                    ? names =>
                    {
                        Published++;
                        LastNames = names;
                        if (PublishThrows) throw new IOException("disk full");
                    }
                    : null,
                () => Resent++,
                canReap ? () => Reaped++ : null,
                Log.Add);
        }
    }

    internal static RosterFacts Menu() => new(RosterRootScenes.MainMenu, null, null);

    internal static RosterFacts InRun(bool connected = true)
        => new(
            RosterRootScenes.Run,
            null,
            new RosterRun("host", "p:1", [new RosterRunSeat("p:1", "Host", "IRONCLAD", true, true), new RosterRunSeat("p:1002", "Ann", "SILENT", false, connected)]));

    private static void ReactionRepublishesAndResendsOncePerChange()
    {
        var rig = new ReactionRig();
        rig.Reaction.Apply(Roster(2));
        Expect(rig.Published == 1 && rig.Resent == 1, "the first roster is a change: names published and sessions re-sent once");
        Expect(rig.LastNames is { Count: 2 }, "the published names are the roster's (both seats)");
        rig.Reaction.Apply(Roster(2));
        Expect(rig.Published == 1 && rig.Resent == 1, "the same roster again does nothing");
        rig.Reaction.Apply(Roster(3));
        Expect(rig.Published == 2 && rig.Resent == 2, "a joined seat is a change");
        rig.Reaction.Apply(InRun());
        Expect(rig.Resent == 3, "a lobby-to-run transition is a change");
        rig.Reaction.Apply(InRun(connected: false));
        Expect(rig.Resent == 4, "a seat dropping out of the run is a change: its row becomes reclaimable");
        Expect(rig.Reaped == 0, "and none of that reaped anything");

        var noManager = new ReactionRig(canPublish: false, canReap: false);
        noManager.Reaction.Apply(Roster(2));
        Expect(noManager.Resent == 1, "a headless client (no manager) still re-sends sessions");
    }

    private static void ReactionResendsWhenRosterDetailsChange()
    {
        var rig = new ReactionRig();
        var lobby = Roster(2);
        rig.Reaction.Apply(lobby);
        var renamedLobby = lobby with
        {
            Lobby = lobby.Lobby! with
            {
                Seats = [lobby.Lobby.Seats[0], lobby.Lobby.Seats[1] with { DisplayName = "Renamed" }],
            },
        };
        rig.Reaction.Apply(renamedLobby);
        Expect(rig.Resent == 2 && rig.Published == 2, "a lobby name change with the same ids and connectivity re-sends once");
        var changedLobbyCharacter = renamedLobby with
        {
            Lobby = renamedLobby.Lobby! with
            {
                Seats = [renamedLobby.Lobby.Seats[0], renamedLobby.Lobby.Seats[1] with { CharacterId = "DEFECT" }],
            },
        };
        rig.Reaction.Apply(changedLobbyCharacter);
        Expect(rig.Resent == 3, "a lobby character change with the same ids and connectivity re-sends once");
        rig.Reaction.Apply(changedLobbyCharacter with { Lobby = changedLobbyCharacter.Lobby! with { Seats = [.. changedLobbyCharacter.Lobby.Seats] } });
        Expect(rig.Resent == 3, "a separate value-equal lobby read does not re-send");

        var run = InRun();
        rig.Reaction.Apply(run);
        Expect(rig.Resent == 4, "entering the run re-sends");
        var changedRunName = run with
        {
            Run = run.Run! with { Seats = [run.Run.Seats[0], run.Run.Seats[1] with { DisplayName = "Run name" }] },
        };
        rig.Reaction.Apply(changedRunName);
        Expect(rig.Resent == 5, "a run name change with the same ids and connectivity re-sends");
        var changedRunCharacter = changedRunName with
        {
            Run = changedRunName.Run! with
            {
                Seats = [changedRunName.Run.Seats[0], changedRunName.Run.Seats[1] with { CharacterId = "DEFECT" }],
            },
        };
        rig.Reaction.Apply(changedRunCharacter);
        Expect(rig.Resent == 6, "a run character change with the same ids and connectivity re-sends");
        rig.Reaction.Apply(changedRunCharacter with
        {
            Run = changedRunCharacter.Run! with
            {
                Seats = [changedRunCharacter.Run.Seats[0], changedRunCharacter.Run.Seats[1] with { IsHost = true }],
            },
        });
        Expect(rig.Resent == 7, "a host-role change with the same ids and connectivity re-sends");
        rig.Reaction.Apply(InRun());
        Expect(rig.Resent == 8, "returning to a previously seen roster is a change from the latest read");
        rig.Reaction.Apply(InRun());
        Expect(rig.Resent == 8, "a separate value-equal run read does not re-send");
    }

    // The next observer is free to re-broadcast the first roster it reads.
    private static void ReactionResetMakesTheNextRosterAChange()
    {
        var rig = new ReactionRig();
        rig.Reaction.Apply(Roster(2));
        rig.Reaction.Reset();
        rig.Reaction.Apply(Roster(2));
        Expect(rig.Resent == 2, "after a reset the same roster counts as a change again");
    }

    // THE RULE (roster-push-only-run-end-rule): reap only once the game has left BOTH the run and any lobby.
    private static void ReactionReapsOnlyAfterTheRunAndLobbyEnd()
    {
        var rig = new ReactionRig();
        rig.Reaction.Apply(InRun());
        Expect(rig.Reaped == 0, "a run in progress, including its end-of-run summary, reaps nothing");

        rig.Reaction.Apply(Roster(1));
        Expect(rig.Reaped == 0, "a lobby screen reaps nothing: it is not the run having ended");
        rig.Reaction.Apply(new RosterFacts(RosterRootScenes.LoadGame, new RosterLobby(NetTypeNames.Host, "p:1", true, [], ["p:1"]), null));
        Expect(rig.Reaped == 0, "neither does the saved-run lobby");

        rig.Reaction.Apply(Menu());
        Expect(rig.Reaped == 1, "leaving to the main menu reaps the detached seats");
        rig.Reaction.Apply(Menu());
        Expect(rig.Reaped == 2, "and every read on the menu asks again (the manager frees only what is still detached)");
    }

    private static void ReactionSurvivesAFailingNamePublish()
    {
        var rig = new ReactionRig { PublishThrows = true };
        rig.Reaction.Apply(Roster(2));
        Expect(rig.Resent == 1, "naming is cosmetic: a failing publish never costs the session re-send");
        Expect(rig.Log.Any(line => line.Contains("publishing roster names failed", StringComparison.Ordinal)), "and it is logged");
    }

    // ---- the hooks -------------------------------------------------------------------------------------------

    /// <summary>
    /// Every game method the roster hooks bind resolves against the installed game, DECLARED by its own type with exactly the
    /// signature the typed binding names, and agrees with the plain-data targets the metadata-only lane checks. Pure metadata
    /// reflection, so it runs in the `host-guards` and `beta-targets` verbs.
    /// </summary>
    internal static void TargetsResolve()
    {
        var data = RosterSignalTargets.Targets;
        var bindings = RosterSignalPatch.Bindings;
        Expect(data.Count == 8 && bindings.Count == data.Count, "eight roster methods are hooked");

        for (var index = 0; index < data.Count; index++)
        {
            var target = data[index];
            var binding = bindings[index];
            var label = $"{binding.Type.Name}.{binding.MethodName}";

            Expect(binding.Type.FullName == target.TypeName, $"{label}: typed binding and metadata data name the same type");
            Expect(binding.MethodName == target.MethodName, $"{label}: same method name");
            Expect(binding.Parameters.Length == target.ParameterCount, $"{label}: same parameter count");

            var method = RosterSignalPatch.ResolveDeclared(binding);
            Expect(method is not null, $"{label} resolves with its exact signature on the installed game");
            Expect(method!.DeclaringType == binding.Type,
                $"{label} is DECLARED by its own type: an inherited one would hook every subclass");
            Expect(!method.IsStatic && method.IsPublic, $"{label} is a public instance member");
            Expect((binding.MethodName == RosterSignalTargets.Constructor) == method.IsConstructor,
                $"{label}: a constructor target resolves to a constructor and nothing else does");

            var postfix = typeof(RosterSignalPatch).GetMethod(
                binding.Postfix, System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            Expect(postfix is not null, $"{label}: postfix {binding.Postfix} exists");
        }

        // The two lobby constructors hand the postfix the constructed lobby; the listener callbacks and the run clean-up
        // take nothing, because a postfix that read the game from inside a game callback would fault the process.
        Expect(bindings.Where(binding => binding.MethodName == RosterSignalTargets.Constructor).All(binding =>
                typeof(RosterSignalPatch).GetMethod(binding.Postfix, System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!
                    .GetParameters().Any(parameter => parameter.Name == "__instance")),
            "the constructor postfixes take the constructed lobby as __instance");
        Expect(bindings.Where(binding => binding.MethodName != RosterSignalTargets.Constructor).All(binding =>
                binding.Postfix == "PostfixWake"
                && typeof(RosterSignalPatch).GetMethod(binding.Postfix, System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!
                    .GetParameters().Length == 0),
            "every other hook only wakes, and takes nothing from the game");
        Expect(data.Select(target => target.Key).Distinct().Count() == data.Count, "targets are unique");
        Expect(data.Count(target => target.TypeName == RosterSignalTargets.RunManager) == 1
                && data.Count(target => target.TypeName == RosterSignalTargets.CharacterSelectScreen) == 3
                && data.Count(target => target.TypeName == RosterSignalTargets.LoadRunScreen) == 2,
            "the run clean-up, the three new-run screen callbacks and the two saved-run screen callbacks are all hooked");
        Expect(data.Count(target => target.TypeName == RosterSignalTargets.CharacterSelectScreen
                && target.MethodName == nameof(MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen.PlayerChanged)) == 1,
            "the character-change callback wakes the roster observer");
    }

    /// <summary>
    /// The zero-demand contract for the roster: with nobody served nothing is listening, no observer exists, and a raised
    /// signal reaches nobody. Then a subscription that is released leaves the process exactly as it found it.
    /// </summary>
    internal static void RosterIsDormantWithoutDemand()
    {
        Expect(CouchCoopRosterObserver.LiveCount == 0, "no roster observer exists with nobody served");
        Expect(CouchCoopRosterSignals.ListenerCount == 0, "no roster signal has a listener with nobody served");
        var timers = System.Threading.Timer.ActiveCount;
        SignalsWithoutListenersCostNothing();
        Expect(System.Threading.Timer.ActiveCount <= timers, "raising signals creates no timer");

        var rig = new Rig();
        rig.Observer.Start();
        rig.Frames.RunFrame();
        rig.Observer.Dispose();
        Expect(rig.Signals.Live == false && CouchCoopRosterObserver.LiveCount == 0, "a released subscription leaves no observer");
        Expect(System.Threading.Timer.ActiveCount <= timers, "and no timer: the observer owns none");
        rig.Frames.RunFrame();
        Expect(rig.Frames.Pending == 0 && rig.Reads == 1, "and nothing was left to read");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"CouchCoopRosterObserverTests failed: {because}");
        }
    }
}
