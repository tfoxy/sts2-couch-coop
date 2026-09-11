namespace CouchCoop.Mod.Loader;

public static partial class CouchCoopModEntry
{
    static partial void InitializeHotReload(string modDirectory)
        => CouchCoopHotReloadProtocol.Initialize(modDirectory);
}
