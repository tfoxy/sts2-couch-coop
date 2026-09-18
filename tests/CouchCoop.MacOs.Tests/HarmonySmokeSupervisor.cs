using System.Diagnostics;

internal static class HarmonySmokeSupervisor
{
    internal static readonly TimeSpan Watchdog = TimeSpan.FromSeconds(30);

    internal enum Outcome { Success, Nonzero, SignalCrash, Timeout }

    internal static Outcome Classify(int? exitCode, bool timedOut)
    {
        if (timedOut) return Outcome.Timeout;
        if (exitCode is null) return Outcome.Timeout;
        if (exitCode == 0) return Outcome.Success;
        // Unix shells conventionally expose signal termination as 128 + signal (SIGKILL = 137,
        // SIGSEGV = 139). Keep ordinary nonzero process failures separate for support triage.
        return exitCode is >= 128 and <= 255 ? Outcome.SignalCrash : Outcome.Nonzero;
    }

    internal static async Task<Outcome> RunAsync(ProcessStartInfo startInfo, CancellationToken cancellationToken = default)
    {
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("failed to start harmony smoke");
        using var watchdog = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        watchdog.CancelAfter(Watchdog);
        try
        {
            await process.WaitForExitAsync(watchdog.Token);
            return Classify(process.ExitCode, timedOut: false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            try { process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
            return Classify(null, timedOut: true);
        }
    }

    internal static void RunClassificationTests()
    {
        Assert(Classify(0, false) == Outcome.Success, "zero exit is success");
        Assert(Classify(1, false) == Outcome.Nonzero, "ordinary failure is nonzero");
        Assert(Classify(139, false) == Outcome.SignalCrash, "SIGSEGV shell status is signal crash");
        Assert(Classify(null, true) == Outcome.Timeout, "watchdog expiry is timeout");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
