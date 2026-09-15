using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// One-line advisories about a degraded hosting session, rendered in the QR dialog AND as a modal on
/// entering the lobby.
/// </summary>
/// <remarks>
/// <para>
/// A deliberately dumb seam. The producer of the only current notice is the hosting transport, which
/// silently falls back to a LAN-only ENet host when Steam is initialised but offline.
/// </para>
/// <para>
/// <b>The product decision here has changed.</b> This used to read "fall back and log, never pop a
/// modal", and the note appeared only as a small tip line under the QR. That half is still true of the
/// TRANSPORT — it never blocks or prompts, it degrades and carries on — but it was wrong for the UI: a
/// host who never opens the QR dialog never saw the tip, and was left guessing why a friend could not
/// connect. So the note now also drives a modal, once per lobby mount, decided by
/// <see cref="HostTransportAlert"/> and rendered by <c>CouchCoopHostTransportAlertDialog</c>. The tip
/// line stays: it is the answer to "why can't they join" for a host who is already in the dialog looking
/// for the address.
/// </para>
/// <para>
/// Kept as a settable semantic value rather than a reference to the transport type so the UI layer does
/// not take a compile-time dependency on the networking layer — the two are built independently, and
/// both surfaces must render fine with the note simply never set.
/// </para>
/// </remarks>
public static class CouchCoopHostUiNotices
{
    /// <summary>
    /// Set by the hosting transport when the session is degraded in a way a joining player should
    /// know about; <see langword="null"/> (the default) renders no label and pops no modal.
    /// </summary>
    public static CouchCoopText? HostTransportNote { get; set; }

    /// <summary>
    /// Whether this machine's <c>.local</c> name is believed to actually resolve on the LAN, as observed by
    /// <see cref="MdnsResponder"/>'s startup self-check. <see langword="null"/> (the default) means "not
    /// observed", which must be read as "assume it works".
    /// </summary>
    /// <remarks>
    /// Written by the responder rather than read from it so the QR dialog does not have to hold — or
    /// null-check — a reference to a best-effort background service that may never have started. Same
    /// reasoning as <see cref="HostTransportNote"/> above.
    /// </remarks>
    public static bool? MdnsNameResolves { get; set; }

    /// <summary>
    /// Set to <c>0</c>/<c>false</c>/<c>off</c>/<c>no</c> to ignore <see cref="MdnsNameResolves"/> and leave
    /// the <c>.local</c> row unbadged however the self-check went. The row's POSITION never depended on this
    /// — <c>QrHostOptions.Build</c> appends the mDNS row last unconditionally.
    /// </summary>
    public const string MdnsRowSelfCheckEnvironmentVariable = "COUCHCOOP_MDNS_ROW_SELFCHECK";

    /// <summary>The value the QR dialog should pass to <c>QrHostOptions.Build</c>.</summary>
    public static bool MdnsRowTrusted()
    {
        var value = Environment.GetEnvironmentVariable(MdnsRowSelfCheckEnvironmentVariable)?.Trim();
        if (value is not null
            && (value.Equals("0", StringComparison.Ordinal)
                || value.Equals("false", StringComparison.OrdinalIgnoreCase)
                || value.Equals("off", StringComparison.OrdinalIgnoreCase)
                || value.Equals("no", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        return MdnsNameResolves ?? true;
    }
}
