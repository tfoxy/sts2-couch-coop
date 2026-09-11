using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Text.Json.Nodes;

namespace CouchCoop.Mod.Diagnostics;

/// <summary>
/// The MEASURED CPU cost of a window of host work, in the shared cross-repo <c>cpu</c> naming that every
/// <c>perf-report/1</c> profile uses:
/// <code>
/// "cpu": {
///   "windowMs": 2500,          // wall clock the window covered
///   "totalCpuMs": 812.4,       // CPU time burned inside it
///   "totalCoreRatio": 0.32,    // totalCpuMs / windowMs — the fraction of ONE core
///   "byThread": [ { "process": …, "thread": …, "cpuMs": …, "wallMs": …, "coreRatio": … } ]
/// }
/// </code>
/// so "CPU per unit of work" reads the same here, in spirectl's <c>producer-walk</c> report and in
/// godot-scene-web's <c>browser-render</c> report without unit translation. <c>byProcess</c> is browser-only and
/// is not emitted here; neither is a <c>gpu</c> block, because these profiles do no GPU work and a fabricated
/// zero would be indistinguishable from a measurement of an idle GPU.
/// </summary>
/// <remarks>
/// <para>
/// WHAT IT ACTUALLY MEASURES — the caveat matters more than the number. The source is
/// <see cref="Process.TotalProcessorTime"/>, i.e. user + system CPU of the WHOLE host process across ALL its
/// threads, sampled once before and once after the measured work. So it prices "what this host burned while it
/// did that work", not the measured code path in isolation: anything else the game was doing in the same window
/// is included. It is an UPPER BOUND on the cost of the thing being reported, never an under-report. That is
/// also why <c>byThread</c> carries the single honest entry <see cref="ThreadName"/> rather than a plausible
/// per-thread split this platform cannot give us — .NET exposes no per-managed-thread CPU counter, and inventing
/// thread names for a process-wide number would be exactly the kind of readable lie this envelope exists to
/// prevent.
/// </para>
/// <para>
/// RESOLUTION. On Linux the counter comes from procfs <c>utime</c>/<c>stime</c>, which advance in clock ticks —
/// 10 ms on every configuration this host runs on. A window of comparable length therefore quantizes, and a
/// short one can read an exact <c>0</c> that means "below the clock's resolution", not "free". Rather than emit
/// that, <see cref="TryBuildCpuBlock"/> refuses any window shorter than <see cref="MinWindowMs"/> and returns
/// the reason, so a reader sees "not measured" instead of a plausible zero.
/// </para>
/// </remarks>
public static class ProcessCpuMetrics
{
    /// <summary>
    /// The one <c>byThread</c> entry name. Deliberately NOT a thread name: the reading is process-wide, and a
    /// name like <c>main</c> would claim an attribution that was never measured.
    /// </summary>
    public const string ThreadName = "process-total";

    /// <summary><c>params.cpuSource</c>: how the number was obtained, so no reader has to guess.</summary>
    public const string Source = "process-total-processor-time-delta";

    /// <summary>
    /// Shortest window this will report CPU for. Five clock ticks of the 10 ms procfs counter: below that the
    /// quantization error is the same order as the reading, and a quantized zero reads exactly like a real zero.
    /// </summary>
    public const double MinWindowMs = 50.0;

    /// <summary><c>params.cpuCaveat</c>: the sentence that must travel with the number. See the remarks above.</summary>
    public static readonly string Caveat =
        "cpuMs is Process.TotalProcessorTime (user+system, ALL threads of the host process) sampled before and "
        + "after the measured work: it prices the whole host over that window, not the measured path alone, so it "
        + "is an upper bound. .NET exposes no per-managed-thread CPU counter, hence the single honest "
        + "'process-total' byThread entry instead of a per-thread split. The counter advances in ~10ms procfs "
        + $"clock ticks, so windows shorter than {MinWindowMs}ms are reported as unmeasured rather than as a "
        + "quantized zero. coreRatio > 1 is legal and means the work used more than one core.";

    /// <summary>One end of a CPU window: the process CPU counter plus the monotonic clock, read together.</summary>
    public readonly record struct Mark(TimeSpan Cpu, long Timestamp);

    /// <summary>A closed window. Both members are measured; <see cref="CoreRatio"/> is the only derived value.</summary>
    public readonly record struct Window(double CpuMs, double WallMs)
    {
        /// <summary>Fraction of ONE core over the window. May exceed 1 when the work used several threads.</summary>
        public double CoreRatio => WallMs > 0 ? CpuMs / WallMs : 0.0;
    }

    /// <summary>
    /// Open a window. Null when this host denies process introspection — the caller then omits the block, which
    /// is the whole contract: a missing field beats an invented one.
    /// </summary>
    public static Mark? TryMark()
    {
        try
        {
            using var process = Process.GetCurrentProcess();
            return new Mark(process.TotalProcessorTime, Stopwatch.GetTimestamp());
        }
        catch (Exception ex) when (ex is InvalidOperationException or PlatformNotSupportedException or NotSupportedException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }

    /// <summary>Close a window opened by <see cref="TryMark"/>. Null when either end could not be read.</summary>
    public static Window? TryClose(Mark? start)
    {
        if (start is not { } opened)
        {
            return null;
        }

        if (TryMark() is not { } closed)
        {
            return null;
        }

        var wallMs = (closed.Timestamp - opened.Timestamp) * 1000.0 / Stopwatch.Frequency;
        var cpuMs = (closed.Cpu - opened.Cpu).TotalMilliseconds;

        // A counter that went backwards is a broken reading, not a negative cost.
        return wallMs < 0 || cpuMs < 0 ? null : new Window(cpuMs, wallMs);
    }

    /// <summary>The host process's name, for <c>byThread[].process</c>. Null when it cannot be read.</summary>
    public static string? ProcessName => ProcessNameLazy.Value;

    /// <summary>
    /// Render a closed window as the shared <c>cpu</c> block, or explain why there is none. Returns false with a
    /// <paramref name="reason"/> the caller records in <c>params.cpuOmittedReason</c> when the window was never
    /// opened, could not be read, is too short for the process CPU clock to resolve, or came from a host that
    /// will not name its own process (every row in the shared block must name one).
    /// <para>
    /// <paramref name="coverage"/> is <c>cpu.cpuCoverage</c>: the share of the measured wall time whose CPU is
    /// actually attributed. Pass 1 for a single contiguous window — a process CPU counter has no unattributed
    /// sub-interval, unlike a browser trace where a task without a <c>tdur</c> leaves its CPU unknown — and the
    /// real fraction when folding several windows of which only some carried a reading.
    /// </para>
    /// </summary>
    public static bool TryBuildCpuBlock(
        Window? window,
        double coverage,
        [NotNullWhen(true)] out JsonObject? cpu,
        out string? reason)
    {
        cpu = null;
        if (window is not { } measured)
        {
            reason = "process CPU time was not sampled around this work (no mark, or the host denies process introspection)";
            return false;
        }

        if (measured.WallMs < MinWindowMs)
        {
            reason =
                $"the measured window is {measured.WallMs:0.###}ms, shorter than the {MinWindowMs}ms floor set by the "
                + "~10ms process CPU clock tick — a reading here would be quantization, not a measurement";
            return false;
        }

        if (string.IsNullOrEmpty(ProcessName))
        {
            reason =
                "this host would not report its own process name, and every row of the shared cpu block must name "
                + "the process it was measured in — there is no honest name to use here";
            return false;
        }

        if (!double.IsFinite(coverage) || coverage < 0)
        {
            reason = $"cpuCoverage is not a measurable fraction ({coverage})";
            return false;
        }

        reason = null;
        cpu = BuildCpuBlock(measured, coverage);
        return true;
    }

    /// <summary>The block for an already-vetted window (see <see cref="TryBuildCpuBlock"/> for the vetting).</summary>
    public static JsonObject BuildCpuBlock(Window window, double coverage)
    {
        var processName = ProcessName ?? string.Empty;
        return new JsonObject
        {
            ["windowMs"] = window.WallMs,
            ["totalCpuMs"] = window.CpuMs,
            ["totalCoreRatio"] = window.CoreRatio,
            ["cpuCoverage"] = coverage,
            // A REAL entry, not the empty object that would technically satisfy the shared validator: the work
            // ran in exactly one process, and `{}` would read as "no process burned CPU". `threads` is left out
            // rather than guessed — this is a process counter, not a sum over threads we enumerated.
            ["byProcess"] = new JsonObject
            {
                [processName] = new JsonObject
                {
                    ["cpuMs"] = window.CpuMs,
                    ["wallMs"] = window.WallMs,
                    ["coreRatio"] = window.CoreRatio,
                    ["processes"] = 1,
                },
            },
            ["byThread"] = new JsonArray(new JsonObject
            {
                ["process"] = processName,
                ["thread"] = ThreadName,
                ["cpuMs"] = window.CpuMs,
                ["wallMs"] = window.WallMs,
                ["coreRatio"] = window.CoreRatio,
            }),
        };
    }

    /// <summary>
    /// <c>cpuCoverage</c> for a single contiguous window: 1. The process CPU counter is cumulative and covers
    /// everything the process did between the two marks, so there is no sub-interval whose CPU is unknown.
    /// </summary>
    public const double FullCoverage = 1.0;

    /// <summary>Record how the <c>cpu</c> block was (or was not) obtained on a report's <c>params</c>.</summary>
    public static void StampParams(JsonObject parameters, bool measured, string? omittedReason)
    {
        ArgumentNullException.ThrowIfNull(parameters);
        parameters["cpuSource"] = measured ? Source : "unmeasured";
        parameters["cpuCaveat"] = Caveat;
        if (!measured)
        {
            parameters["cpuOmittedReason"] = omittedReason ?? "not measured";
        }
    }

    // Read once: Process.GetCurrentProcess() touches procfs, and the name never changes.
    private static readonly Lazy<string?> ProcessNameLazy = new(
        () =>
        {
            try
            {
                using var process = Process.GetCurrentProcess();
                return string.IsNullOrWhiteSpace(process.ProcessName) ? null : process.ProcessName;
            }
            catch (Exception ex) when (ex is InvalidOperationException or PlatformNotSupportedException or NotSupportedException or System.ComponentModel.Win32Exception)
            {
                return null;
            }
        },
        LazyThreadSafetyMode.ExecutionAndPublication);
}
