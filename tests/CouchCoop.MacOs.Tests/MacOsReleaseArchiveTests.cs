using System.IO.Compression;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

internal static class MacOsReleaseArchiveTests
{
    private static readonly string[] SharedAssemblies =
    [
        "couchcoop.dll", "CouchCoop.Mod.Contracts.dll", "CouchCoop.MirrorProtocol.dll"
    ];

    private static readonly string[] LaneAssemblies = ["CouchCoop.Mod.dll", "CouchCoop.Spirectl.dll"];
    private static readonly HashSet<string> ReviewedSdkClosure = new(StringComparer.Ordinal)
    {
        "0Harmony", "GodotSharp", "sts2", "Steamworks.NET", "MonoMod.Backports", "MonoMod.ILHelpers",
        "Sentry", "SmartFormat", "SmartFormat.ZString", "CouchCoop.Sts2.ReferenceSdk"
    };

    internal static void RunGraphTests()
    {
        DependencyClosure.AssertOwnedReferencesResolve(
            [new("CouchCoop.Mod", ["CouchCoop.Spirectl", "GodotSharp"])],
            new HashSet<string>(["CouchCoop.Mod", "CouchCoop.Spirectl"], StringComparer.Ordinal),
            ReviewedSdkClosure);
        ExpectFailure("missing owned dependency", () => DependencyClosure.AssertOwnedReferencesResolve(
            [new("CouchCoop.Mod", ["CouchCoop.MirrorProtocol"])], new HashSet<string>(), ReviewedSdkClosure));
        ExpectFailure("unexpected dependency", () => DependencyClosure.AssertOwnedReferencesResolve(
            [new("CouchCoop.Mod", ["Unreviewed.Game.Payload"])], new HashSet<string>(), ReviewedSdkClosure));
    }

    internal static void VerifyArchive(string archive)
    {
        if (!File.Exists(archive)) throw new FileNotFoundException("release archive was not found", archive);
        using var extract = new TempDirectory("couchcoop archive with spaces");
        ZipFile.ExtractToDirectory(archive, extract.Path);
        var roots = Directory.GetDirectories(extract.Path)
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        Assert(roots.SequenceEqual(["couchcoop"]), "archive has exactly one correctly cased couchcoop root");
        var payload = Path.Combine(extract.Path, "couchcoop");
        Assert(Directory.Exists(payload), "archive has couchcoop root");
        Assert(File.Exists(Path.Combine(payload, "couchcoop.json")), "payload has root couchcoop.json");
        Assert(File.Exists(Path.Combine(payload, "couchcoop.dll")), "payload has root loader couchcoop.dll");

        var allowed = new HashSet<string>(StringComparer.Ordinal)
        {
            "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "couchcoop.json", "build-info.txt",
            "couchcoop.dll", "CouchCoop.Mod.Contracts.dll", "CouchCoop.MirrorProtocol.dll", "QRCoder.dll",
            "DeviceDetector.NET.dll", "LiteDB.dll", "Microsoft.Extensions.DependencyInjection.Abstractions.dll",
            "Microsoft.Extensions.Logging.Abstractions.dll", "System.Diagnostics.DiagnosticSource.dll", "YamlDotNet.dll"
        };
        foreach (var assembly in SharedAssemblies) Assert(File.Exists(Path.Combine(payload, assembly)), $"shared file {assembly}");

        var laneRoot = Path.Combine(payload, "lanes");
        Assert(Directory.Exists(laneRoot), "payload has lanes directory");
        var laneDirectories = Directory.GetDirectories(laneRoot).OrderBy(Path.GetFileName, StringComparer.Ordinal).ToArray();
        Assert(laneDirectories.Select(Path.GetFileName).SequenceEqual(["0.107.1", "0.111.0"]), "archive has exact stable and beta lane directories");
        foreach (var lane in laneDirectories)
        {
            var names = Directory.GetFiles(lane).Select(Path.GetFileName).OrderBy(x => x, StringComparer.Ordinal).ToArray();
            Assert(names.SequenceEqual(LaneAssemblies.OrderBy(x => x, StringComparer.Ordinal)), $"lane {lane} has exactly its assemblies");
        }

        foreach (var file in Directory.GetFiles(payload, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(payload, file).Replace(Path.DirectorySeparatorChar, '/');
            var isLane = LaneAssemblies.Any(name => relative == $"lanes/0.107.1/{name}" || relative == $"lanes/0.111.0/{name}");
            var isKnownShared = allowed.Contains(relative);
            var isAllowedFrontend = relative.StartsWith("frontend/", StringComparison.Ordinal);
            var isAllowedLicense = relative.StartsWith("licenses/", StringComparison.Ordinal);
            Assert(isLane || isKnownShared || isAllowedFrontend || isAllowedLicense, $"unexpected release file {relative}");
            Assert(!relative.EndsWith("CouchCoop.Mod.dll", StringComparison.Ordinal) || isLane, "no flat implementation dll");
            Assert(!relative.EndsWith("CouchCoop.Spirectl.dll", StringComparison.Ordinal) || isLane, "no flat spirectl dll");
        }

        var sharedPaths = Directory.GetFiles(payload, "*.dll", SearchOption.TopDirectoryOnly);
        foreach (var lane in laneDirectories)
        {
            // A lane may resolve from its own two assemblies plus the shared payload, never from the
            // other lane. Keeping this graph per lane catches a beta-only dependency accidentally hidden
            // by the stable directory being present in the same archive.
            var closurePaths = sharedPaths.Concat(Directory.GetFiles(lane, "*.dll", SearchOption.TopDirectoryOnly)).ToArray();
            var payloadNames = closurePaths.Select(path => Path.GetFileNameWithoutExtension(path)!).ToHashSet(StringComparer.Ordinal);
            var ownedNodes = closurePaths.Select(ReadMetadataOnly)
                .Where(node => node.Name == "couchcoop" || node.Name.StartsWith("CouchCoop", StringComparison.Ordinal))
                .ToArray();
            DependencyClosure.AssertOwnedReferencesResolve(ownedNodes, payloadNames, ReviewedSdkClosure);
        }
    }

    private static DependencyClosure.Node ReadMetadataOnly(string path)
    {
        using var stream = File.OpenRead(path);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        var name = metadata.GetString(metadata.GetAssemblyDefinition().Name);
        var references = metadata.AssemblyReferences.Select(handle => metadata.GetString(metadata.GetAssemblyReference(handle).Name)).ToArray();
        return new DependencyClosure.Node(name, references);
    }

    private static void ExpectFailure(string label, Action action)
    {
        try { action(); }
        catch (InvalidOperationException) { return; }
        throw new InvalidOperationException($"expected {label} to fail");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private sealed class TempDirectory : IDisposable
    {
        internal TempDirectory(string name)
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), name + " " + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }
        internal string Path { get; }
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}

internal static class DependencyClosure
{
    internal sealed record Node(string Name, IReadOnlyList<string> References);

    internal static void AssertOwnedReferencesResolve(
        IEnumerable<Node> nodes,
        IReadOnlySet<string> payloadAssemblies,
        IReadOnlySet<string> reviewedSdkAssemblies)
    {
        foreach (var node in nodes)
        foreach (var reference in node.References)
        {
            if (payloadAssemblies.Contains(reference))
                continue;
            if (reference.StartsWith("CouchCoop", StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"{node.Name} references missing CouchCoop payload assembly {reference}");
            }

            if (reference is "System" or "System.Runtime" or "netstandard" or "Microsoft.CSharp" or "Microsoft.Win32.Primitives"
                || reference.StartsWith("System.", StringComparison.Ordinal))
                continue;
            if (!reviewedSdkAssemblies.Contains(reference))
                throw new InvalidOperationException($"{node.Name} references unexpected assembly {reference}");
        }
    }
}
