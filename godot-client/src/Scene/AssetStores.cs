// A tiny process-wide registry of asynchronous asset sources (textures, fonts, spine clips, shaders, …) so the
// --shot settle gate can wait for ALL of them to go idle before capturing — not just the texture store. Before M1d
// the settle predicate was `_textures.Idle`, which never waited for FontStore (a latent race: a --shot could fire
// before fonts arrived). Every store registers itself here; AppShell.MaybeCapture polls AllIdle.
//
// Registration is per-Label (the latest instance under a label replaces a stale one) so replacing a store instance
// across a stage rebuild never leaves two live sources fighting; and a FREED Godot-node source is skipped (treated
// as idle) so it can never wedge AllIdle after its stage is torn down.

using System.Collections.Generic;
using Godot;

namespace CouchCoop.GodotClient.Scene;

// A source of asynchronous asset loads that the --shot settle gate must wait on.
public interface IAssetIdleSource
{
    // True when nothing is queued or in flight for this source.
    bool Idle { get; }

    // Count of items still queued or in flight (for the settle-begin diagnostic line).
    int PendingCount { get; }

    // Stable label; the registry stores one source per label (latest wins).
    string Label { get; }
}

public static class AssetStores
{
    private static readonly Dictionary<string, IAssetIdleSource> Sources = new(System.StringComparer.Ordinal);

    // Register (or replace, by Label) a source. Idempotent per label — a new store instance under an existing label
    // supersedes the old one, so a torn-down-and-remounted stage never accumulates stale sources.
    public static void Register(IAssetIdleSource source) => Sources[source.Label] = source;

    // Drop every registered source (AppShell.ReturnToMenu teardown). AllIdle already skips freed Godot-node sources,
    // so this is a hygiene reset: the process-wide registry must not pin the old stage's freed stores across a
    // back-to-menu rebuild — the new stage's TextureStore (in _Ready) + the self-mounting singletons re-register.
    public static void Reset() => Sources.Clear();

    // True when EVERY registered source is idle. A freed Godot-node source is skipped (a torn-down stage's store must
    // not wedge the gate).
    public static bool AllIdle
    {
        get
        {
            foreach (var s in Sources.Values)
            {
                if (s is GodotObject go && !GodotObject.IsInstanceValid(go))
                {
                    continue;
                }

                if (!s.Idle)
                {
                    return false;
                }
            }

            return true;
        }
    }

    // Total pending items across all live sources (freed sources contribute 0).
    public static int TotalPending
    {
        get
        {
            int total = 0;
            foreach (var s in Sources.Values)
            {
                if (s is GodotObject go && !GodotObject.IsInstanceValid(go))
                {
                    continue;
                }

                total += s.PendingCount;
            }

            return total;
        }
    }

    // "fonts=3 textures=0" style per-label pending summary for the settle-begin log.
    public static string Summary()
    {
        var parts = new List<string>(Sources.Count);
        foreach (var (label, s) in Sources)
        {
            int pending = s is GodotObject go && !GodotObject.IsInstanceValid(go) ? 0 : s.PendingCount;
            parts.Add($"{label}={pending}");
        }

        parts.Sort(System.StringComparer.Ordinal);
        return string.Join(" ", parts);
    }
}
