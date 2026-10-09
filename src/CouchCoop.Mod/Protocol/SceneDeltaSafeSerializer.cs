using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.SceneInspection;

namespace CouchCoop.Mod.Protocol;

// A node the wire could not carry, and why. The caller re-queues the node so the next send re-resolves it.
internal sealed record QuarantinedSceneNode(RuntimeSceneNodeDelta Node, Exception Exception);

// A one-shot tween hint or card flight the wire could not carry. Not re-queued: it describes an animation that
// started this tick, and the producer's own settle re-emit still lands the node where the animation ends.
internal sealed record DroppedSceneHint(string TargetId, string Kind, Exception Exception);

internal sealed class SceneDeltaSerializeResult
{
    // The frame to send, or null when nothing sendable is left (every upsert quarantined and nothing else in the
    // frame) or the frame could not be serialized at all (`Failure`).
    public byte[]? Bytes { get; init; }

    // Upserts whose own serialization threw. Their ids are already out of the coalescer, so they must be re-queued.
    public IReadOnlyList<QuarantinedSceneNode> Quarantined { get; init; } = [];

    // Upserts held back with a quarantined parent that carried its static block (a fresh add or a keyframe node):
    // the client has no such parent, so sending the children alone would place them as roots. Re-queued too.
    public IReadOnlyList<RuntimeSceneNodeDelta> Held { get; init; } = [];

    // Upserts that went out with at least one non-finite number written as 0 (SceneWireNonFinite).
    public IReadOnlyList<string> SanitizedIds { get; init; } = [];

    public IReadOnlyList<DroppedSceneHint> DroppedHints { get; init; } = [];

    // Set only when no bytes could be produced even after quarantining every node and hint that throws alone.
    public Exception? Failure { get; init; }

    public bool HasFaults => Quarantined.Count > 0 || SanitizedIds.Count > 0 || DroppedHints.Count > 0 || Failure is not null;

    public bool HasRequeue => Quarantined.Count > 0 || Held.Count > 0;

    public IEnumerable<RuntimeSceneNodeDelta> Requeue => Quarantined.Select(fault => fault.Node).Concat(Held);
}

// Serializes a scene delta so that one node the wire cannot represent costs that node, not the frame. The normal
// path is exactly BrowserSceneDeltaMessage.Serialize plus one thread-static read. Only when that throws, or when
// a converter had to sanitize a non-finite number, does it serialize each upsert alone to find the node(s)
// responsible, rebuild the frame without the ones that throw (every other field of the delta kept as it was) and
// serialize again. Used by the coalescing drain AND both keyframe paths, so a reconnect while such a node exists
// still gets a keyframe and a running pump.
internal static class SceneDeltaSafeSerializer
{
    public static SceneDeltaSerializeResult Serialize(RuntimeSceneDelta delta, SceneOrderPatch? orderPatch = null)
    {
        Exception failure;
        try
        {
            var bytes = BrowserSceneDeltaMessage.Serialize(delta, orderPatch);
            if (SceneWireNonFinite.Count == 0)
            {
                return new SceneDeltaSerializeResult { Bytes = bytes };
            }

            // The bytes are valid JSON (the channel went out as 0); all that is missing is which node it was.
            var sanitized = new List<string>();
            foreach (var node in delta.Upserts)
            {
                if (ProbeNode(node, out var nodeSanitized) is null && nodeSanitized)
                {
                    sanitized.Add(node.Id);
                }
            }

            return new SceneDeltaSerializeResult { Bytes = bytes, SanitizedIds = sanitized };
        }
        catch (Exception exception)
        {
            failure = exception;
        }

        return SerializeIsolating(delta, orderPatch, failure);
    }

    private static SceneDeltaSerializeResult SerializeIsolating(
        RuntimeSceneDelta delta,
        SceneOrderPatch? orderPatch,
        Exception failure)
    {
        var kept = new List<RuntimeSceneNodeDelta>(delta.Upserts.Count);
        var quarantined = new List<QuarantinedSceneNode>();
        var sanitized = new List<string>();
        foreach (var node in delta.Upserts)
        {
            if (ProbeNode(node, out var nodeSanitized) is { } exception)
            {
                quarantined.Add(new QuarantinedSceneNode(node, exception));
                continue;
            }

            kept.Add(node);
            if (nodeSanitized)
            {
                sanitized.Add(node.Id);
            }
        }

        var held = HoldOrphanedChildren(kept, quarantined);
        var dropped = new List<DroppedSceneHint>();
        // `with` keeps every other field the record carries (removals, order, hints, flights, transform space).
        var rebuilt = delta with { Upserts = kept };
        if (!delta.Full && IsEmpty(rebuilt, orderPatch))
        {
            return Result(null, null);
        }

        var bytes = TrySerialize(rebuilt, orderPatch, ref failure);
        if (bytes is null)
        {
            // No upsert throws alone, or the rest still throws: the one-shot hints are the remaining carriers of
            // free-form doubles. Drop only the ones that throw alone.
            rebuilt = rebuilt with
            {
                Hints = Filter(rebuilt.Hints, SceneDeltaJsonContext.Default.TweenHintDelta, hint => hint.TargetId, "tween hint", dropped),
                CardFlights = Filter(rebuilt.CardFlights, SceneDeltaJsonContext.Default.CardFlightHintDelta, flight => flight.TargetId, "card flight", dropped),
            };
            if (!delta.Full && IsEmpty(rebuilt, orderPatch))
            {
                return Result(null, null);
            }

            bytes = TrySerialize(rebuilt, orderPatch, ref failure);
        }

        return Result(bytes, bytes is null ? failure : null);

        SceneDeltaSerializeResult Result(byte[]? frame, Exception? frameFailure) => new()
        {
            Bytes = frame,
            Quarantined = quarantined,
            Held = held,
            SanitizedIds = sanitized,
            DroppedHints = dropped,
            Failure = frameFailure,
        };
    }

    // Serialize one upsert on its own, exactly as it would ride in a frame. Returns the exception it throws, if any.
    private static Exception? ProbeNode(RuntimeSceneNodeDelta node, out bool sanitized)
    {
        SceneWireNonFinite.Reset();
        try
        {
            _ = JsonSerializer.SerializeToUtf8Bytes(WireNodeDelta.FromNode(node), SceneDeltaJsonContext.Default.WireNodeDelta);
            sanitized = SceneWireNonFinite.Count > 0;
            return null;
        }
        catch (Exception exception)
        {
            sanitized = false;
            return exception;
        }
    }

    // Remove (and return) every kept upsert whose parent chain, within this frame, reaches a quarantined node that
    // carried its static block. Rare path only, so a simple fixed point over the frame is fine.
    private static List<RuntimeSceneNodeDelta> HoldOrphanedChildren(
        List<RuntimeSceneNodeDelta> kept,
        List<QuarantinedSceneNode> quarantined)
    {
        var blocked = new HashSet<string>(StringComparer.Ordinal);
        foreach (var fault in quarantined)
        {
            if (fault.Node.Name is not null)
            {
                blocked.Add(fault.Node.Id);
            }
        }

        var held = new List<RuntimeSceneNodeDelta>();
        if (blocked.Count == 0)
        {
            return held;
        }

        var changed = true;
        while (changed)
        {
            changed = false;
            foreach (var node in kept)
            {
                if (node.ParentId is { } parentId && blocked.Contains(parentId) && blocked.Add(node.Id))
                {
                    held.Add(node);
                    changed = true;
                }
            }
        }

        if (held.Count > 0)
        {
            var heldIds = held.Select(node => node.Id).ToHashSet(StringComparer.Ordinal);
            kept.RemoveAll(node => heldIds.Contains(node.Id));
        }

        return held;
    }

    private static IReadOnlyList<T>? Filter<T>(
        IReadOnlyList<T>? items,
        JsonTypeInfo<T> typeInfo,
        Func<T, string> targetId,
        string kind,
        List<DroppedSceneHint> dropped)
    {
        if (items is not { Count: > 0 })
        {
            return items;
        }

        var kept = new List<T>(items.Count);
        foreach (var item in items)
        {
            try
            {
                _ = JsonSerializer.SerializeToUtf8Bytes(item, typeInfo);
                kept.Add(item);
            }
            catch (Exception exception)
            {
                dropped.Add(new DroppedSceneHint(targetId(item), kind, exception));
            }
        }

        return kept;
    }

    private static byte[]? TrySerialize(RuntimeSceneDelta delta, SceneOrderPatch? orderPatch, ref Exception failure)
    {
        try
        {
            return BrowserSceneDeltaMessage.Serialize(delta, orderPatch);
        }
        catch (Exception exception)
        {
            failure = exception;
            return null;
        }
    }

    // An incremental frame with nothing left in it is not worth a send (or the client's ack round trip).
    private static bool IsEmpty(RuntimeSceneDelta delta, SceneOrderPatch? orderPatch)
        => delta.Upserts.Count == 0
           && delta.RemovedIds.Count == 0
           && delta.OrderedIds is null
           && orderPatch is null
           && delta.Hints is not { Count: > 0 }
           && delta.CardFlights is not { Count: > 0 };
}
