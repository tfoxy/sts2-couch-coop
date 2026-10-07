using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace CouchCoop.MirrorProtocol.Audio;

/// <summary>Versioned, locale-independent identity for a rendered sound take.</summary>
public static class SoundKey
{
    public const byte Schema = 1;

    public static string Canonical(string path, IEnumerable<KeyValuePair<string, float>>? parameters = null)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Contains('|'))
            throw new ArgumentException("Invalid sound path", nameof(path));
        if (parameters is null) return path;
        var ordered = parameters.OrderBy(p => p.Key, StringComparer.Ordinal).ToArray();
        if (ordered.Length == 0) return path;
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (name, value) in ordered)
        {
            if (string.IsNullOrEmpty(name) || name.IndexOfAny(['=', ',', '|']) >= 0 || !names.Add(name))
                throw new ArgumentException("Invalid or duplicate parameter name", nameof(parameters));
            if (!float.IsFinite(value)) throw new ArgumentException("Non-finite parameter", nameof(parameters));
        }
        return path + "|" + string.Join(',', ordered.Select(p => p.Key + "=" + p.Value.ToString("R", CultureInfo.InvariantCulture)));
    }

    public static string Id(string canonical)
    {
        if (string.IsNullOrEmpty(canonical)) throw new ArgumentException("Empty canonical key", nameof(canonical));
        var utf8 = Encoding.UTF8.GetBytes(canonical);
        var input = new byte[utf8.Length + 1];
        input[0] = Schema;
        utf8.CopyTo(input, 1);
        return Convert.ToHexString(SHA256.HashData(input).AsSpan(0, 16)).ToLowerInvariant();
    }

    public static bool IsId(string? id) => id is { Length: 32 } && id.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
}
