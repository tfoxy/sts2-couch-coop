extern alias bridge;
extern alias bridgecore;
using CouchCoop.Mod.Loader;

/// <summary>
/// Pins CouchCoop's local shell to the actual reflection control in the bridge-only assembly, rather than a
/// hand-written test double. The shell protocol is owned by spirectl (v0); CouchCoop's logic contract is a
/// separate compatibility boundary and deliberately remains v1.
/// </summary>
internal static class HotReloadInteropTests
{
    public static void Run()
    {
        var shellAssembly = typeof(CouchCoopHotReloadProtocol).Assembly;
        Expect(shellAssembly.GetName().Name == "couchcoop", "test loaded the CouchCoop shell assembly");

        var logStream = new bridgecore::Spirectl.Sts2.Core.Logging.InMemoryLogStream();
        var control = new bridge::Spirectl.Sts2.Core.HotReload.ReflectionHotReloadControl(logStream);

        var result = control.GetStatus(new bridge::Spirectl.Sts2.Core.HotReload.HotReloadStatusRequestSnapshot(
            "couchcoop-hot-reload-interop",
            "couchcoop",
            "couchcoop"));

        Expect(result.Error is null, "embedded reflection control reports no lookup error");
        var status = result.Status;
        Expect(status is not null, "embedded reflection control returns shell status");
        Expect(status!.Supported, "embedded reflection control discovers CouchCoop shell");
        Expect(status.ShellModId == "couchcoop", "embedded reflection control discovers the CouchCoop shell id");
        Expect(status.Protocol?.Id == "spirectl.m57.hot-reload-shell", "embedded reflection control discovers the spirectl shell protocol");
        Expect(status.Protocol?.Version == 0, "embedded reflection control discovers protocol v0 in the protocol envelope");
        Expect(status.ShellProtocolVersion == 0, "embedded reflection control discovers protocol v0");
        Expect(status.ContractVersion == 1, "embedded reflection control preserves CouchCoop contract v1");
        Expect(
            logStream.Read(new bridgecore::Spirectl.Sts2.Core.Logging.LogQuery(20, AfterCursor: null, MinimumLevel: null, TargetFilter: null)).Entries
                .Any(entry => entry.Target == "bridge.hot_reload"),
            "embedded reflection control records its successful status inspection");
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"HotReloadInteropTests: {message}");
        }
    }
}
