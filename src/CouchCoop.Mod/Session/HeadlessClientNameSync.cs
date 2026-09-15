using System.IO;
using CouchCoop.Mod.Runtime;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Keeps a couch SEAT's player names current with the host's durable roster (<c>mp_names.json</c>).
///
/// <para><b>Why a seat needs this at all.</b> Names never travel over the wire: every label the game draws
/// resolves through <c>PlatformUtil.GetPlayerNameRaw(NetService.Platform, netId)</c>, and a seat's platform is
/// <c>None</c> → <c>NullPlatformUtilStrategy</c>, which reads <c>mp_names.json</c> exactly ONCE in its constructor
/// and otherwise prints the raw netId. So a seat that was already running when somebody else joined can never
/// learn that player's name by itself — the host rewrites the roster file before spawning each newcomer, long
/// after this process read it. Re-reading the file here and pushing each entry onto this process's own
/// display-name override registry (<see cref="CouchCoopLobbyParticipation.SetClientName"/>, resolved by
/// spirectl's <c>GetPlayerNameRaw</c> hook) is what closes that gap.</para>
///
/// <para><b>Why it polls instead of riding the state observer.</b> It used to be a <c>StateChanged</c> handler on
/// <c>CouchCoopBrowserServer</c>'s state observer — which is exactly why it silently stopped working: that
/// observer is refcounted on connections that want STATE, and a seat being played has only a streaming mirror
/// connection (<c>WantsState == false</c>), so the observer is stopped for the entire time the seat is in use. It
/// ran only while the viewer sat on the pre-join picker. A seat's name map must not depend on what its browser
/// happens to be doing, so the sync owns its own clock.</para>
///
/// <para><b>Timing.</b> The host writes the roster BEFORE it launches a newcomer's seat, and that seat needs
/// ~20-60s to boot and complete its ENet handshake — so a <see cref="PollInterval"/> poll lands the override many
/// seconds before the newcomer's widget is built here, which is what matters: the game stamps a nameplate once,
/// from whatever the lookup returns at that moment.</para>
/// </summary>
internal sealed class HeadlessClientNameSync
{
    /// <summary>
    /// How often the roster file is STATTED (not read). A read + a semantic action only follow a real change, so
    /// the steady-state cost is one <c>FileInfo</c> probe per interval on a background thread.
    /// </summary>
    internal static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);

    // Length of the only legitimately empty roster ("[]"). Anything longer that parses to nothing was read
    // mid-write or is corrupt — see SyncOnce.
    private const int EmptyRosterLength = 2;

    private static HeadlessClientNameSync? _running;
    private static readonly object StartGate = new();

    private readonly Func<(DateTime WriteTimeUtc, long Length)?> _stat;
    private readonly Func<IReadOnlyDictionary<ulong, string>> _readRoster;
    private readonly Func<ulong, string, bool> _apply;
    // What this process has SUCCESSFULLY applied, so a tick costs an action only on a real change. Keyed on
    // success deliberately: an apply that no-opped because the runtime host was not up yet (early boot) must be
    // retried on the next tick, not remembered as done.
    private readonly Dictionary<ulong, string> _applied = [];
    private (DateTime WriteTimeUtc, long Length)? _lastStat;

    internal HeadlessClientNameSync(
        Func<(DateTime WriteTimeUtc, long Length)?> stat,
        Func<IReadOnlyDictionary<ulong, string>> readRoster,
        Func<ulong, string, bool> apply)
    {
        _stat = stat;
        _readRoster = readRoster;
        _apply = apply;
    }

    /// <summary>
    /// Start the seat-side sync loop. Idempotent; call only on a headless seat (the host names clients directly
    /// as they join and has no roster to catch up on).
    /// </summary>
    internal static void Start(CouchCoopRuntimeHost runtimeHost)
    {
        ArgumentNullException.ThrowIfNull(runtimeHost);
        lock (StartGate)
        {
            if (_running is not null)
            {
                return;
            }

            var lobby = new CouchCoopLobbyParticipation(runtimeHost);
            var sync = new HeadlessClientNameSync(
                StatRosterFile,
                HeadlessClientManager.ReadMultiplayerNames,
                (netId, name) => lobby.SetClientName(netId, name));
            _running = sync;
            _ = Task.Run(sync.RunAsync);
        }
    }

    // A SERIAL loop rather than a Timer, and one that WAITS before its first tick. An apply marshals to — and
    // blocks on — the Godot main thread, which is not pumping at all when Start runs (the mod initializes before
    // the SceneTree exists), so overlapping timer callbacks would pile threads up behind that. Nothing is lost by
    // waiting: whatever the roster said at boot, the game itself already read it at construction; this loop exists
    // for what changes AFTERWARDS.
    private async Task RunAsync()
    {
        while (true)
        {
            await Task.Delay(PollInterval).ConfigureAwait(false);

            try
            {
                SyncOnce();
            }
            catch (Exception exception)
            {
                // Naming is cosmetic; a failed tick must never take the seat down. Next tick retries.
                Console.Error.WriteLine(
                    $"[couchcoop] seat name sync tick failed: {exception.GetType().Name}: {exception.Message}");
            }
        }
    }

    /// <summary>
    /// One tick: if the roster file changed since the last read, apply every new/changed entry. Internal so the
    /// tests can drive it without a clock.
    /// </summary>
    internal void SyncOnce()
    {
        var stat = _stat();
        if (stat is null || (_lastStat is { } last && last.WriteTimeUtc == stat.Value.WriteTimeUtc && last.Length == stat.Value.Length))
        {
            return;
        }

        var roster = _readRoster();
        if (roster.Count == 0 && stat.Value.Length > EmptyRosterLength)
        {
            // The file says it has content but parsed to nothing — a torn read (the host rewrites it) or a
            // corrupt roster. Leave the stat unrecorded so the next tick reads it again rather than accepting
            // "no names" as the answer for the rest of this seat's life.
            return;
        }

        var applyFailed = false;
        foreach (var (netId, name) in roster)
        {
            if (_applied.TryGetValue(netId, out var applied) && string.Equals(applied, name, StringComparison.Ordinal))
            {
                continue;
            }

            if (_apply(netId, name))
            {
                _applied[netId] = name;
            }
            else
            {
                applyFailed = true;
            }
        }

        // Only accept the file as "seen" once everything in it landed — otherwise a tick during early boot (no
        // semantic-action capability yet) would consume the change and the names would never be applied.
        if (!applyFailed)
        {
            _lastStat = stat;
        }
    }

    private static (DateTime WriteTimeUtc, long Length)? StatRosterFile()
    {
        try
        {
            var info = new FileInfo(Path.Combine(Directory.GetCurrentDirectory(), HeadlessClientManager.MultiplayerNamesFile));
            return info.Exists ? (info.LastWriteTimeUtc, info.Length) : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
