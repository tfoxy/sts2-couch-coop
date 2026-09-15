using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// The one way a patch says it could not be installed.
/// </summary>
/// <remarks>
/// <para>
/// Each patch used to write its own <c>Console.Error</c> line and nothing else. That stream is captured by a
/// launcher and discarded by a Steam-launched game — on macOS it goes nowhere at all — so the whole patch set
/// could fail with <c>godot.log</c> carrying six CouchCoop lines, none of them about it. The same reasoning that
/// gave <c>LobbyScreenMountPatch</c> its <see cref="CouchCoopLog"/> line, applied to the rest of them.
/// </para>
/// <para>
/// Both writes happen, deliberately: stderr still wins when the game IS attached to a terminal, and the
/// <see cref="CouchCoopLog"/> write is the only channel that reaches <c>godot.log</c> in the shipped flow — which
/// is also the file the connections panel excerpts into a copyable report. That excerpt keeps only ERROR-tagged
/// entries, so a patch failure that logged at info level would not reach the report a player sends.
/// </para>
/// </remarks>
internal static class CouchCoopPatchDiagnostics
{
    /// <param name="patch">The patch type's name, as it should appear in the log line and the report fact.</param>
    /// <param name="detail">What failed, in the patch's own words — appended after the <c>patch:</c> prefix.</param>
    /// <param name="costsCoop">
    /// Whether losing this patch costs the lobby QR button or a seat's ability to join, i.e. whether the player
    /// should be told at all. See <see cref="CouchCoopPatchHealth.PatchFailed"/>.
    /// </param>
    internal static void PatchFailed(string patch, string detail, bool costsCoop)
    {
        var message = $"[couchcoop] {patch}: {detail}";
        Console.Error.WriteLine(message);
        CouchCoopLog.Error(message);
        CouchCoopPatchHealth.PatchFailed(patch, costsCoop, message);
    }
}
