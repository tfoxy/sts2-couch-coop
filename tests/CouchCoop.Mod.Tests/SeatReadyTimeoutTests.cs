using CouchCoop.Mod.Activity;
using CouchCoop.Mod.Session;

// The readiness deadline a freshly spawned seat is given before the host kills it, and the one progress line
// emitted while it is still loading (HeadlessClientManager.WaitForReadyAsync).
//
// WHY THIS IS ITS OWN FILE AND ITS OWN VERB. A player on a Steam Deck reported the mod not working, and the
// timing half of that is here: the host used to kill a seat after a flat 60s while the phone was still waiting
// (JOIN_TIMEOUT_MS = 90s in MirrorApp.vue), so a slow-but-healthy start was destroyed by the only participant
// that could see it. These checks are pure — no IO, no Harmony, no Godot, no port, no game executable — which
// puts them in the same "safe to run alone" class as the host-guards slice, and they are registered behind
// `-- seat-timeout` for exactly that reason: the full suite currently dies of a pre-existing SIGSEGV a few
// suites in (project memory: couch-modtests-segfault-main-sep11), so a check registered ONLY in the normal
// sequence would never execute on this machine. They also run in that normal sequence.
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
        TheStillLoadingNoticeLandsWellBeforeTheDeadline();
        await ASlowSeatIsNarratedOnceBeforeItIsKilled();
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

    private static void TheStillLoadingNoticeLandsWellBeforeTheDeadline()
    {
        var standard = TimeSpan.FromSeconds(HeadlessClientManager.DefaultSeatReadyTimeoutSeconds);
        var notice = HeadlessClientManager.StillLoadingNoticeAfter(standard);
        Assert(notice == TimeSpan.FromSeconds(30),
            "under the shipped deadline the notice lands at the top of the measured cold-start range");
        Assert(notice < standard / 2 + TimeSpan.FromMilliseconds(1),
            "…which is no later than halfway, so it reads as progress rather than as a preamble to the kill");

        foreach (var seconds in new[] { 1.0, 4.0, 30.0, 61.0, 75.0, 900.0 })
        {
            var timeout = TimeSpan.FromSeconds(seconds);
            var at = HeadlessClientManager.StillLoadingNoticeAfter(timeout);
            Assert(at > TimeSpan.Zero && at <= timeout / 2,
                $"a {seconds}s deadline still emits its notice inside the first half of the wait");
        }
    }

    // The bug this round fixes, read from the panel: a seat that is merely slow must be narrated as loading and
    // only then killed — and the "still loading" line must appear ONCE, not once per 250ms poll.
    private static async Task ASlowSeatIsNarratedOnceBeforeItIsKilled()
    {
        await WithReadyTimeout("2", async () =>
        {
            CouchCoopActivityLog.Reset();
            var process = new NeverReadyProcess();
            using var manager = new HeadlessClientManager(
                launcher: _ => process,
                // A seat that is up and healthy but has not started serving yet.
                readinessProbe: (_, _) => Task.FromResult(false));

            var started = DateTimeOffset.UtcNow;
            Assert(await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default) is null,
                "a seat that never serves yields no port");
            var elapsed = DateTimeOffset.UtcNow - started;

            AssertNarration(
                [
                    "Starting Ann's game window…",
                    "Ann's game window opened — loading (this takes a moment).",
                    "Ann's game is still loading — this can take a while on a slower PC.",
                    "Ann's game took too long to start — stopping it.",
                ],
                "a slow seat reads launch → opened → still loading → timed out");

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
            CouchCoopActivityLog.Reset();
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

            AssertNarration(
                [
                    "Starting Ann's game window…",
                    "Ann's game window opened — loading (this takes a moment).",
                    "Ann's game window closed while starting up.",
                ],
                "the early-exit narration is unchanged, and no 'still loading' line precedes it");
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
            CouchCoopActivityLog.Reset();
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

    private static void AssertNarration(IReadOnlyList<string> expected, string label)
    {
        var actual = CouchCoopActivityLog.Snapshot().Select(entry => entry.Message).ToList();
        Assert(
            actual.Count == expected.Count && actual.SequenceEqual(expected),
            $"{label}: expected [{string.Join(" | ", expected)}] but the panel reads [{string.Join(" | ", actual)}]");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"SeatReadyTimeoutTests failed: {label}.");
        }
    }
}
