using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace CouchCoop.Mod.Server;

internal sealed record InternalServerErrorReport(
    string Incident,
    string Fault,
    string FaultId,
    string Version,
    string Route,
    string Utc)
{
    public static InternalServerErrorReport Create(CouchCoopHttpRequest? request, Exception exception)
    {
        while (true)
        {
            if (exception is AggregateException { InnerExceptions.Count: 1 } aggregate)
                exception = aggregate.InnerExceptions[0];
            else if (exception is TargetInvocationException { InnerException: { } inner })
                exception = inner;
            else
                break;
        }

        // Only type and mod-owned method identities may cross the wire; messages and stack text stay in logs.
        var frames = new StackTrace(exception, fNeedFileInfo: false).GetFrames()
            .Select(frame => frame.GetMethod())
            .Where(method => method?.DeclaringType?.Namespace?.StartsWith("CouchCoop", StringComparison.Ordinal) == true)
            .Take(3)
            .Select(method => CleanFrame(method!))
            .ToArray();
        var fault = exception.GetType().Name + (frames.Length > 0 ? " in " + frames[0] : string.Empty);
        var fingerprint = exception.GetType().FullName + "\n" + string.Join("\n", frames);
        var faultId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint)))[..8].ToLowerInvariant();
        const string alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        Span<byte> random = stackalloc byte[6];
        RandomNumberGenerator.Fill(random);
        Span<char> incident = stackalloc char[8];
        incident[0] = 'E';
        incident[1] = '-';
        for (var i = 0; i < random.Length; i++) incident[i + 2] = alphabet[random[i] & 31];

        return new InternalServerErrorReport(new string(incident), fault, faultId,
            CouchCoopAssetVersion.ModAssemblyVersion, request?.Path ?? "<unread>",
            DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture));
    }

    private static string CleanFrame(MethodBase method)
    {
        var type = method.DeclaringType!;
        var name = method.Name;
        if (name == "MoveNext" && type.Name.StartsWith('<') && type.DeclaringType is { } outer)
        {
            name = type.Name;
            type = outer;
        }

        if (name.StartsWith('<'))
        {
            name = name.TrimStart('<');
            var end = name.IndexOf('>');
            if (end > 0) name = name[..end];
        }
        while (type.Name.StartsWith("<>", StringComparison.Ordinal) && type.DeclaringType is { } containingType)
            type = containingType;
        var typeName = type.Name.Split('`')[0];
        return typeName + "." + name;
    }

    public string ToHtml() => $$"""
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Couch Co-op hit an error</title>
          <style>
            :root { color-scheme: light dark; font-family: system-ui, sans-serif; background: #f4f5f7; color: #20232b; }
            * { box-sizing: border-box; }
            body { margin: 0; padding: 2rem 1rem; }
            main { max-width: 42rem; margin: 0 auto; }
            h1 { font-size: 1.7rem; line-height: 1.2; }
            p { line-height: 1.6; }
            dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .8rem 1rem;
                 padding: 1rem; border: 1px solid #b8bdc9; border-radius: .5rem;
                 font-family: ui-monospace, monospace; font-size: .875rem; line-height: 1.5; }
            dt { font-weight: bold; }
            dd { margin: 0; overflow-wrap: anywhere; }
            @media (prefers-color-scheme: dark) {
              :root { background: #17191f; color: #edf0f5; }
              dl { border-color: #565d6b; }
            }
          </style>
        </head>
        <body>
          <main>
            <h1>Couch Co-op hit an error</h1>
            <p>The game host ran into an unexpected problem loading this page. Try reloading; if it keeps happening, screenshot this page and send it with your report.</p>
            <dl>
              <dt>Incident</dt><dd>{{WebUtility.HtmlEncode(Incident)}}</dd>
              <dt>Fault</dt><dd>{{WebUtility.HtmlEncode(Fault)}}</dd>
              <dt>Fault id</dt><dd>{{WebUtility.HtmlEncode(FaultId)}}</dd>
              <dt>Mod version</dt><dd>{{WebUtility.HtmlEncode(Version)}}</dd>
              <dt>Page</dt><dd>{{WebUtility.HtmlEncode(Route)}}</dd>
              <dt>Time UTC</dt><dd>{{WebUtility.HtmlEncode(Utc)}}</dd>
            </dl>
            <p>The host computer's log is godot.log in the game's logs folder; attaching it helps most.</p>
          </main>
        </body>
        </html>
        """;
}
