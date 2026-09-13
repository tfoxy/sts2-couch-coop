using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Tests;

internal static class ConnectionDeviceLabelTests
{
    public static void Run()
    {
        Assert(ConnectionDeviceLabel.FromUserAgent(null) is null, "absent UA is unknown");
        Assert(ConnectionDeviceLabel.FromUserAgent("   ") is null, "reduced blank UA is unknown");
        var safari = ConnectionDeviceLabel.FromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1");
        Assert(safari == "iPhone iOS 17.4 · Safari 17.4", $"iPhone Safari label pins parser output including iOS 17.4 (actual: {safari ?? "null"})");
        var chromeIos = ConnectionDeviceLabel.FromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1");
        Assert(chromeIos == "iPhone iOS 17.4 · Chrome 120", $"Chrome iOS is normalized to Chrome with its major version (actual: {chromeIos ?? "null"})");
        var android = ConnectionDeviceLabel.FromUserAgent("Mozilla/5.0 (Linux; Android 14; SM-S928W) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36");
        Assert(android == "Galaxy S24 Ultra · Chrome 120", $"Android model and Chrome 120 label pins parser output (actual: {android ?? "null"})");
        Assert(ConnectionDeviceLabel.FromUserAgent("Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")
            == "Chrome 120", "reduced UA keeps the useful browser label without inventing a device");
        Assert(ConnectionDeviceLabel.FromUserAgent(new string('x', 2049)) is null, "oversized UA is discarded");
    }
    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
}
