using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.HostUi;

/// <summary>Localized native setup instructions; no trust material is downloaded by a browser.</summary>
internal static class DirectIpSetupCopy
{
    public static CouchCoopText Status(DirectIpHttpsState? state) => new(state switch
    {
        { Preparing: true } => "couchcoop_direct_https_preparing",
        { ErrorCode: "authority-expired" } => "couchcoop_direct_https_authority_expired",
        { ErrorCode: "authority-invalid" } => "couchcoop_direct_https_authority_invalid",
        { ErrorCode: not null } => "couchcoop_direct_https_failed",
        { Port: > 0, Addresses.Count: > 0 } => "couchcoop_direct_https_ready",
        _ => "couchcoop_direct_https_pending",
    });

    public static string Body(DirectIpHttpsState? state)
    {
        var paragraphs = new List<string>
        {
            Status(state).Resolve(),
            L("couchcoop_direct_https_warning"),
            L("couchcoop_direct_https_transfer"),
            L("couchcoop_direct_https_platforms"),
            L("couchcoop_direct_https_remove"),
        };
        if (state?.CaFingerprint is { Length: > 0 } fingerprint)
        {
            paragraphs.Add(CouchCoopText.Create("couchcoop_direct_https_identity",
                ("fingerprint", CouchCoopTextArgument.Value(fingerprint)),
                ("expiry", CouchCoopTextArgument.Value(state.CaExpiresAt?.UtcDateTime.ToString("yyyy-MM-dd") ?? "—")))
                .Resolve());
        }
        return string.Join("\n\n", paragraphs);
    }

    private static string L(string key) => CouchCoopLocalization.Resolve(key);
}
