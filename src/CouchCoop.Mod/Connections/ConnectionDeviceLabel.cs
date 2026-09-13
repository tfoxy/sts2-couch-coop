using DeviceDetectorNET;

namespace CouchCoop.Mod.Connections;

/// <summary>A best-effort display label, never a connection identity or a compatibility decision.</summary>
public static class ConnectionDeviceLabel
{
    public static string? FromUserAgent(string? userAgent)
    {
        if (string.IsNullOrWhiteSpace(userAgent)) return null;
        try
        {
            // User agents are untrusted, and parsing must not delay the game thread.
            if (userAgent.Length > 2048) return null;
            var detector = new DeviceDetector(userAgent);
            detector.SkipBotDetection();
            detector.Parse();
            var os = detector.GetOs()?.Match;
            var browser = detector.GetBrowserClient()?.Match;
            var model = Clean(detector.GetModel());
            var osLabel = Join(Clean(os?.Name), Version(os?.Version, majorOnly: false));
            var browserName = Clean(browser?.Name) ?? Clean(detector.GetClient()?.Match?.Name);
            browserName = browserName switch
            {
                "Chrome Mobile" or "Chrome Mobile iOS" => "Chrome",
                "Mobile Safari" => "Safari",
                "Firefox Mobile" or "Firefox Mobile iOS" => "Firefox",
                _ => browserName
            };
            var browserLabel = Join(browserName, Version(browser?.Version, majorOnly: browserName != "Safari"));
            // Apple exposes an OS version in the UA, not the phone's hardware generation.
            var deviceLabel = model is "iPhone" or "iPad" or "iPod Touch"
                ? Join(model, osLabel) : model ?? osLabel;
            return deviceLabel is not null && browserLabel is not null
                ? $"{deviceLabel} · {browserLabel}" : deviceLabel ?? browserLabel;
        }
        catch
        {
            return null;
        }
    }

    private static string? Join(string? left, string? right)
        => left is null ? right : right is null ? left : $"{left} {right}";

    private static string? Version(string? value, bool majorOnly)
    {
        var version = Clean(value);
        if (version is null) return null;
        var parts = version.Split('.');
        return string.Join('.', parts.Take(majorOnly ? 1 : 2));
    }

    private static string? Clean(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return new string(value.Take(128).Select(c => char.IsControl(c) ? ' ' : c).ToArray()).Trim();
    }
}
