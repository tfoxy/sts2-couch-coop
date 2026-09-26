using System.Runtime.CompilerServices;
using CouchCoop.Mod.Session;
using Godot;

namespace CouchCoop.Mod.Runtime;

/// <summary>
/// Runs a piece of work on the game's next processed frame, on the game main thread.
/// </summary>
/// <remarks>
/// Reading the active screen synchronously inside a game callback (the screen-changed event, a lobby postfix) is unsafe:
/// it faults the process without a managed exception. Every roster read therefore waits for the next frame boundary,
/// exactly like the QR host panel's evaluation and the hosting tracker's. Posting is not a blocking marshal, so it is
/// safe to call while a mod lock is held. With no engine behind the process there is no frame to wait for, and the work
/// goes to the thread pool instead of being dropped.
/// </remarks>
internal static class GameNextFrame
{
    internal static void Schedule(Action work)
    {
        ArgumentNullException.ThrowIfNull(work);
        if (!CouchCoopMod.EngineAvailable)
        {
            ThreadPool.QueueUserWorkItem(static state => ((Action)state!).Invoke(), work);
            return;
        }

        var posted = GameMainThread.InvokeAsync(() =>
        {
            AfterNextFrame(work);
            return Task.FromResult(true); // InvokeAsync<T> requires a result.
        });
        // A post that faults would otherwise vanish; the next signal re-arms, so this only needs to be visible.
        _ = posted.ContinueWith(
            task => CouchCoopLog.Stderr($"next-frame scheduling failed: {task.Exception?.GetBaseException().Message}"),
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted,
            TaskScheduler.Default);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void AfterNextFrame(Action work)
    {
        if (Engine.GetMainLoop() is SceneTree { Root: { } root } && GodotObject.IsInstanceValid(root))
        {
            root.GetTree().CreateTimer(0, processAlways: true, ignoreTimeScale: true).Timeout += work;
        }
        else
        {
            work();
        }
    }
}
