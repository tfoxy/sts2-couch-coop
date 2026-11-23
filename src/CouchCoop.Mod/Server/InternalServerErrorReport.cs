using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Server;

internal sealed record InternalServerErrorReport(
    string Incident,
    string Fault,
    string FaultId,
    string Version,
    string Route,
    string Utc,
    string? GameVersion = null,
    string? LogPath = null)
{
    /// <summary>
    /// The Workshop "Having a problem? Post it here" discussion. Must match
    /// <c>workshop/discussions/discussions.json</c> (<c>reporting-a-problem</c>); a Mod.Tests case pins the two.
    /// </summary>
    internal const string ReportProblemUrl =
        "https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/";

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
            DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture),
            string.IsNullOrWhiteSpace(ConnectionRegistry.HostGameVersion) ? null : ConnectionRegistry.HostGameVersion,
            DisplayLogPath(ConnectionRegistry.HostLogPath, OperatingSystem.IsWindows(),
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));
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

    /// <summary>
    /// This process's <c>godot.log</c> as the page shows it: the real path with the home folder written as
    /// <c>%APPDATA%</c>/<c>%USERPROFILE%</c> (Windows) or <c>~</c>, so the page — readable by anyone on the
    /// LAN — never carries the computer's account name, and the text still pastes into Explorer or Finder.
    /// </summary>
    internal static string? DisplayLogPath(string? path, bool windows, string? appData, string? home)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        if (windows)
        {
            var normalized = path.Replace('/', '\\');
            foreach (var (root, alias) in new[] { (appData, "%APPDATA%"), (home, "%USERPROFILE%") })
            {
                if (string.IsNullOrEmpty(root)) continue;
                var prefix = root.Replace('/', '\\').TrimEnd('\\') + "\\";
                if (normalized.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    return alias + normalized[(prefix.Length - 1)..];
            }
            return normalized;
        }

        if (!string.IsNullOrEmpty(home))
        {
            var prefix = home.TrimEnd('/') + "/";
            if (path.StartsWith(prefix, StringComparison.Ordinal)) return "~" + path[(prefix.Length - 1)..];
        }
        return path;
    }

    /// <summary>The plain-text block the page's Copy button puts on the clipboard, ready to paste into a post.</summary>
    public string ToText()
    {
        var text = new StringBuilder()
            .Append("Couch Co-op error ").Append(Incident).Append('\n')
            .Append("Fault: ").Append(Fault).Append(" (").Append(FaultId).Append(")\n")
            .Append("Mod version: ").Append(Version).Append('\n')
            .Append("Game version: ").Append(GameVersion ?? "unknown").Append('\n')
            .Append("Page: ").Append(Route).Append('\n')
            .Append("Time: ").Append(Utc);
        if (LogPath is not null) text.Append('\n').Append("Log file: ").Append(LogPath);
        return text.ToString();
    }

    // The page is served over plain http on the LAN, where browsers withhold navigator.clipboard (it needs a secure
    // context). So Copy tries it, falls back to execCommand on the textarea, and if both refuse it reveals the
    // selected textarea for a manual long-press copy. Inline script only: the page loads nothing external.
    public string ToHtml()
    {
        var logBlock = LogPath is null
            ? "<p>If you can, also attach <code>godot.log</code> from the game's <code>logs</code> folder on the computer running the game.</p>"
            : $"<p>If you can, also attach this file from the computer running the game:</p><p class=\"path\"><code>{WebUtility.HtmlEncode(LogPath)}</code></p>";
        return $$"""
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Couch Co-op hit an error</title>
          <style>
            :root { color-scheme: light dark; font-family: system-ui, sans-serif; background: #f4f5f7; color: #20232b;
                    --line: #b8bdc9; --accent: #2f5fd0; --accent-ink: #fff; }
            * { box-sizing: border-box; }
            body { margin: 0; padding: 2rem 1rem; }
            main { max-width: 42rem; margin: 0 auto; }
            h1 { font-size: 1.7rem; line-height: 1.2; }
            p { line-height: 1.6; }
            dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .6rem 1rem;
                 padding: 1rem; border: 1px solid var(--line); border-radius: .5rem;
                 font-family: ui-monospace, monospace; font-size: .875rem; line-height: 1.5; }
            dt { font-weight: bold; }
            dd { margin: 0; overflow-wrap: anywhere; }
            .actions { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.25rem 0 .5rem; }
            .actions button, .actions a { font: inherit; font-weight: 600; padding: .7rem 1.1rem; border-radius: .5rem;
                 border: 1px solid var(--accent); text-decoration: none; cursor: pointer; text-align: center; flex: 1 1 12rem; }
            .actions button { background: var(--accent); color: var(--accent-ink); }
            .actions a { background: transparent; color: var(--accent); }
            #status { min-height: 1.6em; margin: 0; font-size: .9rem; }
            textarea { width: 100%; min-height: 9rem; font: .8rem/1.5 ui-monospace, monospace; padding: .6rem;
                 border: 1px solid var(--line); border-radius: .5rem; background: transparent; color: inherit; }
            .path code { overflow-wrap: anywhere; font-size: .875rem; }
            @media (prefers-color-scheme: dark) {
              :root { background: #17191f; color: #edf0f5; --line: #565d6b; --accent: #8fb0ff; --accent-ink: #10131a; }
            }
          </style>
        </head>
        <body>
          <main>
            <h1>Couch Co-op hit an error</h1>
            <p>The game host ran into an unexpected problem loading this page. Try reloading. If it keeps happening, copy the details below and post them in the Couch Co-op Workshop discussion.</p>
            <dl>
              <dt>Incident</dt><dd>{{WebUtility.HtmlEncode(Incident)}}</dd>
              <dt>Fault</dt><dd>{{WebUtility.HtmlEncode(Fault)}}</dd>
              <dt>Fault id</dt><dd>{{WebUtility.HtmlEncode(FaultId)}}</dd>
              <dt>Mod version</dt><dd>{{WebUtility.HtmlEncode(Version)}}</dd>
              <dt>Game version</dt><dd>{{WebUtility.HtmlEncode(GameVersion ?? "unknown")}}</dd>
              <dt>Page</dt><dd>{{WebUtility.HtmlEncode(Route)}}</dd>
              <dt>Time UTC</dt><dd>{{WebUtility.HtmlEncode(Utc)}}</dd>
            </dl>
            <div class="actions">
              <button type="button" id="copy">Copy details</button>
              <a href="{{ReportProblemUrl}}" target="_blank" rel="noopener noreferrer">Open the Steam discussion</a>
            </div>
            <p id="status" role="status" aria-live="polite"></p>
            <textarea id="report" readonly hidden aria-label="Error details">{{WebUtility.HtmlEncode(ToText())}}</textarea>
            {{logBlock}}
          </main>
          <script>
            (function () {
              var report = document.getElementById("report");
              var status = document.getElementById("status");
              function manual() {
                report.hidden = false;
                report.style.height = report.scrollHeight + 2 + "px";
                report.focus();
                report.setSelectionRange(0, report.value.length);
                status.textContent = "Couldn't copy automatically. The text below is selected: long-press it and choose Copy.";
              }
              function legacy() {
                report.hidden = false;
                report.focus();
                report.setSelectionRange(0, report.value.length);
                var copied = false;
                try { copied = document.execCommand("copy"); } catch (e) { copied = false; }
                if (copied) { report.hidden = true; status.textContent = "Copied. Paste it into your post."; }
                else { manual(); }
              }
              document.getElementById("copy").addEventListener("click", function () {
                if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(report.value).then(function () {
                    status.textContent = "Copied. Paste it into your post.";
                  }, legacy);
                } else {
                  legacy();
                }
              });
            })();
          </script>
        </body>
        </html>
        """;
    }
}
