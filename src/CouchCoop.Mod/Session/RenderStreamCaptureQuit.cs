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
/// Disarms arming, armed or ended captures and waits for disarming captures to finish before the seat exits.
/// The exit sequence awaits this disarm so capture evidence is written before the immediate process exit.
/// Capture effects run on the main thread; the fallback bounds the wait without blocking frame callbacks.
/// </summary>
internal sealed class RenderStreamCaptureQuit
{
    // Sequential carrier stops: websocket flush (2 s), WebTransport stop (1.75 s), then release, plus 0.6 s margin.
    internal static readonly TimeSpan DisarmTimeout = TimeSpan.FromSeconds(4.5);

    private readonly IRenderStreamCapture _capture;
    private readonly Action _done;
    private readonly Action<TimeSpan, Action> _schedule;
    private bool _doneRequested;

    internal RenderStreamCaptureQuit(
        IRenderStreamCapture capture,
        Action done,
        Action<TimeSpan, Action> schedule)
    {
        _capture = capture;
        _done = done;
        _schedule = schedule;
    }

    internal void Run()
    {
        var state = _capture.HasSingleton ? _capture.State() : null;
        if (state is not ("arming" or "armed" or "ended" or "disarming"))
        {
            DoneOnce();
            return;
        }

        _capture.ConnectOneShot("disarmed", DoneOnce);
        _schedule(DisarmTimeout, DoneOnce);
        if (state != "disarming" && _capture.Disarm("seat-quit", lingerMs: 0) != 0)
        {
            DoneOnce();
        }
    }

    private void DoneOnce()
    {
        if (_doneRequested) return;
        _doneRequested = true;
        _done();
    }

    internal static Task DisarmDeferredAsync()
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        // The exit sequence can run off-thread. Even singleton discovery belongs on the main thread.
        Callable.From(() =>
        {
            try
            {
                if (Engine.GetMainLoop() is not SceneTree tree)
                {
                    HeadlessLog.Write("No SceneTree main loop to disarm capture; leaving the force-exit backstop armed.");
                    completion.TrySetResult();
                    return;
                }

                var sequence = new RenderStreamCaptureQuit(
                    new GodotRenderStreamCapture(),
                    () => completion.TrySetResult(),
                    (delay, callback) => tree.CreateTimer(delay.TotalSeconds, ignoreTimeScale: true).Connect(
                        SceneTreeTimer.SignalName.Timeout,
                        Callable.From(callback),
                        (uint)GodotObject.ConnectFlags.OneShot));
                sequence.Run();
            }
            catch (Exception exception)
            {
                HeadlessLog.Write($"render-stream disarm failed: {exception.GetType().Name}: {exception.Message}");
                completion.TrySetResult();
            }
        }).CallDeferred();
        return completion.Task;
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
