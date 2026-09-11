using System.Text.Json;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-G2 headless geometry/path DUMP probe (no Godot, no display, no live lock) for the R2/R3/R4/R7/R9/R19/R20
// blocking captures. Replays a recorded mirror stream into a MirrorState, runs the REAL GlobalTransformIndex +
// SpreadIndex at a widened factor (F≠1, phone aspect), and prints per matching node: id, name, type-leaf, owning
// scene file, parent id, LocalRect, and the design-space AABB (spread-Dx folded). Env:
//   COUCHCOOP_GEOMDUMP_NDJSON  — recording path (required; skips silently when unset/absent).
//   COUCHCOOP_GEOMDUMP_FILTER  — comma-separated substrings; a node matches if any hits its name/type/sceneFile/
//                                relPath. Empty/unset = dump nothing (keeps the suite quiet).
//   COUCHCOOP_GEOMDUMP_TWEENS  — "1" dumps every accumulated tween hint whose target matches the filter (R3 trace):
//                                target, property, durationMs, start/end transform 6-tuples + decomposed scale.
//   COUCHCOOP_GEOMDUMP_F       — widen factor (default 2255/1920).
// Env-gated, no assert; stays green in a plain checkout.
internal static class GeometryDumpProbe
{
    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_GEOMDUMP_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        double f = double.TryParse(Environment.GetEnvironmentVariable("COUCHCOOP_GEOMDUMP_F"), out var pf) && pf > 0
            ? pf
            : 2255.0 / 1920.0;
        string[] filters = (Environment.GetEnvironmentVariable("COUCHCOOP_GEOMDUMP_FILTER") ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        bool dumpTweens = Environment.GetEnvironmentVariable("COUCHCOOP_GEOMDUMP_TWEENS") == "1";

        var state = MirrorState.Create();
        int applied = 0;
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

            SceneTreeApplier.ApplySceneDelta(state, delta);
            applied++;
        }

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);
        var spread = new SpreadIndex();
        spread.Update(state, transforms, f);

        Console.Error.WriteLine($"[geomdump] applied {applied} deltas; {state.Nodes.Count} nodes; F={f:0.####}; screen={state.ScreenType}");

        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            string leaf = Leaf(node.NodeType);
            var (file, relPath) = SceneIdentity.Resolve(id, state);
            if (!Match(filters, node.Name, leaf, file, relPath))
            {
                continue;
            }

            string box = DesignBox(state, transforms, spread, id, node);
            Console.Error.WriteLine(
                $"[geomdump] id={id} name='{node.Name}' type={leaf} vis={node.Visible} " +
                $"file={file ?? "-"} rel='{relPath ?? "-"}' parent={node.ParentId ?? "-"} " +
                $"local={FmtRect(node.LocalRect)} clip={node.ClipChildren} anchorOwner={node.AnchorOwnerId ?? "-"} {box}");
        }

        if (dumpTweens)
        {
            Console.Error.WriteLine($"[geomdump] --- {state.PendingHints.Count} accumulated tween hints ---");
            foreach (var h in state.PendingHints)
            {
                if (!state.Nodes.TryGetValue(h.TargetId, out var tn))
                {
                    continue;
                }

                string leaf = Leaf(tn.NodeType);
                var (file, relPath) = SceneIdentity.Resolve(h.TargetId, state);
                if (filters.Length > 0 && !Match(filters, tn.Name, leaf, file, relPath))
                {
                    continue;
                }

                Console.Error.WriteLine(
                    $"[geomdump-tween] target={h.TargetId} name='{tn.Name}' type={leaf} rel='{relPath ?? "-"}' " +
                    $"prop={h.Property} durMs={h.DurationMs:0.#} " +
                    $"start={FmtXf(h.StartTransform)} end={FmtXf(h.EndTransform)} endOpacity={h.EndOpacity?.ToString("0.###") ?? "-"} " +
                    $"local={FmtRect(tn.LocalRect)}");
            }
        }
    }

    private static bool Match(string[] filters, string name, string leaf, string? file, string? relPath)
    {
        if (filters.Length == 0)
        {
            return false;
        }

        foreach (var flt in filters)
        {
            if (name.Contains(flt, StringComparison.OrdinalIgnoreCase)
                || leaf.Contains(flt, StringComparison.OrdinalIgnoreCase)
                || (file is not null && file.Contains(flt, StringComparison.OrdinalIgnoreCase))
                || (relPath is not null && relPath.Contains(flt, StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }
        }

        return false;
    }

    private static string DesignBox(
        MirrorState state, GlobalTransformIndex transforms, SpreadIndex spread, string id, MirrorNode node)
    {
        if (node.LocalRect is not { } lr || !transforms.TryGetGlobal(id, out var g))
        {
            return "designBox=-";
        }

        double dx = spread.TryGet(id, out var rec) ? rec.Dx : 0;
        double rw = rec.RenderedWidth;
        // Design AABB corners: global 6-tuple [a,b,c,d,tx,ty] applied to LocalRect corners, then shift X by spread Dx.
        (double, double) Xf(double x, double y) => (g[0] * x + g[2] * y + g[4] + dx, g[1] * x + g[3] * y + g[5]);
        var (x0, y0) = Xf(lr.X, lr.Y);
        var (x1, y1) = Xf(lr.X + lr.Width, lr.Y);
        var (x2, y2) = Xf(lr.X, lr.Y + lr.Height);
        var (x3, y3) = Xf(lr.X + lr.Width, lr.Y + lr.Height);
        double minX = Math.Min(Math.Min(x0, x1), Math.Min(x2, x3));
        double minY = Math.Min(Math.Min(y0, y1), Math.Min(y2, y3));
        double maxX = Math.Max(Math.Max(x0, x1), Math.Max(x2, x3));
        double maxY = Math.Max(Math.Max(y0, y1), Math.Max(y2, y3));
        return $"designBox=[{minX:0.#},{minY:0.#} .. {maxX:0.#},{maxY:0.#}] w={maxX - minX:0.#} h={maxY - minY:0.#} spreadDx={dx:0.#} renderedW={rw:0.#}";
    }

    private static string FmtRect(MirrorRect? r) =>
        r is null ? "-" : $"({r.X:0.#},{r.Y:0.#},{r.Width:0.#}x{r.Height:0.#})";

    private static string FmtXf(IReadOnlyList<double>? m)
    {
        if (m is not { Count: 6 })
        {
            return "-";
        }

        // scale = column norms; origin = (tx,ty).
        double sx = Math.Sqrt(m[0] * m[0] + m[1] * m[1]);
        double sy = Math.Sqrt(m[2] * m[2] + m[3] * m[3]);
        return $"[scale=({sx:0.###},{sy:0.###}) origin=({m[4]:0.#},{m[5]:0.#})]";
    }

    private static string Leaf(string t)
    {
        int dot = t.LastIndexOf('.');
        return dot >= 0 ? t[(dot + 1)..] : t;
    }
}
