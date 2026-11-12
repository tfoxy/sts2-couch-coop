using System.ComponentModel;
using CouchCoop.Mod.Session;

internal static class WindowsSeatLifetimeTests
{
    internal const string Verb = "windows-seat-lifetime";

    internal static void Run()
    {
        JobIsLazySharedAndOwnedUntilDispose();
        UnixNeverCreatesAJob();
        FailedCreationDoesNotRetryOrFailSpawn();
        FailedAssignmentsLogOnceAndRetainJob();
        WatchIsOneShotAndOwnsItsRegistration();
        AlreadyGoneStartsExit();
        AccessDeniedDoesNotReportAHealthyHostDead();
        Console.WriteLine("Windows seat lifetime: 7 passed.");
    }

    private static void JobIsLazySharedAndOwnedUntilDispose()
    {
        var created = 0;
        var job = new Job();
        var owner = new WindowsSeatJob(true, () => { created++; return job; }, _ => { });
        Assert(created == 0, "no job before the first spawn");
        owner.Assign(() => (IntPtr)10);
        owner.Assign(() => (IntPtr)20);
        Assert(created == 1 && job.Handles.SequenceEqual(new IntPtr[] { 10, 20 }), "one job owns both seats");
        Assert(job.Disposals == 0, "job remains open between spawns");
        owner.Dispose();
        owner.Dispose();
        owner.Assign(() => throw new Exception("disposed owner accessed process"));
        Assert(job.Disposals == 1 && job.Handles.Count == 2, "job closes exactly once at shutdown");
    }

    private static void UnixNeverCreatesAJob()
    {
        using var owner = new WindowsSeatJob(false, () => throw new Exception("Windows call on Unix"), _ => { });
        owner.Assign(() => throw new Exception("Windows process handle on Unix"));
    }

    private static void FailedCreationDoesNotRetryOrFailSpawn()
    {
        var attempts = 0;
        var logs = 0;
        using var owner = new WindowsSeatJob(true,
            () => { attempts++; throw new Win32Exception(5); }, _ => logs++);
        owner.Assign(() => (IntPtr)10);
        owner.Assign(() => (IntPtr)20);
        Assert(attempts == 1 && logs == 1, "creation failure logs once and leaves spawning available");
    }

    private static void FailedAssignmentsLogOnceAndRetainJob()
    {
        var job = new Job { FailAssign = true };
        var logs = 0;
        var owner = new WindowsSeatJob(true, () => job, _ => { logs++; throw new IOException("log failed"); });
        owner.Assign(() => (IntPtr)10);
        owner.Assign(() => (IntPtr)20);
        Assert(logs == 1 && job.Handles.Count == 2 && job.Disposals == 0,
            "nested-job failures do not fail spawning or prematurely close the job");
        owner.Dispose();
        Assert(job.Disposals == 1, "failed assignment still releases the retained handle");
    }

    private static void WatchIsOneShotAndOwnsItsRegistration()
    {
        Action? callback = null;
        var exits = 0;
        var registration = new Registration();
        using (var watch = HeadlessHostWatchdog.ArmWindowsHostWatch(123,
            (pid, action) => { Assert(pid == 123, "watch pins the host PID"); callback = action; return registration; },
            () => exits++, _ => throw new Exception("unexpected failure")))
        {
            Assert(exits == 0 && registration.Disposals == 0, "live host and registration are retained");
            callback!();
            callback();
            Assert(exits == 1, "one kernel signal starts exit once");
        }
        Assert(registration.Disposals == 1, "watch releases its registration");
    }

    private static void AlreadyGoneStartsExit()
    {
        var exits = 0;
        using var watch = HeadlessHostWatchdog.ArmWindowsHostWatch(123,
            (_, _) => throw new Win32Exception(87), () => exits++, _ => { });
        Assert(exits == 1 && watch is null, "host lost before registration takes the same exit path");
    }

    private static void AccessDeniedDoesNotReportAHealthyHostDead()
    {
        var exits = 0;
        var logs = 0;
        using var watch = HeadlessHostWatchdog.ArmWindowsHostWatch(123,
            (_, _) => throw new Win32Exception(5), () => exits++, _ => logs++);
        Assert(exits == 0 && logs == 1 && watch is null, "access denied logs without falsely killing a seat");
    }

    private sealed class Job : IWindowsSeatJob
    {
        internal readonly List<IntPtr> Handles = [];
        internal bool FailAssign;
        internal int Disposals;
        public void Assign(IntPtr handle)
        {
            Handles.Add(handle);
            if (FailAssign) throw new Win32Exception(5);
        }
        public void Dispose() => Disposals++;
    }

    private sealed class Registration : IDisposable
    {
        internal int Disposals;
        public void Dispose() => Disposals++;
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("WindowsSeatLifetimeTests: " + message);
    }
}
