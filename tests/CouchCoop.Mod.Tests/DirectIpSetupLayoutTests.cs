using CouchCoop.Mod.HostUi;

internal static class DirectIpSetupLayoutTests
{
    public static void Run()
    {
        foreach (var padding in new[] { 16f, 24f, 48f, 80f })
        {
            var geometry = DirectIpSetupLayout.Calculate(padding, CouchCoopModalDialog.DefaultDismissBottomInset);
            var regions = new[] { geometry.Title, geometry.Progress, geometry.Content, geometry.Back, geometry.Primary, geometry.Dismiss };
            foreach (var (width, height) in new[] { (1920f, 1080f), (1280f, 800f) })
            {
                var rendered = regions.Select(box => box.ToViewport(width, height)).ToArray();
                foreach (var box in rendered)
                    Check(box.X >= 0 && box.Y >= 0 && box.Right <= width && box.Bottom <= height,
                        $"Guide remains within {width}×{height} at padding {padding}");
                for (var i = 0; i < rendered.Length; i++)
                    for (var j = i + 1; j < rendered.Length; j++)
                        Check(!rendered[i].Intersects(rendered[j]), "Body, headings, and navigation must never overlap");
            }
            Check(geometry.Content.Height > 400, "Expanded details and long translations get a useful scroll viewport");
            foreach (var button in new[] { geometry.Back, geometry.Primary, geometry.Dismiss })
            {
                Check(button.Width == 300 && button.Height == 73, "Input rectangle matches artwork dimensions");
                Check(button.Contains(button.X + 150, button.Y + 36), "Button center activates");
                Check(!button.Contains(button.X - 1, button.Y + 36) && !button.Contains(button.Right + 1, button.Y + 36),
                    "Surrounding horizontal layout space does not activate");
                Check(!button.Contains(button.X + 150, button.Y - 1) && !button.Contains(button.X + 150, button.Bottom + 1),
                    "Surrounding vertical layout space does not activate");
            }
        }
        Check(DirectIpSetupLayout.ButtonWidth - 2 * DirectIpSetupLayout.ButtonPadding >= 250,
            "Two-line captions retain usable horizontal space");
        Check(DirectIpSetupLayout.ButtonTextHeight >= 2 * (DirectIpSetupLayout.ButtonFontSize + 4),
            "Two-line captions have enough height at their authored font size");
        Console.WriteLine("DirectIpSetupLayoutTests: ok (1920×1080 and 1280×800 bounds, footer separation, hit rectangles)");
    }

    private static void Check(bool value, string reason)
    {
        if (!value) throw new InvalidOperationException(reason);
    }
}
