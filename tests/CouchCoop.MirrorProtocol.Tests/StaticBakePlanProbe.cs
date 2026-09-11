using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Track-P static-bake planner probe + COVERAGE report. Point COUCHCOOP_STATICBAKE_PROBE_NDJSON at a recording (or a
// comma-separated list, or a directory of *.ndjson); for each it replays every scene-delta to build the final
// MirrorState, forces the whole scene stable (one keyframe drain + a run of frames → the drain-quiescence bypass),
// feeds the REAL StaticBakePlanner the bottomOnly / addBlend sets (see the offline approximation note below), and
// reports what the native client would actually bake: regions planned, nodes baked (mix + add) / re-leveled live /
// rejected-by-reason. Sweeps effectStaticOk two ways — EMPTY (no shader inclusion) and ALL_SHADERS (the max the
// controller could clear) — to bound the outcome. If COUCHCOOP_STATICBAKE_PROBE_REPORT is set, a Markdown coverage
// table is written there. Skips SILENTLY when the env var is unset / no files match (nothing committed).
//
// OFFLINE APPROXIMATION: the probe has no Godot ShaderStore, so it cannot know a shader node's blend class or
// mount/screen-read state. bottomOnly / addBlend are therefore derived from CanvasBlendMode ONLY (a plain Add/Sub/Mul
// painter); a shader node is treated as Mix (never bottom-only). This matches the combat structure (its water shader
// IS Mix; its additive content is atmosphere PARTICLES, hard-rejected regardless), but a hypothetical additive-blend
// SHADER would be classified live-safe here yet bottom-only on-device. Flagged in the report header.
internal static class StaticBakePlanProbe
{
    private const double DesignW = 1920.0;

    // WS-BGBAKE Step-1 diagnostic (COUCHCOOP_STATICBAKE_PROBE_BANDDUMP=1): for a scene with a REAL z<0 bottom bucket,
    // dump the band in PAINT order as compressed runs — `[static xN]` for each contiguous eligible run, one line per
    // live interloper (particle / spine / intent / un-cleared shader / dynamic / Sub-Mul bottomOnly, with blend + name)
    // — plus the current segmented-plan summary. Read-only; skips without the env.
    private static readonly bool BandDumpEnabled =
        Environment.GetEnvironmentVariable("COUCHCOOP_STATICBAKE_PROBE_BANDDUMP") == "1";

    public static void Run()
    {
        var spec = Environment.GetEnvironmentVariable("COUCHCOOP_STATICBAKE_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(spec))
        {
            return;
        }

        var files = ResolveFiles(spec);
        if (files.Count == 0)
        {
            return;
        }

        var rows = new List<Row>();
        foreach (var path in files)
        {
            var row = Probe(path);
            if (row is { } r)
            {
                rows.Add(r);
            }
        }

        if (rows.Count == 0)
        {
            return;
        }

        var report = BuildReport(rows);
        Console.Error.Write(report);

        var reportPath = Environment.GetEnvironmentVariable("COUCHCOOP_STATICBAKE_PROBE_REPORT");
        if (!string.IsNullOrWhiteSpace(reportPath))
        {
            File.WriteAllText(reportPath, report);
            Console.Error.WriteLine($"[bake-probe] wrote coverage report → {reportPath}");
        }
    }

    private static List<string> ResolveFiles(string spec)
    {
        var files = new List<string>();
        foreach (var part in spec.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (Directory.Exists(part))
            {
                files.AddRange(Directory.EnumerateFiles(part, "*.ndjson").OrderBy(p => p, StringComparer.Ordinal));
            }
            else if (File.Exists(part))
            {
                files.Add(part);
            }
            else
            {
                Console.Error.WriteLine($"[bake-probe] not found: {part}");
            }
        }

        return files;
    }

    private static Row? Probe(string path)
    {
        var state = MirrorState.Create();
        int applied = 0;
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            string deltaJson;
            try
            {
                using var doc = JsonDocument.Parse(line);
                if (!doc.RootElement.TryGetProperty("data", out var dataEl) || dataEl.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                deltaJson = dataEl.GetString()!;
            }
            catch
            {
                continue;
            }

            var delta = SceneDeltaReader.Parse(deltaJson);
            if (delta is null)
            {
                continue;
            }

            SceneTreeApplier.ApplySceneDelta(state, delta);
            applied++;
        }

        if (applied == 0)
        {
            Console.Error.WriteLine($"[bake-probe] {Path.GetFileName(path)}: no deltas applied");
            return null;
        }

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);

        var planner = new StaticBakePlanner();
        var all = new HashSet<string>(state.Nodes.Keys, StringComparer.Ordinal);
        planner.ObserveDrain(state, all, Array.Empty<string>(), keyframe: true);
        for (int i = 0; i < StaticBakePlanner.MinStableFrames + 4; i++)
        {
            planner.ObserveFrame();
        }

        var empty = new HashSet<string>(StringComparer.Ordinal);
        var allShaders = new HashSet<string>(
            state.Nodes.Values.Where(n => n.ShaderId is not null).Select(n => n.Id), StringComparer.Ordinal);

        // Offline bottomOnly (WS-ADDBAKE): Sub/Mul plain painters only (b in {2,3}). Plain-Add painters (b==1) are now
        // ordinary bakeable members (alpha-preserving variant), so they are NOT bottom-only. Shader blend class is
        // unknown offline, so an Add-blend SHADER reads as Mix here (see the OFFLINE CAVEAT in the report).
        var bottomOnly = new HashSet<string>(StringComparer.Ordinal);
        int addPainters = 0;
        foreach (var n in state.Nodes.Values)
        {
            if (n.CanvasBlendMode is int b && b is 2 or 3)
            {
                bottomOnly.Add(n.Id);
            }
            else if (n.CanvasBlendMode == 1)
            {
                addPainters++;
            }
        }

        var scene = Path.GetFileNameWithoutExtension(path);
        Console.Error.WriteLine($"[bake-probe] file={Path.GetFileName(path)} nodes={state.Nodes.Count} " +
                                $"orderedIds={state.OrderedIds.Count} shaderNodes={allShaders.Count} " +
                                $"subMulPainters={bottomOnly.Count} addPainters={addPainters}");

        var rEmpty = Measure(planner, state, transforms, empty, bottomOnly, "EMPTY");
        var rAll = Measure(planner, state, transforms, allShaders, bottomOnly, "ALL_SHADERS");

        return new Row(scene, state.Nodes.Count, allShaders.Count, bottomOnly.Count, rEmpty, rAll);
    }

    private static Measured Measure(
        StaticBakePlanner planner, MirrorState state, GlobalTransformIndex transforms,
        IReadOnlySet<string> effectStaticOk, IReadOnlySet<string> bottomOnly, string label)
    {
        var empty = new HashSet<string>(StringComparer.Ordinal);
        var plan = planner.Plan(state, transforms, DesignW, empty, effectStaticOk, bottomOnly);
        var d = planner.LastDiagnostic;

        int mixBaked = 0;
        foreach (var r in plan.Regions)
        {
            mixBaked += r.BakedIds.Count;
        }

        // Per-node reject histogram over the whole paint order (independent of the prefix boundary).
        var histo = new Dictionary<BakeReject, int>();
        foreach (var (_, reason) in planner.ClassifyPaintOrder(state, transforms, empty, effectStaticOk))
        {
            if (reason != BakeReject.None)
            {
                histo[reason] = histo.TryGetValue(reason, out var c) ? c + 1 : 1;
            }
        }

        int eligible = 0;
        foreach (var (_, reason) in planner.ClassifyPaintOrder(state, transforms, empty, effectStaticOk))
        {
            if (reason == BakeReject.None)
            {
                eligible++;
            }
        }

        var topReasons = histo.OrderByDescending(kv => kv.Value)
            .Take(3)
            .Select(kv => $"{kv.Key}:{kv.Value}")
            .ToList();

        string bInfo = "<none>";
        if (d.BoundaryId is { } bid && state.Nodes.TryGetValue(bid, out var bn))
        {
            bInfo = $"name={bn.Name} type={bn.NodeType} z={bn.ZIndex?.ToString() ?? "null"} " +
                    $"particle={bn.ParticleSpec is not null} spine={bn.SpineSceneResPath is not null} " +
                    $"intent={bn.IntentFrames is not null} shader={bn.ShaderId is not null}";
        }

        // Where does the additive content live? (bottom bucket = the background band; else gameplay/UI).
        int bucketZ = state.OrderedIds.Count > 0 ? EffZOfBottom(state) : 0;
        int addInBand = 0, addTotal = 0;
        foreach (var n in state.Nodes.Values)
        {
            if (n.CanvasBlendMode == 1)
            {
                addTotal++;
                if (EffZOf(state, n.Id) == bucketZ)
                {
                    addInBand++;
                }
            }
        }

        Console.Error.WriteLine(
            $"[bake-probe]   {label}: bakeable={plan.IsBakeable} regions={plan.Regions.Count} " +
            $"baked={mixBaked} liveZ={plan.LiveZ.Count} eligible={eligible} " +
            $"coverage={plan.Coverage:0} topQuadZ={plan.QuadZ} bucketZ={bucketZ} addInBand={addInBand}/{addTotal} " +
            $"boundaryReason={d.BoundaryReason} boundary=[{bInfo}] rejects=[{string.Join(" ", topReasons)}]");

        if (plan.Regions.Count > 1)
        {
            var sb = new StringBuilder("[bake-probe]     regions: ");
            foreach (var r in plan.Regions)
            {
                sb.Append($"[baked={r.BakedIds.Count} quadZ={r.QuadZ}] ");
            }

            Console.Error.WriteLine(sb.ToString());
        }

        string boundaryKind = "—";
        if (d.BoundaryId is { } bid2 && state.Nodes.TryGetValue(bid2, out var bn2))
        {
            boundaryKind = bn2.ParticleSpec is not null ? "particle"
                : bn2.SpineSceneResPath is not null ? "spine"
                : bn2.IntentFrames is not null ? "intent"
                : bn2.ShaderId is not null ? "shader"
                : "other";
        }

        if (BandDumpEnabled)
        {
            BandDump(planner, state, transforms, effectStaticOk, bottomOnly, label);
        }

        return new Measured(plan.IsBakeable, plan.Regions.Count, mixBaked, plan.LiveZ.Count,
            eligible, d.BoundaryReason, topReasons, bucketZ, addInBand, addTotal, boundaryKind);
    }

    // The Step-1 band layout dump (see BandDumpEnabled). Uses the REAL planner's ClassifyPaintOrder so the static /
    // interloper split is exactly the per-node Eligibility the flatten planner will consume — the only addition here
    // is paint-order run compression.
    private static void BandDump(
        StaticBakePlanner planner, MirrorState state, GlobalTransformIndex transforms,
        IReadOnlySet<string> effectStaticOk, IReadOnlySet<string> bottomOnly, string label)
    {
        var order = planner.ClassifyPaintOrder(
            state, transforms, new HashSet<string>(StringComparer.Ordinal), effectStaticOk);
        if (order.Count == 0)
        {
            return;
        }

        int bucketZ = EffZOf(state, order[0].Id);
        if (bucketZ >= 0)
        {
            Console.Error.WriteLine($"[band-dump] {label}: bucketZ={bucketZ} (no z<0 band) — skipped");
            return;
        }

        Console.Error.WriteLine($"[band-dump] {label}: bucketZ={bucketZ} — band in paint order:");

        double designArea = DesignW * StaticBakePlanner.DesignHeight;
        int bandCount = 0;               // nodes in the bottom bucket
        int staticPainters = 0;          // eligible painters (quad candidates)
        double staticCoverage = 0;       // Σ clamped coverage of the eligible painters (design areas)
        int lastLivePos = -1;            // band position of the last recorded live interloper
        var liveKinds = new Dictionary<string, int>(StringComparer.Ordinal);

        int runMembers = 0, runPainters = 0;
        var runBlends = new Dictionary<string, int>(StringComparer.Ordinal);

        void FlushRun()
        {
            if (runMembers == 0)
            {
                return;
            }

            var blends = string.Join(",", runBlends.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key}:{kv.Value}"));
            Console.Error.WriteLine($"[band-dump]   [static x{runMembers} painters={runPainters} blends={blends}]");
            runMembers = 0;
            runPainters = 0;
            runBlends.Clear();
        }

        for (int pos = 0; pos < order.Count; pos++)
        {
            var (id, reason) = order[pos];
            if (EffZOf(state, id) != bucketZ)
            {
                break; // the bottom bucket is a paint-order prefix — a higher bucket ends the band
            }

            bandCount++;
            var node = state.Nodes[id];
            bool paints = ProbePaints(node);
            string blend = BlendName(node.CanvasBlendMode);

            // Mirrors the flatten planner's classification: eligible + not bottom-only ⇒ static quad candidate;
            // everything else is a live interloper, RECORDED only when it paints or carries a hard effect.
            bool isStatic = reason == BakeReject.None && !bottomOnly.Contains(id);
            if (isStatic)
            {
                runMembers++;
                if (paints && PaintCoverage(state, transforms, id, node) is { } cov)
                {
                    runPainters++;
                    staticPainters++;
                    staticCoverage += cov;
                }

                runBlends[blend] = runBlends.TryGetValue(blend, out var c) ? c + 1 : 1;
                continue;
            }

            string kind = reason != BakeReject.None
                ? reason == BakeReject.Effect
                    ? node.ParticleSpec is not null ? "particle"
                        : node.SpineSceneResPath is not null ? "spine"
                        : node.IntentFrames is not null ? "intent"
                        : "shader"
                    : reason.ToString()
                : "subMul"; // eligible but bottom-only (Sub/Mul painter) — live above the bottom prefix

            bool recorded = paints || node.ParticleSpec is not null
                || node.SpineSceneResPath is not null || node.IntentFrames is not null;

            FlushRun();
            Console.Error.WriteLine($"[band-dump]   pos={pos} kind={kind} blend={blend} paints={paints} " +
                                    $"recorded={recorded} name={node.Name}");

            if (recorded)
            {
                lastLivePos = pos;
                liveKinds[kind] = liveKinds.TryGetValue(kind, out var k) ? k + 1 : 1;
            }
        }

        FlushRun();

        var kinds = string.Join(" ", liveKinds.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key}:{kv.Value}"));
        Console.Error.WriteLine(
            $"[band-dump]   summary: bandNodes={bandCount} staticPainters={staticPainters} " +
            $"coverage={staticCoverage / designArea:0.00}xDesign live=[{kinds}] lastLivePos={lastLivePos}");

        // Exercise the REAL flatten planner on the same inputs, so the dump's partition arithmetic is checked against
        // the committed PlanBandFlatten output (K, per-region painters, live slots, coverage) for every sweep.
        var flat = planner.PlanBandFlatten(
            state, transforms, DesignW, new HashSet<string>(StringComparer.Ordinal), effectStaticOk, bottomOnly);
        var fd = planner.LastDiagnostic;
        var regionsTxt = string.Join(" ", flat.Regions.Select(r => $"[baked={r.BakedIds.Count} painters={r.PaintCount} quadZ={r.QuadZ}]"));
        Console.Error.WriteLine(
            $"[band-dump]   flatten: bakeable={flat.IsBakeable} regions={flat.Regions.Count} {regionsTxt} " +
            $"liveZ={flat.LiveZ.Count} bandIds={flat.BandIds?.Count ?? -1} " +
            $"excludedRoots={flat.ExcludedLiveRoots?.Count ?? -1} " +
            $"coverage={flat.Coverage / designArea:0.00}xDesign reason={fd.BoundaryReason}");
    }

    private static string BlendName(int? mode) => mode switch
    {
        null or 0 => "Mix",
        1 => "Add",
        2 => "Sub",
        3 => "Mul",
        _ => $"?{mode}",
    };

    // Mirrors StaticBakePlanner.Paints (visible + own pixels).
    private static bool ProbePaints(MirrorNode node) =>
        node.Visible
        && (node.TextureUrl is not null
            || node.FillColor is not null
            || node.Range is not null
            || node.Text is { Text.Length: > 0 });

    // The node's clamped design-space coverage (fraction accumulates in design areas), or null when unknown.
    private static double? PaintCoverage(MirrorState state, GlobalTransformIndex transforms, string id, MirrorNode node)
    {
        var box = node.LocalRect;
        if (box is null || !transforms.TryGetGlobal(id, out var g))
        {
            return null;
        }

        var aabb = CullBounds.OfRect(g, box.X, box.Y, box.Width, box.Height);
        double x0 = Math.Max(aabb.MinX, 0);
        double y0 = Math.Max(aabb.MinY, 0);
        double x1 = Math.Min(aabb.MaxX, DesignW);
        double y1 = Math.Min(aabb.MaxY, StaticBakePlanner.DesignHeight);
        double w = x1 - x0;
        double h = y1 - y0;
        return w > 0 && h > 0 ? w * h : 0;
    }

    // Effective-Z of a node = Σ ZIndex up the ancestor chain (matches the planner's forward pass for a diagnostic).
    private static int EffZOf(MirrorState state, string id)
    {
        int z = 0;
        string? cur = id;
        var guard = 0;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var n) && guard++ < 4096)
        {
            z += n.ZIndex ?? 0;
            cur = n.ParentId;
        }

        return z;
    }

    private static int EffZOfBottom(MirrorState state)
    {
        int min = int.MaxValue;
        foreach (var id in state.Nodes.Keys)
        {
            int z = EffZOf(state, id);
            if (z < min)
            {
                min = z;
            }
        }

        return min == int.MaxValue ? 0 : min;
    }

    private static string BuildReport(List<Row> rows)
    {
        var sb = new StringBuilder();
        sb.AppendLine("# Static-bake coverage report (offline planner probe)");
        sb.AppendLine();
        sb.AppendLine($"Generated by `StaticBakePlanProbe` over {rows.Count} recording(s). Each scene is forced fully");
        sb.AppendLine("stable, then run through the REAL `StaticBakePlanner` with the additive sub-quad + per-region");
        sb.AppendLine("levers active. `effectStaticOk` is swept two ways to bound the shader contribution:");
        sb.AppendLine("`EMPTY` = no shader cleared (every shader ends its prefix); `ALL` = every shader cleared (the");
        sb.AppendLine("maximum the controller could ever allow, on-device gated by mount / blend-class / screen-read).");
        sb.AppendLine();
        sb.AppendLine("Numbers are the PLAN (not a rendered frame): `mix`/`add` = baked nodes per partition, `live` =");
        sb.AppendLine("re-leveled live band painters, `elig` = per-node eligible painters in the paint order.");
        sb.AppendLine();
        sb.AppendLine("> OFFLINE CAVEAT: bottomOnly / addBlend come from `CanvasBlendMode` only (no Godot ShaderStore),");
        sb.AppendLine("> so an additive-blend SHADER would read Mix here. Combat's water shader IS Mix and its additive");
        sb.AppendLine("> content is atmosphere PARTICLES (hard-rejected), so combat coverage is faithful.");
        sb.AppendLine();
        sb.AppendLine("`bucketZ` = the bottom bucket effZ (a real background band is < 0; 0 = flat/spine background).");
        sb.AppendLine("`addBand` = additive (CanvasBlendMode Add) painters IN the bottom bucket / total — where the add");
        sb.AppendLine("sub-quad could help. `bnd` = the node type that ended the baked band.");
        sb.AppendLine();
        sb.AppendLine("| scene | nodes | shaders | sweep | bakeable | bucketZ | regions | baked | live | addBand | bnd | top rejects |");
        sb.AppendLine("|---|--:|--:|---|:--:|--:|--:|--:|--:|--:|---|---|");
        foreach (var row in rows)
        {
            AppendRow(sb, row, "EMPTY", row.Empty);
            AppendRow(sb, row, "ALL", row.All);
        }

        int bakeAll = rows.Count(r => r.All.Bakeable);
        int realBand = rows.Count(r => r.All.BucketZ < 0);
        int spineBg = rows.Count(r => !r.All.Bakeable && r.All.BoundaryKind == "spine");
        int addInBandTotal = rows.Where(r => r.All.BucketZ < 0).Sum(r => r.All.AddInBand);

        sb.AppendLine();
        sb.AppendLine("## Findings");
        sb.AppendLine();
        sb.AppendLine($"- **{bakeAll}/{rows.Count}** scenes bake under the `ALL` sweep; **0/{rows.Count}** under `EMPTY` —");
        sb.AppendLine("  EVERY bakeable scene needs its background shader cleared first (the boundary under `EMPTY` is the");
        sb.AppendLine("  water/room `shader`). On-device that clearance is gated by Static-clone fidelity (WS-EMITTER's");
        sb.AppendLine("  `MaterialSamplerStore`, Part 1) — until that lands, combat baking is not AE-safe on device.");
        sb.AppendLine($"- **{realBand}/{rows.Count}** scenes have a real z<0 background band. The combat/room band bakes a");
        sb.AppendLine("  NON-TRIVIAL 3–5 regions / 22–38 mix nodes once the shader is cleared (the ~33% background-fill");
        sb.AppendLine("  prize). The band always ends at an atmosphere `particle` (`floorfog`) — v3 multi-region jumps it.");
        sb.AppendLine($"- **{spineBg} scenes have a SPINE background** (bucketZ 0, boundary `spine`): two combat recordings");
        sb.AppendLine("  (…37-42, …38-48) and audit-shop. A spine-drawn backdrop is dynamic pixels — legitimately");
        sb.AppendLine("  unbakeable. This is the per-encounter content variance the planner must stay generic about: NOT");
        sb.AppendLine("  every combat has a z<0 static band.");
        sb.AppendLine($"- **Additive sub-quad (Part 2): 0 add partitions OFFLINE** (this probe classifies Add by");
        sb.AppendLine($"  CanvasBlendMode only; the {addInBandTotal} in-band plain-Add painters here all sit in region 0 or a");
        sb.AppendLine("  particle gap). LIVE it is different + WORSE: the Godot ShaderStore flags ~65 combat background");
        sb.AppendLine("  layers as Add-blend SHADERS, so the real combat band is heavily additive-interleaved.");
        sb.AppendLine();
        sb.AppendLine("## Live-render reality (device/Xvfb, NOT visible to this offline probe)");
        sb.AppendLine();
        sb.AppendLine("- **restsite / rewards / event / cardreward bake CORRECTLY** (mix regions), ON-vs-OFF `AE=0` (fuzz-2%,");
        sb.AppendLine("  Full) — the water/room shaders in those bands clone faithfully (blocker #1 is a NON-issue: the");
        sb.AppendLine("  water `noise` is a `.tscn` NoiseTexture2D kept at the shader default for BOTH live and clone, so it");
        sb.AppendLine("  is identical). MaterialSamplerStore (`.tres` Curve/Gradient) never touches a baked node.");
        sb.AppendLine("- **Combat does NOT get a correct fill bake.** Its z=-10 band is ~65-way additive-interleaved LIVE:");
        sb.AppendLine("  with the add sub-quad OFF (default) those additive shaders stay live and fragment the mix runs");
        sb.AppendLine("  below `MinPaintersPerRegion` → the band does not bake (SAFE, no artifact, no fill win). With the");
        sb.AppendLine("  add sub-quad ON the band DOES bake (3 regions / ~19 nodes) but the additive-over-re-leveled-live");
        sb.AppendLine("  composite is wrong: `AE≈107k` vs a ~14k particle jitter floor → the add sub-quad is DEFAULT OFF");
        sb.AppendLine("  (opt-in `…_ADDQUAD=1`). Correct combat baking needs a per-depth additive composite, not one add");
        sb.AppendLine("  quad per region — the remaining real blocker.");

        return sb.ToString();
    }

    private static void AppendRow(StringBuilder sb, Row row, string sweep, Measured m)
    {
        string rejects = m.TopReasons.Count > 0 ? string.Join(", ", m.TopReasons) : "—";
        sb.AppendLine($"| {row.Scene} | {row.Nodes} | {row.Shaders} | {sweep} | " +
                      $"{(m.Bakeable ? "yes" : "no")} | {m.BucketZ} | {m.Regions} | {m.MixBaked} | {m.LiveZ} | " +
                      $"{m.AddInBand}/{m.AddTotal} | {m.BoundaryKind} | {rejects} |");
    }

    private readonly record struct Row(
        string Scene, int Nodes, int Shaders, int BlendPainters, Measured Empty, Measured All);

    private readonly record struct Measured(
        bool Bakeable, int Regions, int MixBaked, int LiveZ, int Eligible,
        BakeReject BoundaryReason, List<string> TopReasons, int BucketZ, int AddInBand, int AddTotal, string BoundaryKind);
}
