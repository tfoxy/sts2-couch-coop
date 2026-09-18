using System.Globalization;
using System.Runtime.CompilerServices;

namespace CouchCoop.Mod.Server;

/// <summary>
/// The browser server's REAL port, written into this process's Godot user dir so something outside the process
/// can find it.
/// </summary>
/// <remarks>
/// <para>
/// WHY IT EXISTS. <c>COUCHCOOP_PREFERRED_PORT</c> is a PREFERENCE, not an assignment:
/// <see cref="CouchCoopBrowserServer.StartAsync"/> walks upward when the preferred port is taken, so a launcher
/// that assumes its request was honoured can end up talking to a completely different process — or, more often,
/// waiting forever on a port nothing ever binds. The same reasoning already produced
/// <see cref="SecureOriginEndpoint"/>, but that one is published over HTTP and so is only reachable by someone who
/// already knows the port; this is the bootstrap case, where the port is exactly what is missing.
/// </para>
/// <para>
/// WHY A FILE AND NOT A LOG LINE. The port has to be readable by a QA script that did not capture the game's
/// stdout (a detached launch nulls it), that may attach to an instance somebody else started, and that must be
/// able to tell "not up yet" from "up on a port I did not expect". A file in the instance's own user dir is
/// addressable from the instance NAME alone, which is the only handle such a script reliably has.
/// </para>
/// <para>
/// IT CARRIES THE PID, and that is not decoration. The file is removed on a clean stop, but <c>sts2 game close</c>
/// KILLS the process — verified — so a stale entry outliving its listener is the normal case, not the edge one.
/// A stale port is worse than no port: another process can bind it, and a reader that trusted the file would then
/// drive somebody else's game. The writer's own pid makes the record self-invalidating, and
/// <c>scripts/lib/instance-port.mjs</c> refuses a file whose process is gone.
/// </para>
/// </remarks>
public static class BrowserPortFile
{
    /// <summary>The file name, inside <c>user://couch-coop/</c>. Read by <c>scripts/lib/instance-port.mjs</c>.</summary>
    public const string FileName = "browser-port";

    /// <summary>
    /// The env var a spawned seat carries its slot number in (see
    /// <c>HeadlessClientManager.SeatLaunchEnvironment</c>). Present only in a seat process.
    /// </summary>
    private const string SlotEnvironmentVariable = "COUCHCOOP_HEADLESS_SLOT";

    /// <summary>
    /// The file name this process writes: the plain one for a HOST, a per-slot one for a SEAT.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A seat normally gets an isolated <c>user://</c>, so its record already lands in a directory of its own
    /// and this makes no difference. If preparation falls back to the shared host profile on any platform (see
    /// <c>HeadlessUserDirSeeder</c>), every process resolves the SAME path and the record stops describing
    /// anybody: the last seat to start overwrites the host's port with its own, and the first seat to stop
    /// deletes the file outright. Scoping the seats fixes both without moving anything a reader knows about.
    /// </para>
    /// <para>
    /// THE HOST'S NAME IS FIXED, deliberately. <c>scripts/lib/instance-port.mjs</c> and the bring-up scripts
    /// address an instance by its user dir and expect <c>couch-coop/browser-port</c> there, and the instance a
    /// QA script launches is always a host. A seat's port is not discovered from a file at all — it is
    /// <c>SlotToPort(slot)</c>, known to the host before the process exists.
    /// </para>
    /// </remarks>
    internal static string FileNameFor(string? headlessSlot)
        => int.TryParse(headlessSlot?.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var slot)
            ? FileNameFor(slot)
            : FileName;

    /// <inheritdoc cref="FileNameFor(string?)"/>
    internal static string FileNameFor(int slot)
        => slot > 0 ? $"{FileName}-slot-{slot.ToString(CultureInfo.InvariantCulture)}" : FileName;

    /// <summary>
    /// Read a record somebody else wrote, by path: the port a process says it bound, and its pid.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The HOST reads a SEAT's record with this, and it is the one thing the host can learn about a seat
    /// WITHOUT a network round trip of any kind. That matters in exactly one situation, and it is the situation
    /// this was added for: a seat whose authenticated control channel to the host is not working reports
    /// nothing, so the host's only other evidence that the seat is alive and serving would be a loopback probe
    /// — over the very transport that is in doubt. A file needs none.
    /// </para>
    /// <para>
    /// THE PID IS THE POINT, and the caller must check it (see the class remarks): <c>sts2 game close</c> kills
    /// a seat, so a record outliving its process is the normal case, not the edge one. Returning the pid rather
    /// than validating it here keeps the check with the caller that knows which process it expects.
    /// </para>
    /// <para>
    /// Total: an unreadable, absent, truncated or foreign file is <see langword="null"/>, never a throw. This
    /// is diagnostic evidence, and a missing answer is a normal one.
    /// </para>
    /// </remarks>
    internal static (int Port, int Pid)? Read(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path));
            if (document.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object) return null;
            return document.RootElement.TryGetProperty("port", out var port)
                && document.RootElement.TryGetProperty("pid", out var pid)
                && port.TryGetInt32(out var portValue)
                && pid.TryGetInt32(out var pidValue)
                && portValue is > 0 and <= ushort.MaxValue
                && pidValue > 0
                ? (portValue, pidValue)
                : null;
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or System.Text.Json.JsonException
            or ArgumentException
            or NotSupportedException)
        {
            return null;
        }
    }

    /// <summary>Write the bound HTTP port. No-op when the user dir cannot be resolved (headless tests).</summary>
    public static void Publish(int port)
    {
        var path = TryResolvePath();
        if (path is null)
        {
            return;
        }

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            // One line of JSON, written whole (never appended) so a reader cannot catch a half-updated value.
            File.WriteAllText(
                path,
                "{\"port\":"
                    + port.ToString(CultureInfo.InvariantCulture)
                    + ",\"pid\":"
                    + Environment.ProcessId.ToString(CultureInfo.InvariantCulture)
                    + "}\n");
        }
        catch (IOException)
        {
            // A read-only or racing user dir is not a reason to fail a launch.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>Remove the file on a clean stop, so a later reader does not trust a port nothing is serving.</summary>
    public static void Clear()
    {
        var path = TryResolvePath();
        if (path is null)
        {
            return;
        }

        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static string? TryResolvePath()
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
            return TryResolveGodotPath();
        }
        catch
        {
            // GodotSharp failed to LOAD at all (the hosted-server harness) — the case the latch does not cover.
            return null;
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static string? TryResolveGodotPath()
    {
        var globalized = Godot.ProjectSettings.GlobalizePath(
            "user://couch-coop/" + FileNameFor(Environment.GetEnvironmentVariable(SlotEnvironmentVariable)));
        return string.IsNullOrWhiteSpace(globalized) || globalized.StartsWith("user://", StringComparison.Ordinal)
            ? null
            : globalized;
    }
}
