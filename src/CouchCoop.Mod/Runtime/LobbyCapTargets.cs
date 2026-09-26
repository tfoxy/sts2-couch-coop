namespace CouchCoop.Mod.Runtime;

/// <summary>
/// Where the start-run lobby keeps its player cap on each game lane, as data with no game type in it, so the
/// metadata-only reference lane can check it against a staged <c>sts2.dll</c> without loading one.
/// </summary>
/// <remarks>
/// The lane split is the reason this is a table. One lane exposes the cap as a public integer property, which the
/// reader calls directly and the compiler therefore pins. The other keeps it in a private integer field the reader
/// has to look up by name (a maintainer-granted exception; see <c>GameFactsReader.StartRunLobbyCap</c>), so a build
/// that renames or retypes it would compile clean and read nothing. <c>CouchCoopGameFactsTests.LobbyCapMemberResolves</c>
/// pins it against the real build, and <c>MetadataOnlyLobbyScreenMountTests</c> against a staged one.
/// </remarks>
internal static class LobbyCapTargets
{
    internal const string StartRunLobbyType = "MegaCrit.Sts2.Core.Multiplayer.Game.Lobby.StartRunLobby";

    /// <summary>The private integer field read by name on the lane that has no public route.</summary>
    internal const string FieldName = "_maxPlayers";

    /// <summary>The getter of the public integer property the other lane reads directly.</summary>
    internal const string PropertyGetterName = "get_MaxPlayers";
}
