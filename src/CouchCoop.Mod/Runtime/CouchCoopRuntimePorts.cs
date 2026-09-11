using Spirectl.Sts2.Embedding;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Core.Models;
using Spirectl.Sts2.Core.SceneInspection;

namespace CouchCoop.Mod.Runtime;

public interface ICouchCoopCapabilityPolicy
{
    bool HasCapability(string capabilityId);
    CouchCoopRuntimeNotice RequireCapability(string capabilityId);
    IReadOnlyList<CouchCoopRuntimeNotice> Notices { get; }
}

/// <summary>
/// Immutable couch composition. Each consumer retains only the port it needs; this record exists solely at the
/// application boundary, where the embedded runtime is adapted once.
/// </summary>
public sealed record CouchCoopRuntimeDependencies(
    IRuntimeCapabilitySource Capabilities,
    IRuntimeAssetSource Assets,
    IRuntimeStateSource State,
    IAnimationHintSource AnimationHints,
    IRuntimeSceneDeltaSource SceneDelta,
    IGameModelSource Models,
    ISpineCatalogSource SpineCatalog,
    ISpineGeoClipBaker SpineGeoClipBaker,
    ISemanticActionSource Actions,
    IRuntimeSceneWatchControlSource SceneWatchControls,
    IDisposable? Lifetime = null) : IDisposable
{
    public void Dispose() => Lifetime?.Dispose();

    /// <summary>The only place couch accepts the aggregate embedded-runtime facade.</summary>
    public static CouchCoopRuntimeDependencies FromFactory(ISpirectlRuntime runtime)
    {
        ArgumentNullException.ThrowIfNull(runtime);
        return new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime as IDisposable);
    }

}
