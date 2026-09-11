using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Runtime;

public sealed record CouchCoopRuntimeNotice(
    string CapabilityId,
    bool Supported,
    bool Provisional,
    string? UnsupportedReason)
{
    public static CouchCoopRuntimeNotice FromCapability(EmbeddableRuntimeCapability capability)
    {
        ArgumentNullException.ThrowIfNull(capability);
        return new CouchCoopRuntimeNotice(
            capability.Id,
            capability.Supported,
            capability.Provisional,
            capability.UnsupportedReason);
    }
}
