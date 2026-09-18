using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace CouchCoop.Mod.Connections;

/// <summary>What the host's own firewall says about this game, when the host can ask.</summary>
internal enum WindowsFirewallVerdict
{
    /// <summary>Not Windows, the query failed, or it answered something this cannot read. Accuses nobody.</summary>
    Unknown,

    /// <summary>An enabled inbound allow rule matches this game and covers a network this PC is on.</summary>
    Allowed,

    /// <summary>An enabled inbound BLOCK rule matches this game. Windows evaluates block before allow.</summary>
    BlockRule,

    /// <summary>The query worked and no enabled inbound allow rule matches this game at all.</summary>
    NoAllowRule,

    /// <summary>Allow rules exist, but none of them covers the profile of any network this PC is on.</summary>
    ProfileMismatch
}

internal readonly record struct WindowsFirewallRule(string Program, string Name, bool Enabled, string Action, string Profiles);

internal readonly record struct WindowsFirewallNetwork(string Name, string Category);

/// <summary>Everything the query returned, already shaped. The classifier below reads only this.</summary>
/// <param name="InboundRuleCount">
/// Every inbound rule on this PC, ours or not. The "did the query actually run" signal: a Windows install has
/// hundreds, so zero means the answer is not about this game.
/// </param>
/// <param name="ProgramRuleCount">
/// How many application filters carried a program at all. The second such signal, and the one that catches a
/// query which enumerated rules but could not read their programs — without it, "we found nothing about this
/// game" and "we could not look" are the same empty list, and one of those is an accusation.
/// </param>
/// <param name="Rules">The inbound rules that name this game's executable, and only those.</param>
internal sealed record WindowsFirewallFacts(
    int InboundRuleCount,
    int ProgramRuleCount,
    IReadOnlyList<WindowsFirewallRule> Rules,
    IReadOnlyList<WindowsFirewallNetwork> Networks,
    string? Error);

internal sealed record WindowsFirewallReading(WindowsFirewallVerdict Verdict, string Detail);

/// <summary>
/// Asks Windows whether its own firewall is why nothing has arrived, so the 90s reachability row can name a
/// cause instead of listing two it cannot tell apart.
/// </summary>
/// <remarks>
/// <para>
/// WHY THIS IS WORTH A PROCESS SPAWN. <see cref="HostReachabilityWatch"/> is honest that "nobody scanned" and
/// "nothing can get through" are the same observation from inside this process — but on Windows that is only
/// true of the NETWORK evidence. The most common single cause of the second one is a local, readable fact:
/// whether an enabled inbound rule for this executable exists, and whether it covers the profile of the
/// network this PC is actually on. `docs/agents/windows-connection-fingerprints.md` §3 measured both halves of
/// why that matters — a stock box's inbound default is block, and the game's permission is carried by
/// per-PROGRAM allow rules, which is also why the advice everywhere is "allow the program, not a port".
/// </para>
/// <para>
/// AND WHY IT IS A DIAGNOSTIC RATHER THAN A CHECK. Nothing acts on this. It runs once, on the failure path,
/// after the watch has already decided to raise a row, and its only output is a sentence. A host with a
/// healthy join never reaches it; a host that cannot answer gets <see cref="WindowsFirewallVerdict.Unknown"/>
/// and the copy it always had. A wrong accusation costs a player their evening, so every uncertain shape —
/// no PowerShell, a timeout, an empty answer, a query that returned rules but no programs — lands on Unknown.
/// </para>
/// <para>
/// Deliberately free of Godot, Harmony and game types, like the two files beside it: it is read from the
/// networking layer and must stay constructible in a process with no engine.
/// </para>
/// </remarks>
internal static class WindowsFirewallProbe
{
    /// <summary><c>0</c>/<c>off</c>/<c>false</c>/<c>no</c> skips the query entirely.</summary>
    internal const string EnabledEnvironmentVariable = "COUCHCOOP_FIREWALL_PROBE";

    /// <summary>
    /// How long the query gets. Generous because it is off the join path entirely — the host is 90 seconds
    /// into a failure by the time this runs — and because the cmdlets below are slow on a cold WMI stack.
    /// </summary>
    /// <remarks>
    /// THE COST, STATED: the watch waits for this before it raises anything, so on Windows the row arrives up
    /// to this much later than the 90s threshold. That is the right way round. The row is read by a person
    /// some minutes into a failed join, and a row that says which of two causes it is beats the same row a few
    /// seconds earlier saying it cannot tell. The probe is never on the path of a join that works.
    /// </remarks>
    internal static readonly TimeSpan Timeout = TimeSpan.FromSeconds(12);

    /// <summary>The environment variable the query reads the game's executable from.</summary>
    internal const string ExecutableEnvironmentVariable = "COUCHCOOP_FIREWALL_EXE";

    /// <summary>
    /// The query, as a CONSTANT. Nothing is interpolated into it — not the executable path, not the port,
    /// nothing a player or a peer could influence — because the one way a diagnostic like this becomes a
    /// vulnerability is by building a command line out of runtime data. The one value it needs is handed over
    /// as an ENVIRONMENT VARIABLE instead, which PowerShell reads as data and never parses as syntax.
    /// </summary>
    /// <remarks>
    /// Written for Windows PowerShell 5.1, which is what a stock install runs: no ternaries, no
    /// null-coalescing, explicit <c>-Depth</c> on <c>ConvertTo-Json</c> (the default is 2 and would flatten
    /// the rule list into type names), and <c>@()</c> around the collections so a single result still
    /// serialises as an array rather than an object.
    ///
    /// It walks the application filters and follows each one to its OWN rule — the documented association —
    /// rather than joining the two lists on a key. A join would be faster and is what the first draft did; it
    /// is also a guess about a WMI class's identity that could not be checked on the machine this was written
    /// on, and a guess that silently matches nothing produces a probe that is inert everywhere and says so
    /// nowhere. Narrowing by file name first keeps the per-rule query to the handful of rules that mention
    /// this game, so the safe shape is also a cheap one.
    ///
    /// <c>$ErrorActionPreference = 'Stop'</c> makes any failure produce no JSON at all rather than a partial
    /// answer — and no JSON is <see cref="WindowsFirewallVerdict.Unknown"/>, which accuses nobody.
    /// </remarks>
    internal const string Query = """
        $ErrorActionPreference = 'Stop'
        $leaf = ''
        if ($env:COUCHCOOP_FIREWALL_EXE) { $leaf = [System.IO.Path]::GetFileName($env:COUCHCOOP_FIREWALL_EXE) }
        $inbound = @(Get-NetFirewallRule -Direction Inbound)
        $filters = @(Get-NetFirewallApplicationFilter -All)
        $withProgram = 0
        $matched = New-Object System.Collections.ArrayList
        foreach ($filter in $filters) {
          if (-not $filter.Program) { continue }
          $withProgram = $withProgram + 1
          if (-not $leaf) { continue }
          if ([System.IO.Path]::GetFileName([string]$filter.Program) -ine $leaf) { continue }
          $rules = $null
          try { $rules = @($filter | Get-NetFirewallRule) } catch { $rules = $null }
          foreach ($rule in @($rules)) {
            if (-not $rule) { continue }
            if ([string]$rule.Direction -ne 'Inbound') { continue }
            [void]$matched.Add([pscustomobject]@{
              program = [string]$filter.Program
              name = [string]$rule.DisplayName
              enabled = [string]$rule.Enabled
              action = [string]$rule.Action
              profiles = [string]$rule.Profile
            })
          }
        }
        $networks = New-Object System.Collections.ArrayList
        foreach ($connection in @(Get-NetConnectionProfile)) {
          [void]$networks.Add([pscustomobject]@{
            name = [string]$connection.Name
            category = [string]$connection.NetworkCategory
          })
        }
        [pscustomobject]@{
          inboundRuleCount = $inbound.Count
          programRuleCount = $withProgram
          rules = @($matched)
          networks = @($networks)
        } | ConvertTo-Json -Depth 4 -Compress
        """;

    private static readonly object Gate = new();
    private static WindowsFirewallReading? _cached;

    /// <summary>The reading for this session, querying at most once. Null when the probe is switched off.</summary>
    internal static async Task<WindowsFirewallReading?> ReadAsync(CancellationToken cancellationToken = default)
    {
        if (!IsEnabled(Environment.GetEnvironmentVariable(EnabledEnvironmentVariable)))
        {
            return null;
        }

        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        lock (Gate)
        {
            if (_cached is { } done)
            {
                return done;
            }
        }

        var reading = Classify(await QueryAsync(cancellationToken).ConfigureAwait(false), Environment.ProcessPath);
        lock (Gate)
        {
            _cached ??= reading;
            return _cached;
        }
    }

    /// <summary>Forget the session's reading. Tests only.</summary>
    internal static void ResetForTests()
    {
        lock (Gate)
        {
            _cached = null;
        }
    }

    /// <summary>Unset is ON; an explicit falsey value or a non-positive number is OFF.</summary>
    internal static bool IsEnabled(string? rawValue)
    {
        var value = rawValue?.Trim();
        if (string.IsNullOrEmpty(value))
        {
            return true;
        }

        if (value.Equals("off", StringComparison.OrdinalIgnoreCase)
            || value.Equals("false", StringComparison.OrdinalIgnoreCase)
            || value.Equals("no", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return !(int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) && number <= 0);
    }

    /// <summary>
    /// Turn the query's answer into a verdict and the sentence that carries it.
    /// </summary>
    /// <param name="facts">What the query returned; null when it could not be run at all.</param>
    /// <param name="processPath">
    /// Usually <see cref="Environment.ProcessPath"/> — the game's own executable, which is the thing the
    /// rules are about.
    /// </param>
    /// <remarks>
    /// MATCHING IS DELIBERATELY LOOSE, AND THE SENTENCE SAYS SO WHEN IT IS. A full-path match is the honest
    /// one; a file-name match also counts, because a rule written against an older install of the same game
    /// (a moved Steam library, a different drive) is still the rule a player will find in that list and
    /// still what they have to change. The looser match can only ever produce a MILDER verdict — it adds
    /// allow rules that would otherwise be missing — so it cannot manufacture an accusation.
    /// </remarks>
    internal static WindowsFirewallReading Classify(WindowsFirewallFacts? facts, string? processPath)
    {
        if (facts is null)
        {
            return new WindowsFirewallReading(WindowsFirewallVerdict.Unknown,
                "Windows Firewall: could not be queried, so this host cannot say whether its own firewall is involved.");
        }

        if (!string.IsNullOrWhiteSpace(facts.Error))
        {
            return new WindowsFirewallReading(WindowsFirewallVerdict.Unknown,
                $"Windows Firewall: the query failed ({facts.Error!.Trim()}), so this host cannot say whether its own firewall is involved.");
        }

        // A query that saw no inbound rules at all, or could not read a single rule's program, did not work —
        // every Windows install has hundreds of both. Neither shape is evidence about this game, and the
        // difference between "we looked and found nothing" and "we could not look" is the whole verdict.
        if (facts.InboundRuleCount <= 0 || facts.ProgramRuleCount <= 0)
        {
            return new WindowsFirewallReading(WindowsFirewallVerdict.Unknown,
                "Windows Firewall: the rule list came back empty, which means the query did not work rather than "
                + "that this game has no rules. Check the firewall entry for Slay the Spire 2 by hand.");
        }

        var fileName = FileNameOf(processPath);
        var mine = facts.Rules.Where(rule => Matches(rule.Program, processPath, fileName)).ToList();
        var blocking = mine.Where(rule => rule.Enabled && IsBlock(rule.Action)).ToList();
        if (blocking.Count > 0)
        {
            return new WindowsFirewallReading(WindowsFirewallVerdict.BlockRule,
                "Windows Firewall: this computer has an enabled inbound BLOCK rule for this game — "
                + Describe(blocking)
                + ". Windows applies a block before any allow rule, so nothing can reach this PC's game port while it "
                + "exists. This is usually what a \"Cancel\" on an old firewall prompt left behind; delete that entry "
                + "and allow the program instead.");
        }

        var allowing = mine.Where(rule => rule.Enabled && !IsBlock(rule.Action)).ToList();
        if (allowing.Count == 0)
        {
            var disabled = mine.Count > 0
                ? $" There {(mine.Count == 1 ? "is 1 rule" : $"are {mine.Count.ToString(CultureInfo.InvariantCulture)} rules")} for it that "
                    + "are switched off."
                : string.Empty;
            return new WindowsFirewallReading(WindowsFirewallVerdict.NoAllowRule,
                "Windows Firewall: no enabled inbound allow rule for this game exists on this computer, and Windows "
                + "blocks anything without one." + disabled
                + " Allow Slay the Spire 2 as a PROGRAM (not a port) for the Private profile — one rule then covers "
                + "the lobby port and every player's port.");
        }

        var categories = facts.Networks
            .Select(network => NormalizeCategory(network.Category))
            .Where(category => category.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var covered = categories.Where(category => allowing.Any(rule => Covers(rule.Profiles, category))).ToList();

        if (categories.Count > 0 && covered.Count == 0)
        {
            return new WindowsFirewallReading(WindowsFirewallVerdict.ProfileMismatch,
                $"Windows Firewall: this game is allowed inbound, but only for {ProfilesOf(allowing)}, and "
                + $"{NetworksSentence(facts.Networks)}. A rule that does not cover the profile the network is in does "
                + "nothing. Either tick that profile on the game's firewall entry, or set the network itself to "
                + "Private (Settings > Network & Internet > your network > Network profile type).");
        }

        var where = covered.Count > 0
            ? $" for {string.Join(" and ", covered)}, and {NetworksSentence(facts.Networks)}"
            : string.Empty;
        return new WindowsFirewallReading(WindowsFirewallVerdict.Allowed,
            $"Windows Firewall: this game IS allowed inbound on this computer{where} — so this PC's own Windows "
            + "Firewall is not what is stopping the connection. Look instead at security software with its own "
            + "firewall, at the network between the phone and this PC (guest Wi-Fi, AP isolation, a VPN on the "
            + "phone), or at nobody having scanned the code yet.");
    }

    /// <summary>Parse the query's stdout. Returns null for anything unreadable — never throws.</summary>
    internal static WindowsFirewallFacts? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var rules = new List<WindowsFirewallRule>();
            foreach (var element in Array(root, "rules"))
            {
                var program = Text(element, "program");
                if (program.Length == 0)
                {
                    continue;
                }

                rules.Add(new WindowsFirewallRule(
                    program,
                    Text(element, "name"),
                    IsTrue(Text(element, "enabled")),
                    Text(element, "action"),
                    Text(element, "profiles")));
            }

            var networks = new List<WindowsFirewallNetwork>();
            foreach (var element in Array(root, "networks"))
            {
                networks.Add(new WindowsFirewallNetwork(Text(element, "name"), Text(element, "category")));
            }

            return new WindowsFirewallFacts(Count(root, "inboundRuleCount"), Count(root, "programRuleCount"), rules, networks, null);
        }
        catch (Exception exception) when (exception is JsonException or FormatException or InvalidOperationException)
        {
            return null;
        }
    }

    private static async Task<WindowsFirewallFacts?> QueryAsync(CancellationToken cancellationToken)
    {
        // -EncodedCommand rather than -Command: the guest's default shell is cmd, quoting is the trap that
        // breaks every hand-written PowerShell invocation there, and UTF-16LE/base64 has no quoting at all.
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(Query));
        var start = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = false,
            // A Steam-launched game must never flash a console window, and an unread pipe that fills would
            // wedge the child — so both streams are redirected and both are read.
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-ExecutionPolicy");
        start.ArgumentList.Add("Bypass");
        start.ArgumentList.Add("-EncodedCommand");
        start.ArgumentList.Add(encoded);
        // The only runtime value the query sees, and it arrives as data rather than as syntax.
        start.Environment[ExecutableEnvironmentVariable] = Environment.ProcessPath ?? string.Empty;

        Process? process = null;
        try
        {
            process = Process.Start(start);
            if (process is null)
            {
                return new WindowsFirewallFacts(0, 0, [], [], "powershell did not start");
            }

            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(Timeout);
            var stdout = process.StandardOutput.ReadToEndAsync(budget.Token);
            var stderr = process.StandardError.ReadToEndAsync(budget.Token);
            await process.WaitForExitAsync(budget.Token).ConfigureAwait(false);
            var output = await stdout.ConfigureAwait(false);
            var error = await stderr.ConfigureAwait(false);

            var parsed = Parse(output);
            if (parsed is not null)
            {
                return parsed;
            }

            var reason = error.Trim();
            if (reason.Length > 200)
            {
                reason = reason[..200];
            }

            return new WindowsFirewallFacts(0, 0, [], [],
                reason.Length > 0 ? reason.ReplaceLineEndings(" ") : "no readable answer");
        }
        catch (OperationCanceledException)
        {
            return new WindowsFirewallFacts(0, 0, [], [],
                $"no answer within {Timeout.TotalSeconds.ToString(CultureInfo.InvariantCulture)}s");
        }
        catch (Exception exception)
        {
            return new WindowsFirewallFacts(0, 0, [], [], exception.GetType().Name);
        }
        finally
        {
            try
            {
                if (process is { HasExited: false })
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch (Exception exception) when (exception is InvalidOperationException or NotSupportedException or System.ComponentModel.Win32Exception)
            {
            }

            process?.Dispose();
        }
    }

    private static IEnumerable<JsonElement> Array(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value))
        {
            yield break;
        }

        // ConvertTo-Json collapses a one-element collection to a bare object on some hosts even with @();
        // both shapes are read rather than trusting the array wrapper.
        if (value.ValueKind == JsonValueKind.Object)
        {
            yield return value;
            yield break;
        }

        if (value.ValueKind != JsonValueKind.Array)
        {
            yield break;
        }

        foreach (var element in value.EnumerateArray())
        {
            if (element.ValueKind == JsonValueKind.Object)
            {
                yield return element;
            }
        }
    }

    private static int Count(JsonElement root, string name)
        => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out var number)
            ? number
            : 0;

    private static string Text(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim() ?? string.Empty
            : string.Empty;

    private static bool IsTrue(string value)
        => value.Equals("True", StringComparison.OrdinalIgnoreCase)
            || value.Equals("Enabled", StringComparison.OrdinalIgnoreCase)
            || value.Equals("1", StringComparison.Ordinal);

    private static bool IsBlock(string action) => action.Trim().Equals("Block", StringComparison.OrdinalIgnoreCase);

    private static string FileNameOf(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return string.Empty;
        }

        var trimmed = path.Trim().TrimEnd('\\', '/');
        var cut = trimmed.LastIndexOfAny(['\\', '/']);
        return cut >= 0 ? trimmed[(cut + 1)..] : trimmed;
    }

    private static bool Matches(string program, string? processPath, string fileName)
    {
        if (!string.IsNullOrWhiteSpace(processPath)
            && program.Equals(processPath.Trim(), StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return fileName.Length > 0
            && FileNameOf(program).Equals(fileName, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>`DomainAuthenticated` is what a connection profile calls the `Domain` firewall profile.</summary>
    private static string NormalizeCategory(string category)
    {
        var value = category.Trim();
        return value.Equals("DomainAuthenticated", StringComparison.OrdinalIgnoreCase) ? "Domain" : value;
    }

    private static bool Covers(string profiles, string category)
    {
        var value = profiles.Trim();
        if (value.Length == 0 || value.Equals("Any", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(entry => entry.Equals(category, StringComparison.OrdinalIgnoreCase));
    }

    private static string ProfilesOf(IEnumerable<WindowsFirewallRule> rules)
    {
        var names = rules
            .SelectMany(rule => rule.Profiles.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        return names.Count == 0 ? "no profile at all" : string.Join(", ", names);
    }

    private static string NetworksSentence(IReadOnlyList<WindowsFirewallNetwork> networks)
    {
        if (networks.Count == 0)
        {
            return "this PC reports no active network";
        }

        var described = networks.Select(network =>
            $"\"{network.Name}\" is {NormalizeCategory(network.Category)}");
        return "this PC's network " + string.Join(" and ", described);
    }

    private static string Describe(IReadOnlyList<WindowsFirewallRule> rules)
    {
        var named = rules.Select(rule => rule.Name.Length > 0 ? $"\"{rule.Name}\"" : rule.Program).Take(3);
        return string.Join(", ", named);
    }
}
