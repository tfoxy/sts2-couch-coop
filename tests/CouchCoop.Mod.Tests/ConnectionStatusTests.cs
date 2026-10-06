using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.Protocol;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Tests;

internal static class ConnectionStatusTests
{
    public static Task RunAsync()
    {
        RetainsFailuresAndRemovesCleanDisconnects();
        RejectsStaleAttemptControls();
        RequiredPeerCleanupSurfacesFailure();
        return Task.CompletedTask;
    }

    private static void RetainsFailuresAndRemovesCleanDisconnects()
    {
        var registry = new ConnectionRegistry();
        var clean = Guid.NewGuid();
        registry.Connected(clean, "Chrome on Android");
        registry.Disconnected(clean);
        Assert(registry.Snapshot().Rows.Count == 0, "clean disconnects are removed");

        var failed = Guid.NewGuid();
        registry.Connected(failed, null);
        registry.Fail(failed, "spawn-failed", "Could not start the game view.", "Try again.", "exit=1");
        var row = registry.Snapshot().Rows.Single();
        Assert(row.Stage == ConnectionStage.Failed, "failure stage is retained");
        Assert(row.Issue?.Code == "spawn-failed", "failure issue is retained");
        Assert(registry.BuildReport(failed)?.Contains("exit=1", StringComparison.Ordinal) == true, "report includes bounded detail");
        Assert(registry.Dismiss(failed), "failed row is dismissible");
        var dismissed = registry.Snapshot().Rows.Single();
        Assert(dismissed.Id == failed && dismissed.IsLive && dismissed.Issue is null && dismissed.Stage == ConnectionStage.Choosing,
            "dismissing a live failure removes its retained issue but keeps the active browser row");
    }

    private static void RejectsStaleAttemptControls()
    {
        var registry = new ConnectionRegistry();
        var id = Guid.NewGuid();
        registry.Connected(id, null);
        var first = registry.BeginAttempt(id);
        var second = registry.BeginAttempt(id);
        Assert(!registry.Presented(id, first), "stale attempt cannot acknowledge a newer view");
        Assert(!registry.Presented(id, second), "an acknowledgement before LoadingView is rejected");
        registry.ConfigureView(id, requiresChild: true);
        registry.Advance(id, ConnectionStage.LoadingView);
        Assert(registry.Presented(id, second), "current attempt acknowledges the loading view");
        Assert(registry.Snapshot().Rows.Single().Stage == ConnectionStage.LoadingView,
            "first frame alone cannot complete without native membership and child liveness");
        registry.SetReadiness(id, member: true, childBrowser: true);
        Assert(registry.Snapshot().Rows.Single().Stage == ConnectionStage.Complete,
            "matching readiness completes the current loading attempt");
    }

    private static void RequiredPeerCleanupSurfacesFailure()
    {
        var source = new CleanupActionSource();
        var calls = 0;
        var refuse = true;
        using var runtime = new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
            source, source, null!, null!, null!, null!, null!, source, null!),
            disconnectSeatPeer: netId =>
            {
                calls++;
                Assert(netId == 1002, "cleanup receives the released seat's netId");
                if (refuse) throw new InvalidOperationException("Peer removal was refused.");
            });
        var lobby = new CouchCoopLobbyParticipation(runtime);
        try
        {
            lobby.DisconnectClient(1002, requireSuccess: true);
            throw new Exception("A failed cleanup incorrectly released the seat.");
        }
        catch (InvalidOperationException exception)
        {
            Assert(exception.Message.Contains("Peer removal was refused.", StringComparison.Ordinal),
                "required cleanup retains the cause for the quarantine report");
        }
        refuse = false;
        lobby.DisconnectClient(1002, requireSuccess: true);
        Assert(calls == 2, "successful idempotent cleanup remains usable after a failure");
    }

    private sealed class CleanupActionSource : IRuntimeCapabilitySource, ISemanticActionSource, IRuntimeAssetSource, ISpirectlAssetProvider
    {
        public ISpirectlAssetProvider Assets => this;
        public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request) => throw new NotSupportedException();
        public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request) => throw new NotSupportedException();
        public EmbeddableAssetBatchResult GetPresentationAssets(PresentationAssetBatchRequest request) => throw new NotSupportedException();
        public EmbeddableRuntimeCapabilities GetCapabilities() => new("test", "test-game", "test-mod", "embedded",
            RuntimeAttachmentState.Attached, DataSourceKind.Stub, false,
            [new(CouchCoopRuntimeHost.SemanticActionsCapability, "actions", true, false, null)], []);
        public EmbeddableActionResult ExecuteAction(EmbeddableActionRequest request) => throw new Exception("peer cleanup must not use a semantic action");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
