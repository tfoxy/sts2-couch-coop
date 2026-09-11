using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R6 (WS-cardtext) HEADLESS live-data verification of the card block-scale table — no Godot, no display, no live
// lock. Point COUCHCOOP_MIRROR_BLOCKSCALE_PROBE_NDJSON at a recorded mirror stream that shows cards (e.g. the deck
// grid .sts2/bench/wscrisp-deckdialog.ndjson or the card reward audit-cardreward-open.ndjson), and this replays
// every scene-delta into a MirrorState and prints, for every node whose resolved (file, relPath) is a card
// DescriptionLabel / TypePlaque / relic AmountLabel: the resolved BlockScale (R6), its LocalRect + computed pivot
// (the FoldCosmetic block pivot c = own rect centre), and — for the relic — the TextScale (R14). This proves the
// table's suffixes match the REAL streamed node paths and that a LocalRect (pivot) exists for every match. Skips
// SILENTLY when the env var is unset/absent so the suite stays green in a plain checkout. Env-gated, no assert.
internal static class BlockScaleReplayProbe
{
    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_BLOCKSCALE_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

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

        Console.Error.WriteLine($"[blockprobe] applied {applied} deltas; {state.Nodes.Count} nodes");
        int desc = 0, plaque = 0, relic = 0;
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            var (file, relPath) = SceneIdentity.Resolve(id, state);
            if (relPath is null)
            {
                continue;
            }

            double bs = BlockScale.ScaleFor(file, relPath);
            bool isRelicAmount = relPath.EndsWith("AmountLabel", StringComparison.Ordinal) &&
                (file?.EndsWith("relics/relic.tscn", StringComparison.Ordinal) ?? false);
            if (bs == 1.0 && !isRelicAmount)
            {
                continue;
            }

            var box = node.LocalRect;
            string pivot = box is { } b
                ? $"pivot=({b.X + b.Width / 2.0:0.#},{b.Y + b.Height / 2.0:0.#}) rect=({b.X:0.#},{b.Y:0.#},{b.Width:0.#}x{b.Height:0.#})"
                : "NO-RECT(!)";
            string text = node.Text?.Text is { Length: > 0 } t ? $" text=\"{Trim(t)}\"" : "";
            double ts = TextScale.ScaleFor(file, relPath);

            if (isRelicAmount) { relic++; }
            else if (relPath.EndsWith("DescriptionLabel", StringComparison.Ordinal)) { desc++; }
            else { plaque++; }

            Console.Error.WriteLine(
                $"[blockprobe] {relPath} block={bs:0.##} textScale={ts:0.##} {pivot}{text}");
        }

        Console.Error.WriteLine(
            $"[blockprobe] matched {desc} DescriptionLabel, {plaque} TypePlaque, {relic} relic AmountLabel");
    }

    private static string Trim(string s)
    {
        s = s.Replace("\n", "\\n");
        return s.Length > 48 ? s[..48] + "…" : s;
    }
}
