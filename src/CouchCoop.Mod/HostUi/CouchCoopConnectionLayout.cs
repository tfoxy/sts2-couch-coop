using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>Fixed companion-card geometry for the QR dialog in the 1920×1080 design space.</summary>
internal static class CouchCoopConnectionLayout
{
    public const float Width = 420f;
    public const float Height = 936f;
    public const float Gap = 24f;
    public const float MainCardWidth = 1000f;
    public const float MainCardHeight = 936f;
    public const float TitleHeight = 48f;
    public const float Padding = 16f;

    /// <summary>Left edge when the unchanged QR card is centred at x=960.</summary>
    public const float Left = (1920f - MainCardWidth) / 2f - Gap - Width;
    public const float Top = (1080f - Height) / 2f;

    public static readonly Vector2 Size = new(Width, Height);
}
