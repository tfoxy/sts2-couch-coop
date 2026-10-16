using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.HostUi;

internal enum DirectIpSetupStage { Prepare, Device, Connect }
internal enum DirectIpSetupDevice { Iphone, Android, Windows, MacOs, LinuxFirefox }

/// <summary>Native guide state only. Acknowledging installation never establishes client trust.</summary>
internal sealed class DirectIpSetupFlow
{
    private string? _operationIdentity;
    public DirectIpSetupStage Stage { get; private set; }
    public DirectIpSetupDevice? Device { get; private set; }
    public bool IsBusy { get; private set; }
    public bool ShowAdvanced { get; private set; }
    public bool ShowVerification { get; private set; }
    public bool ConfirmReset { get; private set; }
    public string? ExportPath { get; private set; }
    public CouchCoopText? Error { get; private set; }
    public DirectIpHttpsState? State { get; private set; }
    public bool HostReady => State is { Port: > 0, Addresses.Count: > 0, CaFingerprint.Length: > 0, CanExport: true, ErrorCode: null, Preparing: false };

    public void Open(DirectIpHttpsState? state)
    {
        Refresh(state);
        ShowAdvanced = ShowVerification = ConfirmReset = false;
        if (IsBusy) return;
        Error = null;
        Stage = HostReady ? DirectIpSetupStage.Device : DirectIpSetupStage.Prepare;
    }

    public void Refresh(DirectIpHttpsState? state)
    {
        var identityChanged = State?.CaFingerprint is { Length: > 0 } prior
            && !string.Equals(prior, state?.CaFingerprint, StringComparison.Ordinal);
        State = state;
        if (identityChanged) ExportPath = null;
        // Preparation temporarily clears the ready port. Completion owns the next stage in that case.
        if (IsBusy || state?.Preparing == true) return;
        if (identityChanged)
        {
            ExportPath = null;
            ShowVerification = ConfirmReset = false;
            Stage = HostReady ? DirectIpSetupStage.Device : DirectIpSetupStage.Prepare;
        }
        else if (!HostReady)
        {
            Stage = DirectIpSetupStage.Prepare;
        }
    }

    public bool BeginOperation()
    {
        if (IsBusy) return false;
        IsBusy = true;
        _operationIdentity = State?.CaFingerprint;
        Error = null;
        ConfirmReset = false;
        return true;
    }

    public void CompleteOperation(DirectIpHttpsState? state, string? exportPath, CouchCoopText? error = null)
    {
        IsBusy = false;
        State = state;
        ExportPath = error is null ? exportPath : null;
        Error = error;
        Stage = HostReady && !string.IsNullOrWhiteSpace(ExportPath) && error is null
            ? DirectIpSetupStage.Device : DirectIpSetupStage.Prepare;
        if (Stage == DirectIpSetupStage.Prepare && Error is null)
            Error = new CouchCoopText("couchcoop_https_operation_failed");
    }

    public void CompleteExport(string? exportPath, CouchCoopText? error = null)
    {
        var identityChanged = !string.Equals(_operationIdentity, State?.CaFingerprint, StringComparison.Ordinal);
        IsBusy = false;
        if (identityChanged || !HostReady)
        {
            ExportPath = null;
            Error = new CouchCoopText("couchcoop_https_operation_failed");
            Stage = HostReady ? DirectIpSetupStage.Device : DirectIpSetupStage.Prepare;
            return;
        }
        ExportPath = error is null ? exportPath : null;
        Error = error ?? (string.IsNullOrWhiteSpace(exportPath)
            ? new CouchCoopText("couchcoop_https_export_failed") : (CouchCoopText?)null);
    }

    public void ChooseDevice(DirectIpSetupDevice device)
    {
        if (IsBusy) return;
        Device = device;
        ShowVerification = false;
    }

    public bool AcknowledgeInstallation()
    {
        if (!HostReady || Device is null || IsBusy || Stage != DirectIpSetupStage.Device) return false;
        Stage = DirectIpSetupStage.Connect;
        return true;
    }

    public void AnotherDevice()
    {
        if (IsBusy) return;
        Device = null;
        ShowVerification = false;
        Stage = HostReady ? DirectIpSetupStage.Device : DirectIpSetupStage.Prepare;
    }

    public void Back()
    {
        if (IsBusy) return;
        ConfirmReset = false;
        Stage = Stage == DirectIpSetupStage.Connect && HostReady
            ? DirectIpSetupStage.Device : DirectIpSetupStage.Prepare;
    }

    public void ToggleAdvanced() { ShowAdvanced = !ShowAdvanced; if (!ShowAdvanced) ConfirmReset = false; }
    public void ToggleVerification() => ShowVerification = !ShowVerification;
    public void RequestReset() { if (!IsBusy) { ShowAdvanced = true; ConfirmReset = true; } }
    public void CancelReset() => ConfirmReset = false;
}
