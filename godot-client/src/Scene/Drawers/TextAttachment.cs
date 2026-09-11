// WS-F: the text sub-layer. Text is NOT painted in MirrorNodeView._Draw — it renders as a child Label /
// RichTextLabel so Godot's font system lays it out (and it draws AFTER the owner's own _Draw, i.e. frontmost).
// MirrorNodeView.Apply calls Sync on every node update; this reconciles exactly ONE deterministically-named child
// ("__text") per owner: create/retype/configure when the node has text, free it when the text is gone.
//
// Ownership: this attaches its label as a child of `owner` (a MirrorNodeView). The reconciler's MoveChild pass
// only reorders its own MirrorNodeView children, so we re-assert the label to the LAST child index each Sync,
// keeping it frontmost regardless of when sibling views were added. TextBuilder does the actual configuration.

using CouchCoop.GodotClient.Scene;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Drawers;

public static class TextAttachment
{
    private const string ChildName = "__text";

    // WS-B: build-once NodePath for the child probe (GetNodeOrNull(string) marshals a fresh NodePath per call).
    private static readonly NodePath ChildPath = ChildName;

    // Called every time the owning view's node data changes. Reconciles the child text node. `textScale` is the
    // per-label multiplier (resolved once in MirrorNodeView.Apply; 1.0 = neutral) folded into the font size;
    // `lineHeight` / `paragraphExtra` are the optional WS-TXT rich-text line-spacing ratios (null = neutral), and
    // `textures` is the shared cache the rich builder fetches inline `[img]` icons from (all rich-text-only);
    // `maxSizePx` / `wrap` are the optional WS-TEXT-v4 plain-Label font-size cap + WordSmart wrap (End Turn only);
    // `nudgeYPx` is the R15 vertical-centring nudge (plain Label only, 0 = neutral).
    public static void Sync(
        Node2D owner,
        MirrorNode node,
        double textScale,
        double? lineHeight = null,
        double? paragraphExtra = null,
        TextureStore? textures = null,
        int? maxSizePx = null,
        bool wrap = false,
        int nudgeYPx = 0)
    {
        var existing = owner.GetNodeOrNull<Control>(ChildPath);

        // No text (or emptied) → drop the child if we have one. Immediate Free (not QueueFree) so no ghost text
        // draws this frame and the "__text" name is free for an immediate re-add; a pending font-fetch callback is
        // guarded by IsInstanceValid, so the free is safe.
        if (node.Text is null || string.IsNullOrEmpty(node.Text.Text))
        {
            existing?.Free();
            return;
        }

        bool rich = node.RichText;

        // Retype if the rich flag flipped (Label <-> RichTextLabel).
        if (existing is not null && existing is RichTextLabel != rich)
        {
            existing.Free();
            existing = null;
        }

        if (existing is null)
        {
            existing = rich ? new RichTextLabel() : new Label();
            existing.Name = ChildName;
            owner.AddChild(existing);
        }

        if (rich)
        {
            TextBuilder.ConfigureRich((RichTextLabel)existing, node, textScale, lineHeight, paragraphExtra, textures);
        }
        else
        {
            TextBuilder.ConfigureLabel((Label)existing, node, textScale, maxSizePx, wrap, nudgeYPx);
        }

        // Keep the label frontmost (last child): sibling MirrorNodeViews the reconciler adds/moves would otherwise
        // draw over co-located text. Cheap no-op when it is already last (the common leaf-node case).
        int last = owner.GetChildCount() - 1;
        if (owner.GetChild(last) != existing)
        {
            owner.MoveChild(existing, last);
        }
    }
}
