using CouchCoop.Mod.Connections;

internal static class ConnectionControlTests
{
    public static Task RunAsync()
    {
        AcceptsOnlyCurrentAuthenticatedGeneration();
        ShutdownRequestIsReturnedOnNextObservation();
        ReplacesPriorGenerationForSlot();
        RejectsUnboundedStatus();
        return Task.CompletedTask;
    }

    private static void AcceptsOnlyCurrentAuthenticatedGeneration()
    {
        var control = new HeadlessConnectionControl();
        var session = Guid.NewGuid();
        control.Register(2, 7, session, "token-a");
        var status = new HeadlessConnectionStatus(1, "Connecting", null, null, 0);

        Assert(!control.Observe("wrong", 7, status).Accepted, "wrong token is rejected");
        Assert(!control.Observe("token-a", 8, status).Accepted, "wrong generation is rejected");
        Assert(control.Observe("token-a", 7, status).Accepted, "current token/generation is accepted");
        Assert(control.Snapshot(2, 7)?.Status?.ErrorCode is null, "healthy status accepts omitted error fields");
        Assert(!control.Observe("token-a", 7, status).Accepted, "stale sequence is rejected");
        var snapshot = control.Snapshot(2, 7);
        Assert(snapshot?.SourceSessionId == session && snapshot.Status?.Sequence == 1 && snapshot.ObservedMonotonicTick > 0,
            "snapshot retains source, status, and a monotonic observation tick");
        control.Unregister(2, 7);
        Assert(control.Snapshot(2, 7) is null, "unregister removes the generation");
    }

    private static void ShutdownRequestIsReturnedOnNextObservation()
    {
        var control = new HeadlessConnectionControl();
        control.Register(3, 11, Guid.NewGuid(), "token-b");
        Assert(control.RequestShutdown(3, 11), "host marks the current generation for shutdown");
        var observed = control.Observe("token-b", 11, new HeadlessConnectionStatus(1, "Failed", "native-network-error", null, 0));
        Assert(observed.Accepted && observed.ShutdownRequested, "accepted status receives shutdown command");
    }

    private static void ReplacesPriorGenerationForSlot()
    {
        var control = new HeadlessConnectionControl();
        control.Register(4, 1, Guid.NewGuid(), "old-token");
        control.Register(4, 2, Guid.NewGuid(), "new-token");
        Assert(!control.Observe("old-token", 1, new HeadlessConnectionStatus(1, "Connecting", null, null, 0)).Accepted,
            "re-registering a slot removes its prior generation credential");
        Assert(control.Observe("new-token", 2, new HeadlessConnectionStatus(1, "Connecting", null, null, 0)).Accepted,
            "current generation credential remains accepted");
    }

    private static void RejectsUnboundedStatus()
    {
        var control = new HeadlessConnectionControl();
        control.Register(5, 1, Guid.NewGuid(), "token-c");
        Assert(!control.Observe("token-c", 1, new HeadlessConnectionStatus(1, new string('x', 33), null, null, 0)).Accepted,
            "overlong native phase is rejected");
        Assert(!control.Observe("token-c", 1, new HeadlessConnectionStatus(1, "Connecting", null, new string('x', 2049), 0)).Accepted,
            "overlong native detail is rejected");
        Assert(!control.Observe("token-c", 1, new HeadlessConnectionStatus(1, "Connecting", null, null, -1)).Accepted,
            "negative browser count is rejected");
        Assert(control.Observe("token-c", 1, new HeadlessConnectionStatus(2, "Connecting", null, null, 65)).Accepted,
            "browser count above 64 is accepted for dynamically expanded lobbies");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"[ConnectionControlTests] FAILED: {message}");
    }
}
