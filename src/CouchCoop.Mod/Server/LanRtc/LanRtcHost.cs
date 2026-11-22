using System.Globalization;
using System.Net;
using CouchCoop.Mod.HostUi;

namespace CouchCoop.Mod.Server.LanRtc;

internal delegate LanRtcModule? LanRtcModuleFactory(LanRtcIdentity identity, IPEndPoint candidate,
    BrowserPortUdpSocket socket, Action<string> log, uint sendBudget);

internal sealed class LanRtcHost : IAsyncDisposable
{
    internal const string SendBudgetEnvironmentVariable = "COUCHCOOP_LAN_RTC_SEND_BUDGET";

    // Opt-in while bulk transfer over the data channel stays much slower than direct LAN HTTP on phones: an
    // unadvertised tunnel keeps `f` out of the Website QR, so players load over the fast direct path.
    internal const string EnableEnvironmentVariable = "COUCHCOOP_LAN_RTC";

    internal static bool EnabledByEnvironment()
        => Environment.GetEnvironmentVariable(EnableEnvironmentVariable)?.Trim() == "1";
    private readonly LanRtcModule _module;
    private readonly LanRtcTunnel _tunnel;
    private readonly IDisposable _publication;
    private int _stopped;

    private LanRtcHost(LanRtcModule module, LanRtcTunnel tunnel, IDisposable publication)
    { _module = module; _tunnel = tunnel; _publication = publication; }

    internal static LanRtcHost? TryStart(IPEndPoint candidate, BrowserPortUdpSocket socket,
        Func<Stream, IPAddress, CancellationToken, Task> serve, Action<string> log,
        string? identityStorageRoot = null, LanRtcModuleFactory? createModule = null)
    {
        if (!socket.IsListening || !BrowserPortUdpSocket.IsRtcSource(candidate.Address)) return null;
        LanRtcModule? module = null;
        try
        {
            var setting = Environment.GetEnvironmentVariable(SendBudgetEnvironmentVariable);
            if (!uint.TryParse(setting ?? "0", NumberStyles.None, CultureInfo.InvariantCulture, out var budget))
                throw new ArgumentException($"Invalid {SendBudgetEnvironmentVariable}.");
            // The budget is association-wide, while Low is per channel and fires on draining to zero.
            if (budget is > 0 and < 65536)
            {
                try { log($"LAN RTC ignoring {SendBudgetEnvironmentVariable} below 65536; using the module default."); } catch { }
                budget = 0;
            }
            using var identity = LanRtcIdentity.LoadOrCreate(identityStorageRoot, log);
            module = createModule is null
                ? LanRtcModule.TryCreate(identity, candidate, socket, log, budget)
                : createModule(identity, candidate, socket, log, budget);
            if (module is null) return null;
            var publication = LanRtcAvailability.Publish(candidate, identity.Fingerprint);
            try { return new LanRtcHost(module, new LanRtcTunnel(module, serve, candidate, log), publication); }
            catch { publication.Dispose(); throw; }
        }
        catch (Exception exception)
        {
            module?.Dispose();
            try { log($"LAN RTC unavailable: {exception.Message}"); } catch { }
            return null;
        }
    }

    // Withdraw readiness and unregister/destroy before the owner starts tearing down its UDP socket.
    internal void Stop()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        _publication.Dispose();
        _module.Dispose();
    }

    public async ValueTask DisposeAsync()
    {
        Stop();
        await _tunnel.DisposeAsync().ConfigureAwait(false);
    }
}
