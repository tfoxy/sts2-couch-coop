using System.Runtime.CompilerServices;

namespace CouchCoop.Mod.Server;

/// <summary>
/// The one place this mod turns a file name into a real path inside <c>user://couch-coop/</c>.
/// </summary>
/// <remarks>
/// <para>
/// Two files live there and both are read from OUTSIDE the process that wrote them: the browser port a seat
/// bound (<see cref="BrowserPortFile"/>) and, when the loopback control channel is failing, the seat's own
/// status record (<see cref="SeatStatusFile"/>). They resolve their directory identically, and the resolution
/// carries a hazard worth stating exactly once rather than twice.
/// </para>
/// </remarks>
internal static class CouchCoopUserFile
{
    /// <summary>The directory, inside the process's Godot user dir, both records live in.</summary>
    /// <remarks>
    /// The host reads a seat's copy of this from the outside, where the same directory is
    /// <c>&lt;SlotUserDir&gt;/couch-coop/</c> — see <c>HeadlessUserDirSeeder.CouchCoopDirName</c>, which is the
    /// same name from that side and is what <c>HeadlessClientManager.CaptureSeatFilePathsLocked</c> composes with.
    /// </remarks>
    internal const string DirectoryName = "couch-coop";

    /// <summary>
    /// The absolute path of <paramref name="fileName"/> inside this process's <c>user://couch-coop/</c>, or
    /// <see langword="null"/> where there is no engine to ask.
    /// </summary>
    internal static string? TryResolve(string fileName)
    {
        // THE LATCH, NOT THE TRY/CATCH, IS WHAT MAKES THIS SAFE — and the try/catch alone is not merely
        // insufficient, it is a trap. `ProjectSettings.GlobalizePath` is a native interop call: in a process that
        // has GodotSharp on its probing path but no engine behind it (which `tests/CouchCoop.Mod.Tests` is — it
        // copies the DLL, and it really does start a browser server), the managed call JITs fine and then
        // SEGFAULTS in native code, which no `catch` can see. This exact call cost a test run with SIGSEGV before
        // the latch went in. `CouchCoopMod.EngineAvailable` is latched true from
        // `CouchCoopMod.Init()`, i.e. only inside a real Godot process, and its own remarks name this hazard.
        if (!CouchCoopMod.EngineAvailable)
        {
            return null;
        }

        try
        {
            return TryResolveGodotPath(fileName);
        }
        catch
        {
            // GodotSharp failed to LOAD at all (the hosted-server harness) — the case the latch does not cover.
            return null;
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static string? TryResolveGodotPath(string fileName)
    {
        var globalized = Godot.ProjectSettings.GlobalizePath("user://" + DirectoryName + "/" + fileName);
        return string.IsNullOrWhiteSpace(globalized) || globalized.StartsWith("user://", StringComparison.Ordinal)
            ? null
            : globalized;
    }
}
