using System;
using System.Collections.Generic;
using System.IO;
using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Bundled Font Awesome platform symbols. This helper depends only on Godot so a standalone
/// guide fixture can source-link it with the same manifest resource names. No runtime downloads.
/// </summary>
internal static class DirectIpPlatformIcons
{
    internal const string ResourcePrefix = "CouchCoop.Mod.HostUi.PlatformIcons.";
    internal const float AreaWidth = 48;
    internal const float AreaHeight = 32;
    internal const float SingleEdge = 32;
    internal const float PairedEdge = 22;
    internal const float PairGap = 4;
    private static readonly Dictionary<string, Texture2D?> Textures = new(StringComparer.Ordinal);

    internal static IReadOnlyList<string> ResourceNamesFor(string platformKey) => platformKey switch
    {
        "iphone" or "macos" => [ResourcePrefix + "apple.svg"],
        "android" => [ResourcePrefix + "android.svg"],
        "windows" => [ResourcePrefix + "windows.svg"],
        "linux" => [ResourcePrefix + "linux.svg", ResourcePrefix + "firefox-browser.svg"],
        _ => throw new ArgumentOutOfRangeException(nameof(platformKey), platformKey, "Unknown guide platform"),
    };

    public static Control Create(string platformKey)
    {
        var resources = ResourceNamesFor(platformKey);
        var area = new Control
        {
            Name = "PlatformIcon", MouseFilter = Control.MouseFilterEnum.Ignore,
            Size = new Vector2(AreaWidth, AreaHeight), CustomMinimumSize = new Vector2(AreaWidth, AreaHeight),
            FocusMode = Control.FocusModeEnum.None,
        };
        var edge = resources.Count == 1 ? SingleEdge : PairedEdge;
        var totalWidth = resources.Count * edge + (resources.Count - 1) * PairGap;
        for (var index = 0; index < resources.Count; index++)
        {
            area.AddChild(new TextureRect
            {
                Name = "Symbol" + index, MouseFilter = Control.MouseFilterEnum.Ignore,
                FocusMode = Control.FocusModeEnum.None,
                Position = new Vector2((AreaWidth - totalWidth) / 2 + index * (edge + PairGap), (AreaHeight - edge) / 2),
                Size = new Vector2(edge, edge), Texture = Load(resources[index]),
                ExpandMode = TextureRect.ExpandModeEnum.IgnoreSize,
                StretchMode = TextureRect.StretchModeEnum.KeepAspectCentered,
            });
        }
        return area;
    }

    private static Texture2D? Load(string resourceName)
    {
        if (Textures.TryGetValue(resourceName, out var cached)) return cached;
        Texture2D? texture = null;
        try
        {
            using var stream = typeof(DirectIpPlatformIcons).Assembly.GetManifestResourceStream(resourceName)
                ?? throw new InvalidOperationException("Missing embedded platform icon");
            using var reader = new StreamReader(stream);
            // Preserve the licensed originals on disk; tint their default black fill only for rendering.
            var svg = reader.ReadToEnd().Replace("<svg ", "<svg fill=\"#ffffff\" ", StringComparison.Ordinal);
            using var image = new Image();
            if (image.LoadSvgFromString(svg, 0.125f) != Error.Ok)
                throw new InvalidOperationException("Cannot decode embedded platform icon");
            texture = ImageTexture.CreateFromImage(image);
        }
        catch (Exception exception) when (exception is IOException or InvalidOperationException)
        {
            // The platform's text label remains usable if an engine cannot decode the optional symbol.
            GD.PushWarning($"CouchCoop platform icon unavailable: {resourceName} ({exception.GetType().Name})");
        }
        Textures[resourceName] = texture;
        return texture;
    }
}
