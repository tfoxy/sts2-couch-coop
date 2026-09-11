using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-3 (round 8, item 6) — RECORDING-DRIVEN regression probe for the vanishing combat energy orb.
//
// The defect: the headless decorative freeze used ProcessMode=Disabled, which in Godot 4.5.1 also pauses a node's
// own TWEEN_PAUSE_BOUND tweens. The energy counter slides in from (-480,128) to its rest origin (0,0) over 600ms
// on exactly such a self-bound tween, so a counter frozen mid-flight STAYED off-position for the rest of
// the combat — the whole orb sat outside the UI, or (when the strand parked the cull-eligible Label just across
// the 128px cull margin while the shader/particle orb nodes stayed resident) only its number vanished. Because
// each headless process has its own scan phase, it hit a subset of players — the reported "~2 of 4".
//
// What this asserts on a stream: every NEnergyCounter in the recording comes to REST at local origin (0,0). The
// tween's own in-flight frames are fine (and expected — more than one transform emit per counter is the healthy
// signal that the slide-in actually played), so the assertion is on the FINAL transform each counter settles at.
// It also checks each counter still carries its Label descendant, which is the "text-only vanish" shape.
//
// Against the PRE-FIX recording `.sts2/bench/combat-2026-07-15T16-40-09-999Z.ndjson` this probe FAILS as designed:
// IroncladEnergyCounter (id 706773784578) is pinned at (-20.374207, 5.4331055) with a single transform emit
// across all 1190 deltas — numerically exactly Expo-Out at t=0.273s of 0.6s, i.e. a paused tween.
//
// Path-presence-gated (nothing is committed under .sts2/): default `.sts2/bench/energy-orb-4necro.ndjson`
// relative to the repo root, overridable via COUCHCOOP_ENERGY_ORB_NDJSON. Absent ⇒ one skip line and a pass.
// Follows the BandResidencyReplayProbe recording-read pattern.
internal static class EnergyCounterRestOriginReplayProbe
{
    private const string DefaultRecording = "energy-orb-4necro.ndjson";

    // The AnimIn tween targets Vector2.Zero exactly, so the resting origin is exact; allow only float noise.
    private const double OriginEpsilon = 0.5;

    public static void Run()
    {
        var path = ResolvePath();
        if (path is null)
        {
            return; // silent skip — no recording available locally
        }

        if (!File.Exists(path))
        {
            Console.Error.WriteLine($"[energy-orb] SKIP — recording not found: {path}");
            return;
        }

        var state = MirrorState.Create();
        var emits = new Dictionary<string, int>(StringComparer.Ordinal);
        int deltas = 0;

        foreach (var delta in ReadDeltas(path))
        {
            deltas++;
            foreach (var upsert in delta.Upserts)
            {
                if (upsert.Transform is not null)
                {
                    emits[upsert.Id] = emits.TryGetValue(upsert.Id, out var n) ? n + 1 : 1;
                }
            }

            SceneTreeApplier.ApplySceneDelta(state, delta);
        }

        var counters = state.Nodes.Values
            .Where(IsEnergyCounter)
            .OrderBy(n => n.Id, StringComparer.Ordinal)
            .ToList();

        Console.Error.WriteLine(
            $"[energy-orb] file={Path.GetFileName(path)} deltas={deltas} counters={counters.Count} " +
            string.Join(" ", counters.Select(c =>
                $"[{c.Name} id={c.Id} origin=({Fmt(OriginX(c))},{Fmt(OriginY(c))}) emits={(emits.TryGetValue(c.Id, out var e) ? e : 0)}]")));

        // Positive: the recording must actually contain a counter, else the assertion is vacuous.
        Check.That(counters.Count > 0,
            "[energy-orb] the recording contains at least one NEnergyCounter (otherwise this probe proves nothing)");

        foreach (var counter in counters)
        {
            double x = OriginX(counter);
            double y = OriginY(counter);
            int emitCount = emits.TryGetValue(counter.Id, out var e) ? e : 0;

            Check.That(Math.Abs(x) <= OriginEpsilon && Math.Abs(y) <= OriginEpsilon,
                $"[energy-orb] counter '{counter.Name}' (id={counter.Id}) rests at local origin (0,0) — got " +
                $"({Fmt(x)},{Fmt(y)}) after {emitCount} transform emit(s). A non-zero rest origin means the "
                + "decorative freeze paused its self-bound AnimIn tween (see CouchCoopHeadlessVisualSuspender).");

            // The "only the number disappeared" shape: the counter landed somewhere that culled its Label while
            // the orb layers stayed resident. With the counter at rest this cannot happen, but assert the Label is
            // actually in the streamed subtree so a future producer-side prune is caught here too.
            Check.That(HasDescendantNamed(state, counter.Id, "Label"),
                $"[energy-orb] counter '{counter.Name}' (id={counter.Id}) still streams its Label descendant");
        }

        Console.Error.WriteLine("[energy-orb] ALL PASS");
    }

    private static string? ResolvePath()
    {
        var env = Environment.GetEnvironmentVariable("COUCHCOOP_ENERGY_ORB_NDJSON");
        if (!string.IsNullOrWhiteSpace(env))
        {
            return env;
        }

        try
        {
            var def = Path.Combine(TestFixtures.RepoRoot(), ".sts2", "bench", DefaultRecording);
            return File.Exists(def) ? def : null;
        }
        catch
        {
            return null;
        }
    }

    // A counter root is the node carrying the NEnergyCounter script; fall back to the scene path so the probe still
    // works on a stream whose nodeType was trimmed.
    private static bool IsEnergyCounter(MirrorNode node)
        => node.NodeType.EndsWith("NEnergyCounter", StringComparison.Ordinal)
            || (node.SceneFilePath is { } scene
                && scene.Contains("/energy_counters/", StringComparison.Ordinal)
                && scene.EndsWith("_energy_counter.tscn", StringComparison.Ordinal));

    // Transform is the flattened 2D affine [xAxis.x, xAxis.y, yAxis.x, yAxis.y, origin.x, origin.y].
    private static double OriginX(MirrorNode node) => node.Transform is { Count: >= 6 } t ? t[4] : 0;

    private static double OriginY(MirrorNode node) => node.Transform is { Count: >= 6 } t ? t[5] : 0;

    private static bool HasDescendantNamed(MirrorState state, string rootId, string name)
    {
        foreach (var node in state.Nodes.Values)
        {
            if (!string.Equals(node.Name, name, StringComparison.Ordinal))
            {
                continue;
            }

            var cur = node.ParentId;
            for (int guard = 0; cur is not null && guard < 64; guard++)
            {
                if (string.Equals(cur, rootId, StringComparison.Ordinal))
                {
                    return true;
                }

                cur = state.Nodes.TryGetValue(cur, out var parent) ? parent.ParentId : null;
            }
        }

        return false;
    }

    // Handles both the record-mirror-stream wrapper ({"t":…,"data":"<raw>"}) and a bare raw line, matching
    // ReplayProbeSupport / BandResidencyReplayProbe.
    private static IEnumerable<MirrorDelta> ReadDeltas(string path)
    {
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            string payload = line;
            if (line.StartsWith("{\"t\"", StringComparison.Ordinal))
            {
                string? inner;
                try
                {
                    using var doc = System.Text.Json.JsonDocument.Parse(line);
                    inner = doc.RootElement.TryGetProperty("data", out var d) ? d.GetString() : null;
                }
                catch
                {
                    continue;
                }

                if (inner is null)
                {
                    continue;
                }

                payload = inner;
            }

            MirrorDelta? delta;
            try
            {
                delta = SceneDeltaReader.Parse(payload);
            }
            catch
            {
                continue;
            }

            if (delta is not null)
            {
                yield return delta;
            }
        }
    }

    private static string Fmt(double v) => v.ToString("0.####", CultureInfo.InvariantCulture);
}
