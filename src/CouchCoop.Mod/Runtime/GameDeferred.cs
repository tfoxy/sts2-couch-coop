using System.Runtime.CompilerServices;
using Godot;

namespace CouchCoop.Mod.Runtime;

/// <summary>All CouchCoop deferred work shares the host's irreversible exit boundary.</summary>
public static class GameDeferred
{
    internal static Action<Action> Enqueue { get; set; } = PostInGodot;

    public static bool Post(Action work)
        => CouchCoopMod.HostExit.TryEnqueue(() => Enqueue(() =>
        {
            if (!CouchCoopMod.HostExiting) work();
        }));

    internal static bool PostCaptureDisarm(Action work)
        => CouchCoopMod.HostExit.TryEnqueue(() => Enqueue(work));

    // Only the exit sequences may replay the game's quit after exit admission closes.
    internal static void PostQuitReplay(Action quit)
        => CouchCoopMod.HostExit.TryEnqueue(() => Enqueue(quit), quitReplay: true);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void PostInGodot(Action work) => Callable.From(work).CallDeferred();

    public static IDisposable Delay(SceneTree tree, double seconds, Action work)
    {
        IDisposable result = EmptyCancellation.Instance;
        Register(() =>
        {
            var timer = tree.CreateTimer(seconds, processAlways: true, ignoreTimeScale: true);
            var callback = Callable.From(() => { if (!CouchCoopMod.HostExiting) work(); });
            timer.Connect(SceneTreeTimer.SignalName.Timeout, callback, (uint)GodotObject.ConnectFlags.OneShot);
            result = new TimerCancellation(timer, callback);
        });
        return result;
    }

    private sealed class EmptyCancellation : IDisposable
    {
        internal static readonly EmptyCancellation Instance = new();
        public void Dispose() { }
    }

    private sealed class TimerCancellation(SceneTreeTimer timer, Callable callback) : IDisposable
    {
        public void Dispose()
        {
            if (GodotObject.IsInstanceValid(timer) && timer.IsConnected(SceneTreeTimer.SignalName.Timeout, callback))
                timer.Disconnect(SceneTreeTimer.SignalName.Timeout, callback);
        }
    }

    public static bool Register(Action registration) => CouchCoopMod.HostExit.TryEnqueue(registration);
}
