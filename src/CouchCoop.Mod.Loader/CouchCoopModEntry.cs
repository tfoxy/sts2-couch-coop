using System.Reflection;
using System.Runtime.Loader;
using MegaCrit.Sts2.Core.Logging;
using MegaCrit.Sts2.Core.Modding;

namespace CouchCoop.Mod.Loader;

[ModInitializer("Init")]
public static partial class CouchCoopModEntry
{
    private const string ImplementationAssemblyName = "CouchCoop.Mod";
    private const string ImplementationTypeName = "CouchCoop.Mod.CouchCoopMod";
    private static bool _initialized;

    public static void Init()
    {
        if (_initialized)
        {
            return;
        }

        try
        {
            var loaderAssembly = Assembly.GetExecutingAssembly();
            var modDirectory = Path.GetDirectoryName(loaderAssembly.Location);
            if (string.IsNullOrWhiteSpace(modDirectory))
            {
                throw new InvalidOperationException("Unable to determine the CouchCoop mod directory.");
            }

            var loadContext = AssemblyLoadContext.GetLoadContext(loaderAssembly)
                ?? throw new InvalidOperationException("Unable to resolve the CouchCoop load context.");

            Assembly ResolveFromModDirectory(AssemblyName assemblyName)
            {
                var loadedAssembly = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(candidate => string.Equals(
                        candidate.GetName().Name,
                        assemblyName.Name,
                        StringComparison.Ordinal));
                if (loadedAssembly is not null)
                {
                    return loadedAssembly;
                }

                var assemblyPath = Path.Combine(modDirectory, $"{assemblyName.Name}.dll");
                if (!File.Exists(assemblyPath))
                {
                    throw new FileNotFoundException(
                        $"Unable to resolve '{assemblyName.Name}' from '{modDirectory}'.",
                        assemblyPath);
                }

                return loadContext.LoadFromAssemblyPath(assemblyPath);
            }

            loadContext.Resolving += (_, assemblyName) =>
            {
                try
                {
                    return ResolveFromModDirectory(assemblyName);
                }
                catch
                {
                    return null;
                }
            };

            AppDomain.CurrentDomain.AssemblyResolve += (_, args) =>
            {
                try
                {
                    return ResolveFromModDirectory(new AssemblyName(args.Name));
                }
                catch
                {
                    return null;
                }
            };

            var implementationAssembly = ResolveFromModDirectory(new AssemblyName(ImplementationAssemblyName));
            var entryPointType = implementationAssembly.GetType(ImplementationTypeName, throwOnError: true)
                ?? throw new InvalidOperationException($"Unable to resolve type '{ImplementationTypeName}'.");
            var initMethod = entryPointType.GetMethod(
                "Init",
                BindingFlags.Public | BindingFlags.Static)
                ?? throw new InvalidOperationException($"Unable to resolve '{ImplementationTypeName}.Init'.");

            initMethod.Invoke(null, null);
            _initialized = true;
            InitializeHotReload(modDirectory);
        }
        catch (Exception ex)
        {
            Log.Error($"[couch-coop] bootstrap loader failed: {ex}");
        }
    }

    static partial void InitializeHotReload(string modDirectory);
}
