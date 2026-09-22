using CouchCoop.Mod.Connections;

// The host asking Windows why nothing has arrived. `HostReachabilityWatch` is honest that "nobody scanned yet"
// and "nothing can get through" are one observation from inside this process — but the most common cause of the
// second is a LOCAL fact this machine can just read, and `docs/agents/windows-connection-fingerprints.md` §3/§5
// measured why it matters: a stock box blocks inbound by default, the game's permission is carried by
// per-PROGRAM rules, and every host-side network check passes while a real phone is being dropped.
//
// What this suite pins:
//
//  1. IT NEVER ACCUSES ON AN UNCERTAIN ANSWER. No PowerShell, a timeout, an empty list, a query that returned
//     rules but no programs — all of them are Unknown, with copy that contains none of the accusation words the
//     watch's own suite forbids. A wrong firewall accusation costs a player their evening.
//  2. It accuses only on the three shapes that are actually decisive, and the watch then raises the OTHER issue
//     code for them — mapped in CouchCoopConnectionPanel.IssueKey, because an unmapped code renders the wrong
//     sentence rather than a missing one.
//  3. It does not cry wolf about profiles. A VPN adapter marked Public beside a covered Private LAN is normal.
//  4. It spawns nothing off Windows.
//
// Pure: the JSON is a captured shape, not a live query, and the watch leg uses a stubbed reading. Assert-or-throw,
// matching the repo's custom Exe runner.
internal static class WindowsFirewallProbeTests
{
    private const string GamePath = @"C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\SlayTheSpire2.exe";

    public static void Run()
    {
        TheSwitchReaderHandlesUnsetOffAndGarbage();
        ParseReadsTheShapePowerShellEmits();
        EveryUncertainAnswerIsUnknownAndAccusesNobody();
        ABlockRuleIsNamedAndExplained();
        NoAllowRuleIsSeparatedFromRulesThatAreMerelySwitchedOff();
        AnAllowedHostIsToldSoOutright();
        ProfilesAreOnlyReportedWhenNOTHINGCoversAnActiveNetwork();
        TheProbeDoesNotRunOffWindows();
        Console.WriteLine("WindowsFirewallProbeTests: ok");
    }

    private static void TheSwitchReaderHandlesUnsetOffAndGarbage()
    {
        Expect(WindowsFirewallProbe.IsEnabled(null), "unset runs the probe");
        Expect(WindowsFirewallProbe.IsEnabled("  "), "blank runs the probe");
        Expect(!WindowsFirewallProbe.IsEnabled("off"), "off switches it off");
        Expect(!WindowsFirewallProbe.IsEnabled("FALSE"), "false switches it off, case-insensitively");
        Expect(!WindowsFirewallProbe.IsEnabled("no"), "no switches it off");
        Expect(!WindowsFirewallProbe.IsEnabled("0"), "0 switches it off");
        Expect(!WindowsFirewallProbe.IsEnabled("-3"), "a negative number switches it off");
        Expect(WindowsFirewallProbe.IsEnabled("1"), "a positive number leaves it on");

        // Same rule as the watch's own threshold reader: a typo must not silently delete a diagnostic.
        Expect(WindowsFirewallProbe.IsEnabled("yes please"), "garbage leaves it on rather than switching it off");
    }

    private static void ParseReadsTheShapePowerShellEmits()
    {
        var facts = WindowsFirewallProbe.Parse(Json(
            rules: $$"""
                {"program":"{{Escaped(GamePath)}}","name":"Slay the Spire 2","enabled":"True","action":"Allow","profiles":"Domain, Private, Public"},
                {"program":"{{Escaped(GamePath)}}","name":"Slay the Spire 2","enabled":"True","action":"Allow","profiles":"Domain, Private, Public"}
                """,
            networks: """{"name":"Home","category":"Private"}""",
            inboundRuleCount: 412,
            programRuleCount: 96));
        Expect(facts is not null, "the captured shape parses");
        Expect(facts!.InboundRuleCount == 412 && facts.ProgramRuleCount == 96,
            "both 'did the query work' counters survive");
        Expect(facts.Rules.Count == 2 && facts.Rules[0].Enabled && facts.Rules[0].Action == "Allow",
            "rules keep their action and their enabled flag, which PowerShell renders as a string");
        Expect(facts.Networks.Count == 1 && facts.Networks[0].Category == "Private", "so does the network profile");

        // ConvertTo-Json collapses a one-element collection to a bare object on some hosts. Both shapes read.
        var single = WindowsFirewallProbe.Parse(
            "{\"inboundRuleCount\":1,\"programRuleCount\":1,\"rules\":{\"program\":\"" + Escaped(GamePath)
            + "\",\"name\":\"r\",\"enabled\":\"True\",\"action\":\"Allow\",\"profiles\":\"Any\"},"
            + "\"networks\":{\"name\":\"Home\",\"category\":\"Private\"}}");
        Expect(single?.Rules.Count == 1 && single.Networks.Count == 1, "a collapsed single result parses as one entry");

        Expect(WindowsFirewallProbe.Parse(null) is null, "no output is not a reading");
        Expect(WindowsFirewallProbe.Parse("") is null, "empty output is not a reading");
        Expect(WindowsFirewallProbe.Parse("not json at all") is null, "garbage is not a reading, and does not throw");
        Expect(WindowsFirewallProbe.Parse("[1,2,3]") is null, "a non-object answer is not a reading");
        Expect(WindowsFirewallProbe.Parse("""{"inboundRuleCount":3,"rules":[{"name":"no program"}]}""")?.Rules.Count == 0,
            "a rule with no program is dropped rather than matched against an empty path");
    }

    private static void EveryUncertainAnswerIsUnknownAndAccusesNobody()
    {
        var readings = new[]
        {
            WindowsFirewallProbe.Classify(null, GamePath),
            WindowsFirewallProbe.Classify(new WindowsFirewallFacts(0, 0, [], [], "no answer within 12s"), GamePath),
            WindowsFirewallProbe.Classify(new WindowsFirewallFacts(0, 0, [], [], null), GamePath),
            // The query ran, saw rules, and could not read a single program off any of them: that is a broken
            // query, not a statement that this game has no rules. The difference matters — one of them accuses.
            WindowsFirewallProbe.Classify(new WindowsFirewallFacts(412, 0, [], [], null), GamePath),
        };

        foreach (var reading in readings)
        {
            Expect(reading.Verdict == WindowsFirewallVerdict.Unknown, "an answer this cannot read is Unknown");
            Expect(!string.IsNullOrWhiteSpace(reading.Detail), "…and still says something");
            foreach (var accusation in new[] { "is blocking", "is blocked", "are blocked", "BLOCK rule", "no enabled inbound allow rule" })
            {
                Expect(!reading.Detail.Contains(accusation, StringComparison.OrdinalIgnoreCase),
                    $"…and accuses nothing (found '{accusation}')");
            }
        }
    }

    private static void ABlockRuleIsNamedAndExplained()
    {
        var reading = WindowsFirewallProbe.Classify(
            Facts(
                [
                    Rule(GamePath, "Slay the Spire 2", enabled: true, action: "Allow", profiles: "Private"),
                    Rule(GamePath, "Slay the Spire 2 (blocked)", enabled: true, action: "Block", profiles: "Private, Public"),
                ],
                [Network("Home", "Private")]),
            GamePath);

        Expect(reading.Verdict == WindowsFirewallVerdict.BlockRule,
            "an enabled block rule wins over an allow rule, which is the order Windows applies them in");
        Expect(reading.Detail.Contains("Slay the Spire 2 (blocked)", StringComparison.Ordinal),
            "the detail names the rule, so the player can find it in the list");
        Expect(reading.Detail.Contains("Cancel", StringComparison.Ordinal),
            "…and names where it usually came from, which is the thing nobody remembers doing");

        var disabledBlock = WindowsFirewallProbe.Classify(
            Facts(
                [
                    Rule(GamePath, "stale block", enabled: false, action: "Block", profiles: "Any"),
                    Rule(GamePath, "Slay the Spire 2", enabled: true, action: "Allow", profiles: "Any"),
                ],
                [Network("Home", "Private")]),
            GamePath);
        Expect(disabledBlock.Verdict == WindowsFirewallVerdict.Allowed,
            "a block rule that is switched OFF blocks nothing and must not be reported as one");
    }

    private static void NoAllowRuleIsSeparatedFromRulesThatAreMerelySwitchedOff()
    {
        // The query narrows to this game's executable, so the working "this game has no rule" shape is an empty
        // rule list against a healthy pair of counters — and a rule for another program, if one ever slipped
        // through, is still not this game's.
        var empty = WindowsFirewallProbe.Classify(
            new WindowsFirewallFacts(412, 96, [], [Network("Home", "Private")], null), GamePath);
        Expect(empty.Verdict == WindowsFirewallVerdict.NoAllowRule,
            "no rule for this game, from a query that plainly worked, is the answer this row exists to give");

        var none = WindowsFirewallProbe.Classify(
            Facts(
                [Rule(@"C:\Windows\System32\svchost.exe", "Core Networking", true, "Allow", "Any")],
                [Network("Home", "Private")]),
            GamePath);
        Expect(none.Verdict == WindowsFirewallVerdict.NoAllowRule, "another program's rule is not this game's");
        Expect(none.Detail.Contains("PROGRAM", StringComparison.Ordinal) && none.Detail.Contains("not a port", StringComparison.Ordinal),
            "the advice is the measured one: allow the program, which covers every player's port");

        var switchedOff = WindowsFirewallProbe.Classify(
            Facts(
                [Rule(GamePath, "Slay the Spire 2", enabled: false, action: "Allow", profiles: "Private")],
                [Network("Home", "Private")]),
            GamePath);
        Expect(switchedOff.Verdict == WindowsFirewallVerdict.NoAllowRule, "a disabled allow rule allows nothing");
        Expect(switchedOff.Detail.Contains("switched off", StringComparison.Ordinal),
            "…and the copy says the entry EXISTS but is off, which is a different thing to go and do");
    }

    private static void AnAllowedHostIsToldSoOutright()
    {
        // The measured stock shape: two per-program allow rules scoped to all three profiles, both adapters
        // Private (windows-connection-fingerprints.md §3).
        var reading = WindowsFirewallProbe.Classify(
            Facts(
                [
                    Rule(GamePath, "Slay the Spire 2", true, "Allow", "Domain, Private, Public"),
                    Rule(GamePath, "Slay the Spire 2", true, "Allow", "Domain, Private, Public"),
                ],
                [Network("Home", "Private")]),
            GamePath);
        Expect(reading.Verdict == WindowsFirewallVerdict.Allowed, "the stock allowed shape reads as allowed");
        Expect(reading.Detail.Contains("is not what is stopping the connection", StringComparison.Ordinal),
            "and the sentence EXONERATES the firewall, which is what moves the player on to the network");
        Expect(reading.Detail.Contains("guest Wi-Fi", StringComparison.OrdinalIgnoreCase)
            || reading.Detail.Contains("AP isolation", StringComparison.OrdinalIgnoreCase),
            "…by naming where to look next");

        // A rule written against an older install of the same game still matches by file name: it is the entry
        // the player will actually find, and a looser match can only ever produce a milder verdict.
        var moved = WindowsFirewallProbe.Classify(
            Facts(
                [Rule(@"D:\SteamLibrary\steamapps\common\Slay the Spire 2\SlayTheSpire2.exe", "Slay the Spire 2", true, "Allow", "Any")],
                [Network("Home", "Private")]),
            GamePath);
        Expect(moved.Verdict == WindowsFirewallVerdict.Allowed, "a rule for the same executable on another drive counts");

        var domain = WindowsFirewallProbe.Classify(
            Facts(
                [Rule(GamePath, "Slay the Spire 2", true, "Allow", "Domain")],
                [Network("corp.example", "DomainAuthenticated")]),
            GamePath);
        Expect(domain.Verdict == WindowsFirewallVerdict.Allowed,
            "DomainAuthenticated is what a connection profile calls the Domain firewall profile");
    }

    private static void ProfilesAreOnlyReportedWhenNOTHINGCoversAnActiveNetwork()
    {
        var mismatch = WindowsFirewallProbe.Classify(
            Facts(
                [Rule(GamePath, "Slay the Spire 2", true, "Allow", "Private")],
                [Network("Wi-Fi 2", "Public")]),
            GamePath);
        Expect(mismatch.Verdict == WindowsFirewallVerdict.ProfileMismatch,
            "a Private-only rule on a Public network permits nothing");
        Expect(mismatch.Detail.Contains("Wi-Fi 2", StringComparison.Ordinal) && mismatch.Detail.Contains("Public", StringComparison.Ordinal),
            "the detail names the network and what it is set to");
        Expect(mismatch.Detail.Contains("Network profile type", StringComparison.Ordinal),
            "…and the other fix, which is usually the better one");

        // THE false-alarm guard. A VPN or virtual adapter marked Public beside a covered Private LAN is the
        // normal shape of a developer's or a Hyper-V user's machine, and is not a finding.
        var vpnBeside = WindowsFirewallProbe.Classify(
            Facts(
                [Rule(GamePath, "Slay the Spire 2", true, "Allow", "Private")],
                [Network("Home", "Private"), Network("Mesh VPN", "Public")]),
            GamePath);
        Expect(vpnBeside.Verdict == WindowsFirewallVerdict.Allowed,
            "one covered network is enough — an uncovered second adapter is not an accusation");

        var noNetworks = WindowsFirewallProbe.Classify(
            Facts([Rule(GamePath, "Slay the Spire 2", true, "Allow", "Private")], []),
            GamePath);
        Expect(noNetworks.Verdict == WindowsFirewallVerdict.Allowed,
            "no readable connection profile is not evidence of a mismatch");
    }

    private static void TheProbeDoesNotRunOffWindows()
    {
        WindowsFirewallProbe.ResetForTests();
        var reading = WindowsFirewallProbe.ReadAsync().GetAwaiter().GetResult();
        if (OperatingSystem.IsWindows())
        {
            // On a real Windows host this is the live query. It may answer anything, including Unknown; what it
            // may not do is throw or hang, which getting here already proves.
            Expect(reading is not null, "a Windows host gets a reading");
            return;
        }

        Expect(reading is null, "no process is spawned off Windows — there is no powershell.exe to ask");
        WindowsFirewallProbe.ResetForTests();
    }

    // ---- helpers --------------------------------------------------------------------------------------------

    private static WindowsFirewallFacts Facts(WindowsFirewallRule[] rules, WindowsFirewallNetwork[] networks)
        => new(412, 96, rules, networks, null);

    private static WindowsFirewallRule Rule(string program, string name, bool enabled, string action, string profiles)
        => new(program, name, enabled, action, profiles);

    private static WindowsFirewallNetwork Network(string name, string category) => new(name, category);

    private static string Json(string rules, string networks, int inboundRuleCount, int programRuleCount)
        => $$"""
            {"inboundRuleCount":{{inboundRuleCount}},"programRuleCount":{{programRuleCount}},"rules":[{{rules}}],"networks":[{{networks}}]}
            """;

    private static string Escaped(string path) => path.Replace(@"\", @"\\", StringComparison.Ordinal);

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"WindowsFirewallProbeTests failed: {because}");
        }
    }
}
