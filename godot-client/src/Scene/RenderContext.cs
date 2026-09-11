// The per-render-stage context threaded through every MirrorNodeView.Apply and effect-attachment Sync. Built ONCE
// by SceneReconciler.Bind and passed by reference; the effect workstreams (WS-H shaders / WS-I spine+particles /
// WS-J tween+intent) read their asset stores + render options through it instead of reaching into globals.
//
//   Textures : the decode-once HTTP texture cache (shaders/particles/spine fetch their own resources through it or
//              their own stores, but the texture cache is the shared one already mounted by AppShell).
//   Store    : the retained MirrorState + GlobalTransformIndex (cosmetic anims read global positions for the wave
//              phase; the tween replayer reads global→parent-local endpoints; NEITHER mutates it — the index stays
//              streamed-truth for hit-testing).
//   Options  : render-mode toggles (see RenderOptions).
//   IdentityCache : memoized scene-identity + text-scale lookup. CosmeticAnimator's bob/spin scoping and
//              MirrorNodeView.SyncText use it instead of re-walking the parent chain and re-matching the text-scale
//              table on every Apply. SceneReconciler owns and invalidates it per drain.

using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.GodotClient.Scene;

public sealed record RenderContext(TextureStore Textures, MirrorStore Store, RenderOptions Options, SceneIdentityCache IdentityCache);

// Render-mode toggles decided at mount time by AppShell.
//   InstantTweens : true in --replay (deterministic single-shot: the final state must render with no in-flight
//                   animation, so the tween replayer snaps to endpoints instead of animating); false in --connect
//                   (live play animates the real Godot tweens).
//
// NOTE: the RUNTIME-mutable effect modes (Dynamic/Static/Off per WS-EFFECTS-NATIVE) do NOT live here — RenderOptions
// is immutable + built once at mount, whereas those flip live from the Settings panel. They live in the RAM-only
// ClientEffectSettings singleton (Scene/ClientEffectSettings.cs) the effect attachments + PaintGates read directly and
// the reconciler polls (SceneReconciler._Process) to force a re-apply, mirroring the widescreen toggle's poll path.
public sealed record RenderOptions(bool InstantTweens);
