using System.Diagnostics;
using System.Text.RegularExpressions;
using CouchCoop.Mod.Session;

internal static class SeatStopEventTests
{
    internal const string Verb = "seat-stop-event";
    private static int _checks;

    internal static void Run()
    {
        var psi = new ProcessStartInfo();
        psi.Environment[StreamingSeatRole.EnvironmentVariable] = "1";
        using var stop = SeatStopEvent.PrepareLaunch(psi, true, 123, 2, name => new FakeEvent(name));
        Check(stop is not null && psi.Environment[SeatStopEvent.EnvironmentVariable] == stop.Name,
            "Windows streaming launch carries its owned event");
        Check(Regex.IsMatch(stop!.Name, @"^Local\\CouchCoop\.SeatStop\.\d+\.\d+\.[0-9a-f]{32}$"), "event name format");
        using var second = SeatStopEvent.PrepareLaunch(psi, true, 123, 2, name => new FakeEvent(name));
        Check(second!.Name != stop.Name, "every launch has a fresh random event");
        foreach (var (windows, streaming) in new[] { (true, false), (false, true), (false, false) })
        {
            psi.Environment[StreamingSeatRole.EnvironmentVariable] = streaming ? "1" : "0";
            psi.Environment[SeatStopEvent.EnvironmentVariable] = "inherited";
            Check(SeatStopEvent.PrepareLaunch(psi, windows, 123, 2, _ => throw new Exception("must not create")) is null
                && !psi.Environment.ContainsKey(SeatStopEvent.EnvironmentVariable), "only Windows streaming launches own events");
        }

        var host = new FakeEvent("host");
        using (var process = new OsHeadlessProcess(new Process(), host))
        {
            Check(process.RequestGracefulStop(isWindows: true, isUnix: false) && host.Sets == 1,
                "Windows graceful stop sets the event");
            host.ThrowOnSet = true;
            Check(!process.RequestGracefulStop(isWindows: true, isUnix: false), "failed signal permits kill backstop");
        }
        Check(host.Disposed, "process disposes its event");
        using (var process = new OsHeadlessProcess(new Process()))
            Check(!process.RequestGracefulStop(isWindows: true, isUnix: false), "ordinary Windows seat has no graceful trigger");

        var seat = new FakeEvent("seat");
        var reasons = new List<string>();
        using (SeatStopEvent.Listen(seat, reason => { reasons.Add(reason); return true; }))
        {
            seat.Signal(); seat.Signal();
            Check(reasons.SequenceEqual(new[] { "host-stop" }), "seat requests host-stop exactly once");
        }
        Check(seat.Disposed && seat.Unregistered, "seat listener releases registration and event");

        if (OperatingSystem.IsLinux())
        {
            using var child = Process.Start(new ProcessStartInfo("/bin/sleep", "30") { UseShellExecute = false })!;
            using var process = new OsHeadlessProcess(child);
            try
            {
                Check(process.RequestGracefulStop(), "Linux sends SIGTERM without a Windows event");
                Check(child.WaitForExit(3000) && child.ExitCode == 128 + 15, "Linux child exits on SIGTERM");
            }
            finally { if (!child.HasExited) child.Kill(entireProcessTree: true); }
        }
        else Console.WriteLine("Linux SIGTERM check: skipped (not Linux)");
        Console.WriteLine($"seat stop event: {_checks} passed.");
    }

    private sealed class FakeEvent(string name) : ISeatStopEvent
    {
        private Action? _signal;
        public string Name => name;
        internal int Sets;
        internal bool Disposed, Unregistered, ThrowOnSet;
        public bool Set()
        {
            if (ThrowOnSet) throw new IOException();
            Sets++;
            return true;
        }
        public IDisposable Register(Action onSignal) { _signal = onSignal; return new Registration(this); }
        internal void Signal() => _signal?.Invoke();
        public void Dispose() => Disposed = true;
        private sealed class Registration(FakeEvent owner) : IDisposable
        {
            public void Dispose() { owner.Unregistered = true; owner._signal = null; }
        }
    }

    private static void Check(bool ok, string message)
    {
        if (!ok) throw new Exception("[SeatStopEventTests] " + message);
        _checks++;
    }
}
