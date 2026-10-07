using System.Reflection;
using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Audio.Native;

internal static class FmodLibrary
{
    private static readonly object Gate = new();
    private static bool installed;
    private static string? libraryDirectory;

    internal static void Install(string? assembliesDirectory = null)
    {
        if (assembliesDirectory is not null && !Directory.Exists(assembliesDirectory))
            throw new DirectoryNotFoundException("game.assembliesDir is required for native audio tests");
        lock (Gate)
        {
            if (installed)
            {
                if (assembliesDirectory is not null && libraryDirectory is not null &&
                    !StringComparer.Ordinal.Equals(libraryDirectory, Path.GetFullPath(assembliesDirectory)))
                    throw new InvalidOperationException("FMOD library resolver already uses another install");
                return;
            }
            libraryDirectory = assembliesDirectory is null ? null : Path.GetFullPath(assembliesDirectory);
            NativeLibrary.SetDllImportResolver(typeof(FmodApi).Assembly, Resolve);
            installed = true;
        }
    }

    private static nint Resolve(string name, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (name is not ("couch-fmod" or "couch-fmodstudio")) return 0;
        string file = name == "couch-fmod" ?
            OperatingSystem.IsWindows() ? "fmod.dll" : OperatingSystem.IsMacOS() ? "libfmod.dylib" : "libfmod.so.14" :
            OperatingSystem.IsWindows() ? "fmodstudio.dll" : OperatingSystem.IsMacOS() ? "libfmodstudio.dylib" : "libfmodstudio.so.14";
        // An already loaded shared object is reused by the platform loader; the path also works in a test process.
        if (libraryDirectory is not null)
        {
            string path = Path.Combine(libraryDirectory, file);
            if (NativeLibrary.TryLoad(path, out nint fromDirectory)) return fromDirectory;
            string parentPath = Path.Combine(Path.GetDirectoryName(libraryDirectory)!, file);
            if (NativeLibrary.TryLoad(parentPath, out fromDirectory)) return fromDirectory;
        }
        if (NativeLibrary.TryLoad(file, out nint handle)) return handle;
        if (NativeLibrary.TryLoad(file, assembly, searchPath, out handle)) return handle;
        throw new DllNotFoundException($"Mirror audio could not bind loaded {file}");
    }
}
