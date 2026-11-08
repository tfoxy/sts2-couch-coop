using Godot;

namespace CouchCoop.Mod.Session;

internal interface IRenderStreamCapture
{
    bool HasSingleton { get; }
    string State();
    int Disarm(string reason, int lingerMs);
    void ConnectOneShot(string signal, Action callback);
}

/// <summary>
/// Disarms arming, armed or ended captures and waits for disarming captures to finish before the seat quits.
/// All effects run on the main thread; the fallback bounds the wait without blocking the capture's frame
/// callbacks. Only this clean quit path writes capture evidence: HeadlessHostWatchdog and HeadlessForceExit
/// remain last-resort kills.
/// </summary>
internal sealed class RenderStreamCaptureQuit
{
    internal static readonly TimeSpan DisarmTimeout = TimeSpan.FromSeconds(1.5);

    private readonly IRenderStreamCapture _capture;
    private readonly Action _quit;
    private readonly Action<TimeSpan, Action> _schedule;
    private bool _quitRequested;

    internal RenderStreamCaptureQuit(
        IRenderStreamCapture capture,
        Action quit,
        Action<TimeSpan, Action> schedule)
    {
        _capture = capture;
        _quit = quit;
        _schedule = schedule;
    }

    internal void Run()
    {
        var state = _capture.HasSingleton ? _capture.State() : null;
        if (state is not ("arming" or "armed" or "ended" or "disarming"))
        {
            QuitOnce();
            return;
        }

        _capture.ConnectOneShot("disarmed", QuitOnce);
        _schedule(DisarmTimeout, QuitOnce);
        if (state != "disarming" && _capture.Disarm("seat-quit", lingerMs: 0) != 0)
        {
            QuitOnce();
        }
    }

    private void QuitOnce()
    {
        if (_quitRequested) return;
        _quitRequested = true;
        _quit();
    }

    internal static void RequestQuitDeferred()
    {
        // The disconnect sequence can run off-thread. Even singleton discovery belongs on the main thread.
        Callable.From(() =>
        {
            if (Engine.GetMainLoop() is not SceneTree tree)
            {
                HeadlessLog.Write("No SceneTree main loop to quit; leaving the force-exit backstop armed.");
                return;
            }

            var sequence = new RenderStreamCaptureQuit(
                new GodotRenderStreamCapture(),
                () => tree.CallDeferred(SceneTree.MethodName.Quit, 0),
                (delay, callback) => tree.CreateTimer(delay.TotalSeconds, ignoreTimeScale: true).Connect(
                    SceneTreeTimer.SignalName.Timeout,
                    Callable.From(callback),
                    (uint)GodotObject.ConnectFlags.OneShot));
            try
            {
                sequence.Run();
            }
            catch (Exception exception)
            {
                HeadlessLog.Write($"render-stream disarm failed: {exception.GetType().Name}: {exception.Message}");
                sequence.QuitOnce();
            }
        }).CallDeferred();
    }

    private sealed class GodotRenderStreamCapture : IRenderStreamCapture
    {
        private const string SingletonName = "RenderStreamCapture";

        public bool HasSingleton => Engine.HasSingleton(SingletonName);

        public string State() => Engine.GetSingleton(SingletonName).Call("state").AsGodotDictionary()["state"].AsString();

        public int Disarm(string reason, int lingerMs) => Engine.GetSingleton(SingletonName).Call(
            "disarm", new Godot.Collections.Dictionary { ["reason"] = reason, ["linger_ms"] = lingerMs }).AsInt32();

        public void ConnectOneShot(string signal, Action callback)
        {
            // The disarmed signal carries one info dictionary argument.
            var result = Engine.GetSingleton(SingletonName).Connect(
                signal, Callable.From<Variant>(_ => callback()), (uint)GodotObject.ConnectFlags.OneShot);
            if (result != Error.Ok)
            {
                throw new InvalidOperationException($"Cannot connect render-stream {signal}: {result}.");
            }
        }
    }
}
