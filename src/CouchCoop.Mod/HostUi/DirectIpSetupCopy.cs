using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.HostUi;

/// <summary>Localized native setup instructions; no trust material is downloaded by a browser.</summary>
internal static class DirectIpSetupCopy
{
    public static string DeviceKey(DirectIpSetupDevice device) => device switch
    {
        DirectIpSetupDevice.Iphone => "iphone",
        DirectIpSetupDevice.Android => "android",
        DirectIpSetupDevice.Windows => "windows",
        DirectIpSetupDevice.MacOs => "macos",
        DirectIpSetupDevice.LinuxFirefox => "linux",
        _ => throw new ArgumentOutOfRangeException(nameof(device)),
    };

    public static CouchCoopText Status(DirectIpHttpsState? state) => new(state switch
    {
        { Preparing: true } => "couchcoop_direct_https_preparing",
        { ErrorCode: "authority-expired" } => "couchcoop_direct_https_authority_expired",
        { ErrorCode: "authority-invalid" } => "couchcoop_direct_https_authority_invalid",
        { ErrorCode: not null } => "couchcoop_direct_https_failed",
        { Port: > 0, Addresses.Count: > 0 } => "couchcoop_direct_https_ready",
        _ => "couchcoop_direct_https_pending",
    });

}
