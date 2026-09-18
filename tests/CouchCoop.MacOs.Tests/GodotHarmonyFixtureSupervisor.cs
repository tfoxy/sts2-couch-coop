using System.Diagnostics;
using System.Text;
using System.Text.Json;

/// <summary>Runs the stock-Godot fixture under a bounded fake home and interprets its single result marker.</summary>
internal static class GodotHarmonyFixtureSupervisor
{
    internal const string MarkerPrefix = "COUCHCOOP_GODOT_HARMONY_FIXTURE:";
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
        bool PatchRefused);

    internal sealed record RunResult(Outcome Outcome, int? ExitCode, bool TimedOut, string Output);

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
            return new(Classify(exitCode, timedOut, output), exitCode, timedOut, output);
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

    internal static FixtureResult? ParseResult(string output, out int markerCount)
    {
        var markers = output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Where(line => line.StartsWith(MarkerPrefix, StringComparison.Ordinal))
            .ToArray();
        markerCount = markers.Length;
        if (markers.Length != 1)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<FixtureResult>(markers[0][MarkerPrefix.Length..],
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (JsonException)
        {
            return null;
        }
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
