// WS-EFFECTS-NATIVE. Device-local (RAM-only) effect-mode surface the render layer reads. NOT sent to the host — the
// user picks per-device how much per-frame effect cost to pay, exactly like the sibling client toggles (widescreen
// stretch, disk-asset-cache) that live in the SettingsPanel and never push to the coordinator.
//
//   Dynamic (default) : the real animated effect — the M1d behavior, unchanged.
//   Static            : render the effect's art FROZEN. Shaders compile a TIME-frozen variant
//                       (ShaderStaticRewrite); particles warm once then SpeedScale=0. This removes animation/simulation
//                       work, but the visible fragments/quads are still rasterized every rendered frame. Distinct
//                       from the host-side "Freeze particles/spines" CPU savers (those cut headless-HOST cost and are
//                       separate SettingsPanel toggles — untouched here).
//   Off               : don't render the effect at all (particles hidden; shaders fall back to base art).
//
// RenderScale is the native analog of the web client's render-resolution tiers. It is applied to the mirror stage
// through AppShell's SubViewportContainer; the UI chrome remains at the root viewport's full resolution.
//
// Pure C# (Godot-free): a plain static class, so PaintGates / ShaderAttachment / ParticleAttachment / SceneReconciler
// all read it without a Godot dependency, and the SettingsPanel OptionButtons are its sole writer. `Generation` bumps
// on any mode change; the reconciler POLLS it (like StageStretch polls the widescreen getter) and re-applies every
// live view so the effect attachments rebuild against the new mode — no server round-trip, no new refresh channel.

namespace CouchCoop.GodotClient.Scene;

public enum EffectMode
{
    Dynamic,
    Static,
    Off,
}

// R9 item 10. The manual SPINE override — deliberately its OWN enum, not the shared EffectMode above: spines have a
// meaningful "let the client decide" state (Auto) that shaders/particles do not, and overloading EffectMode would
// have added a 4th value to two unrelated OptionButtons + every switch that reads them.
//
//   Auto (default)    : today's native behavior verbatim — the full animated clip (native has no tier degrade; the
//                       WEB twin's Auto is tier-driven, which is why the value exists on both sides).
//   Dynamic           : same as Auto on native, but PINNED (a later Auto policy change can't move it).
//   Static            : request a single STILL frame (`&still=1`, the url shape SpineClipStore already builds for
//                       the first-frame-immediate chain) and paint it once — no animated fetch, no _Process advance.
//   Off               : don't attach a spine layer at all (SpineAttachment.Sync takes its teardown branch).
public enum SpineMode
{
    Auto,
    Dynamic,
    Static,
    Off,
}

public enum RenderScale
{
    Full = 1,
    Half = 2,
    Quarter = 4,
}

public static class ClientEffectSettings
{
    private static EffectMode _shaderMode = EffectMode.Dynamic;
    private static EffectMode _particleMode = EffectMode.Dynamic;
    private static SpineMode _spineMode = SpineMode.Auto;
    private static RenderScale _renderScale = RenderScale.Full;

    // Bumped whenever either mode changes. The reconciler compares this each frame (steady-state = one int compare)
    // and re-runs the full Apply pass on a change; the effect attachments also compare their built-at mode so a mode
    // flip rebuilds even though the streamed spec/shader reference is unchanged.
    public static int Generation { get; private set; }

    public static EffectMode ShaderMode
    {
        get => _shaderMode;
        set
        {
            if (_shaderMode != value)
            {
                _shaderMode = value;
                Generation++;
            }
        }
    }

    public static EffectMode ParticleMode
    {
        get => _particleMode;
        set
        {
            if (_particleMode != value)
            {
                _particleMode = value;
                Generation++;
            }
        }
    }

    // R9 item 10. Same Generation++ shape as the two effect modes: the reconciler polls Generation and re-Applies
    // every live view, and SpineLayer folds the resolved still-vs-animated answer into its CLIP IDENTITY, so a live
    // flip re-requests the other url (the streamed anim/skin/mat/skel are unchanged across a mode change).
    public static SpineMode SpineMode
    {
        get => _spineMode;
        set
        {
            if (_spineMode != value)
            {
                _spineMode = value;
                Generation++;
            }
        }
    }

    // The two resolved questions the render layer actually asks. Auto == Dynamic on native (no tier degrade here).
    // Kept next to the field so both clients' "what does this mode mean" answer lives in exactly one place per side
    // (web twin: isSpineClipNode / isSpineStillMode in spineAttributes.ts).
    public static bool SpineRenders => _spineMode != SpineMode.Off;

    public static bool SpineStillOnly => _spineMode == SpineMode.Static;

    public static RenderScale RenderScale
    {
        get => _renderScale;
        set
        {
            if (_renderScale != value)
            {
                _renderScale = value;
                Generation++;
            }
        }
    }
}
