using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Server;

internal static class DirectIpSetupFlowTests
{
    private static readonly DirectIpHttpsState Ready = new(13337, ["192.168.0.123"], new string('A', 64), CanExport: true);

    public static void Run()
    {
        var flow = new DirectIpSetupFlow();
        flow.Open(Ready with { CanExport = false });
        Assert(!flow.HostReady, "unexportable identity is not complete setup readiness");
        flow.Open(Ready with { CaFingerprint = null });
        Assert(!flow.HostReady, "missing identity is not complete setup readiness");
        flow.Open(null);
        Assert(flow.Stage == DirectIpSetupStage.Prepare && !flow.IsBusy && !flow.HostReady, "opening does not prepare automatically");
        Assert(!flow.AcknowledgeInstallation(), "cannot acknowledge before setup");
        Assert(flow.BeginOperation() && !flow.BeginOperation(), "only one operation can run");
        flow.Open(new DirectIpHttpsState(Preparing: true));
        Assert(flow.IsBusy, "reopening cannot release an in-flight operation");
        flow.CompleteOperation(null, null, new CouchCoopText("couchcoop_https_export_failed"));
        Assert(!flow.IsBusy && flow.Stage == DirectIpSetupStage.Prepare && flow.Error?.Key == "couchcoop_https_export_failed", "failed export stays on retry");
        Assert(flow.BeginOperation() && flow.Error is null, "retry clears the inline error");
        flow.CompleteOperation(Ready, null);
        Assert(flow.Stage == DirectIpSetupStage.Prepare && flow.Error is not null, "ready host alone does not finish file creation");
        flow.BeginOperation();
        flow.CompleteOperation(Ready, "/test/public.cer");
        Assert(flow.Stage == DirectIpSetupStage.Device && flow.ExportPath == "/test/public.cer", "successful creation advances to device setup");
        Assert(!flow.AcknowledgeInstallation(), "device choice is explicit");
        foreach (var device in Enum.GetValues<DirectIpSetupDevice>())
        {
            flow.ChooseDevice(device);
            Assert(!string.IsNullOrWhiteSpace(DirectIpSetupCopy.DeviceKey(device)), "each device maps to its own copy");
            flow.ToggleVerification();
            flow.ChooseDevice(device);
            Assert(!flow.ShowVerification, "device changes collapse verification details");
        }
        flow.ChooseDevice(DirectIpSetupDevice.Windows);
        Assert(flow.AcknowledgeInstallation() && flow.Stage == DirectIpSetupStage.Connect, "acknowledgment advances to connect");
        flow.Refresh(Ready with { LeafExpiresAt = DateTimeOffset.UtcNow.AddDays(90) });
        Assert(flow.Stage == DirectIpSetupStage.Connect, "ordinary renewal does not reset acknowledgment");
        flow.Open(Ready);
        Assert(flow.Stage == DirectIpSetupStage.Device && flow.Device == DirectIpSetupDevice.Windows, "reopen retains device but never presumed client trust");
        flow.AcknowledgeInstallation();
        flow.Back();
        Assert(flow.Stage == DirectIpSetupStage.Device, "back from connect returns to device instructions");
        flow.AnotherDevice();
        Assert(flow.Device is null && flow.Stage == DirectIpSetupStage.Device, "another device requires a fresh choice");
        flow.ChooseDevice(DirectIpSetupDevice.Windows);
        flow.AcknowledgeInstallation();
        flow.Refresh(Ready with { Preparing = true, Port = 0 });
        Assert(flow.Stage == DirectIpSetupStage.Connect, "temporary preparation does not reset the guide");
        flow.Refresh(Ready);
        flow.Refresh(Ready with { CaFingerprint = new string('B', 64) });
        Assert(flow.Stage == DirectIpSetupStage.Device && flow.ExportPath is null, "new authority invalidates prior acknowledgment and export path");
        flow.AcknowledgeInstallation();
        flow.Refresh(Ready with { Port = 0, ErrorCode = "authority-invalid" });
        Assert(flow.Stage == DirectIpSetupStage.Prepare && !flow.HostReady, "genuine readiness loss returns to preparation");
        flow.RequestReset();
        Assert(flow.ShowAdvanced && flow.ConfirmReset && !flow.IsBusy, "requesting reset only asks for confirmation");
        flow.CancelReset();
        Assert(!flow.ConfirmReset && !flow.IsBusy, "cancel reset changes no identity");
        flow.RequestReset();
        flow.ToggleAdvanced();
        Assert(!flow.ConfirmReset, "hiding advanced help cancels reset confirmation");
        flow.Open(Ready);
        flow.BeginOperation();
        flow.RequestReset();
        Assert(!flow.ConfirmReset, "cannot request reset while work is running");
        flow.CompleteExport(null, new CouchCoopText("couchcoop_https_export_failed"));
        Assert(flow.Stage == DirectIpSetupStage.Device && flow.Error is not null && !flow.IsBusy, "show-file failure stays in device setup");
        flow.BeginOperation();
        flow.CompleteExport("/test/public.cer");
        Assert(flow.Error is null && flow.ExportPath is not null, "show-file retry recovers without changing stage");
        flow.BeginOperation();
        flow.Refresh(Ready with { CaFingerprint = new string('C', 64) });
        Assert(flow.ExportPath is null && flow.IsBusy, "identity change invalidates a stale export even during work");
        flow.CompleteExport("/test/old-public.cer");
        Assert(flow.ExportPath is null && flow.Error is not null && flow.Stage == DirectIpSetupStage.Device,
            "export completion cannot resurrect a file from a different authority");
        flow.BeginOperation();
        flow.Refresh(Ready with { Port = 0, ErrorCode = "setup-failed" });
        flow.CompleteExport("/test/public.cer");
        Assert(flow.Stage == DirectIpSetupStage.Prepare && flow.ExportPath is null && !flow.IsBusy,
            "export completion reconciles readiness lost during the operation");
        Console.WriteLine("DirectIpSetupFlowTests: ok");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
