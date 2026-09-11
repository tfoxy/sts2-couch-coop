using System.Text.RegularExpressions;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Input;

// M2 WS-O foundation, then FROZEN. Verbatim port of mirrorRenderer.ts `forEachInteractiveRect` L1038-1065 — the
// current frame's visible MOUSE-VISIBLE (mouse_filter Stop=0 OR Pass=1) Control boxes, in paint order (back-to-front,
// so the LAST containing candidate is the topmost painter), each with its TRUE game-space global (composed down the
// parent chain, == the web `liftEndpointToGlobal`), its node-local box, and its cumulative spread shift/rendered
// width from the <see cref="SpreadIndex"/>. Pass matters: tooltip-only elements (relics, Gold/HP counters, potions)
// are Pass — hover-reactive but not pressable — and must offend the near-miss pass like any button.
//
// SHARED (frozen) by WS-P's hitTestShift (remote-cursor anchoring) and WS-Q's near-miss pass (pushOutOfNearMiss).
// Because the native client hit-tests the retained MirrorState + GlobalTransformIndex (no DOM), the scan walks the
// scene tree directly instead of `document.elementsFromPoint`.
public static class InteractiveRectScan
{
    // A visible mouse-visible Control box of the current frame: its game-space global 6-tuple [a,b,c,d,tx,ty], its
    // node-local box, and its cumulative absolute spread shift (design px) + anchor-widened rendered width (0 = none).
    // The native analog of the web `InteractiveRect` (mirrorRenderer.ts L480-486).
    public readonly record struct InteractiveRect(
        string Id,
        IReadOnlyList<double> Global,
        MirrorRect LocalRect,
        double SpreadDx,
        double RenderedWidth);

    // mirrorRenderer REMOTE_FOLLOWER_TYPES — a teammate's co-op cursor / targeting indicator (a shift THIS client
    // never resolved). Keyed by the Godot type LEAF. LIVE-VERIFY: these leaf names are still UNVERIFIED against the
    // streamed nodeType strings — confirm them against a live capture before relying on this set (see the web set).
    private static readonly HashSet<string> RemoteFollowerTypes = new(StringComparer.Ordinal)
    {
        "NRemoteMouseCursor",
        "NRemoteTargetingIndicator",
    };

    // mirrorRenderer ECHO_CONTAINER (case-sensitive) — a non-interactive card copy re-rendered on top of the real one
    // (previews / hover-tips / inspect popup). Its inner NCard must never anchor the map.
    private static readonly Regex EchoContainer = new("Preview|HoverTip|Inspect", RegexOptions.CultureInvariant);

    /// <summary>
    /// Invoke <paramref name="cb"/> for each eligible interactive rect, in paint order (back-to-front). Allocation-free
    /// for the shared consumers (hitTestShift walks + short-circuits without a list).
    /// </summary>
    public static void ForEach(
        MirrorState state,
        GlobalTransformIndex transforms,
        SpreadIndex spread,
        Action<InteractiveRect> cb)
    {
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var n))
            {
                continue;
            }

            // Only a visible mouse-visible (Stop/Pass) Control WITH a transform + a box can anchor the map.
            if (!n.Visible
                || (n.MouseFilter != 0 && n.MouseFilter != 1)
                || n.Transform is null
                || n.LocalRect is not { } localRect)
            {
                continue;
            }

            // Never anchor to a cursor (itself/another), an echo card, or an owner-anchored floater.
            if (IsHitTestExcluded(n))
            {
                continue;
            }

            // EFFECTIVE visibility: an ancestor-hidden control (a closed overlay / debug screen) renders display:none
            // in the nested DOM, so the pointer's DOM hit-test never sees it — it must not anchor here either. The
            // own-visible check above doesn't cover ancestors.
            if (AncestorHidden(state, n))
            {
                continue;
            }

            // The true game-space global (== web liftEndpointToGlobal): the index composes streamed transforms down
            // the parent chain.
            IReadOnlyList<double> global = transforms.TryGetGlobal(id, out var g) ? g : Affine.Identity;
            var rec = spread.TryGet(id, out var r) ? r : default;
            cb(new InteractiveRect(id, global, localRect, rec.Dx, rec.RenderedWidth));
        }
    }

    /// <summary>
    /// Collect the eligible interactive rects into a list (paint order preserved, topmost LAST) — the public provider
    /// WS-Q's near-miss pass consumes. Prefer <see cref="ForEach"/> in a hot z-scan that short-circuits.
    /// </summary>
    public static List<InteractiveRect> Collect(MirrorState state, GlobalTransformIndex transforms, SpreadIndex spread)
    {
        var output = new List<InteractiveRect>();
        ForEach(state, transforms, spread, output.Add);
        return output;
    }

    // ---- exclusion predicates (mirrorRenderer isHitTestExcluded L230-232) ----

    // A follower itself, an ECHO card, or an owner-anchored floater — anchoring to any would feed back a
    // self-referential or transient shift.
    private static bool IsHitTestExcluded(MirrorNode node) =>
        IsRemoteFollower(node) || IsEchoContainer(node) || node.AnchorOwnerId is not null;

    public static bool IsRemoteFollower(MirrorNode node) => RemoteFollowerTypes.Contains(NodeTypeLeaf(node.NodeType));

    private static bool IsEchoContainer(MirrorNode node) => EchoContainer.IsMatch(NodeTypeLeaf(node.NodeType));

    private static bool AncestorHidden(MirrorState state, MirrorNode node)
    {
        for (var p = Parent(state, node); p is not null; p = Parent(state, p))
        {
            if (!p.Visible)
            {
                return true;
            }
        }

        return false;
    }

    private static MirrorNode? Parent(MirrorState state, MirrorNode node) =>
        node.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;

    // The leaf (final dotted segment) of a Godot type name — mirrorRenderer nodeTypeLeaf.
    private static string NodeTypeLeaf(string nodeType)
    {
        var dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }
}
