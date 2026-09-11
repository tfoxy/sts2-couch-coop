using System;
using System.Collections.Generic;

namespace CouchCoop.MirrorProtocol.SceneModel;

// WS-P2 memoizing scene-identity + text-scale cache (pure, Godot-free). Both the cosmetic animator (bob/spin scoping)
// and the per-label text-scale lookup resolve a node's scene identity via SceneIdentity.Resolve — a parent-chain
// walk to the owning instanced-scene root — and the text path additionally runs the TextScale table. On a full Apply
// EVERY node pays that walk (CosmeticAnimator once per node; a text node a second time via TextScale). But a node's
// identity (File, RelPath) and its derived text scale depend ONLY on STATIC inputs (ancestor Names / SceneFilePaths /
// the ParentId links). A volatile-only drain (transform/tint/draw/effect churn) never touches them, so the resolved
// identity is stable drain-over-drain and can be memoized.
//
// INVALIDATION (owner: SceneReconciler): Clear() on any drain that carries a Static-bearing change (a name/type/
// parent/scene/anchor/mouseFilter change or a re-declared static block — NodeChangeFlags.Static), a keyframe / full
// rebuild, or an order change (reparents/renames only arrive via a static-bearing upsert and/or an order patch —
// verified against SceneTreeApplier: MergeNode retains SceneFilePath/Name, so RelPath can only shift when the
// structural draw order changes or a static block is re-sent). A volatile-only drain leaves the cache intact.
public sealed class SceneIdentityCache
{
    // The resolved identity + text metrics for one node id. `File`/`RelPath` are null when the node is not inside any
    // instanced scene (SceneIdentity contract); TextScale is 1.0 and the line-spacing ratios null (neutral) then.
    // BlockScale is the R6 card block TRANSFORM scale (1.0 = none) MirrorNodeView.FoldCosmetic folds; NudgeYPx is the
    // R15 vertical-centring nudge (0 = none) TextBuilder.GrowthCenterPlain applies.
    public readonly record struct Entry(
        string? File,
        string? RelPath,
        double TextScale,
        double? LineHeight = null,
        double? ParagraphExtra = null,
        int? MaxSizePx = null,
        bool Wrap = false,
        double BlockScale = 1.0,
        int NudgeYPx = 0);

    private readonly Dictionary<string, Entry> _cache = new(StringComparer.Ordinal);
    // The node's (File, RelPath, textScale), from the cache when memoized, else freshly resolved. Identical to
    // calling SceneIdentity.Resolve + TextScale.ScaleFor directly.
    public Entry Resolve(string id, MirrorState state)
    {
        if (_cache.TryGetValue(id, out var cached))
        {
            return cached;
        }

        var (file, relPath) = SceneIdentity.Resolve(id, state);
        var m = TextScale.MetricsFor(file, relPath);
        double blockScale = SceneModel.BlockScale.ScaleFor(file, relPath);
        var entry = new Entry(
            file, relPath, m.Scale, m.LineHeight, m.ParagraphExtra, m.MaxSizePx, m.Wrap, blockScale, m.NudgeYPx);
        _cache[id] = entry;

        return entry;
    }

    // Drop all memoized identities (a Static-bearing / structural / keyframe drain changed identity inputs). No-op
    // when empty.
    public void Clear() => _cache.Clear();

    // Test/diagnostic: how many identities are currently memoized.
    public int Count => _cache.Count;
}
