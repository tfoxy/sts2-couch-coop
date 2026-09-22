using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json;
using CouchCoop.Mod.Patches;

internal static class MetadataOnlyLobbyScreenMountTests
{
    internal static void RunProductionTargets(string assemblyPath)
    {
        if (!File.Exists(assemblyPath))
        {
            throw new FileNotFoundException("staged STS2 metadata assembly was not found", assemblyPath);
        }

        // Both mount families, against the same staged assembly: the two lobby screens that carry the QR
        // button, and the pause menu that carries the mid-run QR row.
        foreach (var target in LobbyScreenMountTargets.Targets.Concat(PauseMenuMountTargets.Targets))
        {
            Assert(HasDirectZeroArgumentMethod(assemblyPath, target.TypeName, target.MethodName),
                $"{target.TypeName} must directly declare zero-argument {target.MethodName}");
        }
    }

    internal static void RunFixtureCases()
    {
        var fixture = typeof(CouchCoop.Mod.Tests.MetadataOnlyFixtures.DirectReady).Assembly.Location;
        Assert(HasDirectZeroArgumentMethod(
                fixture,
                "CouchCoop.Mod.Tests.MetadataOnlyFixtures.DirectReady",
                "_Ready"),
            "direct fixture declaration resolves");
        Assert(!HasDirectZeroArgumentMethod(
                fixture,
                "CouchCoop.Mod.Tests.MetadataOnlyFixtures.MissingReady",
                "_Ready"),
            "missing fixture declaration refuses");
        Assert(!HasDirectZeroArgumentMethod(
                fixture,
                "CouchCoop.Mod.Tests.MetadataOnlyFixtures.InheritedReady",
                "_Ready"),
            "inherited fixture declaration refuses");
    }

    /// <summary>
    /// The project file makes this mode game-free; inspect the emitted dependency graph too, so a future project
    /// reference cannot quietly make a metadata check load a game, Godot, Harmony, Steam, or spirectl assembly.
    /// </summary>
    internal static void AssertMetadataOnlyDependencyPolicy()
    {
        var assemblyPath = typeof(MetadataOnlyLobbyScreenMountTests).Assembly.Location;
        var depsPath = Path.ChangeExtension(assemblyPath, ".deps.json");
        using var document = JsonDocument.Parse(File.ReadAllText(depsPath));
        var forbidden = new[]
        {
            "CouchCoop.Mod/", "Godot", "Harmony", "sts2", "Steam", "Spirectl",
        };
        var libraries = document.RootElement.GetProperty("targets")
            .EnumerateObject()
            .SelectMany(target => target.Value.EnumerateObject())
            .Select(library => library.Name);
        foreach (var library in libraries)
        {
            Assert(!forbidden.Any(name => library.Contains(name, StringComparison.OrdinalIgnoreCase)),
                $"metadata-only dependency graph contains forbidden entry {library}");
        }
    }

    internal static bool HasDirectZeroArgumentMethod(string assemblyPath, string fullTypeName, string methodName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        if (!pe.HasMetadata)
        {
            return false;
        }

        var metadata = pe.GetMetadataReader();
        foreach (var handle in metadata.TypeDefinitions)
        {
            var type = metadata.GetTypeDefinition(handle);
            if (!string.Equals(FullName(metadata, type), fullTypeName, StringComparison.Ordinal))
            {
                continue;
            }

            return type.GetMethods().Select(metadata.GetMethodDefinition).Any(method =>
                string.Equals(metadata.GetString(method.Name), methodName, StringComparison.Ordinal)
                && ParameterCount(metadata, method) == 0);
        }

        return false;
    }

    private static int ParameterCount(MetadataReader metadata, MethodDefinition method)
    {
        var signature = metadata.GetBlobReader(method.Signature);
        var header = signature.ReadSignatureHeader();
        if (header.IsGeneric) signature.ReadCompressedInteger();
        return signature.ReadCompressedInteger();
    }

    private static string FullName(MetadataReader metadata, TypeDefinition type)
    {
        var @namespace = metadata.GetString(type.Namespace);
        var name = metadata.GetString(type.Name);
        return string.IsNullOrEmpty(@namespace) ? name : $"{@namespace}.{name}";
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
