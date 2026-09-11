// M1d effect seam — REAL shader attachment (WS-H). For a shader node (MirrorNode.ShaderId set, not a particle) it:
//   1. starts the ShaderStore fetch/compile once, and on async MOUNT re-runs the node's full Apply pipeline (the
//      "re-apply trick") so PaintGates + MaterialResolver re-evaluate — the compiled shader's base now paints and
//      its per-view ShaderMaterial is chosen — WITHOUT editing the frozen MirrorNodeView.
//   2. builds ONE ShaderMaterial per VIEW off the shared compiled Shader (EnsureMaterial, called by MaterialResolver
//      BEFORE this Sync so the material is live at draw time) and applies the material's authored `.tres` defaults +
//      the streamed uniforms.
//
// KEEP-LAST-ON-NULL (high-risk): a volatile-only upsert usually carries ShaderParams=null → UNCHANGED, never a
// reset (SceneTreeApplier drops ShaderParams on merge). So the last non-null param list is cached per view and the
// ShaderMaterial retains previously-set uniforms; only a fresh material or a new (non-null) param list re-applies.
// Uniforms not named keep their `.tres`/source defaults.

using System.Collections.Generic;
using System.Runtime.CompilerServices;
using CouchCoop.GodotClient.Scene;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Effects;

public static class ShaderAttachment
{
    // WS-EFFECTS-NATIVE: the representative TIME the "Static" mode pins (seconds). Matches the web STATIC_SHADER_TIME
    // (frontend/src/render/renderOptions.ts) so a frozen shader lands on the same phase on both clients.
    private const float StaticShaderTime = 1.0f;

    // Per-view shader state. GC'd with the view (ConditionalWeakTable), so freed views self-evict.
    private sealed class ViewShaderData
    {
        public ShaderMaterial? Material;            // per-view material off the shared compiled Shader
        public string? MaterialShaderId;            // the shaderId Material was built for
        public EffectMode MaterialMode;             // the effect mode Material was built for (rebuild on a mode flip)
        public bool MaterialFresh;                  // created this Apply → Sync applies defaults + params, then clears
        public string? RequestedShaderId;           // fetch registered for this shaderId (fire re-apply once)
        public IReadOnlyList<MirrorShaderParam>? LastParams; // keep-last-on-null
        public bool Continuous;                     // on-demand: this view holds a RenderActivity continuous registration (Dynamic + animating shader)
        public bool Suspended;                      // Track I: true while idle-suspended (Shader swapped to the TIME-frozen Static variant + continuous dropped)
        public bool MaterialShared;                 // SHADERMATSHARE: Material is a cache-owned SHARED instance (never Dispose it here, never mutate its per-view uniforms)
    }

    private static readonly ConditionalWeakTable<MirrorNodeView, ViewShaderData> Views = new();

    // One-time notices, keyed so each distinct situation logs once (non-image sampler refs, unsupported kinds).
    private static readonly HashSet<string> Noticed = new(System.StringComparer.Ordinal);

    // Long-session ShaderMaterial accumulation control:
    //   1. SHARE one immutable ShaderMaterial per (shaderId, mode) across every view that streams NO per-view uniforms
    //      (node.ShaderParams / cached LastParams both null) — those materials are FULLY determined by the shaderId +
    //      mode (compiled Shader + .tres defaults + the Static-time pin are identical), so one cached instance is
    //      safely shared by many CanvasItems (exactly like the particle MATSHARE CanvasItemMaterial). A view that
    //      LATER receives streamed uniforms copy-on-writes to a private material in EnsureMaterial (BEFORE Sync applies
    //      them), so the shared instance is never mutated per-view.
    //   2. DETERMINISTIC DISPOSE the PRIVATE materials the moment they are replaced (shaderId/mode change), cleared
    //      (Off / screen-read fallback) or pool-recycled (ResetView) — the RID frees now instead of waiting for the
    //      lagging .NET GC (the on-device accumulation). Shared materials are cache-owned and freed only on back-to-menu.
    // ShaderMaterials get per-view live param updates (ApplyParams / static-time pinning), so naive whole-population
    // sharing is UNSAFE; this shares only the provably-immutable subset and disposes the rest.
    // Shared immutable ShaderMaterials, one per (shaderId, mode). Holds the strong ref (freed on back-to-menu via
    // ResetCaches), main-thread only. A generous cap then falls back to a private material — distinct (shaderId,mode)
    // pairs in a scene are a handful, so the cap is never hit in practice.
    private static readonly Dictionary<string, ShaderMaterial> SharedMats = new(System.StringComparer.Ordinal);
    private const int SharedMatCap = 256;

    // WS-B material-cache hardening (spec-only round): counts cap overflows — a share-eligible view forced onto a
    // fresh PRIVATE material because SharedMats is full (per-view alloc churn returns for every signature past the
    // cap). A long soak proving this stays 0 is what gates ever building the (refcount-heavy) LRU eviction — see
    // godot-client/docs/material-cache-eviction.md. Reset with the cache in ResetCaches.
    public static long SharedMatOverflow;

    // WS-P1 pool linchpin. Called from MirrorNodeView.ResetForPool when a view is recycled: drop the per-view entry
    // (Material / MaterialShaderId / MaterialFresh / RequestedShaderId / LastParams). A pooled view is still a valid
    // GodotObject, so the ConditionalWeakTable would NOT auto-evict it — the stale LastParams (keep-last-on-null)
    // would then poison the NEXT node's material, and the stale RequestedShaderId would suppress the re-fetch. The
    // next tenant lazily rebuilds a fresh ViewShaderData on its first Sync.
    public static void ResetView(MirrorNodeView view)
    {
        if (Views.TryGetValue(view, out var data))
        {
            // On-demand rendering: release this view's continuous registration before dropping the entry, or the
            // recycled view's live-shader count would leak (never decremented) and pin the stage alive forever.
            if (data.Continuous)
            {
                RenderActivity.RemoveContinuous(RenderActivity.ContinuousCategory.Shader);
            }

            // SHADERMATSHARE: deterministically free this view's PRIVATE material now (the recycled view drops its
            // reference; without this the wrapper + its RID lingered until GC — the long-session accumulation). A
            // shared material is cache-owned, so only null the reference here.
            DisposePrivateMaterial(data);
        }

        Views.Remove(view);
    }

    // SHADERMATSHARE: free `data.Material` iff it is a PRIVATE (non-shared) instance, then null the reference. A shared
    // material stays alive in the cache (other views + a future rebuild reuse it; ResetCaches frees it on back-to-menu).
    private static void DisposePrivateMaterial(ViewShaderData data)
    {
        if (data.Material is null)
        {
            return;
        }

        if (!data.MaterialShared && GodotObject.IsInstanceValid(data.Material))
        {
            data.Material.Dispose();
            LeakProbe.ShaderMatFreed++;
        }

        data.Material = null;
        data.MaterialShared = false;
    }

    // Back-to-menu (AppShell alongside LeakProbe.ResetTotals): drop the shared-material cache, disposing each instance
    // so its RID frees for the rebuilt stack. The per-view ViewShaderData entries GC with their (freed) views.
    public static void ResetCaches()
    {
        foreach (var m in SharedMats.Values)
        {
            if (GodotObject.IsInstanceValid(m))
            {
                m.Dispose();
            }
        }

        SharedMats.Clear();
        SharedMatOverflow = 0;
    }

    // Track I (idle-animation suspend): freeze/unfreeze this view's animating shader IN PLACE, with NO
    // ClientEffectSettings mode flip (that fires the global, heavy RefreshEffects). Returns true iff it acted.
    //   suspend on : only an actually-continuous shader (Dynamic + mounted material + animating source) is frozen —
    //     swap data.Material.Shader to the compiled TIME-frozen Static variant (all real set-uniforms persist on the
    //     same ShaderMaterial; PeekShader(Static) transparently serves the dynamic shader for a screen-read-only
    //     shader with no TIME to freeze), pin couch_static_time, and drop the continuous registration so
    //     ContinuousCount can fall to 0.
    //   suspend off: swap the dynamic Shader back (the extra static-time uniform is ignored by the dynamic shader) and
    //     re-add the continuous registration per the SAME predicate Sync uses.
    // Ships the IN-PLACE Shader swap path (verified: SetShaderParameter values persist across a Shader reassignment on
    // the same ShaderMaterial), NOT a material rebuild.
    public static bool SetSuspended(MirrorNodeView view, bool suspend)
    {
        if (!Views.TryGetValue(view, out var data) || suspend == data.Suspended)
        {
            return false;
        }

        if (suspend)
        {
            // Freeze an already-continuous shader or a mounted live-animating shader that has not registered yet.
            if (!(data.Continuous || IsAnimatingLive(data)))
            {
                return false; // not a live animating shader — nothing to freeze
            }

            var frozen = ShaderStore.PeekShader(data.MaterialShaderId!, EffectMode.Static);
            if (frozen is not null)
            {
                data.Material!.Shader = frozen;
                data.Material.SetShaderParameter(ShaderStaticRewrite.StaticTimeUniform, Time.GetTicksMsec() / 1000f);
            }

            if (data.Continuous)
            {
                RenderActivity.RemoveContinuous(RenderActivity.ContinuousCategory.Shader);
                data.Continuous = false;
            }

            data.Suspended = true;
            return true;
        }

        if (data.Material is not null && data.MaterialShaderId is not null
            && ShaderStore.PeekShader(data.MaterialShaderId, EffectMode.Dynamic) is { } dynamic)
        {
            data.Material.Shader = dynamic;
        }

        data.Suspended = false;
        if (IsAnimatingLive(data) && !data.Continuous)
        {
            RenderActivity.AddContinuous(RenderActivity.ContinuousCategory.Shader);
            data.Continuous = true;
        }

        return true;
    }

    // The "this view's shader would force on-demand rendering alive" predicate: a mounted per-view material built in
    // Dynamic mode off an animating source. Screen-read shaders never mount, so they cannot register as continuous.
    // Shared by SetSuspended (freeze/resume) and Sync (continuous reconcile).
    private static bool IsAnimatingLive(ViewShaderData data) =>
        data.Material is not null
        && data.MaterialShaderId is not null
        && data.MaterialMode == EffectMode.Dynamic
        && ShaderStore.PeekAnimates(data.MaterialShaderId);

    // Track-P static bake: seed a bake CLONE's per-view shader state from its LIVE view BEFORE clone.Apply. A fresh
    // clone has no cached params, so its material would apply only the .tres defaults; copying the live view's
    // keep-last-on-null LastParams makes the clone's freshly-built material apply the SAME streamed uniforms → the
    // static-baked shader output matches the live one (at the Static-mode frozen TIME pin). No-op when the live view
    // has no shader entry / no cached params. The controller calls this for every baked ShaderId node.
    public static void SeedCloneParams(MirrorNodeView clone, MirrorNodeView live)
    {
        if (!Views.TryGetValue(live, out var liveData) || liveData.LastParams is null)
        {
            return;
        }

        var data = Views.GetValue(clone, static _ => new ViewShaderData());
        data.LastParams = liveData.LastParams;
    }

    // Called by MaterialResolver (Apply step 3, no ctx): returns this view's ShaderMaterial when the node's shader is
    // MOUNTED (and it isn't a particle node), else null so the caller falls back to the blend material. Creates the
    // per-view material lazily off the shared compiled Shader; uniforms are applied in Sync (step 5, which has ctx).
    public static ShaderMaterial? EnsureMaterial(MirrorNodeView view, MirrorNode node)
    {
        // WS-EFFECTS-NATIVE: Off suppresses the ShaderMaterial entirely (the caller falls back to the blend material;
        // PaintGates paints the base as final art). Treated like a non-shader node here so the per-view material is
        // dropped and rebuilt when the mode flips back.
        var mode = ClientEffectSettings.ShaderMode;
        if (node.ShaderId is null || node.ParticleSpec is not null || mode == EffectMode.Off)
        {
            if (Views.TryGetValue(view, out var cleared))
            {
                DisposePrivateMaterial(cleared); // SHADERMATSHARE: free the private material now (shared = de-ref only)
                cleared.MaterialShaderId = null;
            }

            return null;
        }

        if (ShaderStore.PeekState(node.ShaderId) != ShaderState.Mounted)
        {
            return null;
        }

        // WS-SHADER: a screen-read shader (dark_blur scrim, overlay_blend, …) samples the framebuffer, which is
        // undefined natively (no BackBufferCopy → white on Mali). Never mount its ShaderMaterial: PaintGates
        // suppresses the raw base and ScrimDrawer approximates dark_blur. Clearing any prior material also keeps an
        // unrenderable shader from pinning the on-demand stage awake.
        if (ShaderStore.PeekScreenReads(node.ShaderId))
        {
            if (Views.TryGetValue(view, out var srCleared))
            {
                DisposePrivateMaterial(srCleared); // SHADERMATSHARE: free the private material now (shared = de-ref only)
                srCleared.MaterialShaderId = null;
            }

            return null;
        }

        // WS-ADDBAKE: a static-bake region clone of an Add-blend shader renders the bake-add premul variant (a
        // separate compiled Shader with blend_add → blend_premul_alpha + the fold epilogue). The material is PRIVATE
        // (never shared / never published to SharedMats) — it belongs to a throwaway region clone freed with its
        // viewport. Only a rewritable Add carrier reaches here (PeekBakeAddOk); an un-rewritable one is never baked.
        bool useBakeAdd = view.IsStaticBakeClone && ShaderStore.PeekBakeAddOk(node.ShaderId);
        var shader = useBakeAdd ? ShaderStore.PeekBakeAddShader(node.ShaderId) : ShaderStore.PeekShader(node.ShaderId, mode);
        if (shader is null)
        {
            return null; // race: state Mounted but shader not yet stashed (shouldn't happen — defensive)
        }

        var data = Views.GetValue(view, static _ => new ViewShaderData());

        // SHADERMATSHARE: a view that streams NO per-view uniforms (this upsert's ShaderParams null AND none cached)
        // is fully determined by (shaderId, mode) → it can safely share one immutable cached material; a view WITH
        // uniforms needs a private material (Sync mutates it per-view). node.ShaderParams is THIS upsert's list;
        // data.LastParams is the keep-last cache from PRIOR upserts (Sync updates it AFTER this step, so here it still
        // reflects the past). ShareEnabled=0 forces wantShared false → the pre-fix per-view `new ShaderMaterial`. A
        // bake-add clone is ALWAYS private (its shader differs from the shared (shaderId, mode) instance).
        bool wantShared = !useBakeAdd && node.ShaderParams is null && data.LastParams is null;

        bool rebuild = data.Material is null
            || data.MaterialShaderId != node.ShaderId
            || data.MaterialMode != mode
            || (data.MaterialShared && !wantShared); // copy-on-write: a shared view just gained per-view uniforms

        if (rebuild)
        {
            DisposePrivateMaterial(data); // frees the outgoing PRIVATE material NOW (a shared one is only de-referenced)

            ShaderMaterial mat;
            bool shared = false;
            bool fresh;
            string key = SharedKey(node.ShaderId, mode);
            if (wantShared && SharedMats.TryGetValue(key, out var cached) && GodotObject.IsInstanceValid(cached))
            {
                mat = cached;          // the cached instance already carries its .tres defaults + static-time pin
                shared = true;
                fresh = false;
                LeakProbe.ShaderMatShared++;
            }
            else
            {
                mat = new ShaderMaterial { Shader = shader };
                LeakProbe.ShaderMat++;
                fresh = true;
                if (wantShared && SharedMats.Count < SharedMatCap)
                {
                    SharedMats[key] = mat; // publish for the next immutable view of this (shaderId, mode)
                    shared = true;
                }
                else if (wantShared)
                {
                    SharedMatOverflow++; // cap hit: a share-eligible view falls back to a private material
                }
            }

            data.Material = mat;
            data.MaterialShared = shared;
            data.MaterialShaderId = node.ShaderId;
            data.MaterialMode = mode;
            data.MaterialFresh = fresh;
        }

        return data.Material;
    }

    // SHADERMATSHARE shared-cache key: distinct compiled Shader per (shaderId, mode), so those two fully identify the
    // immutable material (defaults + static-time are shaderId-derived, identical across views).
    private static string SharedKey(string shaderId, EffectMode mode) => shaderId + "|" + (int)mode;

    // Called by MirrorNodeView.Apply (step 5, has ctx). Starts the fetch, arms the async re-apply, and applies the
    // node's uniforms to the per-view material.
    public static void Sync(MirrorNodeView view, MirrorNode node, RenderContext ctx)
    {
        // WS-P2 gate: a node with no shader fields (no ShaderId, no ShaderParams) and no existing per-view entry is
        // not (and never was) a shader node — return BEFORE the ConditionalWeakTable create, which would otherwise
        // stamp an empty entry onto every non-shader view. A node that already HAS an entry (a shader that lost its
        // id) still proceeds so the teardown path (EnsureMaterial cleared Material; this returns after) is unchanged.
        if (node.ShaderId is null && node.ShaderParams is null && !Views.TryGetValue(view, out _))
        {
            return;
        }

        var data = Views.GetValue(view, static _ => new ViewShaderData());

        // keep-last-on-null: only a non-null param list updates the cache (null = unchanged).
        if (node.ShaderParams is not null)
        {
            data.LastParams = node.ShaderParams;
        }

        // Track I: is this view's shader category currently frozen by the idle-suspend controller? While it is, a LATE
        // Sync — an async shader-compile / sampler-texture mount re-Apply that did NOT ride a store drain, so the
        // controller never woke — must NOT resume the shader or add a continuous registration. That un-noticed re-Apply
        // resuming/re-registering behind the controller's back is the on-device gap where renderStageContinuous crept
        // back up (18) while idleSuspended stayed true. Instead it registers SUSPENDED + enrolls for the next wake.
        bool categoryFrozen = IdleSuspend.Suspended;

        // Track I defensive self-resume — now CONSULTS the controller. A Sync reaching a still-suspended view resumes
        // ONLY if the controller is NOT frozen (a genuine wake already happened and the sweep missed this view). If it
        // IS still frozen, stay suspended — never resume behind the controller's back (was unconditional pre-fix).
        if (data.Suspended && !categoryFrozen)
        {
            if (data.Material is not null && node.ShaderId is not null
                && ShaderStore.PeekShader(node.ShaderId, EffectMode.Dynamic) is { } dyn)
            {
                data.Material.Shader = dyn;
            }

            data.Suspended = false;
        }

        // On-demand rendering: reconcile the continuous registration. EnsureMaterial (Apply step 3, just above this
        // step-5 Sync) has already set/cleared data.Material + MaterialMode for the CURRENT mode, so this reads the
        // live truth: force-alive iff a mounted material exists, its built mode is Dynamic, and the shader source
        // animates (TIME / screen read). A mount, a Dynamic↔Static/Off flip (RefreshEffects re-Applies), or a shader
        // loss all flow through here and add/remove exactly once. RemoveContinuous is underflow-guarded.
        // WS-SHADER: a screen-read shader (which EnsureMaterial already refuses to mount ⇒ data.Material null ⇒ this
        // is false anyway) must never pin on-demand rendering — an unrenderable shader has no reason to keep the
        // stage awake. The explicit guard makes that invariant hold even if the material path changes.
        bool wantContinuous = data.Material is not null
            && data.MaterialMode == EffectMode.Dynamic
            && node.ShaderId is not null
            && ShaderStore.PeekAnimates(node.ShaderId);

        if (wantContinuous && categoryFrozen)
        {
            // Track I: a late animating shader arriving while the controller is suspended. Register in the SUSPENDED
            // state — freeze the Shader to its TIME-frozen Static variant IN PLACE (bit-identical idle frame) and keep
            // continuous at 0 — then enroll with the controller so its next wake resumes this view. Never pins the
            // stage: this is the fix for the residual-continuous device gap. (data.Material here is Dynamic + animating;
            // if it happens to be a SHARED immutable material, every co-sharing view is animating + suspended together,
            // so the in-place Shader swap is consistent for all of them — see IsAnimatingLive/SetSuspended.)
            if (data.Continuous)
            {
                RenderActivity.RemoveContinuous(RenderActivity.ContinuousCategory.Shader);
                data.Continuous = false;
            }

            if (!data.Suspended && data.Material is not null && data.MaterialShaderId is not null)
            {
                var frozen = ShaderStore.PeekShader(data.MaterialShaderId, EffectMode.Static);
                if (frozen is not null)
                {
                    data.Material.Shader = frozen;
                    data.Material.SetShaderParameter(ShaderStaticRewrite.StaticTimeUniform, Time.GetTicksMsec() / 1000f);
                }

                data.Suspended = true;
            }

            IdleSuspendController.EnrollLateFrozen(view, IdleSuspendController.LateCategory.Shaders);
        }
        else if (wantContinuous != data.Continuous)
        {
            if (wantContinuous)
            {
                RenderActivity.AddContinuous(RenderActivity.ContinuousCategory.Shader);
            }
            else
            {
                RenderActivity.RemoveContinuous(RenderActivity.ContinuousCategory.Shader);
            }

            data.Continuous = wantContinuous;
        }

        if (node.ShaderId is null || node.ParticleSpec is not null)
        {
            return; // not a shader node (or a particle — particles own their material via ParticleAttachment)
        }

        // Start the fetch once per shaderId; on MOUNT re-run the full pipeline so the gates + material re-evaluate.
        if (data.RequestedShaderId != node.ShaderId)
        {
            data.RequestedShaderId = node.ShaderId;

            // WS-P1: capture the view's Generation at request time. A pooled+recycled view is STILL IsInstanceValid,
            // so the old guard would fire this stale callback and NRE on the reset view's nulled NodeData /
            // StreamedLocal. Comparing Generation drops any callback armed under a prior tenure. (The captured ctx is
            // this tenure's ctx — safe to use only when the generation still matches.)
            int gen = view.Generation;
            ShaderStore.For(view).Request(node.ShaderId, () =>
            {
                if (GodotObject.IsInstanceValid(view) && view.Generation == gen)
                {
                    view.Apply(view.NodeData, view.StreamedLocal, ctx);
                }
            });
        }

        if (data.Material is null)
        {
            return; // shader not mounted yet (EnsureMaterial returned null) — nothing to write
        }

        // Apply defaults once on a fresh material, then the streamed uniforms. Skip when nothing changed this tick.
        bool apply = data.MaterialFresh || node.ShaderParams is not null;
        if (apply)
        {
            if (data.MaterialFresh)
            {
                var defaults = ShaderStore.PeekDefaults(node.ShaderId);
                if (defaults is not null)
                {
                    ApplyParams(view, data.Material, defaults, ctx);
                }

                // WS-EFFECTS-NATIVE: pin the frozen-TIME uniform for the Static variant. Harmless no-op on a shader
                // that had no whole-word TIME (PeekShader served the dynamic shader, which lacks this uniform) or in
                // Dynamic mode (Godot ignores an unknown uniform set). Set once per fresh material; it never appears
                // in streamed params, so ApplyParams never clobbers it.
                if (data.MaterialMode == EffectMode.Static)
                {
                    data.Material.SetShaderParameter(ShaderStaticRewrite.StaticTimeUniform, StaticShaderTime);
                }
            }

            if (data.LastParams is not null)
            {
                ApplyParams(view, data.Material, data.LastParams, ctx);
            }
        }

        data.MaterialFresh = false;
    }

    // Map each streamed/default param to a SetShaderParameter, by kind. Reused for both the material's authored
    // `.tres` defaults and the live streamed uniforms; unnamed uniforms keep their prior value / shader default.
    private static void ApplyParams(
        MirrorNodeView view, ShaderMaterial mat, IReadOnlyList<MirrorShaderParam> parameters, RenderContext ctx)
    {
        foreach (var p in parameters)
        {
            ApplyOne(view, mat, p, ctx);
        }
    }

    private static void ApplyOne(MirrorNodeView view, ShaderMaterial mat, MirrorShaderParam p, RenderContext ctx)
    {
        // Non-resource kinds bind through the shared ShaderUniformBinder (one mapping, also used by the emitter path);
        // the sampler ("resource") + unknown cases are view-specific and handled here.
        switch (ShaderUniformBinder.TryBindNonResource(mat, p))
        {
            case ShaderUniformBindResult.Resource:
                ApplyResource(view, mat, p, ctx);
                break;
            case ShaderUniformBindResult.Unsupported:
                Notice($"kind:{p.Kind}", $"SHADER: unsupported uniform kind '{p.Kind}' for '{p.Name}' — skipped.");
                break;
        }
    }

    // A sampler uniform. An image path → TextureStore (set on arrival + redraw); a `::`-qualified sub-resource or
    // an inline procedural sampler → keep the shader/.tres default + a one-time notice. A non-image atlas path is
    // fetched through the raster-qualified URL (`?format=png`), where the host crops it to PNG.
    private static void ApplyResource(MirrorNodeView view, ShaderMaterial mat, MirrorShaderParam p, RenderContext ctx)
    {
        if (p.ResourcePath is null)
        {
            return; // inline procedural sampler (no path) → Godot uses the shader default
        }

        if (p.ResourcePath.Contains("::"))
        {
            Notice($"res:{p.ResourcePath}",
                $"SHADER: sampler '{p.Name}' → non-image/sub-resource '{p.ResourcePath}' — keeping shader default.");
            return;
        }

        string relUrl = SceneDeltaReader.MirrorResourceUrl(p.ResourcePath);
        if (RasterTextureUrl.NeedsRasterFormat(p.ResourcePath))
        {
            relUrl = RasterTextureUrl.For(relUrl); // reachable only with the texfix ON (the guard above returned otherwise)
        }
        string name = p.Name;
        var tex = ctx.Textures.Request(relUrl, t =>
        {
            if (GodotObject.IsInstanceValid(view) && GodotObject.IsInstanceValid(mat))
            {
                mat.SetShaderParameter(name, t);
                RenderActivity.Mark(); // a shader sampler texture arrived asynchronously — render it in
                view.QueueRedraw();
            }
        });

        if (tex is not null)
        {
            mat.SetShaderParameter(name, tex);
        }
    }

    private static void Notice(string key, string message)
    {
        if (Noticed.Add(key))
        {
            GD.Print(message);
        }
    }
}
