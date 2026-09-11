using System;

namespace CouchCoop.MirrorProtocol.SceneModel;

// R6 card block-scale table — a TextScale SIBLING (same (file, relPath) resolution), but resolved into a per-view
// TRANSFORM scale (folded in MirrorNodeView.FoldCosmetic about the node's OWN LocalRect centre) rather than a
// font-size multiplier. The point (user requirement): the card DESCRIPTION and TYPE blocks must keep the real
// game's byte-identical line breaks — font-size scaling changed them — so the glyphs are transform-scaled instead;
// overflow beyond the card background is ACCEPTABLE, cropping is not. Web twin: the `transform: scale(...);
// transform-origin: 50% 50%` rules on the description / type nodes in mirrorTextScale.css.
//
// The paired TextScale entries for these labels drop to 1.0 (DescriptionLabel 1.24→1.0, TypeLabel 1.16→1.0) so the
// font renders at the game's REAL streamed size (line breaks laid out at that size) and only the transform enlarges
// it. Title / Energy / Star keep their font-size scaling.
//
// Entries are suffix rules only (the card component folds into many owning scenes — hand / picker / deck-grid /
// reward — so a scene-file scope can't cover them; the card's stable internal path suffix is card-specific, exactly
// like the card TextScale suffixes). First match wins; no match → 1.0 (neutral, the FoldCosmetic early-out intact).
//   CardContainer/DescriptionLabel → 1.24  (leaf label; scales its own text block about its rect centre)
//   CardContainer/TypePlaque       → 1.24  (bg NinePatch + child TypeLabel; scales the whole plaque as a UNIT — the
//                                           child TypeLabel inherits TypePlaque's scaled transform, so bg+label grow
//                                           together, fixing the type-block centring + overflow). WS-text round-4
//                                           (P5-b): bumped from 1.16 — the font itself stays pinned at 1.0 (see
//                                           TextScale.cs's TypeLabel entry) so byte-identical wrap is unaffected;
//                                           only this transform scale changes. Web twin: mirrorTextScale.css's
//                                           TypePlaque `.mirror-text` transform: scale(1.24) rule.
public static class BlockScale
{
    private static readonly (string Suffix, double Scale)[] Entries =
    {
        ("CardContainer/DescriptionLabel", 1.24),
        ("CardContainer/TypePlaque", 1.24),
    };

    // Resolve a node's block scale by walking to its owning scene, then matching the table. 1.0 = neutral (no rule).
    public static double ScaleFor(string id, MirrorState state)
    {
        var (file, relPath) = SceneIdentity.Resolve(id, state);
        return ScaleFor(file, relPath);
    }

    // Direct (file, relPath) matcher — the same tuple the web stamps as data-scene-file / data-scene-node-path.
    // `file` is unused today (all entries are file-scope-free card suffixes) but kept for parity with TextScale.
    public static double ScaleFor(string? file, string? relPath)
    {
        _ = file;
        if (relPath is null)
        {
            return 1.0;
        }

        foreach (var (suffix, scale) in Entries)
        {
            if (relPath.EndsWith(suffix, StringComparison.Ordinal))
            {
                return scale;
            }
        }

        return 1.0;
    }
}
