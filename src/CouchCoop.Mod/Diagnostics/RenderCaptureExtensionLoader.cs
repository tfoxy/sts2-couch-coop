namespace CouchCoop.Mod.Diagnostics;

/// <summary>
/// Loads the out-of-tree render-capture GDExtension, named by an absolute path in
/// <see cref="EnvironmentVariable"/>, through <c>GDExtensionManager.LoadExtension</c>. Only the streaming seat
/// loads it; <see cref="Session.StreamingSeatRole"/> decides when, and what a failure means.
/// </summary>
/// <remarks>
/// This is the modder load route of godot-scene-web's render-stream capture
/// (<c>experiments/render-stream/protocol/gate8-product-handoff.md</c> there): the extension reads its own
/// <c>GRC_*</c> environment and decides for itself whether to arm. This class holds no logic beyond validating the
/// path and the load. The path must be absolute and name a <c>.gdextension</c> file that exists; anything else is
/// refused and nothing is loaded. <see cref="Load"/> never throws: mod init runs inside the loader's blanket catch,
/// and a throw there would skip every patch below it.
/// </remarks>
internal static class RenderCaptureExtensionLoader
{
    internal const string EnvironmentVariable = "COUCHCOOP_RENDER_CAPTURE_EXTENSION";

    /// <summary>The validated path to load, or the reason not to. Both null means the variable is unset.</summary>
    internal readonly record struct Request(string? Path, string? Refusal);

    /// <summary>What a load attempt came to: whether the extension is loaded, and the status to log.</summary>
    internal readonly record struct LoadResult(bool Loaded, string Status);

    internal static Request Resolve(string? value, Func<string, bool> fileExists)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return new Request(null, null);
        }

        var path = value.Trim();
        if (!System.IO.Path.IsPathFullyQualified(path))
        {
            return new Request(null, $"{EnvironmentVariable} must be an absolute path, got '{path}'");
        }

        if (!path.EndsWith(".gdextension", StringComparison.Ordinal))
        {
            return new Request(null, $"{EnvironmentVariable} must name a .gdextension file, got '{path}'");
        }

        if (!fileExists(path))
        {
            return new Request(null, $"{EnvironmentVariable} names a file that does not exist: '{path}'");
        }

        return new Request(path, null);
    }

    /// <summary>
    /// Load the extension at a path <see cref="Resolve"/> accepted. <c>AlreadyLoaded</c> counts as loaded; every
    /// other status that is not <c>Ok</c>, and a throw, is a failure reported in the result.
    /// </summary>
    internal static LoadResult Load(string path)
    {
        try
        {
            var status = Godot.GDExtensionManager.LoadExtension(path);
            var loaded = status is Godot.GDExtensionManager.LoadStatus.Ok
                or Godot.GDExtensionManager.LoadStatus.AlreadyLoaded;
            return new LoadResult(loaded, status.ToString());
        }
        catch (Exception exception)
        {
            return new LoadResult(false, $"threw {exception.GetType().Name}: {exception.Message}");
        }
    }
}
