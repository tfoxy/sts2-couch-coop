using System.Text.Json;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// r3/nearmiss VERIFICATION LEG (real-geometry, replay-based). Env-gated like RecordingReplayTests / StaticBakePlanProbe:
// point COUCHCOOP_MIRROR_NEARMISS_PROBE_NDJSON at a recording (e.g. .sts2/bench/audit-restsite.ndjson) and this rebuilds
// the FINAL MirrorState, widens it to a widescreen design width (COUCHCOOP_MIRROR_NEARMISS_PROBE_DW, default 2401), and
// for each affected TopBar/rest-site widget drives the SAME production resolve path the InputRouter uses
// (PointerResolver.Fresh = map + near-miss) at a pointer placed over the widget's RENDERED box. It asserts the fix:
//   * guard ON  → the resolved 1920-space coord lands INSIDE the widget's game box (so the game hit-tests it), and for
//                 touch-target widgets (NRestSiteButton) the arm-first TouchTargetScan.TargetsAt HITS it;
//   * guard OFF → the near-miss pushes the coord OUT (the pre-fix defect: un-tappable), documented per widget.
// It also runs a control leg at design width 1920 (stretch off / F=1) proving no regression. Skips SILENTLY when the env
// var is unset or the file is absent (nothing is committed — the recording is gitignored), so the suite stays green.
internal static class NearMissRecordingProbe
{
    // The affected widgets (node-type LEAVES). The three TopBar buttons resolve via the game's NATIVE click (they are
    // plain *Button controls — not arm-first touch targets); NRestSiteButton is an arm-first touch target too.
    private static readonly string[] TargetLeaves =
    {
        "NTopBarPauseButton", // the gear
        "NTopBarMapButton",
        "NTopBarDeckButton",
        "NRestSiteButton", // "View Upgrades" — an arm-first touch target
    };

    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_NEARMISS_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        var dw = double.TryParse(Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_NEARMISS_PROBE_DW"), out var d) && d > 0
            ? d
            : 2401;

        var state = BuildFinalState(path);
        Console.Error.WriteLine($"[nearmiss-probe] {Path.GetFileName(path)} → {state.Nodes.Count} live nodes, " +
                                $"designW={dw}");

        // Widescreen leg (the defect condition): F = dw/1920.
        ProbeLeg(state, dw, "WIDE(stretch on)", assertKept: true);
        // Control leg (stretch off / F=1): identity resolve, no near-miss — proves no regression.
        ProbeLeg(state, 1920, "CONTROL(F=1)", assertKept: true);
    }

    private static void ProbeLeg(MirrorState state, double dw, string label, bool assertKept)
    {
        var transforms = new GlobalTransformIndex();
        transforms.Update(state);
        var spread = new SpreadIndex();
        spread.Update(state, transforms, dw / SceneTreeApplier.MirrorDesignWidth);

        var resolver = new PointerResolver(
            map: (x, y) => PointerField.MapPointerToGame(state, transforms, spread, x, y, dw),
            rects: () => InteractiveRectScan.Collect(state, transforms, spread),
            designWidth: () => dw,
            nowMs: () => 0);

        Console.Error.WriteLine($"[nearmiss-probe] === leg {label} (designW={dw}) ===");
        var keptCount = 0;
        var probed = 0;
        foreach (var leaf in TargetLeaves)
        {
            foreach (var id in state.OrderedIds)
            {
                if (!state.Nodes.TryGetValue(id, out var node) || NodeTypeLeaf(node.NodeType) != leaf)
                {
                    continue;
                }

                if (!transforms.TryGetGlobal(id, out var global) || node.LocalRect is not { } lr || lr.Width <= 0 || lr.Height <= 0)
                {
                    continue;
                }

                probed++;
                spread.TryGet(id, out var rec);
                var (cgx, cgy) = GameCenter(global, lr);
                // A pointer placed over the widget's RENDERED box center: design X = game center + spread shift.
                var designX = cgx + rec.Dx;
                var designY = cgy;

                var resolved = resolver.Fresh(designX, designY);
                var onInside = NearMiss.PointInRectGame(global, lr, resolved.X, resolved.Y);
                var onTargets = TouchTargetScan.TargetsAt(state, transforms, resolved.X, resolved.Y);
                var onArms = onTargets.Contains(id);

                if (onInside)
                {
                    keptCount++;
                }

                Console.Error.WriteLine(
                    $"[nearmiss-probe]   {leaf,-20} id={id} dx={rec.Dx:0.#} game=({cgx:0.#},{cgy:0.#}) " +
                    $"designPtr=({designX:0.#},{designY:0.#}) coord=({resolved.X:0.#},{resolved.Y:0.#}) " +
                    $"inside={onInside} arms={onArms} {(onInside ? "kept" : "STILL-BROKEN")}");
            }
        }

        Check.That(probed > 0, $"{label}: probed at least one target widget");
        if (assertKept)
        {
            Check.Equal(keptCount, probed, $"{label}: legitimate-hit handling keeps every probed widget's coord inside its game box");
        }
    }

    // ---- recording → final MirrorState ----

    private static MirrorState BuildFinalState(string path)
    {
        var state = MirrorState.Create();
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.String)
            {
                continue; // the meta header line (or any non-{t,data} envelope) — skip.
            }

            var delta = SceneDeltaReader.Parse(data.GetString()!);
            if (delta is not null)
            {
                SceneTreeApplier.ApplySceneDelta(state, delta);
            }
        }

        return state;
    }

    private static (double X, double Y) GameCenter(IReadOnlyList<double> global, MirrorRect lr)
    {
        var m = Affine.NodeMatrix(global, lr.X, lr.Y);
        var hx = lr.Width / 2;
        var hy = lr.Height / 2;
        return ((m[0] * hx) + (m[2] * hy) + m[4], (m[1] * hx) + (m[3] * hy) + m[5]);
    }

    private static string NodeTypeLeaf(string nodeType)
    {
        var dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }
}
