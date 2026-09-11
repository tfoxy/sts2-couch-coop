using Godot;
using Spirectl.Sts2.Core.SceneInspection;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Marks a node subtree as "do not stream to mirror clients".
/// </summary>
/// <remarks>
/// <para>
/// Two callers, two rationales. (1) SAFETY (the original): mirror clients drive the host with REAL
/// injected input (a tap in the browser warps the host's mouse and clicks it), so a phone that can
/// see the injected QR button can PRESS it — opening a dialog on the living-room TV that nobody
/// asked for, and worse, one that then blocks the host's own lobby input. The button and the dialog
/// are therefore stamped so they never reach a mirror at all. (2) BANDWIDTH/CPU (Stage-B walk skip):
/// the static-background tracker stamps the live combat bg root while EVERY streaming viewer shows
/// the host-rendered static image, so the producer walk stops visiting the most expensive subtree.
/// </para>
/// <para>
/// The honouring side lives in spirectl's runtime scene watcher, which skips a stamped node and never
/// descends into it. The key string is the contract between the two repos and must not drift. For
/// injected UI, stamp BEFORE <c>AddChild</c>: the watcher can observe a node the moment it enters the
/// tree, so a stamp applied afterwards races a keyframe. The walk-skip caller stamps a node the game
/// ALREADY mounted, so it deliberately accepts that race (the subtree may stream for one tick, then
/// stale-sweeps) — see CouchCoopStaticBackgroundTracker.
/// </para>
/// <para>
/// Removal is exactly symmetric (the spirectl contract): a skipped subtree was never tracked, so
/// after <see cref="RemoveMeta"/> the next producer walk descends again and re-emits every node as a
/// fresh static-bearing upsert — no keyframe needed.
/// </para>
/// </remarks>
internal static class CouchCoopStreamSkip
{
    /// <summary>
    /// Metadata key read by spirectl's runtime scene watcher — its own published constant, not a copy of it,
    /// so a rename upstream fails this build instead of failing open (an un-honoured key streams every subtree
    /// this type exists to hide).
    /// </summary>
    public const string MetadataKey = SpirectlSceneStreamMeta.StreamSkipMetaKey;

    public static void Stamp(Node? node)
    {
        if (node is null || !GodotObject.IsInstanceValid(node))
        {
            return;
        }

        node.SetMeta(MetadataKey, true);
    }

    /// <summary>Un-stamp: the subtree is re-admitted (as upserts) on the producer's next walk.</summary>
    public static void RemoveMeta(Node? node)
    {
        if (node is null || !GodotObject.IsInstanceValid(node))
        {
            return;
        }

        if (node.HasMeta(MetadataKey))
        {
            node.RemoveMeta(MetadataKey);
        }
    }
}
