using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Runtime;
using MegaCrit.Sts2.Core.Multiplayer.Game;

// CouchCoop's own typed game facts, and everything that decides WHEN they are read.
//
// The QR gates used to pull a full state snapshot on a 0.25 s chain. They now decide from GateFacts, read through
// CouchCoopGameFacts only when something pushed that the answer may have changed, and reuse the remembered answer
// on the panel's heartbeat tick. Nothing here can construct a game screen (a test process that does segfaults), so
// each piece is exercised through the seam that stands where the game would: a fake reader, plain objects for
// screens, and the metadata-only reflection that pins the assignment hooks against the installed game build.
internal static class CouchCoopGameFactsTests
{
    public static void Run()
    {
        FrontReturnsTheReaderAnswer();
        FrontTurnsAThrowingReaderIntoUnavailable();
        ProductionReaderIsUnavailableWithoutAnEngine();
        NetTypeNamesCoverEveryGameValue();
        AssignmentRecordIsPerScreenAndLastWins();
        FactsAreReadOnAPushAndReusedByTheTick();
        AFailedReadIsRetriedButAGoodOneIsKept();
        AFactsReadFollowsTheScreen();
        WithoutAScreenEventEveryEvaluationReads();
        GateScreenIsTheCurrentVisibleLobby();
        TargetsResolve();
        Console.WriteLine("CouchCoopGameFactsTests: ok");
    }

    // ---- the front ---------------------------------------------------------------------------------------

    // internal: the ONE IGameFacts fake in the suite. A new read path adds its member here (a second implementer
    // elsewhere would stop compiling the moment another path adds a member to the interface).
    internal sealed class FakeFacts(Func<object?, GateFacts?>? read = null) : IGameFacts
    {
        public int Calls { get; private set; }
        public object? LastScreen { get; private set; }

        public GateFacts? ReadGates(object? currentScreen)
        {
            Calls++;
            LastScreen = currentScreen;
            return read?.Invoke(currentScreen);
        }

        // ---- WP3 path 7: run presence for a browser disconnect and a seat launch ---------------------------------

        private int _runReads;
        private int _runReadThread;

        /// <summary>What the run-presence read answers; unset reads as unavailable. Mutable so a test can play a sequence.</summary>
        public Func<bool?>? RunRead { get; set; }

        /// <summary>How many run-presence reads reached the reader (atomic: callers run on socket threads).</summary>
        public int RunReads => Volatile.Read(ref _runReads);

        /// <summary>The managed thread the last run-presence read ran on.</summary>
        public int RunReadThread => Volatile.Read(ref _runReadThread);

        public bool? ReadRunInProgress()
        {
            Interlocked.Increment(ref _runReads);
            Volatile.Write(ref _runReadThread, Environment.CurrentManagedThreadId);
            return RunRead?.Invoke();
        }

        // ---- WP3 path 5: the lobby player cap --------------------------------------------------------------------

        private int _capReads;

        /// <summary>What the lobby-cap read answers; unset reads as "no lobby". Mutable so a test can raise it mid-run.</summary>
        public Func<int?>? CapRead { get; set; }

        /// <summary>How many lobby-cap reads reached the reader (atomic: callers run on listener threads).</summary>
        public int CapReads => Volatile.Read(ref _capReads);

        public int? ReadLobbyCap()
        {
            Interlocked.Increment(ref _capReads);
            return CapRead?.Invoke();
        }
    }

    // Runs `body` with the front pointed at `source`, the zero-client tripwire quiet (its own suite owns those
    // counters) and everything put back afterwards.
    internal static void WithSource(IGameFacts source, Action body)
    {
        var previous = CouchCoopGameFacts.Source;
        ZeroClientGuard.ResetForTests(armed: false);
        CouchCoopGameFacts.Source = source;
        try
        {
            body();
        }
        finally
        {
            CouchCoopGameFacts.Source = previous;
            ZeroClientGuard.ResetForTests();
        }
    }

    // The same, for a body that awaits.
    internal static async Task WithSourceAsync(IGameFacts source, Func<Task> body)
    {
        var previous = CouchCoopGameFacts.Source;
        ZeroClientGuard.ResetForTests(armed: false);
        CouchCoopGameFacts.Source = source;
        try
        {
            await body().ConfigureAwait(false);
        }
        finally
        {
            CouchCoopGameFacts.Source = previous;
            ZeroClientGuard.ResetForTests();
        }
    }

    private static void FrontReturnsTheReaderAnswer()
    {
        var screen = new object();
        var fake = new FakeFacts(_ => new GateFacts(false, "host", null));
        WithSource(fake, () =>
        {
            Expect(CouchCoopGameFacts.ReadGates(screen) == new GateFacts(false, "host", null), "the reader's facts come back");
            Expect(fake.Calls == 1 && ReferenceEquals(fake.LastScreen, screen), "the caller's screen reaches the reader untouched");
            Expect(CouchCoopGameFacts.ReadGates(null) is not null && fake.LastScreen is null, "a caller with no screen passes none");
        });
    }

    // A reader that throws is "unavailable" (null), never an exception in the QR panel's evaluation. The gates then
    // refuse, and the support checkpoint records Unavailable rather than NotHost.
    private static void FrontTurnsAThrowingReaderIntoUnavailable()
    {
        var fake = new FakeFacts(_ => throw new InvalidOperationException("the game moved"));
        WithSource(fake, () =>
        {
            var facts = CouchCoopGameFacts.ReadGates(new object());
            Expect(facts is null, "a throwing reader reads as unavailable");
            Expect(!CouchCoopLobbyHostGate.IsHostLobby(facts) && !CouchCoopPauseMenuGate.IsHostRun(facts),
                "unavailable facts open no gate");
            Expect(CouchCoopLobbyHostGate.Classify(facts) == LobbyCheckpointEvaluation.Unavailable,
                "and are recorded as Unavailable, not as a lobby that is not a host lobby");
        });
    }

    // The real reader in a process with no engine behind it: answers unavailable without touching a game type.
    // Reaching RunManager here is the exit-139 hazard, so this is also the guard's own test.
    private static void ProductionReaderIsUnavailableWithoutAnEngine()
    {
        Expect(!CouchCoop.Mod.CouchCoopMod.EngineAvailable, "this process has no engine");
        Expect(GameFactsReader.Instance.ReadGates(null) is null, "no engine: no run facts");
        Expect(GameFactsReader.Instance.ReadGates(new object()) is null, "no engine: no lobby facts either");
        Expect(GameFactsReader.Instance.ReadRunInProgress() is null, "no engine: run presence is unavailable, not \"no run\"");
    }

    private static void NetTypeNamesCoverEveryGameValue()
    {
        Expect(GameFactsReader.NetTypeName(NetGameType.Host) == NetTypeNames.Host, "host");
        Expect(GameFactsReader.NetTypeName(NetGameType.Client) == NetTypeNames.Client, "client");
        Expect(GameFactsReader.NetTypeName(NetGameType.Singleplayer) == NetTypeNames.Singleplayer, "singleplayer");
        Expect(GameFactsReader.NetTypeName(NetGameType.Replay) == NetTypeNames.Replay, "replay");
        Expect(GameFactsReader.NetTypeName(NetGameType.None) == NetTypeNames.None, "none");
        Expect(GameFactsReader.NetTypeName(null) == NetTypeNames.Unknown, "no service");
        Expect(NetTypeNames.Host == CouchCoopLobbyHostGate.HostNetGameType, "the gate's host name is the contract's");
    }

    // ---- the assignment record -----------------------------------------------------------------------------

    private static void AssignmentRecordIsPerScreenAndLastWins()
    {
        var loadScreen = new object();
        var otherScreen = new object();
        Expect(!LobbyAssignmentRecord.TryGet(loadScreen, out _), "nothing is recorded before the game assigns a lobby");

        LobbyAssignmentRecord.Record(loadScreen, NetTypeNames.Host);
        Expect(LobbyAssignmentRecord.TryGet(loadScreen, out var role) && role == NetTypeNames.Host, "the host assignment is read back");
        Expect(!LobbyAssignmentRecord.TryGet(otherScreen, out _), "a different screen instance has its own (empty) answer");

        LobbyAssignmentRecord.Record(otherScreen, NetTypeNames.Client);
        LobbyAssignmentRecord.Record(loadScreen, NetTypeNames.Client);
        Expect(LobbyAssignmentRecord.TryGet(loadScreen, out role) && role == NetTypeNames.Client,
            "a later assignment on the same screen replaces the earlier one");
        Expect(LobbyAssignmentRecord.TryGet(otherScreen, out role) && role == NetTypeNames.Client, "the other screen kept its own");
    }

    // ---- when the facts are read ---------------------------------------------------------------------------

    private static (LobbyGateFactsCache Cache, Func<GateFacts?> Read, Func<int> Reads) Rig(params GateFacts?[] answers)
    {
        var cache = new LobbyGateFactsCache();
        var calls = 0;
        GateFacts? Read() => answers[Math.Min(calls++, answers.Length - 1)];
        return (cache, Read, () => calls);
    }

    // THE POINT OF THE CHANGE. The first evaluation reads (nothing has been read yet); every heartbeat tick after it,
    // with nothing pushed, reuses the answer and reads nothing; a push (any wake) makes exactly the next evaluation
    // read again, and no more.
    private static void FactsAreReadOnAPushAndReusedByTheTick()
    {
        var host = new GateFacts(false, "host", null);
        var (cache, read, reads) = Rig(host, new GateFacts(false, "singleplayer", null));

        Expect(cache.Resolve(7, alwaysRead: false, read) == host && reads() == 1, "the first evaluation reads");
        for (var tick = 0; tick < 20; tick++)
        {
            Expect(cache.Resolve(7, alwaysRead: false, read) == host, "a tick reuses the remembered facts");
        }

        Expect(reads() == 1, "twenty heartbeat ticks read the game zero times");

        // A wake that lands while a chain is already running is dropped by the controller, and still marks: the
        // chain's NEXT evaluation must read, or a lobby assignment would be a lost signal.
        cache.MarkDirty();
        cache.MarkDirty();
        cache.MarkDirty();
        Expect(cache.Resolve(7, alwaysRead: false, read) == new GateFacts(false, "singleplayer", null),
            "after a push the next evaluation reads the new facts");
        Expect(reads() == 2, "a burst of pushes costs one read, not one each");
        Expect(cache.Resolve(7, alwaysRead: false, read) == new GateFacts(false, "singleplayer", null) && reads() == 2,
            "and the tick after that reuses again");
    }

    // A read that failed is not pinned for the whole lobby visit: the next evaluation asks again. A good read is kept.
    private static void AFailedReadIsRetriedButAGoodOneIsKept()
    {
        var host = new GateFacts(false, "host", null);
        var (cache, read, reads) = Rig(null, null, host);

        Expect(cache.Resolve(7, false, read) is null && reads() == 1, "the first read failed");
        Expect(cache.Resolve(7, false, read) is null && reads() == 2, "so the next evaluation retries");
        Expect(cache.Resolve(7, false, read) == host && reads() == 3, "and takes the first good answer");
        Expect(cache.Resolve(7, false, read) == host && reads() == 3, "which is then kept");
    }

    // The remembered facts describe ONE lobby screen. Another screen, or having left every lobby, reads afresh.
    private static void AFactsReadFollowsTheScreen()
    {
        var host = new GateFacts(false, "host", null);
        var client = new GateFacts(false, "client", null);
        var (cache, read, reads) = Rig(host, client, host);

        Expect(cache.Resolve(7, false, read) == host, "the new-run screen");
        Expect(cache.Resolve(9, false, read) == client && reads() == 2, "a different current screen reads for itself");
        Expect(cache.Resolve(9, false, read) == client && reads() == 2, "and is then remembered");

        cache.Invalidate();
        Expect(cache.Resolve(9, false, read) == host && reads() == 3,
            "after no lobby was current, the next lobby reads afresh even for the same screen");
    }

    // The existing safety valve (the game's screen event could not be subscribed): with no push there is nothing to
    // mark, so the evaluation reads every time, exactly as that valve always pulled. Named so it is not mistaken for
    // the normal path.
    private static void WithoutAScreenEventEveryEvaluationReads()
    {
        var host = new GateFacts(false, "host", null);
        var (cache, read, reads) = Rig(host);
        for (var evaluation = 1; evaluation <= 5; evaluation++)
        {
            Expect(cache.Resolve(7, alwaysRead: true, read) == host && reads() == evaluation,
                $"the safety valve reads on evaluation {evaluation}");
        }
    }

    // ---- which screen the facts describe ------------------------------------------------------------------

    private static void GateScreenIsTheCurrentVisibleLobby()
    {
        LobbyScreenFacts[] screens =
        [
            new(1, Visible: true, Current: false),
            new(2, Visible: true, Current: true),
            new(3, Visible: false, Current: false),
        ];

        Expect(LobbyEvaluationPlanner.GateScreenIndex(screens, currentScreenKnown: true) == 1,
            "with a current screen known, the facts describe it, not the first visible one");
        Expect(LobbyEvaluationPlanner.GateScreenIndex(screens, currentScreenKnown: false) == 0,
            "when the seam cannot say, the first visible lobby is the screen the old fallback read for");
        Expect(LobbyEvaluationPlanner.GateScreenIndex(
                [new(1, Visible: true, Current: false), new(2, Visible: false, Current: true)], currentScreenKnown: true) == -1,
            "a current screen that is not visible is not a lobby on screen");
        Expect(LobbyEvaluationPlanner.GateScreenIndex([], currentScreenKnown: true) == -1, "no screens, no gate screen");

        // Agrees with Decide: whenever Decide says to pull, there is a screen to read for, and vice versa.
        foreach (var known in new[] { true, false })
        {
            foreach (var visible in new[] { true, false })
            {
                foreach (var current in new[] { true, false })
                {
                    LobbyScreenFacts[] one = [new(1, visible, current)];
                    var plan = LobbyEvaluationPlanner.Decide(one, known);
                    Expect(plan.PullState == (LobbyEvaluationPlanner.GateScreenIndex(one, known) >= 0),
                        $"Decide and GateScreenIndex agree (known={known}, visible={visible}, current={current})");
                }
            }
        }
    }

    // ---- the assignment hooks: pinned against the installed game build -----------------------------------------

    // Pure metadata reflection over the STS2 assemblies this build was compiled against — no Harmony install, no
    // game. Internal because the `beta-targets` and `host-guards` verbs run this leg rather than a copy.
    internal static void TargetsResolve()
    {
        var data = LobbyAssignmentTargets.Targets;
        var bindings = LobbyAssignmentPatch.Bindings;
        Expect(data.Count == 5 && bindings.Count == data.Count, "five assignment methods are hooked");

        for (var index = 0; index < data.Count; index++)
        {
            var target = data[index];
            var binding = bindings[index];
            var label = $"{binding.Type.Name}.{binding.MethodName}";

            Expect(binding.Type.FullName == target.TypeName, $"{label}: typed binding and metadata data name the same type");
            Expect(binding.MethodName == target.MethodName, $"{label}: same method name");
            Expect(binding.Parameters.Length == target.ParameterCount, $"{label}: same parameter count");
            Expect(binding.Role == target.Role, $"{label}: same role");

            var method = LobbyAssignmentPatch.ResolveDeclared(binding);
            Expect(method is not null, $"{label} resolves with its exact signature on the installed game");
            Expect(method!.DeclaringType == binding.Type,
                $"{label} is DECLARED by its screen — an inherited one would hook every subclass");
            Expect(!method.IsStatic && method.IsPublic, $"{label} is a public instance method");

            var postfix = typeof(LobbyAssignmentPatch).GetMethod(
                binding.Postfix, System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            Expect(postfix is not null, $"{label}: postfix {binding.Postfix} exists");
            Expect(postfix!.GetParameters().Any(parameter => parameter.Name == "__instance"),
                $"{label}: its postfix takes the screen as __instance");

            // The saved-run screen's postfixes also take the initializer's second argument, by position and type:
            // it is what the recorded saved-run player count (the lobby's cap) is read from later.
            if (target.Role is not null)
            {
                var second = postfix!.GetParameters().SingleOrDefault(parameter => parameter.Name == "__1");
                Expect(second is not null, $"{label}: its postfix takes the initializer's second argument as __1");
                Expect(second!.ParameterType == binding.Parameters[1],
                    $"{label}: __1 has exactly the type of the initializer's own second parameter");
            }
        }

        // Only the saved-run screen's two initializers record a role; the new-run screen exposes its lobby and its
        // hooks only wake.
        Expect(data.Where(target => target.Role is not null).Select(target => target.TypeName).Distinct().SequenceEqual(
                [LobbyAssignmentTargets.LoadRunScreen]),
            "only the saved-run screen records a role");
        Expect(data.Single(target => target.MethodName == "InitializeAsHost").Role == NetTypeNames.Host, "host assignment records host");
        Expect(data.Single(target => target.MethodName == "InitializeAsClient").Role == NetTypeNames.Client, "client assignment records client");
        Expect(data.Where(target => target.TypeName == LobbyAssignmentTargets.CharacterSelectScreen).All(target => target.Role is null),
            "the new-run screen's hooks only wake");
        Expect(data.Select(target => target.Key).Distinct().Count() == data.Count, "targets are unique");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"CouchCoopGameFactsTests failed: {because}");
        }
    }
}
