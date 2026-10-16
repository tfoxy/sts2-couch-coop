using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.HostUi;

internal enum QrMethodReadiness { Ready, SetupRequired, Preparing, NeedsAttention, Unavailable }

/// <summary>Host readiness is separate from selectable setup, and never asserts client trust.</summary>
internal sealed record QrMethodPresentation(QrMethodReadiness State, CouchCoopText Subtitle,
    CouchCoopText? SetupAction = null)
{
    public bool ShowsSetup => SetupAction is not null;
    public bool UsesSetupPlaceholder => ShowsSetup && State != QrMethodReadiness.Ready;

    public static QrMethodPresentation For(QrHostOption? option, DirectIpHttpsState? directState = null,
        Uri? previewUrl = null)
    {
        var presentation = Describe(option, directState);
        // The domain's destination remains useful while certificate preparation runs. A preview
        // changes only the subtitle, never readiness, copyability, or the QR payload.
        return option?.Kind == QrHostOptionKind.Secure && previewUrl is not null
            ? presentation with { Subtitle = CouchCoopText.FromLiteral(previewUrl.ToString()) }
            : presentation;
    }

    private static QrMethodPresentation Describe(QrHostOption? option, DirectIpHttpsState? directState)
    {
        if (option is { Enabled: true, Port: > 0 })
            return new(QrMethodReadiness.Ready, CouchCoopText.FromLiteral(option.ToUri().ToString()),
                option.Kind == QrHostOptionKind.DirectIpSecure ? new("couchcoop_https_device_action") : (CouchCoopText?)null);
        if (option is not { Selectable: true })
            return new(QrMethodReadiness.Unavailable, new("couchcoop_qr_unavailable_title"));

        var direct = option.Kind == QrHostOptionKind.DirectIpSecure;
        var state = direct
            ? directState is { Preparing: true } ? QrMethodReadiness.Preparing
                : directState?.ErrorCode is not null ? QrMethodReadiness.NeedsAttention : QrMethodReadiness.SetupRequired
            : option.DisabledReason?.Key switch
            {
                "couchcoop_secure_checking" or "couchcoop_option_secure_pending" => QrMethodReadiness.Preparing,
                null or "couchcoop_secure_idle" => QrMethodReadiness.SetupRequired,
                _ => QrMethodReadiness.NeedsAttention,
            };
        return state switch
        {
            QrMethodReadiness.Preparing => new(state, new("couchcoop_https_busy"), direct ? new("couchcoop_https_view_action") : (CouchCoopText?)null),
            QrMethodReadiness.NeedsAttention => new(state, new("couchcoop_https_needs_attention"), direct ? new("couchcoop_https_fix_action") : (CouchCoopText?)null),
            _ => new(state, new("couchcoop_https_setup_required"), direct ? new("couchcoop_https_setup_action") : (CouchCoopText?)null),
        };
    }

    public static bool OpensSetup(QrHostOption? option, bool explicitMethodSelection)
        => explicitMethodSelection && option is { Kind: QrHostOptionKind.DirectIpSecure, Selectable: true };
}
