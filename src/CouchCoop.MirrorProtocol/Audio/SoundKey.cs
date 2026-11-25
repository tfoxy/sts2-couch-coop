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

    /// <summary>Writes a cue key without allocating; the native cue ABI caps UTF-8 keys at 512 bytes.</summary>
    public static bool TryWriteCueKey(string path, Dictionary<string, float>? parameters,
        Span<byte> destination, out int written)
    {
        written = 0;
        if (string.IsNullOrWhiteSpace(path) || path.Contains('|') || !Append(path, destination, ref written))
            return false;
        if (parameters is null || parameters.Count == 0) return true;
        string? previous = null;
        Span<char> number = stackalloc char[32];
        for (var i = 0; i < parameters.Count; i++)
        {
            string? next = null;
            float value = 0;
            foreach (var pair in parameters)
            {
                if ((previous is null || string.CompareOrdinal(pair.Key, previous) > 0)
                    && (next is null || string.CompareOrdinal(pair.Key, next) < 0))
                    (next, value) = (pair.Key, pair.Value);
            }
            if (string.IsNullOrEmpty(next) || !float.IsFinite(value)) return false;
            foreach (var c in next)
                if (c < ' ' || c > '~' || c is '=' or ',' or '|') return false;
            if (!Append(i == 0 ? "|" : ",", destination, ref written)
                || !Append(next, destination, ref written) || !Append("=", destination, ref written)
                || !value.TryFormat(number, out var count, "R", CultureInfo.InvariantCulture)
                || !Append(number[..count], destination, ref written)) return false;
            previous = next;
        }
        return true;
    }

    /// <summary>The same schema-prefixed identity as <see cref="Id"/>, in its native 16-byte form.</summary>
    public static void WriteCueId(ReadOnlySpan<byte> key, Span<byte> id)
    {
        if (key.Length > 512 || id.Length < 16) throw new ArgumentException("Invalid cue key or id buffer");
        Span<byte> input = stackalloc byte[513];
        input[0] = Schema;
        key.CopyTo(input[1..]);
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(input[..(key.Length + 1)], hash);
        hash[..16].CopyTo(id);
    }

    private static bool Append(ReadOnlySpan<char> value, Span<byte> destination, ref int written)
    {
        var count = Encoding.UTF8.GetByteCount(value);
        if (count > Math.Min(512, destination.Length) - written) return false;
        written += Encoding.UTF8.GetBytes(value, destination[written..]);
        return true;
    }

    public static bool IsId(string? id) => id is { Length: 32 } && id.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
}
