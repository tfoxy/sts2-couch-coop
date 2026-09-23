using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.State;

// What the host says when the live lobby will not tell it how many players fit.
//
// The cap sizes seat limits, the ENet listener and browser admission, so "unknown" is a real state with a
// real notice attached. The trap this suite exists for is that unknown is also ORDINARY for a moment: issue
// #2 caught a macOS host reporting -1 at startup, in a session that then played for an hour. The old notice
// fired on that first read and latched for the process, so a healthy host carried a permanent-looking error
// and never a line saying it had resolved. Everything below is about the difference between "not yet" and
// "not ever".
//
// LobbyCapOf's state is static (the owning type is allocated per read), so every case resets it first and
// drives the clock by hand -- no test here waits on real time.
internal static class LobbyCapNoticeTests
{
    public static void Run()
    {
        AUsableCapIsReturnedAndSaysNothing();
        AFreshlyUnreadableCapIsSilent();
        TheNoticeSpeaksOnceTheGraceHasPassed();
        TheNoticeSpeaksOnlyOnce();
        ACapThatReadsBackWithinTheGraceNeverSpeaks();
        ACapThatReadsBackAfterTheNoticeIsRetracted();
        TheGraceRestartsAfterARecovery();
        AZeroCapIsTreatedLikeAnyOtherUnreadableOne();
        ACapOfOneIsNotAJoinableLobby();

        Console.WriteLine("LobbyCapNoticeTests: ok");
    }

    // Issue #2's exact value, from a real host.
    private const int NotYetNegotiated = -1;

    private static void AUsableCapIsReturnedAndSaysNothing()
    {
        var (cap, said) = Read(8);
        Expect(cap == 8, "a usable cap is returned as-is");
        Expect(said.Length == 0, "a usable cap says nothing");
    }

    // The regression. At T+0 the lobby has simply not answered yet.
    private static void AFreshlyUnreadableCapIsSilent()
    {
        var (cap, said) = Read(NotYetNegotiated);
        Expect(cap is null, "an unusable cap reads as unknown");
        Expect(said.Length == 0, "the first unusable read is silent");
    }

    private static void TheNoticeSpeaksOnceTheGraceHasPassed()
    {
        Reset();
        var at = Origin;
        Observe(NotYetNegotiated, at);
        var said = Observe(NotYetNegotiated, at + CouchCoopLobbyParticipation.UnreadableLobbyCapGrace);

        Expect(said.Length == 1, "the notice speaks once the grace has passed");
        Expect(said[0].Contains("-1", StringComparison.Ordinal), "the notice names the cap it saw");
        Expect(said[0].Contains("WITHOUT a known cap", StringComparison.Ordinal), "the notice says what is unsized");
    }

    private static void TheNoticeSpeaksOnlyOnce()
    {
        Reset();
        var at = Origin;
        Observe(NotYetNegotiated, at);
        Observe(NotYetNegotiated, at + CouchCoopLobbyParticipation.UnreadableLobbyCapGrace);
        var later = Observe(NotYetNegotiated, at + TimeSpan.FromHours(1));

        Expect(later.Length == 0, "a cap that stays unreadable is not repeated");
    }

    // The reporter's session: unknown for a moment, then fine. Nothing should reach the log at all.
    private static void ACapThatReadsBackWithinTheGraceNeverSpeaks()
    {
        Reset();
        var at = Origin;
        Observe(NotYetNegotiated, at);
        var said = Observe(4, at + CouchCoopLobbyParticipation.UnreadableLobbyCapGrace - TimeSpan.FromSeconds(1));

        Expect(said.Length == 0, "a cap that reads back inside the grace says nothing at all");
    }

    private static void ACapThatReadsBackAfterTheNoticeIsRetracted()
    {
        Reset();
        var at = Origin;
        Observe(NotYetNegotiated, at);
        Observe(NotYetNegotiated, at + CouchCoopLobbyParticipation.UnreadableLobbyCapGrace);
        var said = Observe(6, at + TimeSpan.FromMinutes(5));

        Expect(said.Length == 1, "a recovered cap is reported, so the log does not end on the alarm");
        Expect(said[0].Contains("now reports a player cap of 6", StringComparison.Ordinal),
            "the retraction names the cap that came back");
    }

    // A second outage is its own event and gets its own grace -- it must not inherit the first one's clock
    // and speak immediately.
    private static void TheGraceRestartsAfterARecovery()
    {
        Reset();
        var at = Origin;
        Observe(NotYetNegotiated, at);
        Observe(NotYetNegotiated, at + CouchCoopLobbyParticipation.UnreadableLobbyCapGrace);
        Observe(4, at + TimeSpan.FromMinutes(5));

        var immediately = Observe(NotYetNegotiated, at + TimeSpan.FromMinutes(5));
        Expect(immediately.Length == 0, "a second outage starts a fresh grace rather than speaking at once");

        var afterGrace = Observe(
            NotYetNegotiated,
            at + TimeSpan.FromMinutes(5) + CouchCoopLobbyParticipation.UnreadableLobbyCapGrace);
        Expect(afterGrace.Length == 1, "the second outage speaks once its own grace has passed");
    }

    // 0 means the read behind the snapshot failed. Same answer, same notice -- the caller cannot size
    // anything either way.
    private static void AZeroCapIsTreatedLikeAnyOtherUnreadableOne()
    {
        Reset();
        var at = Origin;
        Observe(0, at);
        var said = Observe(0, at + CouchCoopLobbyParticipation.UnreadableLobbyCapGrace);

        Expect(said.Length == 1, "a failed read speaks on the same terms");
        Expect(said[0].Contains(" 0 ", StringComparison.Ordinal), "the notice names the zero it saw");
    }

    private static void ACapOfOneIsNotAJoinableLobby()
    {
        Reset();
        var at = Origin;
        Expect(Cap(1, at) is null, "a one-player cap is not a lobby anyone can join");
    }

    private static readonly DateTimeOffset Origin = new(2026, 9, 23, 12, 0, 0, TimeSpan.Zero);

    private static void Reset()
    {
        CouchCoopLobbyParticipation.ResetLobbyCapNotice();
        CouchCoopLobbyParticipation.LobbyCapClock = () => Origin;
    }

    // One reset + one read, for the cases that only care about a cold start.
    private static (int? Cap, string[] Said) Read(int maxPlayers)
    {
        Reset();
        int? cap = null;
        var said = Capture(() => cap = Cap(maxPlayers, Origin));
        return (cap, said);
    }

    // One read at a chosen instant; returns whatever it wrote to stderr.
    private static string[] Observe(int maxPlayers, DateTimeOffset at) => Capture(() => Cap(maxPlayers, at));

    private static int? Cap(int maxPlayers, DateTimeOffset at)
    {
        CouchCoopLobbyParticipation.LobbyCapClock = () => at;
        return CouchCoopLobbyParticipation.LobbyCapOf(Lobby(maxPlayers));
    }

    private static string[] Capture(Action act)
    {
        var previous = Console.Error;
        var buffer = new StringWriter();
        Console.SetError(buffer);
        try
        {
            act();
        }
        finally
        {
            Console.SetError(previous);
        }

        return buffer.ToString()
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    private static StateCharacterSelectLobbySnapshot Lobby(int maxPlayers)
        => new(
            NetGameType: "host",
            LocalPlayerId: "p:1",
            HostPlayerId: "p:1",
            ConnectingPlayerCount: 0,
            Ascension: 0,
            MaxAscension: 20,
            Act1: "random",
            Seed: null,
            ModifierIds: [],
            Players: [],
            SavedRun: null,
            MaxPlayers: maxPlayers);

    private static void Expect(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"LobbyCapNoticeTests: {what}");
        }
    }
}
