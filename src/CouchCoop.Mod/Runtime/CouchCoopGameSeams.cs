using System.Runtime.CompilerServices;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Runtime;

/// <summary>Which screen is on top, and when that may have changed. The game-facing half of <see cref="GameScreenContext"/>.</summary>
public interface IGameScreenSource
{
    /// <summary>Null, never a throw, when the game's event cannot be resolved (or there is no engine).</summary>
    IDisposable? SubscribeUpdated(Action handler);

    object? Current { get; }

    bool IsCurrent(object? node);
}

/// <summary>Runs work on the game's main thread. The game-facing half of <see cref="GameMainThread"/>.</summary>
public interface IGameMainThread
{
    T Invoke<T>(Func<T> action);

    Task<T> InvokeAsync<T>(Func<Task<T>> action);
}

/// <summary>
/// CouchCoop's own front for the game's active-screen statics. Every use goes through the zero-client tripwire, so a
/// new subscriber to the screen event shows up as <c>[idle-work]</c> when nobody is connected instead of costing
/// nothing visible. Call sites pass nothing: the caller is taken from the compiler.
/// </summary>
/// <remarks>
/// It is a facade over the reusable spirectl statics, not a reimplementation of them; the seam
/// (<see cref="Source"/>) exists so a test can count subscriptions without an engine.
/// </remarks>
public static class GameScreenContext
{
    /// <summary>Test seam. Production is <see cref="SpirectlGameScreenSource"/>.</summary>
    internal static IGameScreenSource Source { get; set; } = SpirectlGameScreenSource.Instance;

    public static IDisposable? SubscribeUpdated(
        Action handler,
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.ScreenSubscribe, caller, file);
        return Source.SubscribeUpdated(handler);
    }

    /// <summary>The screen object on top right now. Only at a frame boundary; see the QR host panel's remarks.</summary>
    public static object? GetCurrent(
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.ScreenRead, caller, file);
        return Source.Current;
    }

    public static bool IsCurrent(
        object? node,
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.ScreenRead, caller, file);
        return Source.IsCurrent(node);
    }
}

/// <summary>Production screen source: spirectl's statics, and nothing at all outside a real game process.</summary>
public sealed class SpirectlGameScreenSource : IGameScreenSource
{
    public static SpirectlGameScreenSource Instance { get; } = new();

    // The seam resolves a game type by reflection, which a process with no engine behind it must never reach.
    public IDisposable? SubscribeUpdated(Action handler)
        => CouchCoopMod.EngineAvailable ? Sts2ScreenContext.SubscribeUpdated(handler) : null;

    public object? Current => Sts2ScreenContext.Current;

    public bool IsCurrent(object? node) => Sts2ScreenContext.IsCurrent(node);
}

/// <summary>
/// CouchCoop's own front for the game's main-thread dispatcher, for the same reason as
/// <see cref="GameScreenContext"/>: a marshal onto the main thread at zero demand is a recurring wake-up somebody
/// added, and it should be named in the log rather than found with a profiler.
/// </summary>
public static class GameMainThread
{
    /// <summary>Test seam. Production is <see cref="SpirectlGameMainThread"/>.</summary>
    internal static IGameMainThread Source { get; set; } = SpirectlGameMainThread.Instance;

    public static T Invoke<T>(
        Func<T> action,
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.MainThreadDispatch, caller, file);
        return Source.Invoke(action);
    }

    public static Task<T> InvokeAsync<T>(
        Func<Task<T>> action,
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.MainThreadDispatch, caller, file);
        return Source.InvokeAsync(action);
    }
}

public sealed class SpirectlGameMainThread : IGameMainThread
{
    public static SpirectlGameMainThread Instance { get; } = new();

    public T Invoke<T>(Func<T> action) => Sts2MainThreadDispatcher.Invoke(action);

    public Task<T> InvokeAsync<T>(Func<Task<T>> action) => Sts2MainThreadDispatcher.InvokeAsync(action);
}
