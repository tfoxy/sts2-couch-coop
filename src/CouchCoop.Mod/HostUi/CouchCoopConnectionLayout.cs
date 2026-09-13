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
    public const float InnerWidth = Width - Padding * 2;
    public const float ListHeight = Height - 60f - Padding;
    public const float ListWithDetailsHeight = 414f;
    public const float DetailTop = 486f;
    public const float SummaryHeight = 294f;
    public const float TechnicalToggleTop = 792f;
    public const float TechnicalTop = 704f;
    public const float TechnicalHeight = 132f;
    public const float ButtonTop = 844f;
    public const float FeedbackTop = 900f;

    // Opening the disclosure gives its space back by shortening the list, without moving the actions.
    public const float TechnicalExpansion = 132f;
    public static float ListHeightFor(bool hasIssue, bool technicalOpen) => !hasIssue ? ListHeight
        : ListWithDetailsHeight - (technicalOpen ? TechnicalExpansion : 0);
    public static float SummaryTopFor(bool technicalOpen) => DetailTop - (technicalOpen ? TechnicalExpansion : 0);
    public static float DisclosureTopFor(bool technicalOpen) => TechnicalToggleTop - (technicalOpen ? TechnicalExpansion : 0);

    /// <summary>Left edge when the unchanged QR card is centred at x=960.</summary>
    public const float Left = (1920f - MainCardWidth) / 2f - Gap - Width;
    public const float Top = (1080f - Height) / 2f;

    public static readonly Vector2 Size = new(Width, Height);
}
