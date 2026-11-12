using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;

namespace CouchCoop.Mod.Session;

internal interface ISeatStopEvent : IDisposable
{
    string Name { get; }
    bool Set();
    IDisposable Register(Action onSignal);
}

/// <summary>A Windows streaming seat's kernel signal for the common capture-disarm exit sequence.</summary>
internal static class SeatStopEvent
{
    internal const string EnvironmentVariable = "COUCHCOOP_SEAT_STOP_EVENT";

    internal static string? LaunchName(bool isWindows, bool streaming, int hostPid, int slot, string randomHex)
        => isWindows && streaming
            ? "Local\\CouchCoop.SeatStop." + hostPid.ToString(CultureInfo.InvariantCulture) + "."
                + slot.ToString(CultureInfo.InvariantCulture) + "." + randomHex
            : null;

    internal static ISeatStopEvent? PrepareLaunch(ProcessStartInfo psi, bool isWindows, int hostPid, int slot,
        Func<string, ISeatStopEvent> create)
    {
        psi.Environment.Remove(EnvironmentVariable);
        psi.Environment.TryGetValue(StreamingSeatRole.EnvironmentVariable, out var role);
        var streaming = StreamingSeatRole.IsRequested(role);
        if (!isWindows || !streaming) return null;
        var name = LaunchName(isWindows, streaming, hostPid, slot,
            Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant());
        var stop = create(name!);
        psi.Environment[EnvironmentVariable] = name;
        return stop;
    }

    internal static ISeatStopEvent Create(string name)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        return new NamedEvent(name, new EventWaitHandle(false, EventResetMode.ManualReset, name));
    }

    internal static ISeatStopEvent Open(string name)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        return new NamedEvent(name, EventWaitHandle.OpenExisting(name));
    }

    internal static IDisposable Listen(ISeatStopEvent stop, Func<string, bool> requestExit)
    {
        try { return new Listener(stop, requestExit); }
        catch { stop.Dispose(); throw; }
    }

    private sealed class NamedEvent(string name, EventWaitHandle handle) : ISeatStopEvent
    {
        public string Name => name;
        public bool Set() => handle.Set();
        public IDisposable Register(Action onSignal) => new Registration(ThreadPool.RegisterWaitForSingleObject(
            handle, (_, _) => onSignal(), null, Timeout.Infinite, executeOnlyOnce: true));
        public void Dispose() => handle.Dispose();
    }

    private sealed class Registration(RegisteredWaitHandle registration) : IDisposable
    {
        public void Dispose() => registration.Unregister(null);
    }

    private sealed class Listener : IDisposable
    {
        private readonly ISeatStopEvent _stop;
        private readonly IDisposable _registration;
        private int _signaled;

        internal Listener(ISeatStopEvent stop, Func<string, bool> requestExit)
        {
            _stop = stop;
            _registration = stop.Register(() =>
            {
                if (Interlocked.Exchange(ref _signaled, 1) == 0)
                    HeadlessTermSignal.Decide(requestExit, "host-stop");
            });
        }

        public void Dispose()
        {
            _registration.Dispose();
            _stop.Dispose();
        }
    }
}
