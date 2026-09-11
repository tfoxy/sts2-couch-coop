namespace CouchCoop.Mod.Server;

/// <summary>
/// The ONE host-wide admission gate for main-thread asset extractions, shared by every provider that renders
/// on the Godot main thread (<see cref="CouchCoopSpineClipProvider"/> spine clips/stills AND
/// <see cref="CouchCoopStaticBackgroundProvider"/> combat-background images). Hoisted out of the spine provider
/// so a background render can never overlap a spine render — they contend for the same main-thread frame budget.
/// </summary>
internal static class CouchCoopAssetExtractionGate
{
    // Cap CONCURRENT main-thread extractions across ALL keys (and provider instances/kinds). Each extraction
    // renders a hidden viewport frame-by-frame ON THE GODOT MAIN THREAD; combat start requests a clip per creature
    // at once, and N simultaneous render-loops collapse the frame rate enough that the ENet co-op client misses its
    // tick and the host drops it (the "connection interrupted on combat start" bug). Serializing them keeps at most
    // one extra per-frame render in flight, so the game (and its ENet tick) stays responsive; results are cached
    // after first run, so this is a one-time warmup cost paid as assets trickle in rather than a single fatal spike.
    public static readonly SemaphoreSlim Gate = new(1, 1);
}
