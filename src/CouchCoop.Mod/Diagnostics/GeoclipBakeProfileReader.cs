using System.Text.Json;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Diagnostics;

/// <summary>
/// Lifts the phase profile a GEOCLIP bake published in its own <c>manifest.json</c> (<c>bake.profile</c>) into the
/// shared <see cref="Sts2RenderPhaseProfile"/> shape, so a geoclip bake can be filed with
/// <see cref="SpineBakeMetrics"/> alongside the raster lane instead of being a log line.
/// </summary>
/// <remarks>
/// <para>
/// WHY THE MANIFEST AND NOT THE PROFILER. The raster lane hands its request id down to the render
/// (<c>EmbeddableAssetRequest</c>) and drains the breakdown back out with
/// <see cref="Sts2RenderPhaseProfile.TryTake"/>. The geoclip seam carries no request id: the baker MINTS its own
/// recorder key and closes it inside the bake, so there is nothing on this side of the seam to take. What it does
/// do is write the same breakdown into the artifact it produces. That file is therefore the only place a host can
/// read a geoclip's blocking/parked split from — and reading it is free next to a bake measured in seconds.
/// </para>
/// <para>
/// ABSENT MEANS UNMEASURED. The producer omits <c>bake.profile</c> entirely when its profiler is off
/// (<c>SPIRECTL_RENDER_PHASE_PROFILE=0</c>), and every failure here — no file, unreadable, malformed, no
/// <c>bake</c> block, no <c>profile</c> block, an empty phase table — answers <see langword="null"/>. A zeroed
/// table is never invented, because a report that cannot tell "the profiler was off" from "the bake cost nothing"
/// is worse than one that says nothing. Nothing in here can throw at a caller: a measurement must not be able to
/// break a bake.
/// </para>
/// </remarks>
public static class GeoclipBakeProfileReader
{
    /// <summary>The manifest property holding the bake report, and the profile inside it.</summary>
    private static ReadOnlySpan<byte> BakeProperty => "bake"u8;

    private static ReadOnlySpan<byte> ProfileProperty => "profile"u8;

    /// <summary>
    /// A manifest bigger than this is not read. A pose manifest is kilobytes and a whole-clip one is megabytes;
    /// the cap exists so a pathological artifact cannot make an instrument allocate without bound, not because any
    /// real bake approaches it.
    /// </summary>
    public const long MaxManifestBytes = 64L * 1024 * 1024;

    /// <param name="Phases">
    /// The bake's phases in producer order, each carrying the side of the split its CALL SITE belongs on.
    /// Never empty — a reading with no phases is reported as no reading at all.
    /// </param>
    /// <param name="UnattributedMs">
    /// Bake time no phase claimed. Carried because the producer measures <paramref name="TotalMs"/> end to end
    /// rather than as the sum of its phases, so the residue is real and hiding it would make the instrument
    /// self-confirming. It has no home in <see cref="SpineBakeMetrics.Sample"/> (a phase table cannot express
    /// "none of these"), so it reaches a reader through the host's bake log line.
    /// </param>
    public sealed record Reading(
        IReadOnlyList<Sts2RenderPhaseProfile.PhaseCost> Phases,
        IReadOnlyDictionary<string, long> Counters,
        double TotalMs,
        double BlockingMs,
        double ParkedMs,
        double UnattributedMs);

    /// <summary>The profile inside the manifest at <paramref name="manifestPath"/>, or null — see the remarks.</summary>
    /// <remarks>
    /// The caller is responsible for having decided that <paramref name="manifestPath"/> is a file this host may
    /// read (the provider constrains it to the bake's own staging tree first, exactly as it does before adopting
    /// it). This only refuses to read what it cannot.
    /// </remarks>
    public static Reading? TryReadFile(string? manifestPath)
    {
        if (string.IsNullOrWhiteSpace(manifestPath))
        {
            return null;
        }

        try
        {
            var file = new FileInfo(manifestPath);
            if (!file.Exists || file.Length == 0 || file.Length > MaxManifestBytes)
            {
                return null;
            }

            return TryParse(File.ReadAllBytes(manifestPath));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>The profile inside a manifest's UTF-8 bytes, or null. Pure — this is the offline-testable half.</summary>
    public static Reading? TryParse(ReadOnlySpan<byte> manifestUtf8)
    {
        try
        {
            var reader = new Utf8JsonReader(
                manifestUtf8,
                new JsonReaderOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
            {
                return null;
            }

            // Walk the TOP level only, skipping every value that is not `bake` — a manifest's bulk is its
            // `parts`/`frames` arrays, and none of it has to be materialized to answer this question.
            while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
            {
                var isBake = reader.ValueTextEquals(BakeProperty);
                if (!reader.Read())
                {
                    return null;
                }

                if (!isBake)
                {
                    reader.Skip();
                    continue;
                }

                return reader.TokenType == JsonTokenType.StartObject ? ReadBake(ref reader) : null;
            }

            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static Reading? ReadBake(ref Utf8JsonReader reader)
    {
        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            var isProfile = reader.ValueTextEquals(ProfileProperty);
            if (!reader.Read())
            {
                return null;
            }

            if (!isProfile)
            {
                reader.Skip();
                continue;
            }

            return reader.TokenType == JsonTokenType.StartObject ? ReadProfile(ref reader) : null;
        }

        return null;
    }

    private static Reading? ReadProfile(ref Utf8JsonReader reader)
    {
        List<Sts2RenderPhaseProfile.PhaseCost>? phases = null;
        var counters = new Dictionary<string, long>(StringComparer.Ordinal);
        double totalMs = 0, blockingMs = 0, parkedMs = 0, unattributedMs = 0;

        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            var name = reader.GetString() ?? string.Empty;
            if (!reader.Read())
            {
                return null;
            }

            switch (name)
            {
                case "totalMs":
                    totalMs = ReadDouble(ref reader);
                    break;
                case "blockingMs":
                    blockingMs = ReadDouble(ref reader);
                    break;
                case "parkedMs":
                    parkedMs = ReadDouble(ref reader);
                    break;
                case "unattributedMs":
                    unattributedMs = ReadDouble(ref reader);
                    break;

                // The producer's bake counters, folded onto the names the shared profiler already publishes
                // rather than onto new ones: `framesWaited` is literally the counter the render lanes keep, and a
                // second spelling of it would split one metric across two columns of the same report.
                //
                // THIS SWITCH IS A TRANSCRIPTION OF THE PRODUCER'S SCHEMA, and its `default: Skip()` is silent —
                // a counter the baker emits and this arm does not name is dropped with no error anywhere. That is
                // not hypothetical: `drawsElided` shipped emitting correctly into the manifest and invisible in
                // /perf/spine.json, so a reader of the ring could not tell an elided bake from a rig that needed
                // fewer draws — exactly what the counter existed to prevent. When the baker gains a counter, it
                // must gain an arm here in the same change.
                case "framesWaited":
                    counters[Sts2RenderPhaseProfile.Counter.FramesWaited] = ReadInt64(ref reader);
                    break;
                case "forceDraws":
                    counters[Sts2RenderPhaseProfile.Counter.BakeForceDraws] = ReadInt64(ref reader);
                    break;
                case "drawsElided":
                    counters[Sts2RenderPhaseProfile.Counter.BakeDrawsElided] = ReadInt64(ref reader);
                    break;
                case "colorReads":
                    counters[Sts2RenderPhaseProfile.Counter.BakeColorReads] = ReadInt64(ref reader);
                    break;
                case "sweepProbes":
                    counters[Sts2RenderPhaseProfile.Counter.BakeSweepProbes] = ReadInt64(ref reader);
                    break;

                case "phases":
                    phases = ReadPhases(ref reader);
                    break;

                default:
                    reader.Skip();
                    break;
            }
        }

        // No phases is NOT a cheap bake, it is an unmeasured one — the producer writes no `profile` at all when
        // its profiler is off, so an empty table here means a shape this reader does not understand.
        return phases is { Count: > 0 }
            ? new Reading(phases, counters, totalMs, blockingMs, parkedMs, unattributedMs)
            : null;
    }

    private static List<Sts2RenderPhaseProfile.PhaseCost>? ReadPhases(ref Utf8JsonReader reader)
    {
        if (reader.TokenType != JsonTokenType.StartArray)
        {
            reader.Skip();
            return null;
        }

        var phases = new List<Sts2RenderPhaseProfile.PhaseCost>();
        while (reader.Read() && reader.TokenType == JsonTokenType.StartObject)
        {
            string? phase = null;
            double ms = 0;
            var calls = 0;
            var blocking = false;
            while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
            {
                var name = reader.GetString() ?? string.Empty;
                if (!reader.Read())
                {
                    return phases;
                }

                switch (name)
                {
                    case "phase":
                        phase = reader.TokenType == JsonTokenType.String ? reader.GetString() : null;
                        break;
                    case "ms":
                        ms = ReadDouble(ref reader);
                        break;
                    case "calls":
                        calls = (int)ReadInt64(ref reader);
                        break;
                    case "blocking":
                        blocking = reader.TokenType == JsonTokenType.True;
                        break;
                    default:
                        reader.Skip();
                        break;
                }
            }

            if (!string.IsNullOrWhiteSpace(phase))
            {
                phases.Add(new Sts2RenderPhaseProfile.PhaseCost(phase!, ms, Math.Max(calls, 1), blocking));
            }
        }

        return phases;
    }

    private static double ReadDouble(ref Utf8JsonReader reader)
        => reader.TokenType == JsonTokenType.Number && reader.TryGetDouble(out var value) ? value : 0d;

    private static long ReadInt64(ref Utf8JsonReader reader)
        => reader.TokenType == JsonTokenType.Number && reader.TryGetInt64(out var value) ? value : 0L;
}
