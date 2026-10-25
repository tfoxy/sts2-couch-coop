using CouchCoop.Mod.Diagnostics;

// The render-capture extension path. What matters: unset resolves to nothing with no refusal (the streaming
// seat role decides what that means), and every malformed value is refused before anything is loaded.
//
// Pure path logic; no environment, no engine.
internal static class RenderCaptureExtensionLoaderTests
{
    private const string Valid = "/opt/research/render_stream_capture.gdextension";

    public static void Run()
    {
        UnsetIsOffAndSilent();
        AbsoluteExistingGdextensionIsLoaded();
        RelativePathIsRefused();
        OtherExtensionIsRefused();
        MissingFileIsRefused();
    }

    private static void UnsetIsOffAndSilent()
    {
        foreach (var blank in new string?[] { null, "", "  " })
        {
            var request = RenderCaptureExtensionLoader.Resolve(blank, _ => true);
            Assert(request.Path is null && request.Refusal is null, "unset resolves to nothing, with no refusal");
        }
    }

    private static void AbsoluteExistingGdextensionIsLoaded()
    {
        var request = RenderCaptureExtensionLoader.Resolve($" {Valid}\n", path => path == Valid);
        Assert(request.Path == Valid && request.Refusal is null, "an absolute existing .gdextension is loaded, trimmed");
    }

    private static void RelativePathIsRefused()
    {
        var request = RenderCaptureExtensionLoader.Resolve("build/render_stream_capture.gdextension", _ => true);
        Assert(request.Path is null && request.Refusal is not null, "a relative path is refused");
    }

    private static void OtherExtensionIsRefused()
    {
        var request = RenderCaptureExtensionLoader.Resolve("/opt/research/librender_stream_capture.so", _ => true);
        Assert(request.Path is null && request.Refusal is not null, "a bare shared library is refused");
    }

    private static void MissingFileIsRefused()
    {
        var request = RenderCaptureExtensionLoader.Resolve(Valid, _ => false);
        Assert(request.Path is null && request.Refusal is not null, "a missing file is refused");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[RenderCaptureExtensionLoaderTests] FAILED: {label}");
        }
    }
}
