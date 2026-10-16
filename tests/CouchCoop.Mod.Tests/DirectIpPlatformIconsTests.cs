using System.Xml;
using System.Xml.Linq;
using CouchCoop.Mod.HostUi;

internal static class DirectIpPlatformIconsTests
{
    public static void Run()
    {
        var mapping = new Dictionary<string, string[]>
        {
            ["iphone"] = ["apple.svg"], ["android"] = ["android.svg"],
            ["windows"] = ["windows.svg"], ["macos"] = ["apple.svg"],
            ["linux"] = ["linux.svg", "firefox-browser.svg"],
        };
        var assembly = typeof(DirectIpPlatformIcons).Assembly;
        var bundled = assembly.GetManifestResourceNames()
            .Where(name => name.StartsWith(DirectIpPlatformIcons.ResourcePrefix, StringComparison.Ordinal)).ToHashSet();
        var expected = mapping.Values.SelectMany(value => value)
            .Select(name => DirectIpPlatformIcons.ResourcePrefix + name).ToHashSet();
        Check(bundled.SetEquals(expected), "The release assembly bundles exactly the five platform SVGs");
        foreach (var (platform, names) in mapping)
        {
            var resources = DirectIpPlatformIcons.ResourceNamesFor(platform);
            Check(resources.SequenceEqual(names.Select(name => DirectIpPlatformIcons.ResourcePrefix + name)),
                $"{platform} resolves to its expected symbols");
            var edge = resources.Count == 1 ? DirectIpPlatformIcons.SingleEdge : DirectIpPlatformIcons.PairedEdge;
            Check(resources.Count * edge + (resources.Count - 1) * DirectIpPlatformIcons.PairGap <= DirectIpPlatformIcons.AreaWidth,
                "Single and paired symbols stay inside the fixed icon area");
            Check(edge <= DirectIpPlatformIcons.AreaHeight, "Symbols do not extend above or below the caption area");
        }
        foreach (var name in bundled)
        {
            using var stream = assembly.GetManifestResourceStream(name)!;
            using var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            var document = XDocument.Load(reader);
            var root = document.Root!;
            XNamespace svg = "http://www.w3.org/2000/svg";
            Check(root.Name == svg + "svg" && root.Attribute("viewBox") is not null, "Each resource is a scalable SVG");
            Check(root.Elements(svg + "path").Any(), "Each platform resource has actual artwork");
            Check(root.Descendants().All(element => element.Name == svg + "path"), "Artwork contains no external images or executable elements");
            Check(root.DescendantsAndSelf().Attributes().All(attribute => attribute.Name.LocalName is not "href" && !attribute.Name.LocalName.StartsWith("on", StringComparison.Ordinal)),
                "Platform artwork never requests external resources or event handlers");
            Check(document.DescendantNodes().OfType<XComment>().Any(comment => comment.Value.Contains("Font Awesome Free 6.7.2", StringComparison.Ordinal)),
                "Bundled originals retain Font Awesome attribution and pinned version");
        }
        try { DirectIpPlatformIcons.ResourceNamesFor("unknown"); throw new InvalidOperationException("Unknown platform unexpectedly accepted"); }
        catch (ArgumentOutOfRangeException) { }
        Console.WriteLine("DirectIpPlatformIconsTests: ok (five embedded SVGs, platform mappings, paired bounds, attribution)");
    }

    private static void Check(bool condition, string reason)
    {
        if (!condition) throw new InvalidOperationException("DirectIpPlatformIconsTests: " + reason);
    }
}
