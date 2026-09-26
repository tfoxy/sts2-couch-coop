using System.Runtime.CompilerServices;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Session;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Runs;

namespace CouchCoop.Mod.Runtime;

/// <summary>
/// CouchCoop's own front for its typed game facts. Every read goes through the zero-client tripwire, so a new
/// caller that reads the game at zero demand shows up as <c>[idle-work]</c> instead of costing nothing visible, and
/// a reader that throws is "unavailable" rather than a crash in the caller. Call sites pass nothing: the caller is
/// taken from the compiler.
/// </summary>
/// <remarks>
/// The seam (<see cref="Source"/>) exists so a test can count reads and inject a reader that throws, without an
/// engine. Like <see cref="GameScreenContext"/>, this lives in <c>Runtime/</c>, which the hot-reload assembly does
/// not link, so the tripwire's counters exist once.
/// </remarks>
public static partial class CouchCoopGameFacts
{
    /// <summary>Test seam. Production is <see cref="GameFactsReader"/>.</summary>
    internal static IGameFacts Source { get; set; } = GameFactsReader.Instance;

    /// <summary>
    /// The facts the QR gates decide on, or <see langword="null"/> when they could not be read. CALLERS MUST BE AT A
    /// FRAME BOUNDARY, never inside a game callback: see the QR host panel's <c>WakeEvaluation</c>.
    /// </summary>
    public static GateFacts? ReadGates(
        object? currentScreen,
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.HostFactsRead, caller, file);
        try
        {
            return Source.ReadGates(currentScreen);
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"gate facts read failed detail={exception.GetType().Name}: {exception.Message}");
            return null;
        }
    }

    // ---- WP3 path 7: run presence for a browser disconnect and a seat launch -----------------------------------

    /// <summary>
    /// Whether the host's game is in a run, or <see langword="null"/> when that could not be read (see
    /// <see cref="IGameFacts.ReadRunInProgress"/>). Safe from any thread and under a mod lock: the read is one
    /// member of the run manager and neither marshals to the main thread nor touches an engine object. It is an
    /// on-demand read for a user action (a browser disconnect, a seat launch), never something to poll.
    /// </summary>
    public static bool? ReadRunInProgress(
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.HostFactsRead, caller, file);
        try
        {
            return Source.ReadRunInProgress();
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"run presence read failed detail={exception.GetType().Name}: {exception.Message}");
            return null;
        }
    }
}

/// <summary>
/// The production reader: the run manager and the current lobby screen, typed against the game assemblies. The
/// same members exist, with the same shapes, on both API lanes, so there is no lane split here.
/// </summary>
internal sealed partial class GameFactsReader : IGameFacts
{
    internal static GameFactsReader Instance { get; } = new();

    public GateFacts? ReadGates(object? currentScreen)
    {
        // Every game type below is touched only from ReadGatesFromGame, which is never JIT-compiled in a process
        // with no engine behind it: a test process can load the game assemblies and then fault in native code.
        if (!CouchCoopMod.EngineAvailable)
        {
            return null;
        }

        return ReadGatesFromGame(currentScreen);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static GateFacts? ReadGatesFromGame(object? currentScreen)
    {
        if (RunInProgressFromGame() is not { } running)
        {
            return null;
        }

        var runNetType = running ? NetTypeName(RunManager.Instance?.NetService?.Type) : null;
        return new GateFacts(running, LobbyNetType(currentScreen), runNetType);
    }

    // ---- WP3 path 7: run presence for a browser disconnect and a seat launch -----------------------------------

    public bool? ReadRunInProgress()
        => CouchCoopMod.EngineAvailable ? RunInProgressFromGame() : null;

    /// <summary>
    /// THE one read of run presence, shared by the QR gates, the hosting tracker (through the front) and the
    /// disconnect and seat-launch callers. It is the run manager's own presence flag, so it is true through the
    /// end-of-run summary and false on every lobby screen. Both API lanes declare the member identically.
    /// </summary>
    /// <remarks>
    /// Thread-safe by construction, which is why callers on WebSocket and listener threads may use it directly:
    /// the manager is a process-wide singleton and the flag is a plain read of one reference, with no engine call
    /// behind it. A read that races a run starting or ending returns one side of that change, exactly as the
    /// marshalled full-state read it replaces did.
    /// </remarks>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool? RunInProgressFromGame()
        => RunManager.Instance is { } manager ? manager.IsInProgress : null;

    /// <summary>
    /// The net game type of the lobby on <paramref name="screen"/>, or null when it is not a lobby screen or its
    /// lobby is not assigned. The new-run screen exposes its lobby; the saved-run screen does not, so its role is
    /// the one its assignment hook recorded (see <see cref="LobbyAssignmentRecord"/>).
    /// </summary>
    private static string? LobbyNetType(object? screen)
        => screen switch
        {
            NCharacterSelectScreen characterSelect => characterSelect.Lobby is { } lobby
                ? NetTypeName(lobby.NetService?.Type)
                : null,
            NMultiplayerLoadGameScreen loadRun => LobbyAssignmentRecord.TryGet(loadRun, out var role) ? role : null,
            _ => null,
        };

    /// <summary>The game's net game type as CouchCoop's lower-case name; a missing service is <see cref="NetTypeNames.Unknown"/>.</summary>
    internal static string NetTypeName(NetGameType? type)
        => type switch
        {
            NetGameType.Host => NetTypeNames.Host,
            NetGameType.Client => NetTypeNames.Client,
            NetGameType.Singleplayer => NetTypeNames.Singleplayer,
            NetGameType.Replay => NetTypeNames.Replay,
            NetGameType.None => NetTypeNames.None,
            _ => NetTypeNames.Unknown,
        };
}
