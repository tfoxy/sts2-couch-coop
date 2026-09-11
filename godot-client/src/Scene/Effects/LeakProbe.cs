// TEMPORARY diagnostic (descriptor-set-leak hunt, 2026-07-22). Telemetry-grade "created" counters for the GPU
// resources whose Vulkan uniform/descriptor sets are the finite pool the moto g86 exhausts: particle
// ParticleProcessMaterial + per-emitter CanvasItemMaterial + Gradient/Curve textures, and per-view ShaderMaterials.
//
// Frees USED to happen only via Godot's RefCounted GC (a C# `new` Resource is released when its wrapper is finalized)
// — on Mali the .NET GC lagged the churn, so the wrappers (and their RIDs) piled up between collections (lkShaderMat
// 525→10,403 / lkGpuEmitter→4,045 / lkCpuEmitter→2,277 over 17min, engineOrphans 23→95). The FREED counters below
// track deterministic Dispose()/Free() (ShaderAttachment SHADERMATSHARE + the particle reuse Free path), so the
// honest leak signal is now created-MINUS-freed (a bounded delta) plus Godot's own Performance monitors
// (ObjectResourceCount / ObjectOrphanNodeCount, surfaced alongside these in QaStateJson). Read-only counters;
// main-thread only. Reset on back-to-menu (ResetTotals) so a soak leg starts clean.
namespace CouchCoop.GodotClient.Scene.Effects;

public static class LeakProbe
{
    public static long ParticleProcMat;   // ParticleProcessMaterial FRESH-built (GPU compute SET 3 — the descriptor set the storm exhausts)
    public static long ParticleCanvasMat; // CanvasItemMaterial FRESH-built (per emitter, pre-MATSHARE)
    public static long GpuEmitter;         // GpuParticles2D wrapper CREATED (BuildGpu)
    public static long CpuEmitter;         // CpuParticles2D wrapper CREATED (BuildCpu)
    public static long ShaderMat;          // per-view ShaderMaterial CREATED (ShaderAttachment.EnsureMaterial private/shared build)
    public static long EmitterShaderMat;   // WS-EMITTER: signature-shared emitter ShaderMaterial CREATED (ParticleLayer)

    // FREED counters (deterministic Dispose/Free). created-minus-freed is the live-wrapper estimate the soak watches
    // go flat. GpuEmitterFreed/CpuEmitterFreed advance on the particle reuse/teardown Free path; ShaderMatFreed on a
    // ShaderAttachment private-material replace/clear/pool-recycle Dispose; ShaderMatShared counts shared-cache reuses
    // (a per-view alloc avoided — so lkShaderMat itself climbs far slower with the cache on).
    public static long GpuEmitterFreed;
    public static long CpuEmitterFreed;
    public static long ShaderMatFreed;
    public static long ShaderMatShared;
    // WS-EMITTER: emitter ShaderMaterials are signature-SHARED (one immutable instance per ShaderId|MaterialRef|params
    // key) and disposed on back-to-menu — EmitterShaderMatShared counts cache reuses (allocs avoided), Freed the
    // deterministic disposes. created-minus-freed stays bounded exactly like the particle MATSHARE materials.
    public static long EmitterShaderMatFreed;
    public static long EmitterShaderMatShared;

    public static void ResetTotals()
    {
        ParticleProcMat = 0;
        ParticleCanvasMat = 0;
        GpuEmitter = 0;
        CpuEmitter = 0;
        ShaderMat = 0;
        EmitterShaderMat = 0;
        GpuEmitterFreed = 0;
        CpuEmitterFreed = 0;
        ShaderMatFreed = 0;
        ShaderMatShared = 0;
        EmitterShaderMatFreed = 0;
        EmitterShaderMatShared = 0;
    }
}
