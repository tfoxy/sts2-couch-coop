// The QA hide-verb force-hide set (DemoInputPlayer `hide`/`show`/`hidelist`). The reconciler re-writes Visible on
// essentially every drain (MirrorNodeView.Apply / ApplyLight, SceneReconciler.ApplyCull), so a one-shot
// Visible=false cannot stick; instead the three write sites consult this set AT APPLY TIME against the WIRE node
// data — pooled/recycled and freshly-created views are all handled, because the check keys off the node, never a
// cached per-view flag. ZERO overhead when unused: every enforcement site guards on `Active` (an empty-array
// length check), and the match loop is a plain for over a tiny copy-on-write array (no LINQ, no allocation).
//
// `stage` / `bake` are pseudo-selectors targeting CLIENT nodes (the SceneReconciler root / the StaticBake
// controller root — the bake quads' parent), not wire nodes; the verb sets their Visible directly and the two
// flags here let a rebuilt stack (reconnect) re-assert the hide at Bind time. All mutation happens on the main
// thread (verbs execute in DemoInputPlayer._Process); the COW array just keeps the hot-path read allocation-free.

using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.GodotClient.Scene;

internal static class QaForcedHide
{
    private static QaHideSelector[] _selectors = System.Array.Empty<QaHideSelector>();

    // Pseudo-selector flags: `hide stage` (the whole-mirror kill) / `hide bake` (the composited bake quads).
    public static bool StageHidden;
    public static bool BakeHidden;

    // The hot-path guard: every per-node enforcement site checks this FIRST (zero cost when the feature is unused).
    public static bool Active => _selectors.Length > 0;

    // Active selector count including the pseudo-selectors — the `state` verb's `qaHidden` field.
    public static int Count => _selectors.Length + (StageHidden ? 1 : 0) + (BakeHidden ? 1 : 0);

    public static System.Collections.Generic.IReadOnlyList<QaHideSelector> Selectors => _selectors;

    public static bool Matches(MirrorNode node)
    {
        var sels = _selectors;
        for (int i = 0; i < sels.Length; i++)
        {
            if (sels[i].Matches(node))
            {
                return true;
            }
        }

        return false;
    }

    // Add a selector (no-op when the identical selector text is already active).
    public static void Add(QaHideSelector selector)
    {
        var sels = _selectors;
        for (int i = 0; i < sels.Length; i++)
        {
            if (sels[i] == selector)
            {
                return;
            }
        }

        var next = new QaHideSelector[sels.Length + 1];
        sels.CopyTo(next, 0);
        next[sels.Length] = selector;
        _selectors = next;
    }

    // Remove a selector; false when it was not active.
    public static bool Remove(QaHideSelector selector)
    {
        var sels = _selectors;
        for (int i = 0; i < sels.Length; i++)
        {
            if (sels[i] == selector)
            {
                var next = new QaHideSelector[sels.Length - 1];
                for (int j = 0, k = 0; j < sels.Length; j++)
                {
                    if (j != i)
                    {
                        next[k++] = sels[j];
                    }
                }

                _selectors = next;
                return true;
            }
        }

        return false;
    }

    // `show all`: drop every selector including the pseudo-selectors.
    public static void Clear()
    {
        _selectors = System.Array.Empty<QaHideSelector>();
        StageHidden = false;
        BakeHidden = false;
    }
}
