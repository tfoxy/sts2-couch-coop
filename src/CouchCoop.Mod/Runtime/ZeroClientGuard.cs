using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Runtime;

/// <summary>
/// One kind of game-state or scene work the zero-client tripwire watches. Declared once, in
/// <see cref="ZeroClientEntries"/>; the counter is per entry so a report can say which kind of work leaked.
/// </summary>
public sealed class ZeroClientEntry
{
    private static readonly List<ZeroClientEntry> Registered = [];
    private long _hits;

    private ZeroClientEntry(string name) => Name = name;

    /// <summary>The name written into the log line, after the caller.</summary>
    public string Name { get; }

    /// <summary>How many times this entry was used at zero demand outside every allowance since the last reset.</summary>
    public long Hits => Interlocked.Read(ref _hits);

    internal void Hit() => Interlocked.Increment(ref _hits);

    internal void Reset() => Interlocked.Exchange(ref _hits, 0);

    internal static IReadOnlyList<ZeroClientEntry> AllRegistered
    {
        get
        {
            // Registration is a static-field initializer on ZeroClientEntries: touching it is what fills the list.
            _ = ZeroClientEntries.StateRead;
            lock (Registered) return [.. Registered];
        }
    }

    internal static ZeroClientEntry Register(string name)
    {
        var entry = new ZeroClientEntry(name);
        lock (Registered)
        {
            if (Registered.Any(existing => existing.Name == name))
            {
                throw new InvalidOperationException($"Zero-client entry '{name}' is already registered.");
            }

            Registered.Add(entry);
        }

        return entry;
    }

    public override string ToString() => Name;
}

/// <summary>
/// EVERY STATE OR SCENE ENTRY POINT THE HOST CAN USE, one line each. This is where a new entry point is registered:
/// add a field here, then call <see cref="ZeroClientGuard.Enter"/> (or <see cref="ZeroClientGuard.EnterPort"/> for a
/// method that implements a runtime port) on the way into it. <c>ZeroClientContractTests</c> fails until the
/// new entry also has a rogue driver, so the contract test is forced to be able to see it.
/// </summary>
public static class ZeroClientEntries
{
    /// <summary>A full game-state capture (<c>GetCurrentState</c>).</summary>
    public static readonly ZeroClientEntry StateRead = ZeroClientEntry.Register("state.read");

    /// <summary>A live game-state subscription or watch.</summary>
    public static readonly ZeroClientEntry StateSubscribe = ZeroClientEntry.Register("state.subscribe");

    /// <summary>A live scene-delta subscription (the producer's whole-tree walk).</summary>
    public static readonly ZeroClientEntry SceneSubscribe = ZeroClientEntry.Register("scene.subscribe");

    /// <summary>A live animation-hint subscription (enables the producer's tween capture).</summary>
    public static readonly ZeroClientEntry AnimationHintSubscribe = ZeroClientEntry.Register("animation-hints.subscribe");

    /// <summary>A read of the latest native multiplayer connection observation.</summary>
    public static readonly ZeroClientEntry MultiplayerConnectionRead = ZeroClientEntry.Register("multiplayer-connection.read");

    /// <summary>A subscription to native multiplayer connection changes.</summary>
    public static readonly ZeroClientEntry MultiplayerConnectionSubscribe = ZeroClientEntry.Register("multiplayer-connection.subscribe");

    /// <summary>A subscription to the game's "the screen on top may have changed" event.</summary>
    public static readonly ZeroClientEntry ScreenSubscribe = ZeroClientEntry.Register("screen-context.subscribe");

    /// <summary>A read of which screen is on top.</summary>
    public static readonly ZeroClientEntry ScreenRead = ZeroClientEntry.Register("screen-context.read");

    /// <summary>Work marshalled onto the game's main thread through the dispatcher.</summary>
    public static readonly ZeroClientEntry MainThreadDispatch = ZeroClientEntry.Register("main-thread.dispatch");

    public static IReadOnlyList<ZeroClientEntry> All => ZeroClientEntry.AllRegistered;
}

/// <summary>
/// A named, justified reason some entry points are legitimately used while no client is connected. The reason is a
/// required argument so that adding to <see cref="ZeroClientAllowances"/> cannot be done without writing down why
/// the work is demand-free; the contract test rejects an empty or one-line reason.
/// </summary>
public sealed class ZeroClientAllowance
{
    private static readonly List<ZeroClientAllowance> Registered = [];
    private long _hits;

    private ZeroClientAllowance(string name, string reason, IReadOnlyList<ZeroClientEntry> entries)
    {
        Name = name;
        Reason = reason;
        Entries = entries;
    }

    public string Name { get; }
    public string Reason { get; }
    public IReadOnlyList<ZeroClientEntry> Entries { get; }

    /// <summary>How many zero-demand uses this allowance has excused since the last reset.</summary>
    public long Hits => Interlocked.Read(ref _hits);

    internal void Excused() => Interlocked.Increment(ref _hits);

    internal void Reset() => Interlocked.Exchange(ref _hits, 0);

    internal bool Covers(ZeroClientEntry entry) => Entries.Contains(entry);

    internal static IReadOnlyList<ZeroClientAllowance> AllRegistered
    {
        get
        {
            _ = ZeroClientAllowances.QrHostPanel;
            lock (Registered) return [.. Registered];
        }
    }

    internal static ZeroClientAllowance Register(string name, string reason, params ZeroClientEntry[] entries)
    {
        var allowance = new ZeroClientAllowance(name, reason, entries);
        lock (Registered)
        {
            if (Registered.Any(existing => existing.Name == name))
            {
                throw new InvalidOperationException($"Zero-client allowance '{name}' is already registered.");
            }

            Registered.Add(allowance);
        }

        return allowance;
    }
}

/// <summary>
/// THE REVIEWED ALLOW-LIST. Each entry names work that touches game state at zero demand and says why that is
/// acceptable; everything else that touches an entry at zero demand is a regression and shows up in the log as
/// <c>[idle-work]</c>. Adding an entry here is the review point: the reason is what the reviewer reads.
/// </summary>
/// <remarks>
/// Deliberately NOT here, because demand covers them: the hosting tracker, the browser server's observers and
/// static-background probe (all exist only while a browser socket is served), detached active-run seat supervision
/// (an owned seat is demand), and the listener's accept loop (parked; it reads no game state).
/// </remarks>
public static class ZeroClientAllowances
{
    public static readonly ZeroClientAllowance QrHostPanel = ZeroClientAllowance.Register(
        "qr-host-panel",
        "The QR host panel is the join affordance itself, so it has to exist before any client can. Its screen-changed "
        + "subscription is event-driven (a handful of screen changes a minute, none at idle) and every wake returns "
        + "after one registry check unless a lobby screen is the current screen; the current-screen read only happens "
        + "in that case, on the panel's own evaluation.",
        ZeroClientEntries.ScreenSubscribe,
        ZeroClientEntries.ScreenRead);

    public static readonly ZeroClientAllowance LobbyPanelStateRead = ZeroClientAllowance.Register(
        "lobby-panel-state-read",
        "The lobby QR panel re-reads the lobby state on its 0.25 s chain, but only while a lobby screen is the current "
        + "screen (LobbyEvaluationPlanner parks the chain otherwise), and the pause-menu row reads it once per "
        + "visibility change. In both the host player looking at that screen is the demand, and the read is bounded "
        + "by the screen staying open. The read itself goes away when the panel moves to the cheap host-facts reader.",
        ZeroClientEntries.StateRead);

    public static readonly ZeroClientAllowance HostTransportSizing = ZeroClientAllowance.Register(
        "host-transport-sizing",
        "Starting a hosting session sizes its ENet listener from the live lobby's player cap: one read per host start, "
        + "on the lobby that is being created, before any client exists. It is not recurring.",
        ZeroClientEntries.StateRead);

    public static readonly ZeroClientAllowance WindowlessViewport = ZeroClientAllowance.Register(
        "windowless-viewport",
        "Only a windowless instance (a headless seat or a --headless host) starts it: with no window to own the root "
        + "viewport it has to be re-asserted at a low steady rate. A player's windowed host never starts this loop.",
        ZeroClientEntries.MainThreadDispatch);

    public static IReadOnlyList<ZeroClientAllowance> All => ZeroClientAllowance.AllRegistered;
}

/// <summary>
/// The zero-client tripwire. While no browser client is being served and no owned seat exists, any use of a
/// registered state or scene entry point counts as idle work: it increments the entry's counter and writes one
/// rate-limited line, <c>[couchcoop][idle-work] &lt;caller&gt; &lt;entry point&gt;</c>, to the game log. It never
/// fails, throws or blocks; it exists so the next always-on subscriber shows up in a player's log and in QA without a
/// profiler (the Sep-13 hosting tracker ran for two releases with nothing noticing).
/// </summary>
/// <remarks>
/// <para>
/// DEMAND. Two sources, both fed by <c>HotReloadableBrowserServerHost</c>: the number of client connections the
/// listener is currently serving (opened when a socket is dispatched, closed when its handler returns), and the
/// owned-seat count. The connection count is deliberately not <see cref="BrowserDemandLedger"/> or
/// <see cref="StreamingViewerDemand"/>: those publish only after a WebSocket has registered, which is after the
/// handshake's own session read and after the first state observer starts, so they would flag the first viewer's
/// own work. A picker-parked viewer is a served connection and therefore demand, and is what keeps
/// <c>CouchCoopStateObserver</c>'s 50 ms subscription legitimate.
/// </para>
/// <para>
/// THE HOT PATH is one volatile integer read. Everything else (grace, allowance, counters, log) is behind it and
/// only runs at zero demand. A short grace after demand falls to zero excuses the tail of in-flight work: a queued
/// evaluation that runs one frame after the last viewer left is teardown, not a leak.
/// </para>
/// <para>
/// PER-ASSEMBLY STATICS. This type lives in <c>Runtime/</c>, which is not link-compiled into
/// <c>CouchCoop.Mod.HotReload</c>, so both assemblies reach the one set of counters through the project reference
/// (the reason the engine latch lives on <c>CouchCoopMod</c>; see <c>CouchCoopMod.EngineAvailable</c>). Put new
/// counters here, never on a <c>Server/</c> type.
/// </para>
/// <para>
/// ARMED on a player's host only. A spawned seat exists to serve a demand and supervises itself, and its own
/// browser connection is not the signal, so the tripwire stays silent there.
/// </para>
/// </remarks>
public static class ZeroClientGuard
{
    /// <summary>How long after demand reaches zero the tripwire stays quiet, for in-flight teardown work.</summary>
    public static readonly TimeSpan ReleaseGrace = TimeSpan.FromSeconds(5);

    private const long LogIntervalMs = 60_000;
    private const int MaxDistinctLogKeys = 64;

    private static readonly object Gate = new();
    private static BrowserDemandLedger _seatLedger = new(PublishOwnedSeats);
    private static readonly ConcurrentDictionary<string, long> LastLogged = new(StringComparer.Ordinal);

    [ThreadStatic]
    private static ZeroClientAllowance? _permit;

    // The single integer the hot path reads: served client connections plus owned seats.
    private static int _demand;
    private static int _clients;
    private static int _seats;
    private static long _seatGeneration;
    private static long _graceUntilMs;
    private static long _violations;

    /// <summary>Test seam: where the rate-limited line goes. Default is the game log.</summary>
    internal static Action<string> LogSink { get; set; } = CouchCoopLog.Info;

    /// <summary>Test seam: a millisecond clock for the grace window and the rate limit.</summary>
    internal static Func<long> Clock { get; set; } = () => Environment.TickCount64;

    /// <summary>Test seam: forces the armed state; null means armed on a host, disarmed on a spawned seat.</summary>
    internal static bool? ArmedOverride { get; set; }

    public static bool HasDemand => Volatile.Read(ref _demand) > 0;

    /// <summary>Total zero-demand uses outside every allowance since the last reset.</summary>
    public static long Violations => Interlocked.Read(ref _violations);

    private static bool Armed => ArmedOverride ?? !CouchCoopMod.IsHeadlessClient;

    /// <summary>
    /// Records that <paramref name="entry"/> is being used. Call this on the way into the entry point; the caller
    /// is taken from the compiler, so a call site needs no argument beyond the entry.
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static void Enter(
        ZeroClientEntry entry,
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        if (Volatile.Read(ref _demand) > 0)
        {
            return;
        }

        EnterAtZeroDemand(entry, caller, file);
    }

    /// <summary>
    /// The same check for a method that implements a runtime port. Its caller is whoever called through the
    /// interface, which the compiler cannot supply, so the caller is read from the stack, and only when a
    /// violation is actually being reported.
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static void EnterPort(ZeroClientEntry entry)
    {
        if (Volatile.Read(ref _demand) > 0)
        {
            return;
        }

        EnterAtZeroDemand(entry, null, null);
    }

    /// <summary>
    /// Excuses <paramref name="allowance"/>'s entries on this thread until the returned scope is disposed. Use it
    /// around a synchronous call only: the scope is thread-local and does not follow an <c>await</c>.
    /// </summary>
    public static ZeroClientPermit Permit(ZeroClientAllowance allowance)
    {
        var previous = _permit;
        _permit = allowance;
        return new ZeroClientPermit(previous);
    }

    internal static void RestorePermit(ZeroClientAllowance? previous) => _permit = previous;

    /// <summary>A client connection is now being served. Balanced by <see cref="ClientClosed"/>.</summary>
    internal static void ClientOpened()
    {
        lock (Gate)
        {
            _clients++;
            Recompute();
        }
    }

    internal static void ClientClosed()
    {
        lock (Gate)
        {
            _clients = Math.Max(0, _clients - 1);
            Recompute();
        }
    }

    /// <summary>
    /// A reporter for one owner of seat processes, with the <see cref="BrowserDemandLedger"/> contract: a stale
    /// (older-generation) report is ignored, and <c>(0, long.MaxValue)</c> retires the owner.
    /// </summary>
    internal static Action<int, long> CreateOwnedSeatReporter() => _seatLedger.CreateReporter();

    private static void PublishOwnedSeats(int count, long generation)
    {
        lock (Gate)
        {
            // The ledger publishes outside its own lock, so two reports can arrive swapped; the newer one wins.
            if (generation <= _seatGeneration)
            {
                return;
            }

            _seatGeneration = generation;
            _seats = Math.Max(0, count);
            Recompute();
        }
    }

    // Under Gate. The demand integer is written last so the hot path never sees a half-updated pair.
    private static void Recompute()
    {
        var before = Volatile.Read(ref _demand);
        var after = _clients + _seats;
        if (before > 0 && after == 0)
        {
            Volatile.Write(ref _graceUntilMs, Clock() + (long)ReleaseGrace.TotalMilliseconds);
        }

        Volatile.Write(ref _demand, after);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void EnterAtZeroDemand(ZeroClientEntry entry, string? caller, string? file)
    {
        try
        {
            if (!Armed)
            {
                return;
            }

            var now = Clock();
            if (now < Volatile.Read(ref _graceUntilMs))
            {
                return;
            }

            if (_permit is { } permit && permit.Covers(entry))
            {
                permit.Excused();
                return;
            }

            entry.Hit();
            Interlocked.Increment(ref _violations);
            Report(entry, caller, file, now);
        }
        catch
        {
            // A tripwire that can fail the call it watches is worse than no tripwire.
        }
    }

    private static void Report(ZeroClientEntry entry, string? caller, string? file, long now)
    {
        // Rate-limit BEFORE resolving a stack-derived caller, so a rogue polling at 4 Hz costs a stack walk once a
        // minute rather than four times a second. Attributed callers key on themselves; port callers key on the entry.
        var key = caller is null ? entry.Name : $"{entry.Name}|{file}|{caller}";
        if (!LastLogged.TryGetValue(key, out var last) || now - last >= LogIntervalMs)
        {
            if (!LastLogged.ContainsKey(key) && LastLogged.Count >= MaxDistinctLogKeys)
            {
                return;
            }

            LastLogged[key] = now;
            var who = caller is null
                ? ResolveCallerFromStack()
                : $"{BaseName(file)}.{caller}";
            LogSink($"[idle-work] {who} {entry.Name} hits={entry.Hits}");
        }
    }

    // CallerFilePath is spelled with the separators of the machine that compiled it, so split on both.
    private static string BaseName(string? file)
    {
        if (string.IsNullOrEmpty(file))
        {
            return "unknown";
        }

        var name = file[(file.LastIndexOfAny(['/', '\\']) + 1)..];
        var dot = name.LastIndexOf('.');
        return dot > 0 ? name[..dot] : name;
    }

    private static string ResolveCallerFromStack()
    {
        try
        {
            foreach (var frame in new StackTrace(fNeedFileInfo: false).GetFrames())
            {
                var method = frame.GetMethod();
                if (method?.DeclaringType is not { } type || IsInfrastructure(type))
                {
                    continue;
                }

                return Describe(type, method);
            }
        }
        catch
        {
            // Fall through: an unnamed caller still logs the entry.
        }

        return "unknown";
    }

    private static bool IsInfrastructure(Type type)
    {
        var owner = type;
        while (owner.DeclaringType is { } parent)
        {
            owner = parent;
        }

        return owner == typeof(ZeroClientGuard)
            || owner == typeof(CouchCoopRuntimeHost)
            || owner == typeof(GameScreenContext)
            || owner == typeof(GameMainThread);
    }

    private static bool IsCompilerGenerated(Type type)
        => type.Name.StartsWith('<') || type.Name.Contains("DisplayClass", StringComparison.Ordinal);

    private static string Describe(Type type, System.Reflection.MethodBase method)
    {
        var member = method.Name;
        var current = type;
        while (IsCompilerGenerated(current) && current.DeclaringType is { } parent)
        {
            // Async state machines carry the source method in the type name and run as MoveNext.
            if (member == "MoveNext" && current.Name.StartsWith('<'))
            {
                member = current.Name;
            }

            current = parent;
        }

        if (member.StartsWith('<') && member.IndexOf('>') is var end and > 1)
        {
            member = member[1..end];
        }

        if (member == ".ctor")
        {
            member = "ctor";
        }

        var typeName = current.Name;
        var tick = typeName.IndexOf('`');
        return $"{(tick > 0 ? typeName[..tick] : typeName)}.{member}";
    }

    /// <summary>Test seam: back to a clean, armed, zero-demand state with default clock and sink.</summary>
    internal static void ResetForTests(bool? armed = null)
    {
        lock (Gate)
        {
            _clients = 0;
            _seats = 0;
            _seatGeneration = 0;
            _seatLedger = new BrowserDemandLedger(PublishOwnedSeats);
            Volatile.Write(ref _demand, 0);
            Volatile.Write(ref _graceUntilMs, 0);
            Interlocked.Exchange(ref _violations, 0);
        }

        _permit = null;
        LastLogged.Clear();
        foreach (var entry in ZeroClientEntries.All)
        {
            entry.Reset();
        }

        foreach (var allowance in ZeroClientAllowances.All)
        {
            allowance.Reset();
        }

        LogSink = CouchCoopLog.Info;
        Clock = () => Environment.TickCount64;
        ArmedOverride = armed;
    }
}

/// <summary>Disposing restores whatever allowance was in force before <see cref="ZeroClientGuard.Permit"/>.</summary>
public readonly struct ZeroClientPermit : IDisposable
{
    private readonly ZeroClientAllowance? _previous;

    internal ZeroClientPermit(ZeroClientAllowance? previous) => _previous = previous;

    public void Dispose() => ZeroClientGuard.RestorePermit(_previous);
}
