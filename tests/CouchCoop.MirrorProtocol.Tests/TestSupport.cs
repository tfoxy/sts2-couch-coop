using System.Text.Json;

namespace CouchCoop.MirrorProtocol.Tests;

// Assert-or-throw harness support, matching the repo's custom Exe-runner convention (see
// tests/CouchCoop.Mod.Tests). No xunit / dotnet test.
internal static class Check
{
    public static void That(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"assertion failed: {label}");
        }
    }

    public static void Equal<T>(T actual, T expected, string label)
    {
        if (!EqualityComparer<T>.Default.Equals(actual, expected))
        {
            throw new Exception($"assertion failed: {label} (expected {Format(expected)}, got {Format(actual)})");
        }
    }

    public static void Close(double actual, double expected, string label, double tolerance = 1e-6)
    {
        if (double.IsNaN(actual) || Math.Abs(actual - expected) > tolerance)
        {
            throw new Exception($"assertion failed: {label} (expected ~{expected}, got {actual})");
        }
    }

    public static void SequenceEqual(IReadOnlyList<string> actual, IReadOnlyList<string> expected, string label)
    {
        if (actual.Count != expected.Count || !actual.SequenceEqual(expected))
        {
            throw new Exception($"assertion failed: {label} (expected [{string.Join(",", expected)}], got [{string.Join(",", actual)}])");
        }
    }

    public static void SequenceClose(IReadOnlyList<double>? actual, IReadOnlyList<double> expected, string label, double tolerance = 1e-6)
    {
        That(actual is not null, $"{label}: not null");
        That(actual!.Count == expected.Count, $"{label}: length {expected.Count}");
        for (var i = 0; i < expected.Count; i++)
        {
            Close(actual[i], expected[i], $"{label}[{i}]", tolerance);
        }
    }

    private static string Format<T>(T value) => value?.ToString() ?? "null";
}

// Fixture path resolution + JSON test helpers.
internal static class TestFixtures
{
    // Locate the repo root (dir with CouchCoop.sln) walking up from the test binary, then tests/fixtures/wire/<file>.
    public static string WirePath(string file) => Path.Combine(RepoRoot(), "tests", "fixtures", "wire", file);

    public static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "CouchCoop.sln")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new Exception("could not locate repo root (CouchCoop.sln)");
    }

    public static string ReadWire(string file) => File.ReadAllText(WirePath(file));

    // Serialize a plain object graph (dictionaries / lists / primitives) to a compact JSON string, so tests can
    // build wire messages inline (like the TS specs pass plain objects to parseSceneDelta).
    public static string J(object? value) => JsonSerializer.Serialize(value);
}
