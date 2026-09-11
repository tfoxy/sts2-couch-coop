using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R8 (WS-2) — the REGRESSION GATE for the event-option scale flicker (reported three times: R4, R6, R7).
//
// It replays a recorded ancient-event stream DELTA BY DELTA through the exact pipeline the native client runs each
// drain — SceneDeltaReader → SceneTreeApplier → GlobalTransformIndex.Update → SpreadIndex.Update →
// ViewScaleStampIndex.Build — and asserts the property the old stateful ViewScaler could not hold:
//
//   ON EVERY SINGLE DRAIN in which the ancient OptionsContainer exists, it resolves an ACTIVE 1.2× BottomCenter
//   stamp. Not "eventually", not "unless a tween owns it / unless the measure is momentarily null / unless a carry
//   rescues it" — every drain, with NO cross-drain memory in the model at all.
//
// A single drain that fails to stamp IS the user-visible defect (the options snap back to 1.0 for that frame, and
// the old code then needed LastApplied/GroupCarry to paper over it). Because Build is pure, this probe is the whole
// truth for the resolve half of the fix; the fold half (bake clones / pool recycle) is by construction — see
// MirrorNodeView.EnsureViewScale.
//
// It also checks PURITY (rebuilding twice off the same state gives an identical index — no hidden state) and that
// the stamped subtree lands in the StaticBake exclusion set.
//
// Path-presence-gated (BandResidencyReplayProbe idiom): default `.sts2/bench/audit-mprun.ndjson`, overridable via
// COUCHCOOP_MIRROR_VIEWSCALE_STAMP_NDJSON. Prints ONE skip line and passes when absent (nothing under .sts2/ is
// committed).
internal static class ViewScaleStampReplayProbe
{
    private const double DesignW = 1920.0;
    private const double DesignH = 1080.0;
    private const string AncientEventLayout = "res://scenes/events/ancient_event_layout.tscn";
    private const string AncientOptionsRelPath = "ContentContainer/Content/OptionsContainer";

    public static void Run()
    {
        var path = ResolvePath();
        if (path is null)
        {
            return; // silent skip — no recording available in this checkout
        }

        var state = MirrorState.Create();
        var transforms = new GlobalTransformIndex();
        var spread = new SpreadIndex();

        int drains = 0;
        int drainsWithOptions = 0;
        int drainsStamped = 0;
        var missed = new List<int>();
        string? optionsId = null;

        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            string payload = line;
            if (line.StartsWith("{\"t\"", StringComparison.Ordinal))
            {
                using var doc = JsonDocument.Parse(line);
                if (!doc.RootElement.TryGetProperty("data", out var d) || d.GetString() is not { } inner)
                {
                    continue;
                }

                payload = inner;
            }

            var delta = SceneDeltaReader.Parse(payload);
            if (delta is null)
            {
                continue;
            }

            // One DRAIN, exactly as MirrorStore.FinishDrain sequences it.
            SceneTreeApplier.ApplySceneDelta(state, delta);
            transforms.Update(state);
            spread.Update(state, transforms, 1.0);
            drains++;

            var endpoints = EndpointsOf(delta);
            var index = ViewScaleStampIndex.Build(state, transforms, spread, DesignW, DesignH, endpoints);

            string? id = FindAncientOptions(state);
            if (id is null)
            {
                continue;
            }

            optionsId ??= id;
            drainsWithOptions++;
            if (index.TryGetValue(id, out var stamped))
            {
                Check.Close(stamped.Design.Scale, ViewScale.EventOptionsScale,
                    "[viewscale-stamp] ancient OptionsContainer stamp is 1.2×");
                Check.That(stamped.IsGroup, "[viewscale-stamp] ancient OptionsContainer stamps as a GROUP");
                // BottomCenter pins the box BOTTOM and grows UP: the stamp pivot Y must be the box's MaxY.
                Check.Close(stamped.Design.PivotY, stamped.DesignBox.MaxY,
                    "[viewscale-stamp] ancient OptionsContainer pivots at its BOTTOM (grows up)");
                Check.Close(stamped.Design.PivotX, (stamped.DesignBox.MinX + stamped.DesignBox.MaxX) / 2.0,
                    "[viewscale-stamp] ancient OptionsContainer pivots at its horizontal centre");
                drainsStamped++;
            }
            else if (missed.Count < 12)
            {
                missed.Add(drains);
            }

            // PURITY: a second Build over the same inputs must produce the identical index (no hidden state, no
            // ordering dependence) — the property that makes "rebuild every drain" safe to rely on.
            if (drains % 97 == 0)
            {
                var again = ViewScaleStampIndex.Build(state, transforms, spread, DesignW, DesignH, endpoints);
                Check.Equal(again.Count, index.Count, "[viewscale-stamp] rebuild is pure (same stamp count)");
                foreach (var (k, v) in index)
                {
                    Check.That(again.TryGetValue(k, out var v2) && v2 == v,
                        "[viewscale-stamp] rebuild is pure (identical stamp per id)");
                }
            }
        }

        // The bake exclusion (belt): the stamped container and its whole subtree are kept out of the static bake.
        if (optionsId is not null)
        {
            var finalIndex = ViewScaleStampIndex.Build(state, transforms, spread, DesignW, DesignH);
            if (finalIndex.Count > 0)
            {
                var excluded = new HashSet<string>(StringComparer.Ordinal);
                ViewScaleStampIndex.CollectBakeExcluded(state, finalIndex, excluded);
                Check.That(excluded.Contains(optionsId),
                    "[viewscale-stamp] a view-scaled node is excluded from the static bake");
                int descendants = 0;
                foreach (var id in state.OrderedIds)
                {
                    if (id != optionsId && state.Nodes.TryGetValue(id, out var n) && n.ParentId == optionsId)
                    {
                        descendants++;
                        Check.That(excluded.Contains(id),
                            "[viewscale-stamp] a view-scaled node's DESCENDANTS are excluded from the static bake too");
                    }
                }

                Check.That(descendants > 0, "[viewscale-stamp] the OptionsContainer has children to exclude");
            }
        }

        Console.Error.WriteLine(
            $"[viewscale-stamp] file={Path.GetFileName(path)} drains={drains} " +
            $"drainsWithAncientOptions={drainsWithOptions} stamped={drainsStamped} " +
            $"id={optionsId ?? "<none>"} missedDrains=[{string.Join(",", missed)}]");

        Check.That(drainsWithOptions > 0,
            "[viewscale-stamp] the recording visits an ancient_event_layout screen with an OptionsContainer");
        Check.Equal(drainsStamped, drainsWithOptions,
            "[viewscale-stamp] the ancient OptionsContainer resolves an ACTIVE stamp on EVERY drain it exists (no gap = no snap-back)");
    }

    // The ancient-event OptionsContainer node id in the current state, or null when the screen is not up.
    private static string? FindAncientOptions(MirrorState state)
    {
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.ContainsKey(id))
            {
                continue;
            }

            var (file, relPath) = SceneIdentity.Resolve(id, state);
            if (file == AncientEventLayout && relPath == AncientOptionsRelPath)
            {
                return id;
            }
        }

        return null;
    }

    // This delta's transform tween endpoints, keyed by target id (the native ViewScaler feeds the same shape).
    private static IReadOnlyDictionary<string, IReadOnlyList<double>>? EndpointsOf(MirrorDelta delta)
    {
        Dictionary<string, IReadOnlyList<double>>? map = null;
        foreach (var h in delta.Hints)
        {
            if (h.EndTransform is { Count: 6 } et)
            {
                (map ??= new Dictionary<string, IReadOnlyList<double>>(StringComparer.Ordinal))[h.TargetId] = et;
            }
        }

        return map;
    }

    private static string? ResolvePath()
    {
        var env = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_VIEWSCALE_STAMP_NDJSON");
        if (!string.IsNullOrWhiteSpace(env))
        {
            return File.Exists(env) ? env : null;
        }

        try
        {
            var def = Path.Combine(TestFixtures.RepoRoot(), ".sts2", "bench", "audit-mprun.ndjson");
            return File.Exists(def) ? def : null;
        }
        catch
        {
            return null;
        }
    }
}
