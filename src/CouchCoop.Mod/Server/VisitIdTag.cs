using System.Text;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Embeds a per-response visit id in the SPA document, as <c>&lt;meta name="couchcoop-visit" content="…"&gt;</c>.
/// </summary>
/// <remarks>
/// <para>
/// This is the pre-WebSocket identity the host is otherwise blind to (see <see cref="ConnectionArrivalLog"/>
/// for why it is not a cookie). Same-origin script reads it straight out of the DOM and sends it back on
/// <c>join</c>; nothing transmits it ambiently.
/// </para>
/// <para>
/// <b>Never corrupt the shell.</b> Every failure mode here returns the document EXACTLY as it was read from
/// disk: no recognisable <c>&lt;head&gt;</c>, a non-HTML body, an implausibly large file, or a visit id that
/// is not in the minted shape. A join page that loads without a visit id costs one diagnostic; a join page
/// that does not parse costs the session.
/// </para>
/// <para>
/// The response that carries an injected id MUST be <c>Cache-Control: no-store</c>. Without it the HTTP cache
/// (or a shared proxy) hands several devices the same id and the whole correlation is silently wrong.
/// </para>
/// </remarks>
public static class VisitIdTag
{
    /// <summary>The <c>name</c> attribute the browser looks the id up by.</summary>
    public const string MetaName = "couchcoop-visit";

    /// <summary>The cache policy a document carrying an injected id must be served with.</summary>
    public const string RequiredCacheControl = "no-store";

    /// <summary>Documents larger than this are served unmodified rather than rewritten in memory.</summary>
    public const int MaximumDocumentBytes = 4 * 1024 * 1024;

    /// <summary>How far into the document the opening <c>&lt;head&gt;</c> is looked for.</summary>
    private const int HeadScanBytes = 64 * 1024;

    private static readonly byte[] HeadTag = "<head"u8.ToArray();

    /// <summary>True for a response body this may rewrite — an HTML document and nothing else.</summary>
    public static bool IsHtml(string? contentType)
        => contentType is not null
           && contentType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Return <paramref name="document"/> with the visit meta tag inserted after its opening
    /// <c>&lt;head&gt;</c>, or the very same array when it cannot be done safely.
    /// </summary>
    public static byte[] Inject(byte[] document, string? visitId)
    {
        ArgumentNullException.ThrowIfNull(document);
        var visit = ConnectionArrivalLog.NormalizeVisitId(visitId);
        if (visit is null || document.Length == 0 || document.Length > MaximumDocumentBytes) return document;

        var insertAt = FindHeadInsertionPoint(document);
        if (insertAt < 0) return document;

        // `visit` is 32 lower-case hex characters by construction (NormalizeVisitId), so there is nothing to
        // escape — and nothing a caller could steer into the markup.
        var tag = Encoding.UTF8.GetBytes($"\n    <meta name=\"{MetaName}\" content=\"{visit}\" />");
        var result = new byte[document.Length + tag.Length];
        document.AsSpan(0, insertAt).CopyTo(result);
        tag.CopyTo(result, insertAt);
        document.AsSpan(insertAt).CopyTo(result.AsSpan(insertAt + tag.Length));
        return result;
    }

    /// <summary>Insert a server-created, non-sensitive metadata tag into a document already safe to rewrite.</summary>
    public static byte[] InjectMeta(byte[] document, string? tag)
    {
        if (string.IsNullOrEmpty(tag) || document.Length == 0 || document.Length > MaximumDocumentBytes) return document;
        var insertAt = FindHeadInsertionPoint(document);
        if (insertAt < 0) return document;
        var bytes = Encoding.UTF8.GetBytes("\n    " + tag);
        var result = new byte[document.Length + bytes.Length];
        document.AsSpan(0, insertAt).CopyTo(result);
        bytes.CopyTo(result, insertAt);
        document.AsSpan(insertAt).CopyTo(result.AsSpan(insertAt + bytes.Length));
        return result;
    }

    /// <summary>The byte offset just past the opening <c>&lt;head …&gt;</c> tag, or -1 when there is none.</summary>
    private static int FindHeadInsertionPoint(byte[] document)
    {
        var limit = Math.Min(document.Length, HeadScanBytes);
        for (var index = 0; index + HeadTag.Length < limit; index++)
        {
            if (!MatchesHeadTag(document, index)) continue;
            // `<head`, but not `<header`: the next byte must end the tag name.
            var next = document[index + HeadTag.Length];
            if (next is not ((byte)'>' or (byte)'/' or (byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n')) continue;
            for (var close = index + HeadTag.Length; close < limit; close++)
                if (document[close] == (byte)'>')
                    return close + 1;
            return -1;
        }

        return -1;
    }

    private static bool MatchesHeadTag(byte[] document, int index)
    {
        for (var offset = 0; offset < HeadTag.Length; offset++)
        {
            var actual = document[index + offset];
            if (actual is >= (byte)'A' and <= (byte)'Z') actual = (byte)(actual + 32);
            if (actual != HeadTag[offset]) return false;
        }

        return true;
    }
}
