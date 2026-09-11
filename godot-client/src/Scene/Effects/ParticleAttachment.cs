// M1d effect seam — PARTICLE attachment (WS-I real body; replaces the M1c stub). MirrorNodeView.Apply calls Sync
// on every node update. This is the MECHANICAL INVERSE of spirectl's Sts2ParticleInspector: that inspector read a
// live GpuParticles2D/CpuParticles2D into the flat MirrorParticleSpec (snake_case Get, Vector3→Vector2 flatten,
// Gradient/Curve → stop/point arrays); here we read the spec back onto a REAL Godot emitter (snake_case Set,
// Vector2→Vector3 expansion z=0, arrays → Gradient/Curve) so the engine reproduces the VFX natively.
//
// Structure: a "__particles" wrapper Node2D (end-appended + ShowBehindParent, identity transform → emits at the
// owner node's origin) owns the actual emitter as its single child. The emitter is REBUILT only when the spec
// OBJECT REFERENCE changes (mergeNode carries the same static spec across volatile-only upserts); the volatile
// Emitting flag is applied EVERY Sync and a ParticleRestartEpoch increase triggers Restart() (a one-shot re-burst).
// The particle texture is the node's own Texture2D (spec.TextureUrl), fetched via the shared decode-once
// TextureStore. Blend mode + flipbook live on a PER-ATTACHMENT CanvasItemMaterial (never the shared BlendMaterials).
//
// Deviation noted honestly: Curve tangents are NOT on the wire (the inspector emits only point positions), so
// rebuilt Curves use flat tangents — a faithful limit of the spec, matching gsw's curve sampling.

using System;
using System.Collections.Generic;
using CouchCoop.GodotClient.Scene;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Effects;

public static class ParticleAttachment
{
    private const string ChildName = "__particles";

    // WS-B: build-once NodePath for the child probes (GetNodeOrNull(string) marshals a fresh NodePath per call).
    private static readonly NodePath ChildPath = ChildName;

    public static void Sync(MirrorNodeView owner, MirrorNode node, RenderContext ctx)
    {
        // WS-EFFECTS-NATIVE: Off hides particles entirely — treat it exactly like "no spec" so the emitter is torn
        // down (and never built). Dynamic/Static both build the emitter; the mode is threaded to Configure so a flip
        // between them rebuilds the emitter (warm+freeze vs live sim).
        var mode = ClientEffectSettings.ParticleMode;
        bool wantEmitter = node.ParticleSpec is not null && mode != EffectMode.Off;

        // WS-P2 gate: nothing to render AND none ever attached → skip the marshalled child probe entirely.
        if (!wantEmitter && !owner.HasParticleChild)
        {
            return;
        }

        var layer = owner.GetNodeOrNull<ParticleLayer>(ChildPath);

        if (!wantEmitter)
        {
            if (layer is not null)
            {
                owner.RemoveChild(layer); // the layer.Free()/QueueFree() below fires Predelete → emitter-freed count

                // WS-PARTICLE-REUSE: this is the DOMINANT transient-VFX teardown (a VFX node whose spec dropped). Free
                // the layer (and its emitter's per-particle RD buffers) DETERMINISTICALLY this frame rather than piling
                // up until the deferred QueueFree idle pass — lower peak descriptor-set residency (consistent with the
                // Rebuild-path FreeEmitter). RemoveChild already detached it, so an immediate Free is safe; the RD frees
                // the GPU resources with frame-lag. Kill switch =0 restores the original deferred QueueFree.
                layer.Free();
            }

            owner.HasParticleChild = false;
            return;
        }

        if (layer is null)
        {
            layer = new ParticleLayer { Name = ChildName, ShowBehindParent = true };
            owner.AddChild(layer); // end-appended; the reconciler's MoveChild pass keeps non-view children at the tail
            owner.HasParticleChild = true;
        }

        layer.Configure(node, ctx, mode);
    }

    // Track I: freeze/unfreeze this view's particle emitter (idle-suspend sweep). Returns true iff a live
    // "__particles" layer was toggled — the controller gates on owner.HasParticleChild; this re-confirms the child.
    public static bool SetSuspended(MirrorNodeView owner, bool suspend)
    {
        var layer = owner.GetNodeOrNull<ParticleLayer>(ChildPath);
        if (layer is null)
        {
            return false;
        }

        layer.SetSuspended(suspend);
        return true;
    }
}

// The "__particles" wrapper. Owns one GpuParticles2D or CpuParticles2D emitter, rebuilt on spec-reference change.
public sealed partial class ParticleLayer : Node2D
{
    private MirrorParticleSpec? _spec;   // the spec REFERENCE that built the current emitter
    private EffectMode _builtMode;       // the effect mode the current emitter was built for (rebuild on a flip)
    private long _builtEpoch;            // last ParticleRestartEpoch honored (rebuild resets to the current epoch)
    private GpuParticles2D? _gpu;
    private CpuParticles2D? _cpu;
    private string? _wantTexUrl;
    // #1 luma-refetch: the RenderContext captured for the ONE-SHOT raster (?format=png) refetch of an undecodable
    // (compressed) no-alpha page, and the original url that refetch is in flight for (dedup / one-shot guard).
    private RenderContext? _texCtx;
    private string? _lumaRasterFor;
    private bool _logged;
    private bool _continuous; // on-demand: this layer holds a RenderActivity continuous registration (Dynamic + emitting)
    private bool _suspended;  // Track I: true while idle-suspended (live emitter SpeedScale pinned 0 + continuous dropped)

    // ---- WS-EMITTER: this emitter's own ShaderMaterial (mounted when the node carries a ShaderId + a qualifying,
    // parseable material `.tres`). All null/false until the shader compiles AND the material samplers parse; until then
    // (and on any failure) the emitter stays on the fallback CanvasItemMaterial — exactly today's rendering. --------
    private string? _emitterShaderId;      // node.ShaderId this layer is running (keep-last across upserts)
    private string? _emitterMaterialRef;   // node.MaterialRef (raw res:// path) the samplers come from
    private IReadOnlyList<MirrorShaderParam>? _emitterParams; // keep-last-on-null streamed material uniforms
    private RenderContext? _shaderCtx;      // captured ctx for async re-apply (sampler image fetch)
    private EffectMode _shaderMode;         // the effect mode the mounted material was built for
    private string? _requestedShaderId;     // shader fetch armed (fire the re-apply once)
    private string? _requestedMaterialRef;  // material-sampler fetch armed
    private bool _shaderMatMounted;         // a ShaderMaterial (not the CanvasItemMaterial) is the emitter's material
    private ShaderMaterial? _emitterShaderMat; // the mounted SHARED material (cache-owned; never disposed per-layer)
    private string? _emitterShaderKey;      // the cache key the mounted material was served under
    private bool _lumaSuppressed;           // a mounted shader owns coverage → skip the luma-alpha texture synthesis
    private bool _shaderLogged;             // one-time per-layer "shader mounted" log

    // ---- WS-PARTICLE-REUSE: descriptor-set churn fix (Mali/Vulkan pool exhaustion) --------------------------------
    // A keyframe re-sends every particle node's whole static block, and MirrorParticleSpec is a record whose LIST
    // members (ramps/curves/vectors) compare by REFERENCE — so a re-parsed-but-identical spec always fails
    // ReferenceEquals, forcing Rebuild() to tear down + recreate the emitter + ParticleProcessMaterial +
    // CanvasItemMaterial + Gradient/Curve textures. Each fresh material = a fresh Vulkan uniform/descriptor set; on a
    // long combat soak the churn out-runs the deferred QueueFree reclaim and exhausts Mali's finite descriptor pool
    // ("Cannot allocate descriptor sets, error -12" + "Uniforms were never supplied for set (3)" bursts, self-
    // recovering once the frees catch up). Fix: reuse the live emitter when a fresh spec's CONTENT matches what we
    // already built (SameBuild), free replaced emitters DETERMINISTICALLY (immediate Free, not deferred QueueFree),
    // and cache the per-class property-name list.
    // WS-PARTICLE-MATSHARE: share one immutable ParticleProcessMaterial + CanvasItemMaterial per distinct MATERIAL
    // signature across all emitters (the set-3 descriptor-set fragmentation fix; see BuildProcessMaterial).
    // WS-EMITTER: run an emitter's own ShaderMaterial (vfx_ring_polar/flipbook/grayscale) instead of the fallback
    // CanvasItemMaterial, and materialize the sampler sub-resources (CurveTexture/GradientTexture) it reads.
    // The representative TIME the Static effect mode pins on an emitter ShaderMaterial (a harmless no-op on a shader
    // with no whole-word TIME — the whole VFX emitter family drives off INSTANCE_CUSTOM, not TIME). Matches
    // ShaderAttachment.StaticShaderTime so a frozen emitter lands on the same phase as a frozen shader node.
    private const float StaticEmitterShaderTime = 1.0f;

    // WS-EMITTER telemetry: signature-shared emitter ShaderMaterial reuses served (allocs avoided). Cleared on
    // back-to-menu via ResetTotals.
    public static long EmitterShaderMatShared;

    // Telemetry (surfaced in QaStateJson + BENCH_RESULT; cleared on back-to-menu via ResetTotals). RebuildTotal counts
    // actual emitter+material builds (== ParticleProcessMaterial/CanvasItemMaterial pairs created == new descriptor
    // sets); RebuildSkipped counts fresh-reference keyframe respecs whose content matched a live emitter (rebuild — and
    // its descriptor churn — avoided). Before this fix RebuildSkipped is always 0 and RebuildTotal = every keyframe
    // respec; after, RebuildTotal collapses and RebuildSkipped absorbs the identical-content respecs.
    public static long RebuildTotal;
    public static long RebuildSkipped;

    // Why a fresh-reference respec did NOT reuse the live emitter (telemetry). MissNull = first build for this layer
    // (no prior emitter — a genuinely transient one-shot VFX; the DOMINANT case and NOT avoidable churn). MissMode = a
    // Dynamic↔Static/Off mode flip. MissContent = SameBuild found a real content change. Measured on the loop harness:
    // MissContent == 0 (SameBuild is correct; the ~4:1 rebuild:skip ratio is transient VFX vs steady emitters, NOT a
    // comparison bug). The set-3 descriptor churn from these transient builds is what the MATSHARE cache neutralizes.
    public static long ReuseMissNull;
    public static long ReuseMissMode;
    public static long ReuseMissContent;

    public static void ResetTotals()
    {
        RebuildTotal = 0;
        RebuildSkipped = 0;
        ReuseMissNull = 0;
        ReuseMissMode = 0;
        ReuseMissContent = 0;
        ClearMatCaches();
    }

    // Per-class GetPropertyList() cache. The property-NAME set is identical for every default-constructed instance of a
    // given engine class (GpuParticles2D / ParticleProcessMaterial / CpuParticles2D — no script props), so the
    // marshalled GetPropertyList() only needs to run once per class instead of on every Build*. Read-only after fill;
    // main-thread only (Godot node/resource ops are), so a plain Dictionary is safe.
    private static readonly Dictionary<Type, HashSet<string>> _propNameCache = new();

    public void Configure(MirrorNode node, RenderContext ctx, EffectMode mode)
    {
        // Track I: is this layer's particle category currently frozen by the idle-suspend controller? (LateFix gates
        // the whole late-arrival fix for a clean A/B; =0 → false → the pre-fix unconditional-resume + AddContinuous.)
        bool categoryFrozen = IdleSuspend.Suspended;

        // Track I defensive self-resume — now CONSULTS the controller. A Configure reaching a still-suspended layer
        // resumes ONLY if the controller is NOT frozen (a genuine wake already happened and the sweep missed this
        // layer). If it IS still frozen (a late re-Apply that did not ride a drain), stay suspended — never resume
        // behind the controller's back (was unconditional pre-fix, the residual-continuous device gap). Any live-speed
        // emitter a rebuild below produces is re-pinned to SpeedScale 0 by the freeze-aware tail of this method.
        if (_suspended && !categoryFrozen)
        {
            SetSuspended(false);
        }

        var spec = node.ParticleSpec!;

        // WS-EMITTER: decide luma-alpha suppression BEFORE the (re)build's ApplyTexture, so a WARM emitter whose shader
        // is already mounted skips the luma synthesis on its first texture set (the shader owns coverage). A COLD
        // emitter (shader still fetching) keeps luma this pass; ApplyEmitterShader re-applies the raw texture when the
        // shader mounts. Recomputed every Configure from the live mount state.
        _lumaSuppressed = EmitterShaderMountable(node);

        // Rebuild when the spec object changed (a keyframe rebuilt it) OR the effect mode flipped (Dynamic↔Static
        // changes SpeedScale/Preprocess on the emitter). Never on a volatile-only upsert at a steady mode.
        if (!ReferenceEquals(spec, _spec) || mode != _builtMode)
        {
            // WS-PARTICLE-REUSE: a keyframe hands a FRESH spec object (list members re-parsed → ReferenceEquals fails)
            // whose content is almost always bit-identical to what we already built. Skip the teardown+rebuild — and
            // its Vulkan descriptor-set churn — when the mode is unchanged AND the content matches (SameBuild). Only a
            // genuine content change or a mode flip recreates the emitter/materials.
            bool reuse = _spec is not null && mode == _builtMode && SameBuild(spec, _spec);
            if (reuse)
            {
                // Adopt the fresh reference (so the next keyframe's ReferenceEquals fast-path holds); keep the live
                // emitter/materials/textures + _builtEpoch untouched — behaviorally a volatile-only (same-ref) upsert,
                // so the emitting + restart-epoch logic below still honors a restart that rode this keyframe.
                _spec = spec;
                RebuildSkipped++;
            }
            else
            {
                // Attribute WHY the live emitter was not reused (telemetry; surfaced in QaStateJson). MissNull = first
                // build for a fresh layer (a genuinely transient VFX node — the dominant case; NOT avoidable churn).
                // MissMode = a Dynamic↔Static/Off flip. MissContent = SameBuild found a genuine content change (measured
                // ZERO on the loop harness — SameBuild is correct; the reuse simply can't engage for one-shot VFX).
                {
                    if (_spec is null)
                    {
                        ReuseMissNull++;
                    }
                    else if (mode != _builtMode)
                    {
                        ReuseMissMode++;
                    }
                    else
                    {
                        ReuseMissContent++;
                    }
                }

                Rebuild(spec, ctx, mode);
                _spec = spec;
                _builtMode = mode;
                _builtEpoch = node.ParticleRestartEpoch; // a fresh build starts at the current epoch (no phantom restart)
                RebuildTotal++;

                if (!_logged)
                {
                    _logged = true;
                    GD.Print($"PARTICLES: emitter built kind={spec.Kind} mode={mode} amount={spec.Amount:F0} " +
                             $"blend={(spec.BlendMode >= 1 ? "add" : "mix")} tex={(spec.TextureUrl ?? "<none>")} " +
                             $"ramp={(spec.ColorRamp is { Count: > 0 })} hframes={spec.Hframes:F0}x{spec.Vframes:F0}");
                }
            }
        }

        // WS-EFFECTS-NATIVE: in Static keep the warmed art visible (SpeedScale=0 means no new particles accrue, so
        // Emitting stays true purely to hold the frozen set); in Dynamic honor the streamed emitting flag.
        bool emitting = mode == EffectMode.Static || node.ParticleEmitting;
        if (_gpu is not null)
        {
            _gpu.Emitting = emitting;
        }
        else if (_cpu is not null)
        {
            _cpu.Emitting = emitting;
        }

        // WS-perf3 continuous-render-node budget: under a heavy continuous-particle load (Tezcatara fire ⇒ phone-GPU
        // overdraw) scale this emitter's AmountRatio by ContinuousBudget.Multiplier (< 1 while engaged ⇒ fewer live
        // particles ⇒ proportionally less additive overdraw, still alive/animating). Applied EVERY Configure (cheap
        // runtime property, no rebuild) so a fresh/reused emitter, a volatile respec, AND the RefreshEffects sweep a
        // budget flip fires all land the current multiplier. Multiplier is pinned 1 when the kill switch is off, so
        // this is a byte-identical no-op on the default-behavior path.
        ApplyBudgetAmountRatio(spec);

        // On-demand rendering: a Dynamic-mode emitter simulates GPU-side every frame with NO C# signal, so force-keep
        // the stage alive while it is emitting. Static (SpeedScale=0 → frozen art, no accrual) and Off (torn down) are
        // NOT continuous — in Static `emitting` is forced true only to HOLD the frozen set, hence the explicit
        // mode==Dynamic gate. Reconciled so a Dynamic↔Static flip / an emitting toggle add/removes exactly once.
        bool wantContinuous = mode == EffectMode.Dynamic && emitting;
        if (wantContinuous && categoryFrozen)
        {
            // Track I: a late emitter Configured/rebuilt while the controller is suspended. Register in the SUSPENDED
            // state — pin SpeedScale to 0 (bit-identical frozen art) and DON'T add a continuous registration — then
            // enroll with the controller so its next wake resumes this layer. Never pins the stage: the fix for the
            // residual-continuous device gap (a re-Configure behind the controller's back must not re-pin).
            if (!_suspended)
            {
                SetSuspended(true); // drops any continuous + freezes SpeedScale to 0
            }
            else
            {
                PinSpeedScaleZero(); // already flagged suspended, but a rebuild above may have made a live-speed emitter
            }

            EnrollLateFrozen();
        }
        else
        {
            SetContinuous(wantContinuous);
        }

        // Volatile: a restart-epoch increase re-triggers the system (one-shot re-burst). In Static, Restart() re-runs
        // the Preprocess warm at SpeedScale=0 → re-warm then hold (no ongoing sim).
        if (node.ParticleRestartEpoch > _builtEpoch)
        {
            _builtEpoch = node.ParticleRestartEpoch;
            _gpu?.Restart();
            _cpu?.Restart();
        }

        // WS-EMITTER: run the emitter's own ShaderMaterial (arms the shader + material-sampler fetches; mounts the
        // shared ShaderMaterial once both are ready). No-op / early-return when the switch is off or the node has no
        // qualifying emitter shader — the CanvasItemMaterial path (built above) then stands, exactly today's rendering.
        SyncEmitterShader(node, ctx, mode);
    }

    // ---- WS-EMITTER: emitter ShaderMaterial mount + sampler materialization -------------------------------------

    // The task's fetch guard: a material `.tres` whose FULL TEXT (and its sampler sub-resource blocks) is fetchable
    // over `/res` — non-empty, not a `::`-qualified scene-embedded material (power.tscn::…), ends in `.tres`.
    private static bool MaterialRefQualifies(string? materialRef) =>
        materialRef is { Length: > 0 }
        && !materialRef.Contains("::", System.StringComparison.Ordinal)
        && materialRef.EndsWith(".tres", System.StringComparison.Ordinal);

    // Would this node's emitter shader mount RIGHT NOW (synchronously)? True only when the switch is on, the node has a
    // ShaderId + a qualifying material, the shader is compiled, AND the material samplers have parsed. Used for the
    // pre-build luma-suppression decision and as the readiness gate. A Pending/Failed shader or material ⇒ false ⇒ the
    // CanvasItemMaterial fallback (today's rendering) stands (ApplyEmitterShader re-checks on each async arrival).
    private static bool EmitterShaderMountable(MirrorNode node)
    {
        if (node.ShaderId is null || !MaterialRefQualifies(node.MaterialRef))
        {
            return false;
        }

        return ShaderStore.PeekState(node.ShaderId) == ShaderState.Mounted
            && MaterialSamplerStore.PeekReady(node.MaterialRef!);
    }

    private void SyncEmitterShader(MirrorNode node, RenderContext ctx, EffectMode mode)
    {
        // keep-last-on-null: a volatile-only upsert carries ShaderParams=null (unchanged), never a reset.
        if (node.ShaderParams is not null)
        {
            _emitterParams = node.ShaderParams;
        }

        string? shaderId = node.ShaderId;
        string? materialRef = node.MaterialRef;
        if (shaderId is null || !MaterialRefQualifies(materialRef))
        {
            // Not a materializable emitter shader (no shader, or an unfetchable/scene-embedded material) → today's
            // rendering. If a shader material was mounted under a prior (qualifying) tenure, revert to the fallback.
            if (_shaderMatMounted)
            {
                RevertToCanvasMaterial();
            }

            return;
        }

        _emitterShaderId = shaderId;
        _emitterMaterialRef = materialRef;
        _shaderCtx = ctx;
        _shaderMode = mode;

        // Arm the shader + material-sampler fetches ONCE each; each async arrival re-runs ApplyEmitterShader (which
        // mounts the shared material once BOTH are ready). The IsInstanceValid guard drops a callback for a freed layer.
        if (_requestedShaderId != shaderId)
        {
            _requestedShaderId = shaderId;
            ShaderStore.For(this).Request(shaderId, () =>
            {
                if (GodotObject.IsInstanceValid(this))
                {
                    ApplyEmitterShader();
                }
            });
        }

        if (_requestedMaterialRef != materialRef)
        {
            _requestedMaterialRef = materialRef;
            MaterialSamplerStore.For(this).Request(materialRef!, () =>
            {
                if (GodotObject.IsInstanceValid(this))
                {
                    ApplyEmitterShader();
                }
            });
        }

        ApplyEmitterShader();
    }

    // WS-PARTICLE: are ALL of this emitter material's plain-image samplers (e.g. the power-applied `mask` PNG) already
    // decoded in the TextureStore? Warms any that aren't and arms a callback that re-runs the mount when each arrives.
    // A `::` sub-resource sampler or a non-resource uniform is not an image sampler (skipped — those gate via
    // MaterialSamplerStore / the shared binder). True when there are no image samplers to wait on.
    private bool EmitterImageSamplersReady()
    {
        if (_emitterParams is null || _shaderCtx is null)
        {
            return true;
        }

        bool all = true;
        foreach (var p in _emitterParams)
        {
            if (p.ResourcePath is not { } rp
                || rp.IndexOf("::", System.StringComparison.Ordinal) >= 0
                || !ShaderResourceParser.IsImagePath(rp))
            {
                continue;
            }

            string relUrl = SceneDeltaReader.MirrorResourceUrl(rp);
            if (RasterTextureUrl.NeedsRasterFormat(rp))
            {
                relUrl = RasterTextureUrl.For(relUrl);
            }

            if (_shaderCtx.Textures.Request(relUrl, _ =>
                {
                    if (GodotObject.IsInstanceValid(this))
                    {
                        ApplyEmitterShader();
                    }
                }) is null)
            {
                all = false; // pending — the callback re-runs the mount when it decodes
            }
        }

        return all;
    }

    // Mount the shared emitter ShaderMaterial when the shader is compiled AND the material samplers have parsed; else
    // leave the CanvasItemMaterial fallback (today's rendering). Re-entrant: called synchronously from Configure and
    // from the shader/material async-arrival callbacks.
    private void ApplyEmitterShader()
    {
        if (_emitterShaderId is not { } shaderId
            || !MaterialRefQualifies(_emitterMaterialRef) || _emitterMaterialRef is not { } materialRef)
        {
            return;
        }

        if (_gpu is null && _cpu is null)
        {
            return; // no live emitter to mount onto
        }

        bool ready = ShaderStore.PeekState(shaderId) == ShaderState.Mounted
            && MaterialSamplerStore.PeekReady(materialRef);
        if (!ready)
        {
            return; // Pending (retry on arrival) or Failed (CanvasItemMaterial fallback stands — today's rendering)
        }

        // WS-PARTICLE (POWER-GAIN WHITE SQUARE): also require the material's plain-image samplers (the power-applied
        // `mask`) to be CACHED before mounting. Otherwise the shader mounts with a hint_default_white mask for the few
        // frames until the PNG decodes — a coverage-less quad that paints the white square. While they're pending, hold
        // the emitter on the CanvasItemMaterial + luminance-alpha soft-blob path (NOT the raw opaque page); the
        // image-request callback re-runs this once they arrive, so the shader mounts with the mask already in hand.
        if (!EmitterImageSamplersReady())
        {
            if (_lumaSuppressed && _spec is not null && _shaderCtx is not null)
            {
                _lumaSuppressed = false;
                ApplyTexture(_spec, _shaderCtx);
            }

            return;
        }

        var mat = SharedEmitterMaterial(shaderId, materialRef, _shaderMode);
        if (mat is null)
        {
            return; // race: state Mounted but the compiled Shader not yet stashed (defensive)
        }

        if (_gpu is not null)
        {
            _gpu.Material = mat;
        }
        else if (_cpu is not null)
        {
            _cpu.Material = mat;
            // A CPUParticles2D cannot feed INSTANCE_CUSTOM, which every VFX emitter shader reads for lifetime/flipbook
            // phase — the shader mounts (blend/tint still apply) but its flipbook/erosion-over-life is degraded.
            NoticeEmitter($"cpu-instance-custom:{shaderId}",
                $"PARTICLES: CPU emitter mounted shader {shaderId} — INSTANCE_CUSTOM (lifetime/flipbook) unavailable on CPUParticles2D.");
        }

        _shaderMatMounted = true;
        _emitterShaderMat = mat;

        // The shader owns coverage now → suppress luma-alpha and re-apply the RAW texture if an earlier (cold) pass
        // applied the luma variant.
        //
        // WS-PARTICLE (POWER-GAIN WHITE SQUARE): that suppression assumes the mounted emitter shader DERIVES coverage
        // from the (opaque, no-alpha) grayscale page itself. The power/debuff-applied flash's vfx_panning_shader does
        // NOT reliably shape coverage on the native mirror, so its OPAQUE noise page (vfx_noise_1.png: 8-bit grayscale,
        // alpha=255) painted a solid WHITE QUAD — the white square behind the "N <Status>" notification. With
        // EmitterSamplerFix ON we KEEP the synthesized luminance-alpha on the emitter's own texture (black→transparent,
        // white→opaque): a no-op for alpha-carrying pages and for a shader that reads .rgb, but it turns a
        // coverage-less shader's opaque square back into the intended luminance-shaped blob (web parity, same rule as
        // the energy-counter static-square LumaAlpha fix — just not suppressed for shader emitters).
        {
            if (_lumaSuppressed && _spec is not null && _shaderCtx is not null)
            {
                _lumaSuppressed = false;
                ApplyTexture(_spec, _shaderCtx); // restore the luminance-coverage variant on a reused (previously-suppressed) layer
            }
            else
            {
                _lumaSuppressed = false;
            }
        }
        if (!_shaderLogged)
        {
            _shaderLogged = true;
            GD.Print($"PARTICLES: emitter shader mounted id={shaderId} material={materialRef} mode={_shaderMode}");
        }
    }

    // Revert a previously-mounted emitter to the CanvasItemMaterial fallback (a qualify→non-qualify tenure change on a
    // reused layer). Rebuilds/rebinds the shared CanvasItemMaterial + restores the luma-alpha texture path.
    private void RevertToCanvasMaterial()
    {
        _shaderMatMounted = false;
        _emitterShaderMat = null;
        _emitterShaderKey = null;
        _lumaSuppressed = false;
        if (_spec is null)
        {
            return;
        }

        var cim = SharedCanvasMaterial(_spec);
        if (_gpu is not null)
        {
            _gpu.Material = cim;
        }
        else if (_cpu is not null)
        {
            _cpu.Material = cim;
        }

        if (_shaderCtx is not null)
        {
            ApplyTexture(_spec, _shaderCtx);
        }
    }

    // Signature-SHARED immutable emitter ShaderMaterial cache: one instance per (ShaderId | MaterialRef | mode |
    // param-signature). The samplers are deterministic from MaterialRef and the params are in the key, so two emitters
    // with an identical key get a bit-identical material → safe to share (MATSHARE lesson: never mutate a shared
    // material; a different param set = a different key). Cache-owned; disposed on back-to-menu (ClearMatCaches).
    private static readonly Dictionary<string, ShaderMaterial> _emitterMatCache = new(System.StringComparer.Ordinal);

    private ShaderMaterial? SharedEmitterMaterial(string shaderId, string materialRef, EffectMode mode)
    {
        string key = shaderId + "|" + materialRef + "|" + (int)mode + "|" + ParamSignature(_emitterParams);
        if (_emitterMatCache.TryGetValue(key, out var cached) && GodotObject.IsInstanceValid(cached))
        {
            EmitterShaderMatShared++;
            LeakProbe.EmitterShaderMatShared++;
            _emitterShaderKey = key;
            return cached;
        }

        var shader = ShaderStore.PeekShader(shaderId, mode);
        if (shader is null)
        {
            return null;
        }

        var mat = new ShaderMaterial { Shader = shader }; // Godot applies the shader source's `uniform x = default`s
        LeakProbe.EmitterShaderMat++;

        // Streamed material overrides (numbers/vectors) + the `::` sampler sub-resources (materialized CurveTexture/
        // GradientTexture). Set ONLY at construction — the material is immutable thereafter (safe to share).
        ApplyEmitterUniforms(mat, _emitterParams, materialRef);

        // Static effect mode: pin the frozen-TIME uniform (a no-op on a shader with no whole-word TIME; the emitter is
        // additionally SpeedScale-frozen so its INSTANCE_CUSTOM-driven art holds).
        if (mode == EffectMode.Static)
        {
            mat.SetShaderParameter(ShaderStaticRewrite.StaticTimeUniform, StaticEmitterShaderTime);
        }

        if (_emitterMatCache.Count < MatCacheCap)
        {
            _emitterMatCache[key] = mat;
        }

        _emitterShaderKey = key;
        return mat;
    }

    // Apply the streamed material uniforms to the emitter ShaderMaterial: non-resource kinds via the shared binder;
    // a `::`-qualified sampler → the materialized CurveTexture/GradientTexture; a plain image sampler → TextureStore
    // (bound only if already cached, to keep the shared material immutable — no async mutation).
    private void ApplyEmitterUniforms(ShaderMaterial mat, IReadOnlyList<MirrorShaderParam>? parameters, string materialRef)
    {
        if (parameters is null)
        {
            return;
        }

        foreach (var p in parameters)
        {
            switch (ShaderUniformBinder.TryBindNonResource(mat, p))
            {
                case ShaderUniformBindResult.Resource:
                    BindEmitterSampler(mat, p, materialRef);
                    break;
                case ShaderUniformBindResult.Unsupported:
                    NoticeEmitter($"kind:{p.Kind}",
                        $"PARTICLES: unsupported emitter uniform kind '{p.Kind}' for '{p.Name}' — skipped.");
                    break;
            }
        }
    }

    private void BindEmitterSampler(ShaderMaterial mat, MirrorShaderParam p, string materialRef)
    {
        if (p.ResourcePath is null)
        {
            return; // inline procedural sampler → Godot uses the shader default
        }

        int sep = p.ResourcePath.IndexOf("::", System.StringComparison.Ordinal);
        if (sep >= 0)
        {
            string matPath = p.ResourcePath[..sep];
            string subId = p.ResourcePath[(sep + 2)..];
            if (matPath == materialRef && MaterialSamplerStore.Instance is { } store
                && store.GetSamplerTexture(materialRef, subId) is { } tex)
            {
                mat.SetShaderParameter(p.Name, tex);
                return;
            }

            NoticeEmitter($"sampler:{p.ResourcePath}",
                $"PARTICLES: emitter sampler '{p.Name}' → unresolved sub-resource '{p.ResourcePath}' — shader default.");
            return;
        }

        // A plain image-path sampler (e.g. the power-applied panning `mask` = power_applied_noise_mask.png): warm the
        // TextureStore, but bind only if the page is ALREADY cached so the shared immutable material is never mutated by
        // a late async arrival. With EmitterSamplerFix ON the shader is not mounted until EmitterImageSamplersReady()
        // confirms these pages are cached (ApplyEmitterShader gate), so construction here binds the real mask instead of
        // its hint_default_white default — the fix that keeps the power-applied flash from painting a white square.
        if (ShaderResourceParser.IsImagePath(p.ResourcePath) && _shaderCtx is not null)
        {
            string relUrl = SceneDeltaReader.MirrorResourceUrl(p.ResourcePath);
            if (RasterTextureUrl.NeedsRasterFormat(p.ResourcePath))
            {
                relUrl = RasterTextureUrl.For(relUrl);
            }

            var tex = _shaderCtx.Textures.Request(relUrl, static _ => { });
            if (tex is not null)
            {
                mat.SetShaderParameter(p.Name, tex);
            }
            else
            {
                NoticeEmitter($"img:{p.ResourcePath}",
                    $"PARTICLES: emitter image sampler '{p.Name}' not yet cached — shader default (no async mutation of a shared material).");
            }
        }
    }

    // A stable value-signature over the streamed material uniforms (the emitter-material sharing key's param part).
    private static string ParamSignature(IReadOnlyList<MirrorShaderParam>? ps)
    {
        if (ps is null || ps.Count == 0)
        {
            return "n";
        }

        var inv = System.Globalization.CultureInfo.InvariantCulture;
        var sb = new System.Text.StringBuilder(128);
        void D(double d) => sb.Append(d.ToString("R", inv)).Append(',');
        foreach (var p in ps)
        {
            sb.Append(p.Name).Append(':').Append(p.Kind).Append('=');
            if (p.Number is { } n) { D(n); }
            else if (p.Bool is { } b) { sb.Append(b ? '1' : '0'); }
            else if (p.ResourcePath is { } rp) { sb.Append(rp); }
            else if (p.String is { } s) { sb.Append(s); }
            else if (p.Color is { } c) { D(c.R); D(c.G); D(c.B); D(c.A); }
            else if (p.Vector2 is { } v2) { D(v2.X); D(v2.Y); }
            else if (p.Vector3 is { } v3) { D(v3.X); D(v3.Y); D(v3.Z); }
            else if (p.Vector4 is { } v4) { D(v4.X); D(v4.Y); D(v4.Z); D(v4.W); }
            else if (p.Rect2 is { } r) { D(r.X); D(r.Y); D(r.Width); D(r.Height); }
            else if (p.Transform2D is { } t) { foreach (var x in t) { D(x); } }
            else if (p.NumberArray is { } na) { foreach (var x in na) { D(x); } }

            sb.Append('|');
        }

        return sb.ToString();
    }

    private static readonly HashSet<string> _emitterNoticed = new(System.StringComparer.Ordinal);

    private static void NoticeEmitter(string key, string message)
    {
        if (_emitterNoticed.Add(key))
        {
            GD.Print(message);
        }
    }

    // On-demand rendering: release the continuous registration when this emitter leaves the tree — teardown
    // (ParticleAttachment.Sync RemoveChild), a flip to Off, or a pool reset (ResetForPool frees children). Idempotent
    // via SetContinuous's guard; RemoveContinuous is underflow-guarded so ordering vs RenderActivity.Reset is safe.
    public override void _ExitTree() => SetContinuous(false);

    // Leak telemetry: count this layer's emitter as freed on ACTUAL deletion. NotificationPredelete fires exactly once
    // when the object is destroyed (immediate Free, deferred QueueFree, OR the owner view's pool-recycle free — the
    // DOMINANT path in combat, where a transient VFX's whole owner node is recycled rather than its spec dropped), and
    // NEVER on a reparent/RemoveChild (unlike _ExitTree, which over-counted). The Rebuild-path replacement emitter is
    // counted separately in FreeEmitter (the layer survives a rebuild, so its Predelete does not fire then).
    public override void _Notification(int what)
    {
        if (what == NotificationPredelete)
        {
            NoteEmitterFreed();
        }
    }

    private void SetContinuous(bool want)
    {
        if (want == _continuous)
        {
            return;
        }

        if (want)
        {
            RenderActivity.AddContinuous(RenderActivity.ContinuousCategory.Particle);
        }
        else
        {
            RenderActivity.RemoveContinuous(RenderActivity.ContinuousCategory.Particle);
        }

        _continuous = want;
    }

    // Track I: force the current emitter's SpeedScale to 0 (frozen art) and drop any continuous registration — used
    // when a rebuild produced a fresh live-speed emitter while the layer is already idle-suspended (the freeze-aware
    // tail of Configure), so the late emitter never advances or pins the stage until a real wake resumes it.
    private void PinSpeedScaleZero()
    {
        if (_gpu is not null)
        {
            _gpu.SpeedScale = 0f;
        }
        else if (_cpu is not null)
        {
            _cpu.SpeedScale = 0f;
        }

        SetContinuous(false);
    }

    // WS-perf3 continuous-render-node budget: (re)apply the current AmountRatio to the live emitter as
    // spec.AmountRatio * ContinuousBudget.Multiplier (clamped to the engine's 0..1 range). A cheap single-property set
    // — no rebuild, no continuous-registration change — so the emitter stays alive and animating while its live
    // particle count (and its additive overdraw) is throttled under load. Multiplier is 1 on the kill-switch-off path,
    // making this a no-op restatement of the built AmountRatio.
    private void ApplyBudgetAmountRatio(MirrorParticleSpec spec)
    {
        float ratio = System.Math.Clamp((float)spec.AmountRatio * ContinuousBudget.Multiplier, 0f, 1f);
        if (_gpu is not null)
        {
            _gpu.AmountRatio = ratio;
        }
        else if (_cpu is not null && PropNames(_cpu).Contains("amount_ratio"))
        {
            _cpu.Set("amount_ratio", ratio); // amount_ratio is engine-version-gated on CpuParticles2D (same guard as BuildCpu)
        }
    }

    // Track I: enroll this layer's owner view with the idle-suspend controller as a LATE-frozen particle, so the
    // controller's next wake resumes it even though it was frozen AFTER the one-shot sweep (idempotent controller-side).
    private void EnrollLateFrozen()
    {
        if (GetParent() is MirrorNodeView owner)
        {
            IdleSuspendController.EnrollLateFrozen(owner, IdleSuspendController.LateCategory.Particles);
        }
    }

    // Leak telemetry: note this layer's CURRENT emitter as freed. Called from _Notification(NotificationPredelete) —
    // the single accurate free site covering EVERY layer-death path (transient teardown, mode-flip-to-Off, AND the
    // dominant owner-view pool-recycle free), and never a reparent. With FreeEmitter counting the rebuild-replacement
    // emitters, created-minus-freed tracks the true live emitter-wrapper count over a soak.
    private void NoteEmitterFreed()
    {
        if (_gpu is not null)
        {
            LeakProbe.GpuEmitterFreed++;
        }
        else if (_cpu is not null)
        {
            LeakProbe.CpuEmitterFreed++;
        }
    }

    // Track I (idle-animation suspend): freeze/unfreeze the LIVE emitter without a ClientEffectSettings mode flip
    // (RefreshEffects is global + heavy). On: pin the emitter's SpeedScale to 0 (the GPU sim stops accruing/advancing
    // → the frozen quads hold, bit-identical to a Static warm) and drop the continuous registration (its per-frame
    // GPU sim was the sole alive source, so ContinuousCount can now fall to 0). Off: restore the emitter's BUILT
    // SpeedScale (Static built at 0; Dynamic at the streamed spec.SpeedScale) and re-reconcile the continuous
    // registration against the SAME predicate Configure uses (Dynamic && currently-emitting). Idempotent.
    public void SetSuspended(bool suspend)
    {
        if (suspend == _suspended)
        {
            return;
        }

        _suspended = suspend;

        if (suspend)
        {
            if (_gpu is not null)
            {
                _gpu.SpeedScale = 0f;
            }
            else if (_cpu is not null)
            {
                _cpu.SpeedScale = 0f;
            }

            SetContinuous(false);
        }
        else
        {
            float restore = _builtMode == EffectMode.Static ? 0f : (float)(_spec?.SpeedScale ?? 0.0);
            bool emitting;
            if (_gpu is not null)
            {
                _gpu.SpeedScale = restore;
                emitting = _gpu.Emitting;
            }
            else if (_cpu is not null)
            {
                _cpu.SpeedScale = restore;
                emitting = _cpu.Emitting;
            }
            else
            {
                emitting = false;
            }

            SetContinuous(_builtMode == EffectMode.Dynamic && emitting);
        }
    }

    private void Rebuild(MirrorParticleSpec spec, RenderContext ctx, EffectMode mode)
    {
        if (_gpu is not null)
        {
            RemoveChild(_gpu);
            FreeEmitter(_gpu);
            _gpu = null;
        }

        if (_cpu is not null)
        {
            RemoveChild(_cpu);
            FreeEmitter(_cpu);
            _cpu = null;
        }

        if (spec.Kind == "GPUParticles2D")
        {
            _gpu = BuildGpu(spec, mode);
            AddChild(_gpu);
        }
        else
        {
            _cpu = BuildCpu(spec, mode);
            AddChild(_cpu);
        }

        ApplyTexture(spec, ctx);
    }

    // WS-EFFECTS-NATIVE: in Static, warm the system once (Preprocess fast-forwards to a representative time so a
    // populated frame is drawn) then freeze it (SpeedScale=0 → the sim never advances → zero ongoing per-frame cost).
    // Dynamic uses the streamed Preprocess/SpeedScale verbatim.
    private static float StaticPreprocess(MirrorParticleSpec spec) =>
        (float)Math.Max(spec.Preprocess, 0.5 * Math.Max(0.0001, spec.Lifetime));

    // GPUParticles2D + a ParticleProcessMaterial (snake_case Set, Vector3 expansion). Inverse of DescribeGpu.
    private static GpuParticles2D BuildGpu(MirrorParticleSpec spec, EffectMode mode)
    {
        LeakProbe.GpuEmitter++;
        bool staticMode = mode == EffectMode.Static;
        var gpu = new GpuParticles2D
        {
            Amount = Math.Max(1, (int)Math.Round(spec.Amount)),
            AmountRatio = (float)spec.AmountRatio,
            Lifetime = (float)Math.Max(0.0001, spec.Lifetime),
            OneShot = spec.OneShot,
            Explosiveness = (float)spec.Explosiveness,
            Randomness = (float)spec.Randomness,
            Preprocess = staticMode ? StaticPreprocess(spec) : (float)spec.Preprocess,
            SpeedScale = staticMode ? 0f : (float)spec.SpeedScale,
            FixedFps = (int)spec.FixedFps,
            LocalCoords = spec.LocalCoords,
            DrawOrder = (GpuParticles2D.DrawOrderEnum)(int)spec.DrawOrder,
        };

        // Deterministic seed (matches the web sim / the inspector's fixed-or-hashed seed).
        var gprops = PropNames(gpu);
        if (gprops.Contains("use_fixed_seed"))
        {
            gpu.Set("use_fixed_seed", true);
        }

        if (gprops.Contains("seed"))
        {
            gpu.Set("seed", (long)spec.Seed);
        }

        gpu.ProcessMaterial = SharedProcessMaterial(spec);
        gpu.Material = SharedCanvasMaterial(spec);
        gpu.Texture = DefaultTexture(spec); // WS-PARTICLE defensive: never draw Godot's raw untextured quads (see DefaultTexture)
        return gpu;
    }

    // WS-PARTICLE defensive default: emitters must NEVER draw Godot's DEFAULT UNTEXTURED QUADS (solid white/tinted
    // squares — glitchy big squares on VFX whose texture is null, still in flight, or permanently failed). The
    // texture a freshly-BUILT emitter starts on:
    //   * spec has NO texture url + the soft-dot lever is on (#1) → gsw's SOFT ROUND DOT (web parity: an untextured
    //     particle system draws soft dots, not raw quads / nothing);
    //   * spec HAS a texture url → the 1x1 fully-transparent placeholder (SetTexture swaps in the real art on
    //     arrival; a missing/failed page never paints raw quads);
    //   * texfix kill switch OFF and no dot applies → null (pre-fix default-quad behavior, exact A/B).
    // One shared instance per fallback (emitters only read them; main-thread Build* is the only creator).
    private static ImageTexture? _transparentTex;
    private static ImageTexture? _softDotTex;

    private static Texture2D? DefaultTexture(MirrorParticleSpec spec)
    {
        if (string.IsNullOrEmpty(spec.TextureUrl))
        {
            return SoftDot();
        }

        return TransparentTex();
    }

    // A shared 1x1 fully-transparent ImageTexture (draws nothing).
    private static ImageTexture TransparentTex()
    {
        if (_transparentTex is null || !GodotObject.IsInstanceValid(_transparentTex))
        {
            var img = Image.CreateEmpty(1, 1, false, Image.Format.Rgba8);
            img.Fill(new Color(0f, 0f, 0f, 0f));
            _transparentTex = ImageTexture.CreateFromImage(img);
        }

        return _transparentTex;
    }

    // A shared 32x32 soft-round-dot ImageTexture (gsw untextured-particle parity; see ParticleTextureBuilders).
    private static ImageTexture SoftDot()
    {
        if (_softDotTex is null || !GodotObject.IsInstanceValid(_softDotTex))
        {
            _softDotTex = ParticleTextureBuilders.SoftDotTexture();
        }

        return _softDotTex;
    }

    // WS-PARTICLE-MATSHARE (descriptor-set fragmentation fix): the ParticleProcessMaterial's own uniforms are the
    // particle-process compute pipeline's SET 3 (MaterialUniforms) — keyed on the material RID. A GPU emitter's set-1/2
    // (per-particle buffers) free synchronously with the node, but the ProcessMaterial is a C# RefCounted whose RID —
    // and its set-3 descriptor set — outlives the emitter until the C# wrapper is GC'd. On a Mali device the .NET GC
    // lags far behind the ~300 transient VFX ProcessMaterials/min, so the set-3 wrappers (and their descriptor sets)
    // pile up until the Vulkan pool exhausts (VK_ERROR_FRAGMENTED_POOL / "Uniforms were never supplied for set (3)",
    // delayed-onset, non-recovering, clears on disconnect). Fix: SHARE one IMMUTABLE ProcessMaterial per distinct
    // material signature. Set 3 is keyed on the material RID, so N identical emitters share ONE set-3 uniform set that
    // is allocated ONCE and never freed while cached — the set-3 alloc/free churn (and its wrapper accumulation) is
    // eliminated. The material is truly immutable (BuildProcessMaterial only SETs at construction; texture, amount,
    // preprocess and speed_scale all live on the NODE, so the material key is mode/position/texture-INDEPENDENT).
    private static ParticleProcessMaterial BuildProcessMaterial(MirrorParticleSpec spec)
    {
        var ppm = new ParticleProcessMaterial();
        LeakProbe.ParticleProcMat++;
        var mprops = PropNames(ppm);
        void M(string name, Variant v)
        {
            if (mprops.Contains(name))
            {
                ppm.Set(name, v);
            }
        }

        M("lifetime_randomness", spec.LifetimeRandomness);
        M("emission_shape", (int)spec.EmissionShape);
        M("emission_shape_offset", V3(spec.EmissionOffset));
        M("emission_shape_scale", V3(spec.EmissionScale));
        M("emission_sphere_radius", spec.EmissionSphereRadius);
        M("emission_ring_radius", spec.EmissionRingRadius);
        M("emission_ring_inner_radius", spec.EmissionRingInnerRadius);
        M("emission_ring_height", spec.EmissionRingHeight);
        M("emission_box_extents", V3(spec.EmissionBoxExtents));
        M("direction", V3(spec.Direction));
        M("spread", spec.Spread);
        M("initial_velocity_min", spec.InitialVelocityMin);
        M("initial_velocity_max", spec.InitialVelocityMax);
        M("angle_min", spec.AngleMin);
        M("angle_max", spec.AngleMax);
        M("angular_velocity_min", spec.AngularVelocityMin);
        M("angular_velocity_max", spec.AngularVelocityMax);
        M("gravity", V3(spec.Gravity));
        M("linear_accel_min", spec.LinearAccelMin);
        M("linear_accel_max", spec.LinearAccelMax);
        M("radial_accel_min", spec.RadialAccelMin);
        M("radial_accel_max", spec.RadialAccelMax);
        M("tangential_accel_min", spec.TangentialAccelMin);
        M("tangential_accel_max", spec.TangentialAccelMax);
        M("damping_min", spec.DampingMin);
        M("damping_max", spec.DampingMax);
        M("particle_flag_damping_as_friction", spec.DampingAsFriction);
        M("orbit_velocity_min", spec.OrbitVelocityMin);
        M("orbit_velocity_max", spec.OrbitVelocityMax);
        M("scale_min", spec.ScaleMin);
        M("scale_max", spec.ScaleMax);
        M("hue_variation_min", spec.HueVariationMin);
        M("hue_variation_max", spec.HueVariationMax);
        M("particle_flag_align_y", spec.AlignY);
        M("color", BaseColor(spec.BaseColor));
        M("anim_speed_min", spec.AnimSpeedMin);
        M("anim_speed_max", spec.AnimSpeedMax);
        M("anim_offset_min", spec.AnimOffsetMin);
        M("anim_offset_max", spec.AnimOffsetMax);

        // Over-life ramps/curves: GPU wants TEXTURE-wrapped Gradient/Curve.
        if (spec.ColorRamp is { Count: > 0 } cr)
        {
            M("color_ramp", new GradientTexture1D { Gradient = BuildGradient(cr) });
        }

        if (spec.ColorInitialRamp is { Count: > 0 } cir)
        {
            M("color_initial_ramp", new GradientTexture1D { Gradient = BuildGradient(cir) });
        }

        if (spec.ScaleCurve is { Count: > 0 } sc)
        {
            M("scale_curve", new CurveTexture { Curve = BuildCurve(sc) });
        }

        if (spec.AlphaCurve is { Count: > 0 } ac)
        {
            M("alpha_curve", new CurveTexture { Curve = BuildCurve(ac) });
        }

        if (spec.HueCurve is { Count: > 0 } hc)
        {
            M("hue_variation_curve", new CurveTexture { Curve = BuildCurve(hc) });
        }

        return ppm;
    }

    // CpuParticles2D — every field lives on the NODE (no process material). Inverse of DescribeCpu, honoring the
    // name diffs: scale_amount_min/max, scale_amount_curve, emission_rect_extents, Vector2 gravity/direction,
    // damping_as_friction (no particle_flag_ prefix), bare Gradient/Curve.
    private static CpuParticles2D BuildCpu(MirrorParticleSpec spec, EffectMode mode)
    {
        LeakProbe.CpuEmitter++;
        bool staticMode = mode == EffectMode.Static;
        var cpu = new CpuParticles2D
        {
            Amount = Math.Max(1, (int)Math.Round(spec.Amount)),
            Lifetime = (float)Math.Max(0.0001, spec.Lifetime),
            OneShot = spec.OneShot,
            Explosiveness = (float)spec.Explosiveness,
            Randomness = (float)spec.Randomness,
            Preprocess = staticMode ? StaticPreprocess(spec) : (float)spec.Preprocess,
            SpeedScale = staticMode ? 0f : (float)spec.SpeedScale,
            FixedFps = (int)spec.FixedFps,
            LocalCoords = spec.LocalCoords,
            DrawOrder = (CpuParticles2D.DrawOrderEnum)(int)spec.DrawOrder,
            Color = BaseColor(spec.BaseColor),
        };

        var nprops = PropNames(cpu);
        void N(string name, Variant v)
        {
            if (nprops.Contains(name))
            {
                cpu.Set(name, v);
            }
        }

        if (nprops.Contains("use_fixed_seed"))
        {
            N("use_fixed_seed", true);
            N("seed", (long)spec.Seed);
        }

        N("amount_ratio", spec.AmountRatio);
        N("lifetime_randomness", spec.LifetimeRandomness);
        N("emission_shape", (int)spec.EmissionShape);
        N("emission_sphere_radius", spec.EmissionSphereRadius);
        N("emission_ring_radius", spec.EmissionRingRadius);
        N("emission_ring_inner_radius", spec.EmissionRingInnerRadius);
        N("emission_ring_height", spec.EmissionRingHeight);
        N("emission_rect_extents", V2(spec.EmissionBoxExtents));
        N("direction", V2(spec.Direction));
        N("spread", spec.Spread);
        N("initial_velocity_min", spec.InitialVelocityMin);
        N("initial_velocity_max", spec.InitialVelocityMax);
        N("angle_min", spec.AngleMin);
        N("angle_max", spec.AngleMax);
        N("angular_velocity_min", spec.AngularVelocityMin);
        N("angular_velocity_max", spec.AngularVelocityMax);
        N("gravity", V2(spec.Gravity));
        N("linear_accel_min", spec.LinearAccelMin);
        N("linear_accel_max", spec.LinearAccelMax);
        N("radial_accel_min", spec.RadialAccelMin);
        N("radial_accel_max", spec.RadialAccelMax);
        N("tangential_accel_min", spec.TangentialAccelMin);
        N("tangential_accel_max", spec.TangentialAccelMax);
        N("damping_min", spec.DampingMin);
        N("damping_max", spec.DampingMax);
        N("damping_as_friction", spec.DampingAsFriction);
        N("orbit_velocity_min", spec.OrbitVelocityMin);
        N("orbit_velocity_max", spec.OrbitVelocityMax);
        N("scale_amount_min", spec.ScaleMin);
        N("scale_amount_max", spec.ScaleMax);
        N("hue_variation_min", spec.HueVariationMin);
        N("hue_variation_max", spec.HueVariationMax);
        N("particle_flag_align_y", spec.AlignY);
        N("anim_speed_min", spec.AnimSpeedMin);
        N("anim_speed_max", spec.AnimSpeedMax);
        N("anim_offset_min", spec.AnimOffsetMin);
        N("anim_offset_max", spec.AnimOffsetMax);

        // Over-life ramps/curves: CPU wants BARE Gradient/Curve.
        if (spec.ColorRamp is { Count: > 0 } cr)
        {
            N("color_ramp", BuildGradient(cr));
        }

        if (spec.ColorInitialRamp is { Count: > 0 } cir)
        {
            N("color_initial_ramp", BuildGradient(cir));
        }

        if (spec.ScaleCurve is { Count: > 0 } sc)
        {
            N("scale_amount_curve", BuildCurve(sc));
        }

        // alpha_curve / hue_variation_curve are GPU-only on CPUParticles2D in Godot 4; the guard skips them if
        // absent (spec still carries them for the GPU path).
        if (spec.AlphaCurve is { Count: > 0 } ac)
        {
            N("alpha_curve", BuildCurve(ac));
        }

        if (spec.HueCurve is { Count: > 0 } hc)
        {
            N("hue_variation_curve", BuildCurve(hc));
        }

        cpu.Material = SharedCanvasMaterial(spec);
        cpu.Texture = DefaultTexture(spec); // WS-PARTICLE defensive: never draw Godot's raw untextured quads (see DefaultTexture)
        return cpu;
    }

    // Per-attachment CanvasItemMaterial: blend mode + particles flipbook. NEVER the shared BlendMaterials.
    private static CanvasItemMaterial BuildCanvasMaterial(MirrorParticleSpec spec)
    {
        LeakProbe.ParticleCanvasMat++;
        var cim = new CanvasItemMaterial
        {
            BlendMode = spec.BlendMode >= 1
                ? CanvasItemMaterial.BlendModeEnum.Add
                : CanvasItemMaterial.BlendModeEnum.Mix,
        };

        int h = Math.Max(1, (int)spec.Hframes);
        int v = Math.Max(1, (int)spec.Vframes);
        if (h > 1 || v > 1)
        {
            cim.ParticlesAnimation = true;
            cim.ParticlesAnimHFrames = h;
            cim.ParticlesAnimVFrames = v;
            cim.ParticlesAnimLoop = spec.AnimLoop;
        }

        return cim;
    }

    // WS-PARTICLE-MATSHARE caches — one immutable material per distinct MATERIAL signature, shared across every emitter
    // (main-thread only; freed + cleared on back-to-menu via ResetTotals). Keyed by a VALUE signature over ONLY the
    // material-relevant fields (never the node-level amount/lifetime/preprocess/speed_scale/texture/position/blend), so
    // the SAME VFX emitted at different positions or with a different texture shares ONE material — collapsing the
    // per-emitter set-3 (ProcessMaterial) descriptor-set churn that fragments Mali's pool. The cache holds the strong
    // ref, so a bounded set of materials persists for the session instead of ~300 transient wrappers/min piling up
    // undisposed until GC (the device leak). ProcMatShared/CanvasMatShared count reuses served (allocs avoided).
    private static readonly Dictionary<string, ParticleProcessMaterial> _procMatCache = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, CanvasItemMaterial> _canvasMatCache = new(StringComparer.Ordinal);
    private const int MatCacheCap = 512; // distinct signatures are dozens in a scene; a generous ceiling (then fall back to per-emitter)
    public static long ProcMatShared;
    public static long CanvasMatShared;

    // WS-B material-cache hardening (spec-only round): counts cap overflows — a FULL cache handing back a fresh
    // UN-CACHED material, i.e. the exact per-emitter descriptor/GC churn the cache exists to prevent, returning
    // for every signature past the cap. A long soak proving this stays 0 is what gates ever building the
    // (refcount-heavy) LRU eviction — see godot-client/docs/material-cache-eviction.md. One counter covers both
    // the proc and canvas caches (same cap mechanism, same failure mode).
    public static long MatCacheOverflow;

    private static ParticleProcessMaterial SharedProcessMaterial(MirrorParticleSpec spec)
    {
        string key = ProcessMaterialKey(spec);
        if (_procMatCache.TryGetValue(key, out var cached) && GodotObject.IsInstanceValid(cached))
        {
            ProcMatShared++;
            return cached;
        }

        var ppm = BuildProcessMaterial(spec);
        if (_procMatCache.Count < MatCacheCap)
        {
            _procMatCache[key] = ppm;
        }
        else
        {
            MatCacheOverflow++; // cap hit: this material lives (and GC-dies) per-emitter — the pre-cache hazard
        }

        return ppm;
    }

    private static CanvasItemMaterial SharedCanvasMaterial(MirrorParticleSpec spec)
    {
        int h = Math.Max(1, (int)spec.Hframes);
        int v = Math.Max(1, (int)spec.Vframes);
        int blend = spec.BlendMode >= 1 ? 1 : 0;
        string key = (h > 1 || v > 1) ? $"{blend}:{h}:{v}:{(spec.AnimLoop ? 1 : 0)}" : blend.ToString();
        if (_canvasMatCache.TryGetValue(key, out var cached) && GodotObject.IsInstanceValid(cached))
        {
            CanvasMatShared++;
            return cached;
        }

        var cim = BuildCanvasMaterial(spec);
        if (_canvasMatCache.Count < MatCacheCap)
        {
            _canvasMatCache[key] = cim;
        }
        else
        {
            MatCacheOverflow++; // cap hit: per-emitter fallback material (see the counter doc above)
        }

        return cim;
    }

    // The material signature: EXACTLY the fields BuildProcessMaterial reads (the ParticleProcessMaterial params +
    // ramps/curves), in a stable value form. LOCKSTEP INVARIANT with BuildProcessMaterial: a NEW material field added
    // there MUST be appended here too — otherwise two specs differing only in that field wrongly share a material.
    // Node-level fields (amount/lifetime/preprocess/speed_scale/texture/position/blend/flipbook/seed) are DELIBERATELY
    // excluded (they live on the node / the CanvasItemMaterial, not this material) so sharing is maximal. ScaleCurveX/Y
    // are excluded because BuildProcessMaterial does not consume them.
    private static string ProcessMaterialKey(MirrorParticleSpec s)
    {
        var sb = new System.Text.StringBuilder(256);
        var c = System.Globalization.CultureInfo.InvariantCulture;
        void D(double d) => sb.Append(d.ToString("R", c)).Append('|');
        void Bl(bool b) => sb.Append(b ? '1' : '0').Append('|');
        void L(IReadOnlyList<double>? l)
        {
            if (l is null) { sb.Append("n|"); return; }
            foreach (var x in l) { sb.Append(x.ToString("R", c)).Append(','); }
            sb.Append('|');
        }

        void Stops(IReadOnlyList<MirrorGradientStop>? st)
        {
            if (st is null) { sb.Append("n;"); return; }
            foreach (var g in st) { D(g.Offset); L(g.Color); }
            sb.Append(';');
        }

        void Pts(IReadOnlyList<MirrorCurvePoint>? p)
        {
            if (p is null) { sb.Append("n;"); return; }
            foreach (var q in p) { D(q.X); D(q.Y); }
            sb.Append(';');
        }

        D(s.LifetimeRandomness); D(s.EmissionShape);
        L(s.EmissionOffset); L(s.EmissionScale);
        D(s.EmissionSphereRadius); D(s.EmissionRingRadius); D(s.EmissionRingInnerRadius); D(s.EmissionRingHeight);
        L(s.EmissionBoxExtents); L(s.Direction); D(s.Spread);
        D(s.InitialVelocityMin); D(s.InitialVelocityMax); D(s.AngleMin); D(s.AngleMax);
        D(s.AngularVelocityMin); D(s.AngularVelocityMax); L(s.Gravity);
        D(s.LinearAccelMin); D(s.LinearAccelMax); D(s.RadialAccelMin); D(s.RadialAccelMax);
        D(s.TangentialAccelMin); D(s.TangentialAccelMax); D(s.DampingMin); D(s.DampingMax); Bl(s.DampingAsFriction);
        D(s.OrbitVelocityMin); D(s.OrbitVelocityMax); D(s.ScaleMin); D(s.ScaleMax);
        D(s.HueVariationMin); D(s.HueVariationMax); Bl(s.AlignY); L(s.BaseColor);
        D(s.AnimSpeedMin); D(s.AnimSpeedMax); D(s.AnimOffsetMin); D(s.AnimOffsetMax);
        Stops(s.ColorRamp); Stops(s.ColorInitialRamp);
        Pts(s.ScaleCurve); Pts(s.AlphaCurve); Pts(s.HueCurve);
        return sb.ToString();
    }

    // Release the cached materials deterministically (drop the C# strong ref now — the RID + its set-3 descriptor set
    // free once the last emitter ref also drops, instead of lingering to GC) and empty the maps. Called on back-to-menu.
    private static void ClearMatCaches()
    {
        foreach (var m in _procMatCache.Values)
        {
            if (GodotObject.IsInstanceValid(m)) { m.Dispose(); }
        }

        foreach (var m in _canvasMatCache.Values)
        {
            if (GodotObject.IsInstanceValid(m)) { m.Dispose(); }
        }

        _procMatCache.Clear();
        _canvasMatCache.Clear();
        ProcMatShared = 0;
        CanvasMatShared = 0;
        MatCacheOverflow = 0;

        // WS-EMITTER: dispose the signature-shared emitter ShaderMaterials (drop the C# strong ref now — the RID + its
        // descriptor sets free for the rebuilt stack instead of lingering to GC), then empty the map.
        foreach (var m in _emitterMatCache.Values)
        {
            if (GodotObject.IsInstanceValid(m))
            {
                m.Dispose();
                LeakProbe.EmitterShaderMatFreed++;
            }
        }

        _emitterMatCache.Clear();
        EmitterShaderMatShared = 0;
        _emitterNoticed.Clear();

        // WS-PARTICLE: drop the luminance-alpha texture cache with the session (entries holding the ORIGINAL
        // store texture are just references; converted ones free with the dictionary — dispose is the store's
        // concern only for its own pages, so no explicit Dispose here beyond dropping the refs).
        _lumaCache.Clear();
    }

    // The particle texture is the node's own Texture2D (spec.TextureUrl), fetched via the shared decode-once cache.
    private void ApplyTexture(MirrorParticleSpec spec, RenderContext ctx)
    {
        _texCtx = ctx; // captured for a possible #1 luma raster refetch (ArmLumaRasterRefetch)
        _lumaRasterFor = null; // a fresh texture request → clear any prior raster-refetch dedup
        _wantTexUrl = spec.TextureUrl;
        if (_wantTexUrl is null)
        {
            return;
        }

        // WS-PARTICLE texfix: a NON-IMAGE texture path (an AtlasTexture `.tres` — the IntentParticle case) can
        // never decode from the raw route (it returns `[gd_resource]` text). Request the raster-qualified variant
        // (`?format=png`, a DISTINCT TextureStore/disk-cache key) so the host serves the cropped-region PNG.
        // _wantTexUrl carries the QUALIFIED url so the SetTexture in-flight guard compares like with like.
        if (RasterTextureUrl.NeedsRasterFormat(_wantTexUrl))
        {
            _wantTexUrl = RasterTextureUrl.For(_wantTexUrl);
        }

        var captured = _wantTexUrl;
        var cached = ctx.Textures.Request(captured, tex => SetTexture(captured, tex));
        if (cached is not null)
        {
            SetTexture(captured, cached);
        }
    }

    private void SetTexture(string url, Texture2D tex)
    {
        if (!GodotObject.IsInstanceValid(this) || url != _wantTexUrl)
        {
            return; // torn down or rebuilt onto a different spec while the fetch was in flight
        }

        ApplyToEmitter(ResolveLumaTexture(url, tex, allowRasterRefetch: true));
    }

    private void ApplyToEmitter(Texture2D tex)
    {
        if (_gpu is not null)
        {
            _gpu.Texture = tex;
        }
        else if (_cpu is not null)
        {
            _cpu.Texture = tex;
        }
    }

    // The texture to PAINT for a fetched particle page. WS-PARTICLE fix 2 (energy-counter static square): a no-alpha
    // grayscale VFX page (the game's additive "common glow" family, authored for a grayscale particle shader we
    // can't run) would paint as an OPAQUE quad — swap in a synthesized luminance-alpha variant (converted once per
    // url). WS-EMITTER: when this emitter's OWN grayscale shader is mounted (_lumaSuppressed), the shader derives
    // coverage itself — feed it the RAW page, not the luma variant.
    //
    // #1 fix (a): an UNDECODABLE page (compressed — e.g. an ASTC page the CPU can't unpack — so its alpha can't be
    // inspected) must NEVER keep the opaque original. Instead refetch the raster (?format=png) variant and luma-
    // convert THAT (allowRasterRefetch), painting a TRANSPARENT placeholder until it arrives; if even the raster is
    // undecodable it's a PERMANENT failure → the soft dot (#1 fix (b), web parity) rather than a square.
    private Texture2D ResolveLumaTexture(string url, Texture2D tex, bool allowRasterRefetch)
    {
        if (_lumaSuppressed)
        {
            return tex;
        }

        if (_lumaCache.TryGetValue(url, out var cached) && GodotObject.IsInstanceValid(cached))
        {
            return cached;
        }

        var converted = TryLumaConvert(url, tex);
        if (converted is not null)
        {
            CacheLuma(url, converted);
            return converted;
        }

        // Undecodable page — never the opaque original. Refetch the raster variant to luma-convert (transparent
        // meanwhile). If no refetch is possible here — no ctx, the url is already raster-qualified, or this arrival
        // IS the raster refetch and it's STILL undecodable — it's a permanent failure → the soft dot (web parity).
        if (allowRasterRefetch && ArmLumaRasterRefetch(url))
        {
            return TransparentTex();
        }

        var fallback = (Texture2D)SoftDot();
        CacheLuma(url, fallback);
        return fallback;
    }

    // Arm a ONE-SHOT raster (?format=png) refetch of an undecodable page's url, luma-converted on arrival. Returns
    // false when no refetch is possible (no captured ctx, or the url is already raster-qualified → would re-fail).
    private bool ArmLumaRasterRefetch(string originalUrl)
    {
        if (_texCtx is null)
        {
            return false;
        }

        var rasterUrl = RasterTextureUrl.For(originalUrl);
        if (string.Equals(rasterUrl, originalUrl, StringComparison.Ordinal))
        {
            return false; // already `?format=png` — nowhere further to escalate (bounded)
        }

        if (string.Equals(_lumaRasterFor, originalUrl, StringComparison.Ordinal))
        {
            return true; // refetch already in flight for this url
        }

        _lumaRasterFor = originalUrl;
        var captured = originalUrl;
        var cachedRaster = _texCtx.Textures.Request(rasterUrl, rtex => OnLumaRasterArrived(captured, rtex));
        if (cachedRaster is not null)
        {
            OnLumaRasterArrived(captured, cachedRaster);
        }

        return true;
    }

    private void OnLumaRasterArrived(string originalUrl, Texture2D rtex)
    {
        // Drop the arrival if the emitter moved to another texture while the raster was in flight.
        if (!GodotObject.IsInstanceValid(this) || originalUrl != _wantTexUrl)
        {
            return;
        }

        // Convert the raster page; NO further refetch (bounded to one). Undecodable even here → permanent → dot.
        ApplyToEmitter(ResolveLumaTexture(originalUrl, rtex, allowRasterRefetch: false));
    }

    // ---- WS-PARTICLE luminance-alpha synthesis (COUCHCOOP_MIRROR_PARTICLE_LUMA) --------------------------------
    // Per-url decision cache: the value is the texture EMITTERS SHOULD USE — the original reference when the page
    // carries alpha (no work to redo), or the converted luminance-alpha ImageTexture when it doesn't. Main-thread
    // only (SetTexture runs there). Capped like the material caches; cleared on back-to-menu via ResetTotals →
    // ClearMatCaches so a stale converted page can't outlive a session's TextureStore.
    private static readonly Dictionary<string, Texture2D> _lumaCache = new(StringComparer.Ordinal);

    private static void CacheLuma(string url, Texture2D tex)
    {
        if (_lumaCache.Count < MatCacheCap)
        {
            _lumaCache[url] = tex;
        }
    }

    // Convert a fetched particle page into the texture emitters should paint: the ORIGINAL when it already carries
    // alpha (no work), a synthesized luminance-alpha (alpha = max(r,g,b)) variant when it's a no-alpha grayscale
    // page, or NULL when the page is UNDECODABLE (GetImage null, or compressed and the CPU can't Decompress it — e.g.
    // an ASTC page). Returning null lets the caller refetch a raster variant / fall to the soft dot rather than
    // keeping the opaque original (#1 fix a). A conversion EXCEPTION falls back to the raw page (rare; never a dot).
    private static Texture2D? TryLumaConvert(string url, Texture2D tex)
    {
        try
        {
            var img = tex.GetImage(); // one-time CPU readback per DISTINCT particle texture url
            if (img is null)
            {
                return null; // can't inspect → caller refetches / falls to a dot (never the opaque original)
            }

            if (img.IsCompressed() && img.Decompress() != Error.Ok)
            {
                return null; // can't unpack (e.g. an ASTC page) → undecodable; never keep the opaque original
            }

            if (img.GetFormat() != Image.Format.Rgba8)
            {
                img.Convert(Image.Format.Rgba8); // covers the Tex16 RGB565 pack + grayscale L uploads
            }

            if (img.DetectAlpha() != Image.AlphaMode.None)
            {
                return tex; // already carries alpha — no work
            }

            // The store uploads mipmapped pages; GetData() would return base+mips concatenated and the no-mips
            // CreateFromData below would reject the oversized buffer. Convert the BASE level only and regenerate mips.
            if (img.HasMipmaps())
            {
                img.ClearMipmaps();
            }

            var data = img.GetData();
            for (int i = 0; i < data.Length; i += 4)
            {
                byte r = data[i];
                byte g = data[i + 1];
                byte b = data[i + 2];
                data[i + 3] = Math.Max(r, Math.Max(g, b)); // coverage = luminance (white art on black bg)
            }

            var converted = Image.CreateFromData(img.GetWidth(), img.GetHeight(), false, Image.Format.Rgba8, data);
            if (converted is null)
            {
                return tex;
            }

            converted.GenerateMipmaps(); // best effort — parity with the store's decode path

            var up = ImageTexture.CreateFromImage(converted);
            if (up is not null)
            {
                GD.Print($"PARTICLES: luma-alpha synthesized for {url}"); // once per url (decode-once contract)
                return up;
            }

            return tex;
        }
        catch (Exception e)
        {
            GD.PrintErr($"PARTICLES: luma-alpha convert failed for {url}: {e.Message} — using the raw page");
            return tex;
        }
    }

    // ---- builders / helpers ---------------------------------------------------------------------------------

    private static Vector3 V3(IReadOnlyList<double> v) =>
        new((float)(v.Count > 0 ? v[0] : 0), (float)(v.Count > 1 ? v[1] : 0), 0f); // z=0 (inspector flattened Vector3→Vector2)

    private static Vector2 V2(IReadOnlyList<double> v) =>
        new((float)(v.Count > 0 ? v[0] : 0), (float)(v.Count > 1 ? v[1] : 0));

    private static Color BaseColor(IReadOnlyList<double> c) =>
        new(
            (float)(c.Count > 0 ? c[0] : 1),
            (float)(c.Count > 1 ? c[1] : 1),
            (float)(c.Count > 2 ? c[2] : 1),
            (float)(c.Count > 3 ? c[3] : 1));

    // Over-life ramps/curves build through the shared ParticleTextureBuilders (the SAME logic the emitter-shader
    // sampler path reuses; flat tangents here — the streamed spec carries no tangents).
    private static Gradient BuildGradient(IReadOnlyList<MirrorGradientStop> stops) =>
        ParticleTextureBuilders.BuildGradient(stops);

    private static Curve BuildCurve(IReadOnlyList<MirrorCurvePoint> points) =>
        ParticleTextureBuilders.BuildCurve(points);

    private static HashSet<string> PropNames(GodotObject o)
    {
        // Cache by class: the property-NAME set is identical for every default instance of these engine classes, so the
        // marshalled GetPropertyList() runs once per class rather than once per Build*. The returned set is READ-ONLY
        // to callers (only `.Contains`), so sharing the single cached instance is safe.
        var type = o.GetType();
        if (_propNameCache.TryGetValue(type, out var cached))
        {
            return cached;
        }

        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in o.GetPropertyList())
        {
            if (entry.TryGetValue("name", out var n))
            {
                set.Add(n.AsString());
            }
        }

        _propNameCache[type] = set;
        return set;
    }

    // Deterministic release of a replaced emitter: immediate Free() (kill switch ON) drops the emitter + its
    // ParticleProcessMaterial/CanvasItemMaterial + Gradient/Curve textures — and therefore their Vulkan uniform/
    // descriptor sets — THIS frame, instead of piling up until the deferred QueueFree idle pass (a rebuild burst
    // otherwise exhausts Mali's finite descriptor pool). RemoveChild has already detached it, so an immediate Free is
    // safe (same pattern as SceneReconciler's view.Free() teardown and IntentPlayer/CosmeticAnimator ticker.Free()).
    // Kill switch =0 restores the original deferred QueueFree.
    private static void FreeEmitter(Node emitter)
    {
        // Leak telemetry: count the replaced-emitter free so created-minus-freed tracks the live wrapper count.
        if (emitter is GpuParticles2D)
        {
            LeakProbe.GpuEmitterFreed++;
        }
        else if (emitter is CpuParticles2D)
        {
            LeakProbe.CpuEmitterFreed++;
        }

        emitter.Free();
    }

    // WS-PARTICLE-REUSE: would BuildGpu/BuildCpu produce a bit-identical emitter for `a` as the one already built from
    // `b`? True ⇒ reuse the live emitter (no descriptor-set churn). The record's auto Equals compares its LIST members
    // (ramps/curves/vectors) by REFERENCE, so it can't be used directly across a keyframe re-parse; deep-compare those
    // members here, then normalize a's list refs (+ the volatile Emitting) to b's so the generated Equals compares only
    // the ~55 SCALAR fields by value (auto-covering current + future scalars). LOCKSTEP INVARIANT: every list member
    // normalized in the `with` MUST also be deep-compared below. Adding a NEW list field to NEITHER fails SAFE
    // (record-eq ref-compares it → a keyframe re-parse ⇒ not-equal ⇒ rebuild); adding to the `with` but not the deep
    // compare would silently ignore it (stale) — so keep them in step.
    private static bool SameBuild(MirrorParticleSpec a, MirrorParticleSpec b)
    {
        if (!ListEq(a.EmissionOffset, b.EmissionOffset)
            || !ListEq(a.EmissionScale, b.EmissionScale)
            || !ListEq(a.EmissionBoxExtents, b.EmissionBoxExtents)
            || !ListEq(a.Direction, b.Direction)
            || !ListEq(a.Gravity, b.Gravity)
            || !ListEq(a.BaseColor, b.BaseColor)
            || !StopsEq(a.ColorRamp, b.ColorRamp)
            || !StopsEq(a.ColorInitialRamp, b.ColorInitialRamp)
            || !PointsEq(a.ScaleCurve, b.ScaleCurve)
            || !PointsEq(a.ScaleCurveX, b.ScaleCurveX)
            || !PointsEq(a.ScaleCurveY, b.ScaleCurveY)
            || !PointsEq(a.AlphaCurve, b.AlphaCurve)
            || !PointsEq(a.HueCurve, b.HueCurve))
        {
            return false;
        }

        var an = a with
        {
            Emitting = b.Emitting,
            EmissionOffset = b.EmissionOffset,
            EmissionScale = b.EmissionScale,
            EmissionBoxExtents = b.EmissionBoxExtents,
            Direction = b.Direction,
            Gravity = b.Gravity,
            BaseColor = b.BaseColor,
            ColorRamp = b.ColorRamp,
            ColorInitialRamp = b.ColorInitialRamp,
            ScaleCurve = b.ScaleCurve,
            ScaleCurveX = b.ScaleCurveX,
            ScaleCurveY = b.ScaleCurveY,
            AlphaCurve = b.AlphaCurve,
            HueCurve = b.HueCurve,
        };
        return an.Equals(b);
    }

    private static bool ListEq(IReadOnlyList<double>? a, IReadOnlyList<double>? b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a is null || b is null || a.Count != b.Count)
        {
            return false;
        }

        for (int i = 0; i < a.Count; i++)
        {
            if (a[i] != b[i])
            {
                return false;
            }
        }

        return true;
    }

    private static bool StopsEq(IReadOnlyList<MirrorGradientStop>? a, IReadOnlyList<MirrorGradientStop>? b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a is null || b is null || a.Count != b.Count)
        {
            return false;
        }

        for (int i = 0; i < a.Count; i++)
        {
            if (a[i].Offset != b[i].Offset || !ListEq(a[i].Color, b[i].Color))
            {
                return false;
            }
        }

        return true;
    }

    private static bool PointsEq(IReadOnlyList<MirrorCurvePoint>? a, IReadOnlyList<MirrorCurvePoint>? b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a is null || b is null || a.Count != b.Count)
        {
            return false;
        }

        for (int i = 0; i < a.Count; i++)
        {
            if (a[i].X != b[i].X || a[i].Y != b[i].Y)
            {
                return false;
            }
        }

        return true;
    }
}
