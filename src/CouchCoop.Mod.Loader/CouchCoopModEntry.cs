using System.Reflection;
using System.Runtime.Loader;
using CouchCoop.Mod.Session;
using MegaCrit.Sts2.Core.Modding;

namespace CouchCoop.Mod.Loader;

[ModInitializer("Init")]
public static partial class CouchCoopModEntry
{
    private const string ImplementationAssemblyName = "CouchCoop.Mod";
    private const string ImplementationTypeName = "CouchCoop.Mod.CouchCoopMod";
    private static bool _initialized;

    /// <summary>
    /// Simple names already reported as a foreign-copy conflict, so a resolve storm cannot flood godot.log.
    /// </summary>
    /// <remarks>
    /// The conflict throw travels out through <c>Resolving</c> / <c>AssemblyResolve</c> handlers that swallow
    /// it (by contract — a handler must return null, not throw), so the CLR's own "could not load" is all a
    /// player would otherwise see. The message has to be logged where it is DECIDED, and the CLR will ask for
    /// the same name repeatedly.
    /// </remarks>
    private static readonly HashSet<string> ReportedConflicts = new(StringComparer.Ordinal);

    public static void Init()
    {
        if (_initialized)
        {
            return;
        }

        Checkpoint("loader-entry");

        // Hoisted out of the `try` so the failure line below can carry them. Which game this is, and which
        // build of CouchCoop this is, are the two facts that turn an opaque CLR type-load stack into an
        // obvious answer — and they are the two the catch would otherwise have lost.
        string? detectedVersion = null;
        var payloadDescription = "flat";

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

            // WHICH LANE. One payload ships an implementation per game build under `lanes/<floor version>/`;
            // this picks the highest one at or below the running game. A flat payload (every dev deploy) has
            // no `lanes/` directory and takes the pre-lane path unchanged and silently. See
            // CouchCoopLaneSelection for why the decision cannot simply call spirectl's version ladder.
            detectedVersion = CouchCoopLaneSelection.ResolveGameVersion();
            Checkpoint($"loader-version version={detectedVersion ?? "<undetected>"}");
            var selection = CouchCoopLaneSelection.Select(modDirectory, detectedVersion);
            payloadDescription = selection.LaneDirectory is not null
                ? $"lane {Path.GetFileName(selection.LaneDirectory)}"
                : $"flat, built for {CouchCoopLaneSelection.ReadFlatBuildGameVersion(modDirectory) ?? "<unstamped>"}";
            Checkpoint($"loader-payload payload={payloadDescription}");
            if (selection.Refusal is not null)
            {
                // Refuse BEFORE loading anything. A lane built for a different game build loads fine and then
                // throws from inside a game callback, where nothing names CouchCoop as the cause.
                CouchCoopLogLine.Error(selection.Refusal);
                return;
            }

            // The lane FIRST, the mod root second: the lane owns CouchCoop.Mod.dll / CouchCoop.Spirectl.dll,
            // the root owns everything both lanes share.
            string[] probeDirectories = selection.LaneDirectory is null
                ? [modDirectory]
                : [selection.LaneDirectory, modDirectory];

            if (selection.LaneDirectory is not null)
            {
                CouchCoopLogLine.Info(
                    $"game {selection.DetectedVersion} -> lane '{selection.LaneDirectory}'");

                // Names a stale root copy the lane is shadowing. Benign for someone who extracted a new
                // release over an old one; the tell that a dev deploy is not the code running otherwise.
                var ignoredRootCopy = CouchCoopLaneSelection.DescribeIgnoredRootCopy(
                    modDirectory,
                    selection.LaneDirectory,
                    ImplementationAssemblyName);
                if (ignoredRootCopy is not null)
                {
                    CouchCoopLogLine.Warn(ignoredRootCopy);
                }
            }

            Assembly ResolveFromModDirectory(AssemblyName assemblyName)
            {
                var assemblyPath = CouchCoopLaneSelection.FindAssembly(probeDirectories, assemblyName.Name);

                var loadedAssembly = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(candidate => string.Equals(
                        candidate.GetName().Name,
                        assemblyName.Name,
                        StringComparison.Ordinal));
                if (loadedAssembly is not null)
                {
                    // Already loaded by simple name is normally the right answer — it is what keeps one copy
                    // of the shared types in the process. But if we ship that name ourselves and the loaded
                    // copy is a DIFFERENT FILE, silently using it runs the other lane, or a second installed
                    // copy of CouchCoop, with no symptom until something binds a member that moved.
                    var conflict = CouchCoopLaneSelection.DescribeLoadedCopyConflict(
                        assemblyName.Name,
                        SafeLocation(loadedAssembly),
                        assemblyPath);
                    if (conflict is not null)
                    {
                        if (assemblyName.Name is { } name && ReportedConflicts.Add(name))
                        {
                            if (conflict.Fatal)
                            {
                                CouchCoopLogLine.Error(conflict.Message);
                            }
                            else
                            {
                                CouchCoopLogLine.Warn(conflict.Message);
                            }
                        }

                        if (conflict.Fatal)
                        {
                            throw new InvalidOperationException(conflict.Message);
                        }
                    }

                    return loadedAssembly;
                }

                if (assemblyPath is null)
                {
                    throw new FileNotFoundException(
                        $"Unable to resolve '{assemblyName.Name}' from "
                        + $"'{string.Join("', '", probeDirectories)}'.");
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

            Checkpoint("loader-invoke");
            initMethod.Invoke(null, null);
            _initialized = true;
            InitializeHotReload(modDirectory);
        }
        catch (Exception ex)
        {
            // The build identity leads, because it is the answer far more often than the stack is. The
            // failure this catch sees most is an implementation compiled for a different game build than
            // the one running: the CLR reports it as a TypeLoadException naming a GAME type, which reads
            // as "the game is broken" and names neither the build we are nor the build this is.
            CouchCoopLogLine.Error(
                $"bootstrap loader failed (game {detectedVersion ?? "<undetected>"}, "
                + $"payload {payloadDescription}): {ex}");
        }
    }

    // Loader diagnostics must reach both the terminal attached to a manual launch and the game's own
    // godot.log. The logger sink is intentionally best-effort (CouchCoopLogLine catches logger startup
    // failures); stderr remains the early-loader evidence path.
    private static void Checkpoint(string checkpoint)
    {
        CouchCoopLogLine.Stderr(checkpoint);
        CouchCoopLogLine.Info(checkpoint);
    }

    /// <summary>
    /// <see cref="Assembly.Location"/>, or <see langword="null"/> when the assembly has none.
    /// </summary>
    /// <remarks>
    /// A dynamic assembly throws on <c>Location</c> under some hosts and returns an empty string under
    /// others. Both mean the same thing here — "no file to compare" — and the caller treats that as "no
    /// conflict", because refusing on an incomparable path would take the mod down over nothing.
    /// </remarks>
    private static string? SafeLocation(Assembly assembly)
    {
        try
        {
            var location = assembly.Location;
            return string.IsNullOrEmpty(location) ? null : location;
        }
        catch (NotSupportedException)
        {
            return null;
        }
    }

    static partial void InitializeHotReload(string modDirectory);
}
