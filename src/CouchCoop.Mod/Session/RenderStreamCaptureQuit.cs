using CouchCoop.Mod.Runtime;
using Godot;

namespace CouchCoop.Mod.Session;

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
        var state = _capture.HasSingleton && _capture.AttachmentState != "detached" ? _capture.State() : null;
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

    internal static Task DisarmOnMainThreadAsync()
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CompleteDisarmOnMainThread(completion);
        return completion.Task;
    }

    private static void CompleteDisarmOnMainThread(TaskCompletionSource completion)
    {
        try
        {
            var sequence = new RenderStreamCaptureQuit(new GodotRenderStreamCapture(),
                () => completion.TrySetResult(),
                // The caller bounds disarm with WaitAsync; no engine timer is needed during host exit.
                (_, _) => { });
            sequence.Run();
        }
        catch (Exception exception)
        {
            HeadlessLog.Write($"render-stream disarm failed: {exception.GetType().Name}: {exception.Message}");
            completion.TrySetResult();
        }
    }

    internal static Task DisarmDeferredAsync()
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        // Seat/headless exit can run off-thread; windowed quit calls the main-thread variant directly.
        if (!GameDeferred.PostCaptureDisarm(() => CompleteDisarmOnMainThread(completion)))
            completion.TrySetResult();
        return completion.Task;
    }
}
