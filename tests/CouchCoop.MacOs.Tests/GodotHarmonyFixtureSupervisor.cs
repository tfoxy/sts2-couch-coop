using System.Diagnostics;
using System.Text;
using System.Text.Json;

/// <summary>Runs the stock-Godot fixture under a bounded fake home and interprets its result and diagnostic markers.</summary>
internal static class GodotHarmonyFixtureSupervisor
{
    internal const string MarkerPrefix = "COUCHCOOP_GODOT_HARMONY_FIXTURE:";
    internal const string DiagnosticMarkerPrefix = "COUCHCOOP_GODOT_HARMONY_FIXTURE_DIAG:";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };
    internal static readonly TimeSpan Watchdog = TimeSpan.FromSeconds(30);
    private const int OutputLimit = 64 * 1024;

    internal enum Outcome
    {
        Success,
        Timeout,
        SignalCrash,
        PatchRefusal,
        MissingCallback,
        DuplicateCallback,
        Nonzero,
        InvalidResult,
    }

    internal sealed record FixtureResult(
        int Targets,
        int Readies,
        int Callbacks,
        int FirstReadies,
        int SecondReadies,
        int FirstCallbacks,
        int SecondCallbacks,
        int Markers,
        int Frames,
        ulong ElapsedMilliseconds,
        bool PatchRefused,
        FixtureFailure[]? Failures = null,
        string[]? RefusalSources = null);

    internal sealed record FixtureFailure(string Target, string Kind, string? Detail);
    internal sealed record AssemblyFact(string Name, string Version);
    internal sealed record HarmonyFact(string Location, string Version, string InformationalVersion);
    internal sealed record ExceptionFact(string Target, string Type, string Message, string Full);
    internal sealed record FixtureDiagnostics(
        string Framework,
        string ProcessArchitecture,
        string OsDescription,
        HarmonyFact? Harmony,
        AssemblyFact[]? Assemblies,
        ExceptionFact[]? Exceptions);

    internal sealed record RunResult(
        Outcome Outcome, int? ExitCode, bool TimedOut, string Output,
        FixtureResult? Result, FixtureDiagnostics? Diag);

    /// <summary>
    /// Hosted workflow code supplies the stock Godot executable and this fixture project path. The fake HOME and
    /// ArgumentList preserve the macOS spaces-in-path contract without involving a game installation.
    /// </summary>
    internal static async Task<RunResult> RunAsync(
        string godotExecutable,
        string fixtureProjectPath,
        CancellationToken cancellationToken = default)
    {
        var fakeHome = Path.Combine(Path.GetTempPath(), "couchcoop godot fixture home " + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(fakeHome);
        try
        {
            var startInfo = CreateStartInfo(godotExecutable, fixtureProjectPath, fakeHome);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("failed to start Godot Harmony fixture");
            var stdout = ReadCappedAsync(process.StandardOutput);
            var stderr = ReadCappedAsync(process.StandardError);
            using var watchdog = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            watchdog.CancelAfter(Watchdog);
            var timedOut = false;
            try
            {
                await process.WaitForExitAsync(watchdog.Token);
            }
            catch (OperationCanceledException)
            {
                timedOut = true;
                try { process.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) { }
                await process.WaitForExitAsync();
            }

            var output = string.Concat(await stdout, "\n", await stderr);
            int? exitCode = timedOut ? null : process.ExitCode;
            return CreateRunResult(exitCode, timedOut, output);
        }
        finally
        {
            Directory.Delete(fakeHome, recursive: true);
        }
    }

    internal static Outcome Classify(int? exitCode, bool timedOut, string output)
    {
        // Keep this order aligned with the workflow diagnosis contract: a watchdog or native crash is more useful
        // than any half-written fixture marker; an explicit patch refusal is more useful than its expected 1 exit.
        if (timedOut || exitCode is null) return Outcome.Timeout;
        if (exitCode is >= 128 and <= 255) return Outcome.SignalCrash;

        var result = ParseResult(output, out var markerCount);
        if (HasPatchRefusal(result)) return Outcome.PatchRefusal;
        if (result is not null && result.Callbacks < 2) return Outcome.MissingCallback;
        if (result is not null && result.Callbacks > 2) return Outcome.DuplicateCallback;
        if (exitCode != 0) return Outcome.Nonzero;
        if (markerCount != 1 || result is null || !IsSuccess(result)) return Outcome.InvalidResult;
        return Outcome.Success;
    }

    internal static RunResult CreateRunResult(int? exitCode, bool timedOut, string output) =>
        new(Classify(exitCode, timedOut, output), exitCode, timedOut, output,
            ParseResult(output, out _), ParseDiagnostics(output));

    internal static FixtureResult? ParseResult(string output, out int markerCount) =>
        ParseMarker<FixtureResult>(output, MarkerPrefix, out markerCount);

    internal static FixtureDiagnostics? ParseDiagnostics(string output) =>
        ParseMarker<FixtureDiagnostics>(output, DiagnosticMarkerPrefix, out _);

    private static T? ParseMarker<T>(string output, string prefix, out int markerCount) where T : class
    {
        var markers = output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Where(line => line.StartsWith(prefix, StringComparison.Ordinal))
            .ToArray();
        markerCount = markers.Length;
        if (markers.Length != 1)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<T>(markers[0][prefix.Length..], JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    internal static string Describe(RunResult run)
    {
        var text = new StringBuilder().AppendLine($"godot harmony fixture: {run.Outcome}");
        if (run.Outcome == Outcome.Success) return text.ToString();

        text.AppendLine("failures: " + JsonSerializer.Serialize(run.Result?.Failures ?? [], JsonOptions));
        text.AppendLine("refusalSources: " + JsonSerializer.Serialize(run.Result?.RefusalSources ?? [], JsonOptions));
        if (run.Diag is { } diag)
        {
            text.AppendLine($"framework: {diag.Framework}; arch: {diag.ProcessArchitecture}; OS: {diag.OsDescription}");
            if (diag.Harmony is { } harmony)
                text.AppendLine($"Harmony: {harmony.Location}; version: {harmony.Version}; informational: {harmony.InformationalVersion}");
            foreach (var exception in diag.Exceptions ?? [])
            {
                text.AppendLine($"exception target: {exception.Target}");
                text.AppendLine($"type: {exception.Type}");
                text.AppendLine($"message: {exception.Message}");
                text.AppendLine(exception.Full);
            }
        }
        else text.AppendLine("fixture diagnostics: unavailable (missing, malformed or duplicate marker)");
        return text.ToString();
    }

    internal static void WriteArtifacts(string outputDirectory, RunResult run)
    {
        var directory = Path.GetFullPath(outputDirectory);
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "result.json"), JsonSerializer.Serialize(new
        {
            outcome = run.Outcome.ToString(),
            run.ExitCode,
            run.TimedOut,
            run.Result,
            run.Diag,
        }, JsonOptions));
        File.WriteAllText(Path.Combine(directory, "godot-output.log"), run.Output);
        File.WriteAllText(Path.Combine(directory, "supervisor.txt"), Describe(run));
    }

    internal static void RunClassificationTests()
    {
        const string good = "COUCHCOOP_GODOT_HARMONY_FIXTURE:{\"targets\":2,\"readies\":2,\"callbacks\":2,\"firstReadies\":1,\"secondReadies\":1,\"firstCallbacks\":1,\"secondCallbacks\":1,\"markers\":2,\"frames\":30,\"elapsedMilliseconds\":5000,\"patchRefused\":false}";
        Assert(Classify(0, false, good) == Outcome.Success, "complete zero-exit marker is success");
        Assert(Classify(0, true, good) == Outcome.Timeout, "timeout wins over marker");
        Assert(Classify(139, false, good) == Outcome.SignalCrash, "signal crash wins over marker");
        Assert(Classify(1, false, good.Replace("\"patchRefused\":false", "\"patchRefused\":true")) == Outcome.PatchRefusal,
            "JSON patch refusal beats ordinary nonzero");
        Assert(Classify(1, false, good.Replace("\"callbacks\":2", "\"callbacks\":1")) == Outcome.MissingCallback,
            "missing callback beats ordinary nonzero");
        Assert(Classify(1, false, good.Replace("\"callbacks\":2", "\"callbacks\":3")) == Outcome.DuplicateCallback,
            "duplicate callback beats ordinary nonzero");
        Assert(Classify(1, false, good) == Outcome.Nonzero, "ordinary nonzero is retained");
        Assert(Classify(0, false, "not a marker") == Outcome.InvalidResult, "missing marker is invalid");
        Assert(Classify(0, false, good + "\n" + good) == Outcome.InvalidResult, "duplicate result markers are invalid");
        Assert(Classify(0, false, good.Replace("\"firstCallbacks\":1", "\"firstCallbacks\":2")) == Outcome.InvalidResult,
            "per-target callback duplication is invalid even when an aggregate is forged");

        var extended = good[..^1] + ",\"failures\":[{\"target\":\"Synthetic._Ready\",\"kind\":\"PatchFailed\",\"detail\":\"refused\"}],"
            + "\"refusalSources\":[\"patch-failure\",\"first-apply-false\",\"second-apply-false\"],\"futureField\":true}";
        Assert(Classify(0, false, extended) == Outcome.Success, "new result fields do not change success classification");
        var refused = extended.Replace("\"patchRefused\":false", "\"patchRefused\":true");
        Assert(Classify(1, false, refused) == Outcome.PatchRefusal, "new result fields do not change refusal classification");
        var parsed = ParseResult(refused, out _)!;
        Assert(parsed.Failures is [{ Target: "Synthetic._Ready", Kind: "PatchFailed", Detail: "refused" }],
            "failure target, kind and detail survive parsing");
        Assert(parsed.RefusalSources?.SequenceEqual(["patch-failure", "first-apply-false", "second-apply-false"]) == true,
            "refusal sources survive parsing");
        const string diag = DiagnosticMarkerPrefix + """
            {"framework":".NET 8.0","processArchitecture":"Arm64","osDescription":"Darwin","harmony":{"location":"/fixture/0Harmony.dll","version":"2.4.2.0","informationalVersion":"2.4.2"},"assemblies":[{"name":"MonoMod.Core","version":"1.0.0"}],"exceptions":[{"target":"Synthetic._Ready","type":"System.InvalidOperationException","message":"refused patch","full":"System.InvalidOperationException: refused patch\n   at DiagnosticPostfix()"}],"futureField":true}
            """;
        var diagnostics = ParseDiagnostics(diag)!;
        Assert(diagnostics is { Framework: ".NET 8.0", ProcessArchitecture: "Arm64", OsDescription: "Darwin" },
            "DIAG parses runtime identity and tolerates unknown fields");
        Assert(diagnostics.Harmony is { Location: "/fixture/0Harmony.dll", Version: "2.4.2.0", InformationalVersion: "2.4.2" },
            "DIAG parses Harmony identity");
        Assert(diagnostics.Assemblies is [{ Name: "MonoMod.Core", Version: "1.0.0" }], "DIAG parses loaded assemblies");
        Assert(diagnostics.Exceptions is [{ Target: "Synthetic._Ready", Type: "System.InvalidOperationException",
            Message: "refused patch", Full: "System.InvalidOperationException: refused patch\n   at DiagnosticPostfix()" }],
            "DIAG parses the full exception and stack");
        Assert(ParseDiagnostics(diag + "\n" + diag) is null, "duplicate DIAG markers are ignored as invalid");
        Assert(ParseDiagnostics(DiagnosticMarkerPrefix + "{") is null, "malformed DIAG is ignored as invalid");
        Assert(ParseDiagnostics(good) is null, "missing DIAG is optional");
        Assert(Classify(0, false, good + "\n" + diag + "\n" + diag) == Outcome.Success,
            "invalid DIAG does not change result classification");

        var largeDiag = DiagnosticMarkerPrefix + JsonSerializer.Serialize(diagnostics with
        {
            Exceptions =
            [
                new("SyntheticOne._Ready", "System.InvalidOperationException", "refused", new string('x', 15 * 1024)),
                new("SyntheticTwo._Ready", "System.InvalidOperationException", "refused", new string('x', 15 * 1024)),
            ],
        }, JsonOptions);
        using (var reader = new StreamReader(new MemoryStream(Encoding.UTF8.GetBytes(largeDiag + "\n" + good))))
        {
            var capped = ReadCappedAsync(reader).GetAwaiter().GetResult();
            Assert(Classify(0, false, capped) == Outcome.Success,
                "a result following a 30 KiB DIAG survives the stdout cap");
            Assert(ParseDiagnostics(capped)?.Exceptions is { Length: 2 },
                "a 30 KiB DIAG retains both exception entries under the stdout cap");
        }

        var outputDirectory = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "couchcoop fixture artifacts " + Guid.NewGuid().ToString("N")));
        try
        {
            var run = CreateRunResult(1, false, "raw native output\n" + diag + "\n" + refused);
            WriteArtifacts(outputDirectory, run);
            Assert(Directory.GetFiles(outputDirectory).Length == 3, "--out writes exactly three artifact files");
            using var artifact = JsonDocument.Parse(File.ReadAllText(Path.Combine(outputDirectory, "result.json")));
            var root = artifact.RootElement;
            Assert(root.GetProperty("outcome").GetString() == "PatchRefusal"
                && root.GetProperty("exitCode").GetInt32() == 1 && !root.GetProperty("timedOut").GetBoolean(),
                "result.json retains the supervisor outcome");
            Assert(root.GetProperty("result").GetProperty("failures").GetArrayLength() == 1
                && root.GetProperty("diag").GetProperty("exceptions")[0].GetProperty("type").GetString() == "System.InvalidOperationException",
                "result.json retains parsed result and DIAG");
            Assert(File.ReadAllText(Path.Combine(outputDirectory, "godot-output.log")) == run.Output,
                "godot-output.log retains capped raw output");
            var diagnosis = File.ReadAllText(Path.Combine(outputDirectory, "supervisor.txt"));
            Assert(diagnosis == Describe(run) && diagnosis.StartsWith("godot harmony fixture: PatchRefusal", StringComparison.Ordinal),
                "supervisor.txt matches the step diagnosis");
            Assert(diagnosis.Contains("Synthetic._Ready") && diagnosis.Contains("first-apply-false")
                && diagnosis.Contains(".NET 8.0") && diagnosis.Contains("Arm64")
                && diagnosis.Contains("/fixture/0Harmony.dll") && diagnosis.Contains("2.4.2.0")
                && diagnosis.Contains("System.InvalidOperationException") && diagnosis.Contains("refused patch")
                && diagnosis.Contains("   at DiagnosticPostfix()") && !diagnosis.Contains("raw native output"),
                "step diagnosis prints parsed refusal and stack without native output");
            var success = Describe(CreateRunResult(0, false, good + "\n" + diag));
            Assert(success.TrimEnd() == "godot harmony fixture: Success", "success stays a one-line outcome");
        }
        finally
        {
            if (Directory.Exists(outputDirectory)) Directory.Delete(outputDirectory, recursive: true);
        }

        var start = CreateStartInfo("/opt/Godot", "/tmp/couchcoop fixture project", "/tmp/couchcoop fixture home");
        Assert(start.ArgumentList.SequenceEqual(["--headless", "--path", "/tmp/couchcoop fixture project"]),
            "ArgumentList preserves the project path with spaces");
        Assert(start.Environment["HOME"] == "/tmp/couchcoop fixture home", "fixture receives its fake HOME");
    }

    internal static ProcessStartInfo CreateStartInfo(string godotExecutable, string fixtureProjectPath, string fakeHome)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(godotExecutable);
        ArgumentException.ThrowIfNullOrWhiteSpace(fixtureProjectPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(fakeHome);
        var startInfo = new ProcessStartInfo
        {
            FileName = godotExecutable,
            WorkingDirectory = fixtureProjectPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("--headless");
        startInfo.ArgumentList.Add("--path");
        startInfo.ArgumentList.Add(fixtureProjectPath);
        startInfo.Environment["HOME"] = fakeHome;
        return startInfo;
    }

    private static bool HasPatchRefusal(FixtureResult? result) =>
        result?.PatchRefused == true;

    private static bool IsSuccess(FixtureResult result) =>
        !result.PatchRefused
        && result.Targets == 2
        && result.Readies == 2
        && result.Callbacks == 2
        && result.FirstReadies == 1
        && result.SecondReadies == 1
        && result.FirstCallbacks == 1
        && result.SecondCallbacks == 1
        && result.Markers == 2
        && result.Frames >= 30
        && result.ElapsedMilliseconds >= 5000;

    private static async Task<string> ReadCappedAsync(StreamReader reader)
    {
        var buffer = new char[2048];
        var output = new StringBuilder(OutputLimit);
        while (true)
        {
            var read = await reader.ReadAsync(buffer);
            if (read == 0) break;
            var capacity = OutputLimit - output.Length;
            if (capacity > 0) output.Append(buffer, 0, Math.Min(read, capacity));
        }

        return output.ToString();
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
