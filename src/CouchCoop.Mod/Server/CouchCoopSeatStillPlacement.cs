using System.Globalization;
using System.Numerics;

namespace CouchCoop.Mod.Server;

internal static class CouchCoopSeatStillPlacement
{
    // Image pixels -> seat canvas -> parent space. The 2520x1080 still is centred on the viewport width; a combat
    // still carries reference framing (scale 0.9 about image (1283, 540)), which the probed frame replaces.
    internal static Matrix3x2 LocalTransform(StaticBackgroundFamily family, string? frameSpec,
        float viewportWidth, Matrix3x2 parentGlobalTransform)
    {
        var scale = 1f;
        var dx = 0f;
        var dy = 0f;
        var parts = frameSpec?.Split(',');
        if (family == StaticBackgroundFamily.Combat && parts is { Length: 3 }
            && float.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var x)
            && float.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var y)
            && float.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var s)
            && float.IsFinite(x) && float.IsFinite(y) && float.IsFinite(s) && s > 0)
        {
            scale = s / 0.9f;
            dx = x - 983f;
            dy = y - 540f;
        }
        var canvas = Matrix3x2.CreateScale(scale)
            * Matrix3x2.CreateTranslation(viewportWidth / 2f - 1260f + dx + 1283f * (1f - scale),
                dy + 540f * (1f - scale));
        if (!Matrix3x2.Invert(parentGlobalTransform, out var inverse))
            throw new ArgumentException("The still parent transform must be invertible.", nameof(parentGlobalTransform));
        return canvas * inverse;
    }
}

// Main-thread lifetime seam: completion tickets also fence freed roots and replaced descriptors.
internal sealed class StreamStillLifetime
{
    internal ulong RootId { get; private set; }
    internal string? Descriptor { get; private set; }
    internal long Generation { get; private set; }
    internal bool IsCurrent(long generation) => RootId != 0 && Generation == generation;
    internal void Update(bool desired, ulong rootId, CouchCoopStaticBackgroundState? state, Func<ulong, bool> alive,
        Action engage, Action<string> retire)
    {
        var descriptor = CouchCoopStaticBackgroundTracker.StreamHideIdentity(state);
        var nextRoot = desired && rootId != 0 && alive(rootId) ? rootId : 0;
        if (RootId == nextRoot && Descriptor == descriptor && nextRoot != 0) return;
        if (RootId != 0)
        {
            var reason = !alive(RootId) ? "root freed" : !desired ? "demand lost"
                : RootId != nextRoot ? "room changed" : "descriptor changed";
            retire(reason);
        }
        RootId = 0;
        Descriptor = null;
        Generation++;
        if (nextRoot == 0) return;
        RootId = nextRoot;
        Descriptor = descriptor;
        engage();
    }
}
