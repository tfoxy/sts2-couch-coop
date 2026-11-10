using System.Runtime.InteropServices;
using CouchCoop.Mod.Session;

internal static class HeadlessProcessExitTests
{
    public static void Run()
    {
        LeaveLogsFlushesThenExits();
        LeaveExitsWhenLoggingThrows();
        LeaveFallsBackWhenThePlatformExitThrows();
        SelectRoutesPosixWindowsAndOther();
        TheExitLineNamesTheReason();
        Console.WriteLine("HeadlessProcessExitTests: 5 passed.");
    }

    private static void LeaveLogsFlushesThenExits()
    {
        foreach (var route in Enum.GetValues<HeadlessProcessExit.Route>())
        {
            var trace = new List<string>();
            HeadlessProcessExit.Leave("host-gone",
                _ => trace.Add("log"),
                _ => trace.Add("flush"),
                selected => trace.Add($"platform:{selected}"),
                () => trace.Add("managed"), route);
            Assert(string.Join(",", trace) == $"log,flush,platform:{route},managed",
                $"{route} logs, flushes and exits, with managed fallback if the primitive returns");
        }
    }

    private static void LeaveExitsWhenLoggingThrows()
    {
        foreach (var failLog in new[] { false, true })
        foreach (var failFlush in new[] { false, true })
        {
            var trace = new List<string>();
            HeadlessProcessExit.Leave("host-gone",
                _ => { trace.Add("log"); if (failLog) throw new IOException("log failed"); },
                _ => { trace.Add("flush"); if (failFlush) throw new IOException("flush failed"); },
                _ => trace.Add("platform"),
                () => trace.Add("managed"), HeadlessProcessExit.Route.PosixExit);
            Assert(string.Join(",", trace) == "log,flush,platform,managed",
                $"log failure={failLog}, flush failure={failFlush} cannot skip either exit");
        }
    }

    private static void LeaveFallsBackWhenThePlatformExitThrows()
    {
        foreach (var route in Enum.GetValues<HeadlessProcessExit.Route>())
        {
            var managed = 0;
            HeadlessProcessExit.Leave("host-gone", _ => { }, _ => { },
                _ => throw new DllNotFoundException("native primitive unavailable"),
                () => managed++, route);
            Assert(managed == 1, $"{route} failure reaches the managed exit exactly once");
        }
    }

    private static void SelectRoutesPosixWindowsAndOther()
    {
        foreach (var platform in new[] { OSPlatform.Linux, OSPlatform.OSX, OSPlatform.FreeBSD, OSPlatform.Windows })
        {
            var route = HeadlessProcessExit.Select(candidate => candidate == platform);
            var expected = platform == OSPlatform.Windows
                ? HeadlessProcessExit.Route.WindowsTerminate : HeadlessProcessExit.Route.PosixExit;
            Assert(route == expected, $"{platform} selects {expected}");
        }

        Assert(HeadlessProcessExit.Select(_ => false) == HeadlessProcessExit.Route.ManagedExit,
            "an unknown platform uses managed exit");
    }

    private static void TheExitLineNamesTheReason()
    {
        string? logged = null;
        string? flushed = null;
        HeadlessProcessExit.Leave("run-in-progress", line => logged = line, line => flushed = line,
            _ => { }, () => { }, HeadlessProcessExit.Route.ManagedExit);
        Assert(logged == "headless disconnect-exit: leaving the process without SceneTree.Quit (reason=run-in-progress)",
            "the exit line names the trigger");
        Assert(flushed == logged, "the flushed line is the same as the normal log line");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"HeadlessProcessExitTests: {message}");
    }
}
