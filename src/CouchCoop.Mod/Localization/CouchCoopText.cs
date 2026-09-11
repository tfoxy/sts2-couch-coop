using System.Collections.ObjectModel;

namespace CouchCoop.Mod.Localization;

/// <summary>A player-facing CouchCoop sentence: a stable catalog key plus safe named values.</summary>
public readonly record struct CouchCoopText
{
    private static readonly IReadOnlyDictionary<string, CouchCoopTextArgument> EmptyArguments
        = new ReadOnlyDictionary<string, CouchCoopTextArgument>(new Dictionary<string, CouchCoopTextArgument>());

    public CouchCoopText(string key, IReadOnlyDictionary<string, CouchCoopTextArgument>? arguments = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        Key = key;
        Arguments = arguments ?? EmptyArguments;
        Literal = null;
    }

    private CouchCoopText(string literal)
    {
        Key = string.Empty;
        Arguments = EmptyArguments;
        Literal = literal;
    }

    public string Key { get; }
    public IReadOnlyDictionary<string, CouchCoopTextArgument> Arguments { get; }
    public string? Literal { get; }
    /// <summary>Compatibility for existing UI predicates; semantic storage remains <see cref="Key"/> plus arguments.</summary>
    public int Length => Resolve().Length;

    /// <summary>For foreign diagnostics only; product copy must use a catalog key.</summary>
    public static CouchCoopText FromLiteral(string? value) => new(value ?? string.Empty);

    public static CouchCoopText Create(string key, params (string Name, CouchCoopTextArgument Value)[] arguments)
    {
        if (arguments.Length == 0)
        {
            return new CouchCoopText(key);
        }

        var values = new Dictionary<string, CouchCoopTextArgument>(arguments.Length, StringComparer.Ordinal);
        foreach (var (name, value) in arguments)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ArgumentException("Localization argument names must be nonblank.", nameof(arguments));
            }

            values[name] = value;
        }

        return new CouchCoopText(key, new ReadOnlyDictionary<string, CouchCoopTextArgument>(values));
    }

    public string Resolve() => Literal ?? CouchCoopLocalization.Resolve(Key, Arguments);

    /// <summary>Embedded-catalog resolution for locale-independent diagnostics; external literals pass through.</summary>
    public string ResolveForLanguage(string language)
        => Literal ?? CouchCoopLocalization.ResolveForLanguage(language, Key, Arguments);

    /// <summary>Lock-safe equality for activity dedupe: compares only stored data and never resolves text.</summary>
    public bool StructurallyEquals(CouchCoopText other)
    {
        if (!string.Equals(Key, other.Key, StringComparison.Ordinal) || !string.Equals(Literal, other.Literal, StringComparison.Ordinal)
            || Arguments.Count != other.Arguments.Count)
        {
            return false;
        }

        foreach (var (name, value) in Arguments)
        {
            if (!other.Arguments.TryGetValue(name, out var otherValue) || !value.StructurallyEquals(otherValue))
            {
                return false;
            }
        }

        return true;
    }

    public static implicit operator CouchCoopText(string value) => FromLiteral(value);
    public static bool operator ==(CouchCoopText value, string? other)
        => string.Equals(value.Resolve(), other, StringComparison.Ordinal);
    public static bool operator !=(CouchCoopText value, string? other) => !(value == other);

    internal bool IsBlankLiteral => Literal is not null && string.IsNullOrWhiteSpace(Literal);
}

/// <summary>A safe text argument, either player/external text or another catalog value.</summary>
public readonly record struct CouchCoopTextArgument
{
    private CouchCoopTextArgument(string? literal, CouchCoopText? localized)
    {
        Literal = literal;
        Localized = localized;
    }

    public string? Literal { get; }
    public CouchCoopText? Localized { get; }

    public static CouchCoopTextArgument Value(string? value) => new(value ?? string.Empty, null);
    public static CouchCoopTextArgument LocalizedValue(CouchCoopText value) => new(null, value);
    public string Resolve() => Localized?.Resolve() ?? Literal ?? string.Empty;
    internal string ResolveForLanguage(string language) => Localized?.ResolveForLanguage(language) ?? Literal ?? string.Empty;

    internal bool StructurallyEquals(CouchCoopTextArgument other)
    {
        if (!string.Equals(Literal, other.Literal, StringComparison.Ordinal))
        {
            return false;
        }

        return (Localized, other.Localized) switch
        {
            (null, null) => true,
            ({ } left, { } right) => left.StructurallyEquals(right),
            _ => false,
        };
    }

    public static implicit operator CouchCoopTextArgument(string? value) => Value(value);
    public static bool operator ==(CouchCoopTextArgument value, string? other)
        => string.Equals(value.Resolve(), other, StringComparison.Ordinal);
    public static bool operator !=(CouchCoopTextArgument value, string? other) => !(value == other);
}
