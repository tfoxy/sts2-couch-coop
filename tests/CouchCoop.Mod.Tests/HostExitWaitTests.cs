using System.Diagnostics;
using System.Runtime.InteropServices;
using CouchCoop.Mod.Session;

internal static class HostExitWaitTests
{
    internal static void Run()
    {
        DecisionTable();
        WaitErrorsNeverReportDeath();
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            Console.WriteLine("Host exit wait real-kernel leg: skipped (requires Linux or macOS).");
            return;
        }

        Assert(Marshal.SizeOf<HostExitWait.KEvent>() == 32, "64-bit Darwin kevent must be 32 bytes");
        Console.WriteLine("Host exit wait Darwin kevent layout: 1 passed.");
        KernelWaitReportsExit();
        AlreadyReapedHostIsGone();
        Console.WriteLine($"Host exit wait real-kernel {HostExitWait.PathName} leg: 2 passed.");
    }

    private static void DecisionTable()
    {
        var cases = new (string Name, int Errno, string? Before, string? After, string? Self,
            HostExitWait.ArmKind Kind, int Closes)[]
        {
            ("ESRCH", 3, "100", "100", "200", HostExitWait.ArmKind.HostGone, 0),
            ("ENOSYS", 38, "100", "100", "200", HostExitWait.ArmKind.Fallback, 0),
            ("EPERM", 1, "100", "100", "200", HostExitWait.ArmKind.Fallback, 0),
            ("EINVAL", 22, "100", "100", "200", HostExitWait.ArmKind.Fallback, 0),
            ("equal identity", 0, "100", "100", "200", HostExitWait.ArmKind.Wait, 0),
            ("reused during arm", 0, "100", "101", "200", HostExitWait.ArmKind.HostGone, 1),
            ("host newer than seat", 0, "300", "300", "200", HostExitWait.ArmKind.HostGone, 1),
            ("before newer, after unreadable", 0, "300", null, "200", HostExitWait.ArmKind.HostGone, 1),
            ("after newer, before unreadable", 0, null, "300", "200", HostExitWait.ArmKind.HostGone, 1),
            ("equal jiffies", 0, "200", "200", "200", HostExitWait.ArmKind.Wait, 0),
            ("unreadable identities", 0, null, null, "200", HostExitWait.ArmKind.Wait, 0),
            ("before unreadable", 0, null, "100", "200", HostExitWait.ArmKind.Wait, 0),
            ("after unreadable", 0, "100", null, "200", HostExitWait.ArmKind.Wait, 0),
            ("self unreadable", 0, "300", "300", null, HostExitWait.ArmKind.Wait, 0),
            ("numeric ordering", 0, "20", "20", "100", HostExitWait.ArmKind.Wait, 0),
            ("large unsigned ticks", 0, "18446744073709551615", "18446744073709551615", "100",
                HostExitWait.ArmKind.HostGone, 1),
            ("unparseable identity", 0, "unknown", "unknown", "100", HostExitWait.ArmKind.Wait, 0),
        };
        foreach (var item in cases)
        {
            var reads = 0;
            var closes = new List<int>();
            var opened = false;
            var result = HostExitWait.Decide(123, pid =>
                {
                    Assert(pid == 123 && reads == 1, $"{item.Name}: identity read before opening");
                    opened = true;
                    return (item.Errno == 0 ? 42 : -1, item.Errno);
                }, closes.Add, pid =>
                {
                    Assert(pid == 123, $"{item.Name}: identity belongs to host");
                    if (reads++ == 0) return item.Before;
                    Assert(opened, $"{item.Name}: second read follows open");
                    return item.After;
                }, item.Self, HostExitWait.CompareIdentity);

            Assert(result.Kind == item.Kind, $"{item.Name}: {result.Kind}, expected {item.Kind}");
            Assert(closes.Count == item.Closes && closes.All(fd => fd == 42), $"{item.Name}: handle ownership");
            Assert(reads == (item.Errno == 0 ? 2 : 1), $"{item.Name}: identity read exactly once on each side of open");
            if (result.Kind == HostExitWait.ArmKind.Wait)
                Assert(result.Handle == 42, $"{item.Name}: wait owns the open handle");
            if (result.Kind == HostExitWait.ArmKind.Fallback)
                Assert(result.Errno == item.Errno, $"{item.Name}: fallback carries errno");
        }
        Console.WriteLine($"Host exit wait decision table: {cases.Length} passed.");
    }

    private static void WaitErrorsNeverReportDeath()
    {
        foreach (var error in new[] { 0, 9, 22 })
        {
            var waits = 0;
            var closes = 0;
            var gone = 0;
            var fallbacks = new List<string>();
            HostExitWait.RunWait(42, fd =>
                {
                    Assert(fd == 42, "wait uses the opened descriptor");
                    return ++waits == 1 ? (false, 4) : (false, error);
                }, fd => { Assert(fd == 42, "close uses the opened descriptor"); closes++; }, () => gone++,
                reason => { Assert(closes == 1, "close precedes fallback"); fallbacks.Add(reason); });
            Assert(waits == 2 && closes == 1 && gone == 0 && fallbacks.Count == 1,
                $"wait error {error} restarts EINTR only, closes once and falls back without declaring death");
        }

        var readyWaits = 0;
        var readyCloses = 0;
        var readyGone = 0;
        HostExitWait.RunWait(42, _ => ++readyWaits == 1 ? (false, 4) : (true, 0), _ => readyCloses++,
            () => { Assert(readyCloses == 1, "close precedes gone callback"); readyGone++; },
            _ => throw new Exception("ready wait must not fall back"));
        Assert(readyWaits == 2 && readyGone == 1 && readyCloses == 1, "EINTR then exit fires once");
        Console.WriteLine("Host exit wait restart/error handling: 4 passed.");
    }

    private static void KernelWaitReportsExit()
    {
        using var child = StartChild();
        using var gone = new ManualResetEventSlim();
        using var fallback = new ManualResetEventSlim();
        try
        {
            // A test child starts after this runner; the production ancestor check is covered by the table.
            var arm = HostExitWait.Arm(child.Id, selfIdentity: null);
            Assert(arm.Kind == HostExitWait.ArmKind.Wait,
                $"real {HostExitWait.PathName} arm must wait, got {arm.Kind}: {arm.Reason} errno={arm.Errno}");
            Assert(HostExitWait.PathName == (OperatingSystem.IsLinux() ? "pidfd" : "kqueue"),
                "arm selects the native kernel path");
            HostExitWait.StartWait(arm.Handle, gone.Set, _ => fallback.Set());
            Assert(!gone.Wait(TimeSpan.FromMilliseconds(200)) && !fallback.IsSet,
                "a living host does not fire either callback");
            var elapsed = Stopwatch.StartNew();
            child.Kill();
            Assert(gone.Wait(TimeSpan.FromSeconds(1)), "kernel reports exit within one second");
            elapsed.Stop();
            Assert(elapsed.Elapsed < TimeSpan.FromSeconds(1) && !fallback.IsSet,
                "kernel exit is prompt and never falls back");
            Console.WriteLine($"Host exit wait {HostExitWait.PathName}: exit callback in {elapsed.Elapsed.TotalMilliseconds:F1} ms.");
        }
        finally
        {
            if (!child.HasExited) child.Kill();
            child.WaitForExit();
        }
    }

    private static void AlreadyReapedHostIsGone()
    {
        using var child = StartChild();
        var pid = child.Id;
        child.Kill();
        child.WaitForExit();
        var arm = HostExitWait.Arm(pid);
        Assert(arm.Kind == HostExitWait.ArmKind.HostGone, $"reaped host is gone at arm: {arm.Kind} {arm.Reason}");
        Assert(arm.Handle == -1, "gone-at-arm retains no descriptor");
    }

    private static Process StartChild() => Process.Start(new ProcessStartInfo("/bin/sleep", "30")
    {
        UseShellExecute = false,
    }) ?? throw new InvalidOperationException("could not start sleep child");

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"HostExitWaitTests failed: {message}");
    }
}
