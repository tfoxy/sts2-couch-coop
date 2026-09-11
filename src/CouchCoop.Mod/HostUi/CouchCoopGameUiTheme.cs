using Godot;
using CouchCoop.Mod.Localization;
using MegaCrit.Sts2.Core.Localization.Fonts;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Cached <c>res://</c> loads of the game art the couch-coop lobby UI borrows, plus the raw colour
/// constants copied out of the shipped scenes.
/// </summary>
/// <remarks>
/// <para>
/// Every load is wrapped and degrades to <see langword="null"/>. A game update that renames a texture
/// or a theme must NOT take the lobby down with it: the widgets check for null and fall back to a
/// flat <see cref="StyleBoxFlat"/> and Godot's default font, which is ugly but functional. That is the
/// whole reason this lives behind an accessor instead of being loaded inline at each use site.
/// </para>
/// <para>
/// Values are transcribed from the extracted scenes (<c>scenes/combat/ping_button.tscn</c>,
/// <c>scenes/ui/choice_selection_skip_button.tscn</c>, <c>scenes/ui/dropdown_item.tscn</c>) so the
/// injected controls read as part of the game rather than as a mod overlay. The scenes are the source
/// of truth, NOT <c>StsColors</c>: the skip button's cream is a scene one-off (#FDF4E3) that differs
/// from <c>StsColors.cream</c> (#FFF6E2), and copying the "obvious" constant would be subtly wrong.
/// </para>
/// </remarks>
internal static class CouchCoopGameUiTheme
{
    public const string EventButtonTexturePath = "res://images/packed/common_ui/event_button.png";
    public const string RewardSkipButtonTexturePath = "res://images/ui/reward_screen/reward_skip_button.png";
    public const string HsvShaderPath = "res://shaders/hsv.gdshader";
    public const string KreonBoldGlyphSpaceOnePath = "res://themes/kreon_bold_glyph_space_one.tres";
    public const string KreonBoldGlyphSpaceTwoPath = "res://themes/kreon_bold_glyph_space_two.tres";

    /// <summary>The hsv.gdshader uniform the game tweens for hover/press brightness. <c>1.0</c> is identity.</summary>
    public const string HsvValueParameter = "shader_parameter/v";

    // ---- ping_button.tscn (the "Couch Co-Op QR Code" button) -------------------------------------------
    public static Color ButtonFontColor { get; } = new(1f, 0.964706f, 0.886275f, 1f);
    public static Color ButtonShadowColor { get; } = new(0f, 0f, 0f, 0.188235f);
    public static Color ButtonOutlineColor { get; } = new(0.0756f, 0.12084f, 0.18f, 1f);
    public const int ButtonOutlineSize = 12;
    public const int ButtonShadowOffsetX = 3;
    public const int ButtonShadowOffsetY = 2;

    // ---- choice_selection_skip_button.tscn (the "Close QR Code" button) -------------------------------------
    public static Color SkipFontColor { get; } = new(0.992157f, 0.956863f, 0.890196f, 1f);
    public static Color SkipShadowColor { get; } = new(0f, 0f, 0f, 0.25098f);
    public static Color SkipOutlineColor { get; } = new(0.121569f, 0.25098f, 0.270588f, 1f);
    public const int SkipOutlineSize = 12;
    public const int SkipShadowOffsetX = 5;
    public const int SkipShadowOffsetY = 3;

    // ---- dropdown_item.tscn (the host-select rows) ----------------------------------------------------------
    public static Color DropdownFontColor { get; } = new(1f, 0.964706f, 0.886275f, 1f);
    public static Color DropdownShadowColor { get; } = new(0f, 0f, 0f, 0.12549f);
    public static Color DropdownHighlightColor { get; } = new(0.172549f, 0.345098f, 0.439216f, 1f);
    public const int DropdownShadowOffsetX = 3;
    public const int DropdownShadowOffsetY = 2;

    /// <summary>Colour NPingButton modulates its visuals to while held. Matches <c>Colors.DarkGray</c>.</summary>
    public static Color PressedModulate { get; } = new(0.663f, 0.663f, 0.663f, 1f);

    public static Texture2D? EventButtonTexture => _eventButtonTexture.Value;
    public static Texture2D? RewardSkipButtonTexture => _rewardSkipButtonTexture.Value;
    public static Shader? HsvShader => _hsvShader.Value;
    public static Font? KreonBoldGlyphSpaceOne => _kreonBoldGlyphSpaceOne.Value;
    public static Font? KreonBoldGlyphSpaceTwo => _kreonBoldGlyphSpaceTwo.Value;

    private static readonly DeferredResource<Texture2D> _eventButtonTexture = Deferred<Texture2D>(EventButtonTexturePath);
    private static readonly DeferredResource<Texture2D> _rewardSkipButtonTexture = Deferred<Texture2D>(RewardSkipButtonTexturePath);
    private static readonly DeferredResource<Shader> _hsvShader = Deferred<Shader>(HsvShaderPath);
    private static readonly DeferredResource<Font> _kreonBoldGlyphSpaceOne = Deferred<Font>(KreonBoldGlyphSpaceOnePath);
    private static readonly DeferredResource<Font> _kreonBoldGlyphSpaceTwo = Deferred<Font>(KreonBoldGlyphSpaceTwoPath);

    /// <summary>
    /// A fresh hsv ShaderMaterial, or <see langword="null"/> when the shader failed to load. Never
    /// shared: each button tweens its OWN <c>v</c> for hover/press, and the shipped scenes set
    /// <c>resource_local_to_scene</c> for exactly that reason — one cached instance would make every
    /// button light up together.
    /// </summary>
    public static ShaderMaterial? CreateHsvMaterial()
    {
        if (HsvShader is not { } shader)
        {
            return null;
        }

        var material = new ShaderMaterial { Shader = shader };
        material.SetShaderParameter("h", 1.0f);
        material.SetShaderParameter("s", 1.0f);
        material.SetShaderParameter("v", 1.0f);
        return material;
    }

    /// <summary>
    /// Flat chrome used wherever a game texture is unavailable, so a failed load still produces a
    /// visible, clickable control instead of an invisible one.
    /// </summary>
    public static StyleBoxFlat CreateFallbackStyle(Color background, Color border, int cornerRadius, int borderWidth)
    {
        var style = new StyleBoxFlat { BgColor = background, BorderColor = border, AntiAliasing = true };
        style.SetBorderWidthAll(borderWidth);
        style.SetCornerRadiusAll(cornerRadius);
        return style;
    }

    /// <summary>Applies a font override only when the font actually loaded (Godot's default is the fallback).</summary>
    public static void ApplyFont(Label label, Font? font, int fontSize)
    {
        ArgumentNullException.ThrowIfNull(label);
        var resolvedFont = ResolveBoldFont(font);
        if (resolvedFont is not null)
        {
            label.AddThemeFontOverride("font", resolvedFont);
        }

        label.AddThemeFontSizeOverride("font_size", fontSize);
    }

    /// <summary>
    /// <see cref="ApplyFont"/>'s twin for a <see cref="RichTextLabel"/>.
    /// </summary>
    /// <remarks>
    /// Separate method because the THEME ITEM NAMES differ: a <c>Label</c> reads <c>font</c> /
    /// <c>font_size</c>, a <c>RichTextLabel</c> reads <c>normal_font</c> / <c>normal_font_size</c> (plus
    /// <c>bold_font</c>, <c>italics_font</c>, … which this deliberately leaves to Godot's fallbacks). An
    /// override under the wrong name is silently ignored, so the text would simply render in the engine
    /// default and look like nothing had been applied at all.
    /// </remarks>
    public static void ApplyRichFont(RichTextLabel label, Font? font, int fontSize)
    {
        ArgumentNullException.ThrowIfNull(label);
        var resolvedFont = ResolveBoldFont(font);
        if (resolvedFont is not null)
        {
            label.AddThemeFontOverride("normal_font", resolvedFont);
        }

        label.AddThemeFontSizeOverride("normal_font_size", fontSize);
    }

    /// <summary>Locales outside Kreon's Latin coverage use the game's matching substitute bold font.</summary>
    private static Font? ResolveBoldFont(Font? fallback)
    {
        if (!ShouldUseLocaleFont(CouchCoopLocalization.Language))
        {
            return fallback;
        }

        try
        {
            return FontManager.GetSubstituteFont(CouchCoopLocalization.Language, FontType.Bold) ?? fallback;
        }
        catch
        {
            return fallback;
        }
    }

    internal static bool ShouldUseLocaleFont(string? language)
        => language?.ToLowerInvariant() is "zhs" or "jpn" or "kor" or "rus" or "tha";

    // Deferred so a headless/test process that never touches the lobby never loads any of it.
    private static DeferredResource<T> Deferred<T>(string path) where T : Resource => new(path);

    /// <summary>
    /// A lazily loaded theme resource that RELOADS itself if the engine frees what it cached.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This was a <see cref="Lazy{T}"/>, which caches for the life of the process. Loading a fixture over a
    /// live screen frees the resources these paths point at, and the cached managed wrapper then throws
    /// <c>ObjectDisposedException: Cannot access a disposed object. Object name: 'Godot.CompressedTexture2D'</c>
    /// on every later use. The host-panel scan rebuilds its panels from this theme four times a second, so
    /// one freed resource became a PERMANENT per-tick exception loop with no panel on screen for the rest
    /// of the process — surviving main-menu round trips, because the dead wrapper outlived every screen.
    /// </para>
    /// <para>
    /// Re-checking <see cref="GodotObject.IsInstanceValid"/> per read costs a pointer comparison and makes
    /// the cache self-healing. It matters for the FONTS as much as the textures: the activity panel is
    /// built entirely from fonts, so a font freed this way takes that panel down the same way.
    /// </para>
    /// </remarks>
    private sealed class DeferredResource<T>(string path) where T : Resource
    {
        private readonly object _gate = new();
        private T? _cached;

        public T? Value
        {
            get
            {
                lock (_gate)
                {
                    if (_cached is not null && GodotObject.IsInstanceValid(_cached))
                    {
                        return _cached;
                    }

                    if (_cached is not null)
                    {
                        Console.Error.WriteLine($"[couch-coop] host-ui theme resource was freed; reloading path={path}");
                        _cached = null;
                    }

                    _cached = Load();
                    return _cached;
                }
            }
        }

        // ResourceLoader.Load prints its own engine error and returns null for a missing path; the catch is
        // for the rarer managed failures (a .tres that parses but fails to instantiate, a disposed loader
        // during shutdown).
        private T? Load()
        {
            try
            {
                return ResourceLoader.Load<T>(path);
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(
                    $"[couch-coop] host-ui theme load failed path={path} detail={exception.GetType().Name}: {exception.Message}");
                return null;
            }
        }
    }
}
