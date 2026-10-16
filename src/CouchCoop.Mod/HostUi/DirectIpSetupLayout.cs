namespace CouchCoop.Mod.HostUi;

/// <summary>Shared by the native guide and engine-free bounds checks; all values use design coordinates.</summary>
internal static class DirectIpSetupLayout
{
    public const float CardWidth = 1400;
    public const float CardHeight = 960;
    public const float ButtonWidth = 300;
    public const float ButtonHeight = 73;
    public const float ButtonPadding = 24;
    public const float ButtonTextHeight = 56;
    public const int ButtonFontSize = 22;
    public const float ContentGap = 20;

    internal readonly record struct Box(float X, float Y, float Width, float Height)
    {
        public float Right => X + Width;
        public float Bottom => Y + Height;
        public bool Contains(float x, float y) => x >= X && x < Right && y >= Y && y < Bottom;
        public bool Intersects(Box other) => X < other.Right && Right > other.X && Y < other.Bottom && Bottom > other.Y;
        public Box ToViewport(float width, float height)
        {
            var scale = MathF.Min(width / 1920, height / 1080);
            return new((width - CardWidth * scale) / 2 + X * scale,
                (height - CardHeight * scale) / 2 + Y * scale, Width * scale, Height * scale);
        }
    }

    internal readonly record struct Geometry(Box Title, Box Progress, Box Content, Box Back, Box Primary, Box Dismiss);

    public static Geometry Calculate(float padding, float dismissBottomInset)
    {

        var width = CardWidth - padding * 2;
        var footerY = CardHeight - padding - ButtonHeight - dismissBottomInset;
        return new(new(padding, 24, width, 62), new(padding, 100, width, 72),
            new(padding, 192, width, footerY - 192 - 24),
            new(padding, footerY, ButtonWidth, ButtonHeight),
            new(CardWidth - padding - ButtonWidth, footerY, ButtonWidth, ButtonHeight),
            new((CardWidth - ButtonWidth) / 2, footerY, ButtonWidth, ButtonHeight));
    }
}
