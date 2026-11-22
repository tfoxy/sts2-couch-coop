namespace CouchCoop.Mod.Session;

/// <summary>Defers a windowed host's quit until capture disarms, then resumes quit on the main thread.</summary>
internal sealed class HostCaptureQuitSequence
{
    private readonly Func<Task> _disarm;
    private readonly Action<Action> _post;
    private readonly Action<string> _log;
    private readonly TimeProvider _timeProvider;
    private readonly Action _stopRenderer;
    private readonly bool _disarmOnMainThread;
    private bool _started;
    private bool _continuing;

    internal HostCaptureQuitSequence(Func<Task> disarm, Action<Action> post,
        Action<string>? log = null, TimeProvider? timeProvider = null, Action? stopRenderer = null, bool disarmOnMainThread = false)
    {
        _disarmOnMainThread = disarmOnMainThread;
        _disarm = disarm;
        _post = post;
        _log = log ?? CouchCoopLog.Info;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _stopRenderer = stopRenderer ?? (() => { });
    }

    internal Task Completion { get; private set; } = Task.CompletedTask;

    // Called on the main thread. Only the posted continuation may re-enter the original quit.
    internal bool BeforeQuit(bool captureEnabled, Action quit, bool captureAttached = true)
    {
        if (!captureEnabled || _continuing) return true;
        if (!_started)
        {
            _started = true;
            _stopRenderer();
            if (!captureAttached) return true;
            Completion = DisarmThenQuitAsync(quit);
        }
        return false;
    }

    private async Task DisarmThenQuitAsync(Action quit)
    {
        try
        {
            // Bound synchronous failures/blocking as well as the asynchronous disarm completion.
            await (_disarmOnMainThread ? _disarm() : Task.Run(_disarm))
                .WaitAsync(RenderStreamCaptureQuit.DisarmTimeout, _timeProvider)
                .ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            Log($"windowed host capture disarm did not finish: {exception.GetType().Name}: {exception.Message}");
        }

        try
        {
            _post(() =>
            {
                _continuing = true;
                try { quit(); }
                catch (Exception exception)
                {
                    Log($"windowed host game quit failed: {exception.GetType().Name}: {exception.Message}");
                }
                finally { _continuing = false; }
            });
        }
        catch (Exception exception)
        {
            Log($"windowed host quit dispatch failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private void Log(string message)
    {
        try { _log(message); }
        catch { /* Logging must not prevent quit after a failed disarm. */ }
    }
}
