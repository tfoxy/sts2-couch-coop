using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Runtime;

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

        // The methods that assign a lobby to those screens: each must still be DECLARED by its screen with the same
        // number of parameters (their parameter types are pinned by the typed binding in the full lane).
        foreach (var target in LobbyAssignmentTargets.Targets)
        {
            Assert(HasDirectMethod(assemblyPath, target.TypeName, target.MethodName, target.ParameterCount),
                $"{target.TypeName} must directly declare {target.MethodName} with {target.ParameterCount} parameter(s)");
        }

        // Where the start-run lobby keeps its player cap: the private int field one lane reads by name (a
        // maintainer-granted exception) or the public int property the other lane calls. Either shape satisfies the
        // build the assembly is for; a build with NEITHER would compile clean and read no cap at all.
        Assert(HasInstanceIntField(assemblyPath, LobbyCapTargets.StartRunLobbyType, LobbyCapTargets.FieldName)
                || HasInstanceIntGetter(assemblyPath, LobbyCapTargets.StartRunLobbyType, LobbyCapTargets.PropertyGetterName),
            $"{LobbyCapTargets.StartRunLobbyType} must declare an int field {LobbyCapTargets.FieldName} or an int "
            + $"property getter {LobbyCapTargets.PropertyGetterName}");
    }

    internal static void RunFixtureCases()
    {
        var parameterized = typeof(CouchCoop.Mod.Tests.MetadataOnlyFixtures.DirectReady).Assembly.Location;
        Assert(HasDirectMethod(parameterized, "CouchCoop.Mod.Tests.MetadataOnlyFixtures.TwoArguments", "Assign", 2),
            "a declared two-argument fixture method resolves by its parameter count");
        Assert(!HasDirectMethod(parameterized, "CouchCoop.Mod.Tests.MetadataOnlyFixtures.TwoArguments", "Assign", 1),
            "a different parameter count refuses");

        // The lobby-cap member checks: an int field or int getter matches, and the near misses do not.
        const string cases = "CouchCoop.Mod.Tests.MetadataOnlyFixtures.";
        Assert(HasInstanceIntField(parameterized, cases + "CapAsField", "_maxPlayers"), "a private int field matches");
        Assert(!HasInstanceIntField(parameterized, cases + "CapAsProperty", "_maxPlayers"), "a lane with only the property has no field");
        Assert(!HasInstanceIntField(parameterized, cases + "CapAsWrongType", "_maxPlayers"), "a field of another type refuses");
        Assert(!HasInstanceIntField(parameterized, cases + "CapAsStaticField", "_maxPlayers"), "a static field refuses");
        Assert(!HasInstanceIntField(parameterized, cases + "MissingReady", "_maxPlayers"), "a type without the field refuses");
        Assert(HasInstanceIntGetter(parameterized, cases + "CapAsProperty", "get_MaxPlayers"), "a public int property getter matches");
        Assert(!HasInstanceIntGetter(parameterized, cases + "CapAsField", "get_MaxPlayers"), "a lane with only the field has no getter");
        Assert(!HasInstanceIntGetter(parameterized, cases + "CapAsWrongType", "get_MaxPlayers"), "a getter of another type refuses");

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
        => HasDirectMethod(assemblyPath, fullTypeName, methodName, parameterCount: 0);

    internal static bool HasDirectMethod(string assemblyPath, string fullTypeName, string methodName, int parameterCount)
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
                && ParameterCount(metadata, method) == parameterCount);
        }

        return false;
    }

    /// <summary>Whether the type declares an instance field of exactly this name whose type is <c>int</c>.</summary>
    internal static bool HasInstanceIntField(string assemblyPath, string fullTypeName, string fieldName)
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

            foreach (var field in type.GetFields().Select(metadata.GetFieldDefinition))
            {
                if (!string.Equals(metadata.GetString(field.Name), fieldName, StringComparison.Ordinal)
                    || (field.Attributes & FieldAttributes.Static) != 0)
                {
                    continue;
                }

                var signature = metadata.GetBlobReader(field.Signature);
                signature.ReadSignatureHeader();
                return signature.ReadSignatureTypeCode() == SignatureTypeCode.Int32;
            }

            return false;
        }

        return false;
    }

    /// <summary>Whether the type declares a parameterless instance method of this name that returns <c>int</c>.</summary>
    internal static bool HasInstanceIntGetter(string assemblyPath, string fullTypeName, string getterName)
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

            foreach (var method in type.GetMethods().Select(metadata.GetMethodDefinition))
            {
                if (!string.Equals(metadata.GetString(method.Name), getterName, StringComparison.Ordinal)
                    || (method.Attributes & MethodAttributes.Static) != 0)
                {
                    continue;
                }

                var signature = metadata.GetBlobReader(method.Signature);
                var header = signature.ReadSignatureHeader();
                if (header.IsGeneric) signature.ReadCompressedInteger();
                return signature.ReadCompressedInteger() == 0 && signature.ReadSignatureTypeCode() == SignatureTypeCode.Int32;
            }

            return false;
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
