namespace CouchCoop.Mod.Session;

/// <summary>Process-owned scene-stream demand that can be reported without loading Godot.</summary>
public static class StreamingViewerDemandState
{
    // A browser-server generation reports its balanced scene-stream count through a process-wide ledger.
    // A windowed host parks its rescan-only Timer at zero viewers once every owed finish nudge has fired.
    // Headless seats retain their continuous FPS/input supervision.
    // The callback defers suspender initialization until demand changes; creating a reporter is game-free.
    private static readonly StreamingViewerDemand StreamingViewers = new(
        () => CouchCoopHeadlessVisualSuspender.QueueTimerDemandReconcile());

    internal static bool HasViewers => StreamingViewers.HasViewers;

    // BCL-only boundary: BrowserServer.cs is linked into the hot-reload assembly, but the ledger and Timer
    // live in the process-owned mod assembly so every generation updates the SAME demand state.
    public static Action<int, long> CreateStreamingDemandReporter() => StreamingViewers.CreateReporter();
}
