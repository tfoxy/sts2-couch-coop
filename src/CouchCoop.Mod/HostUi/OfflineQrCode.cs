using QRCoder;

namespace CouchCoop.Mod.HostUi;

public sealed class OfflineQrCode
{
    public const int DefaultQuietZoneModules = 4;
    private readonly bool[] _darkModules;

    private OfflineQrCode(string payload, int size, int quietZoneModules, bool[] darkModules)
    {
        Payload = payload;
        Size = size;
        QuietZone = quietZoneModules;
        _darkModules = darkModules;
    }

    public string Payload { get; }
    public int Size { get; }
    public int Width => Size;
    public int Height => Size;
    public int QuietZone { get; }

    public static OfflineQrCode EncodeJoinUrl(Uri joinBaseUri, int quietZoneModules = DefaultQuietZoneModules)
    {
        ArgumentNullException.ThrowIfNull(joinBaseUri);
        if (quietZoneModules < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(quietZoneModules), "Quiet zone modules must be non-negative.");
        }

        if (joinBaseUri.Scheme is not ("http" or "https"))
        {
            throw new ArgumentException("The QR join URL must use http or https.", nameof(joinBaseUri));
        }

        if (!joinBaseUri.IsAbsoluteUri)
        {
            throw new ArgumentException("The QR join URL must be absolute.", nameof(joinBaseUri));
        }

        var payload = NormalizePayload(joinBaseUri);
        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(payload, QRCodeGenerator.ECCLevel.Q);
        var sourceSize = data.ModuleMatrix.Count;
        var size = sourceSize + (quietZoneModules * 2);
        var modules = new bool[size * size];

        for (var y = 0; y < sourceSize; y++)
        {
            var sourceRow = data.ModuleMatrix[y];
            for (var x = 0; x < sourceSize; x++)
            {
                if (sourceRow[x])
                {
                    modules[(y + quietZoneModules) * size + x + quietZoneModules] = true;
                }
            }
        }

        return new OfflineQrCode(payload, size, quietZoneModules, modules);
    }

    public bool IsDark(int x, int y)
    {
        if ((uint)x >= (uint)Size || (uint)y >= (uint)Size)
        {
            throw new ArgumentOutOfRangeException($"QR module coordinate ({x}, {y}) is outside {Size}x{Size}.");
        }

        return _darkModules[(y * Size) + x];
    }

    /// <summary>
    /// Query keys that MAY survive into a scanned payload. Everything else is stripped.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The strip is a real safety property, not tidying: this QR is shown on a TV to a room full of people,
    /// and a stray <c>?name=</c> picked up from wherever the URL was built would hand every scanner the
    /// same seat. Default-deny keeps that impossible no matter what a future caller passes in.
    /// </para>
    /// <para>
    /// <c>h</c> is the one exception, and it is load-bearing: the "web link" option encodes a PUBLIC origin
    /// whose only clue about which PC to talk to is that parameter (see
    /// <see cref="QrHostOptions.DescribeWebFor"/>). Stripping it would produce a code that scans
    /// perfectly, opens the right site, and cannot find the game — a failure that looks like a network
    /// problem and is not.
    /// </para>
    /// </remarks>
    private static readonly string[] PreservedQueryKeys = ["h"];

    private static string NormalizePayload(Uri joinBaseUri)
        => new UriBuilder(joinBaseUri)
        {
            Path = string.IsNullOrEmpty(joinBaseUri.AbsolutePath) ? "/" : joinBaseUri.AbsolutePath,
            Query = PreservedQuery(joinBaseUri),
            Fragment = string.Empty
        }.Uri.ToString();

    private static string PreservedQuery(Uri joinBaseUri)
    {
        var query = joinBaseUri.Query.TrimStart('?');
        if (query.Length == 0)
        {
            return string.Empty;
        }

        var kept = new List<string>();
        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = pair.IndexOf('=');
            var key = separator < 0 ? pair : pair[..separator];
            if (Array.Exists(PreservedQueryKeys, preserved => string.Equals(key, preserved, StringComparison.Ordinal)))
            {
                kept.Add(pair);
            }
        }

        return string.Join("&", kept);
    }
}
