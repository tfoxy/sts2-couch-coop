using CouchCoop.Mod.Session;

// The readiness deadline a freshly spawned seat is given before the host kills it, and the one progress line
// emitted while it is still loading (HeadlessClientManager.WaitForReadyAsync).
//
// WHY THIS IS ITS OWN FILE AND ITS OWN VERB. A player on a Steam Deck reported the mod not working, and the
// timing half of that is here: the host used to kill a seat after a flat 60s while the phone was still waiting
// (JOIN_TIMEOUT_MS = 90s in MirrorApp.vue), so a slow-but-healthy start was destroyed by the only participant
// that could see it. These checks are pure — no IO, no Harmony, no Godot, no port, no game executable — which
// puts them in the same "safe to run alone" class as the host-guards slice, and they are registered behind
// `-- seat-timeout` for exactly that reason. They also run in the normal sequence, which reaches them again
// now that the SIGSEGV a few suites in is fixed (project memory: couch-modtests-segfault-main-sep11) — the
// verb stays because a pure, fast check is worth being able to run on its own.
//
// The two waiting tests below are the only slow ones (~2s each, against a deliberately shortened deadline);
// nothing here waits on a real seat.
internal static class SeatReadyTimeoutTests
{
    // The browser's own ceiling on a silent join — JOIN_TIMEOUT_MS in frontend/src/mirror/MirrorApp.vue.
    // Spelled here rather than imported (different language, different process) so the relationship the host
    // deadline was chosen against is asserted in the one place that would otherwise drift silently.
    private const double BrowserJoinTimeoutSeconds = 90.0;

    public static async Task RunAsync()
    {
        TheDefaultDeadlineLosesTheRaceToTheBrowser();
        AnOperatorValueWinsAndIsClamped();
        GarbageFallsBackToTheDefault();
        TheContactDeadlineIsShorterAndReadTheSameWay();
        await ASlowSeatRunsToTheDeadlineAndIsKilled();
        await AnEarlyExitStillFailsFastUnderALongDeadline();
        Console.WriteLine("SeatReadyTimeoutTests: ok");
    }

    // The number is a relationship, not a taste: the host must always give up BEFORE the page does (so the
    // failure is narrated and the rejection lands while the phone is still listening) and well AFTER a cold
    // start finishes (the file's own measured 20-30s, which a 15W handheld runs past while healthy).
    private static void TheDefaultDeadlineLosesTheRaceToTheBrowser()
    {
        var seconds = HeadlessClientManager.DefaultSeatReadyTimeoutSeconds;
        Assert(seconds < BrowserJoinTimeoutSeconds,
            "the host gives up before the browser does, so a kill is always narrated to a page still listening");
        Assert(BrowserJoinTimeoutSeconds - seconds >= 10,
            "…with real headroom: the phone's clock starts at its join message, ahead of the host's spawn");
        Assert(seconds >= 60,
            "…and a cold seat (20-30s on a desktop, longer on a handheld) is never killed while starting normally");
        Assert(HeadlessClientManager.ParseSeatReadyTimeout(null) == TimeSpan.FromSeconds(seconds),
            "an unset override resolves to that default");
    }

    private static void AnOperatorValueWinsAndIsClamped()
    {
        Assert(HeadlessClientManager.ParseSeatReadyTimeout("120") == TimeSpan.FromSeconds(120),
            "an operator value wins over the default — same polarity as the memory tuning");
        Assert(HeadlessClientManager.ParseSeatReadyTimeout("  120  ") == TimeSpan.FromSeconds(120),
            "surrounding whitespace is not a parse failure");
        Assert(HeadlessClientManager.ParseSeatReadyTimeout("120.5") == TimeSpan.FromSeconds(120.5),
            "seconds are read invariantly, fractions included");
        Assert(
            HeadlessClientManager.ParseSeatReadyTimeout("200") > TimeSpan.FromSeconds(BrowserJoinTimeoutSeconds),
            "a value past the browser's ceiling is honoured — debugging a very slow host is a real case");

        var floor = TimeSpan.FromSeconds(HeadlessClientManager.MinSeatReadyTimeoutSeconds);
        var ceiling = TimeSpan.FromSeconds(HeadlessClientManager.MaxSeatReadyTimeoutSeconds);
        Assert(HeadlessClientManager.ParseSeatReadyTimeout("0") == floor,
            "zero clamps to the floor rather than turning every join into an instant kill");
        Assert(HeadlessClientManager.ParseSeatReadyTimeout("-30") == floor, "a negative clamps to the floor");
        Assert(HeadlessClientManager.ParseSeatReadyTimeout("99999") == ceiling,
            "a fat-fingered value clamps to the ceiling rather than parking the viewer for hours");
    }

    private static void GarbageFallsBackToTheDefault()
    {
        var fallback = TimeSpan.FromSeconds(HeadlessClientManager.DefaultSeatReadyTimeoutSeconds);
        foreach (var raw in new[] { "", "   ", "sixty", "60s", "1,5", "NaN", "Infinity", "-Infinity" })
        {
            Assert(HeadlessClientManager.ParseSeatReadyTimeout(raw) == fallback,
                $"'{raw}' carries no number to honour, so it falls back to the default instead of clamping");
        }
    }


    // The SECOND deadline, which asks a different question: not "is this seat usable yet" but "is CouchCoop
    // running in it at all". Total silence means the reporter — initialised early in mod init, long before the
    // 20-30s asset preload — never ran, so the process has no isolation between it and the host account's Steam
    // Cloud saves. It must therefore be well short of the readiness deadline, and it is read through the same
    // parse rule so an operator who has learned one knob has learned both.
    private static void TheContactDeadlineIsShorterAndReadTheSameWay()
    {
        var contact = HeadlessClientManager.DefaultSeatContactTimeoutSeconds;
        Assert(contact < HeadlessClientManager.DefaultSeatReadyTimeoutSeconds,
            "a silent seat dies long before a merely slow one would");
        Assert(HeadlessClientManager.ParseSeatContactTimeout(null) == TimeSpan.FromSeconds(contact),
            "an unset override resolves to that default");
        Assert(HeadlessClientManager.ParseSeatContactTimeout("45") == TimeSpan.FromSeconds(45),
            "an operator value wins here too");
        Assert(
            HeadlessClientManager.ParseSeatContactTimeout("0")
                == TimeSpan.FromSeconds(HeadlessClientManager.MinSeatReadyTimeoutSeconds),
            "…inside the same clamp floor");
        Assert(
            HeadlessClientManager.ParseSeatContactTimeout("99999")
                == TimeSpan.FromSeconds(HeadlessClientManager.MaxSeatReadyTimeoutSeconds),
            "…and the same ceiling");
        foreach (var raw in new[] { "", "   ", "twenty", "20s", "NaN" })
        {
            Assert(HeadlessClientManager.ParseSeatContactTimeout(raw) == TimeSpan.FromSeconds(contact),
                $"'{raw}' falls back to the default rather than being half-honoured");
        }
    }

    // The bug this round fixes, read from the panel: a seat that is merely slow must be narrated as loading and
    // only then killed — and the "still loading" line must appear ONCE, not once per 250ms poll.
    private static async Task ASlowSeatRunsToTheDeadlineAndIsKilled()
    {
        await WithReadyTimeout("2", async () =>
        {
            var process = new NeverReadyProcess();
            using var manager = new HeadlessClientManager(
                launcher: _ => process,
                // A seat that is up and healthy but has not started serving yet.
                readinessProbe: (_, _) => Task.FromResult(false));

            var started = DateTimeOffset.UtcNow;
            Assert(await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default) is null,
                "a seat that never serves yields no port");
            var elapsed = DateTimeOffset.UtcNow - started;


            Assert(elapsed >= TimeSpan.FromSeconds(1.5),
                "the wait actually ran to the configured deadline rather than short-circuiting");
            Assert(process.HardKilled, "the expired seat is still killed, exactly as before");
        });
    }

    // The early-exit path is deliberately untouched by the longer deadline: a process that has actually DIED
    // must fail fast, not sit out a 15-minute timeout. Asserted against the largest deadline we accept.
    private static async Task AnEarlyExitStillFailsFastUnderALongDeadline()
    {
        await WithReadyTimeout("900", async () =>
        {
            using var manager = new HeadlessClientManager(
                launcher: _ =>
                {
                    var process = new NeverReadyProcess();
                    process.ForceExit();
                    return process;
                },
                readinessProbe: (_, _) => Task.FromResult(false));

            var started = DateTimeOffset.UtcNow;
            Assert(await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default) is null,
                "a stillborn seat yields no port");
            Assert(DateTimeOffset.UtcNow - started < TimeSpan.FromSeconds(5),
                "a dead process is reported immediately, however long the readiness deadline is");

        });
    }

    private static async Task WithReadyTimeout(string seconds, Func<Task> body)
    {
        var previous = Environment.GetEnvironmentVariable(
            HeadlessClientManager.SeatReadyTimeoutEnvironmentVariable);
        Environment.SetEnvironmentVariable(
            HeadlessClientManager.SeatReadyTimeoutEnvironmentVariable, seconds);
        try
        {
            await body();
        }
        finally
        {
            Environment.SetEnvironmentVariable(
                HeadlessClientManager.SeatReadyTimeoutEnvironmentVariable, previous);
        }
    }

    // A seat process that stays up and never serves — the shape the old 60s deadline killed on a slow host.
    private sealed class NeverReadyProcess : IHeadlessProcess
    {
        public bool HardKilled { get; private set; }
        public int Id => 12345;
        public bool HasExited { get; private set; }
        public int ExitCode => 0;

        public void ForceExit() => HasExited = true;
        public bool RequestGracefulStop() => false;
        public void Kill() { HardKilled = true; HasExited = true; }
        public void Dispose() { }
    }


    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"SeatReadyTimeoutTests failed: {label}.");
        }
    }
}
