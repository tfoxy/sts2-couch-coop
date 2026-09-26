using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;

// When does the pause menu's "Couch Co-Op QR Code" row exist?
//
// The entry re-evaluates this every time the pause menu becomes visible (and only then) and shows or hides the row
// from the answer, so this predicate is also the row's teardown path — there is no second "hide it now" branch that could
// fall out of sync. The negative cases are the interesting ones, for the same reason they are in
// CouchCoopLobbyHostGateTests: a row left on a singleplayer run is a QR that promises a join nobody can perform.
internal static class CouchCoopPauseMenuGateTests
{
    public static void Run()
    {
        HostRunWithAListenerShows();
        SingleplayerRunIsRefused();
        ClientRunIsRefused();
        LobbyIsRefused();
        UnknownStateIsRefused();
        MissingListenerIsRefused();
        TheTwoGatesCoverDifferentMoments();

        Console.WriteLine("CouchCoopPauseMenuGateTests: ok");
    }

    private static readonly Uri Listener = new("http://0.0.0.0:13337/");

    // The whole point of the row: mid-run, when the lobby button is long gone and a device that already has a
    // seat has lost its browser.
    private static void HostRunWithAListenerShows()
    {
        Expect(
            CouchCoopPauseMenuGate.ShouldShow(Listener, Facts(true, null, "host")),
            "a hosted run with a listener shows the row");
    }

    // A couch-coop host reports "host" even alone in the run, so this is NOT a stand-in for "nobody else is
    // here" — a true singleplayer run is a different net game type entirely, and nothing can join it.
    private static void SingleplayerRunIsRefused()
    {
        Expect(
            !CouchCoopPauseMenuGate.ShouldShow(Listener, Facts(true, null, "singleplayer")),
            "a singleplayer run is refused");
    }

    // We joined someone else's session: their browser players are their host's to serve, and our URL would hand
    // out a seat we do not own. The game hides Give Up and Save-and-Quit on the same distinction.
    private static void ClientRunIsRefused()
    {
        Expect(
            !CouchCoopPauseMenuGate.ShouldShow(Listener, Facts(true, null, "client")),
            "a run we joined as a client is refused");
    }

    // The pause menu does not exist outside a run, but the gate must not answer yes on lobby state either — a
    // future caller reading it from the wrong screen should get a no, not a lobby's answer.
    private static void LobbyIsRefused()
    {
        Expect(
            !CouchCoopPauseMenuGate.ShouldShow(Listener, Facts(false, "host", null)),
            "a host LOBBY is not a host run");
    }

    private static void UnknownStateIsRefused()
    {
        Expect(!CouchCoopPauseMenuGate.ShouldShow(Listener, null), "facts that could not be read are refused");
        Expect(
            !CouchCoopPauseMenuGate.ShouldShow(Listener, Facts(false, null, null)),
            "the main menu is refused");
    }

    // No browser server means no URL to encode, so the dialog would have nothing to show.
    private static void MissingListenerIsRefused()
    {
        Expect(!CouchCoopPauseMenuGate.ShouldShow(null, Facts(true, null, "host")), "no listener means no row");
    }

    // The two gates are deliberately DISJOINT: the lobby one requires `Run: null` because it answers "can a NEW
    // device join?", this one requires a run because it answers "is the URL worth anything to a device that
    // already has a seat?". If they ever overlapped, both entry points would be on screen at once — and if a
    // change made this one inherit the lobby's `Run: null`, the row would never appear at all.
    private static void TheTwoGatesCoverDifferentMoments()
    {
        foreach (var (facts, label) in new (GateFacts? Facts, string Label)[]
        {
            (Facts(false, "host", null), "host lobby"),
            (Facts(false, "singleplayer", null), "singleplayer lobby"),
            (Facts(true, null, "host"), "hosted run"),
            (Facts(true, null, "singleplayer"), "singleplayer run"),
            (Facts(true, null, "client"), "client run"),
            (Facts(false, null, null), "main menu"),
            (null, "unavailable facts"),
        })
        {
            Expect(
                !(CouchCoopLobbyHostGate.ShouldShow(Listener, facts)
                    && CouchCoopPauseMenuGate.ShouldShow(Listener, facts)),
                $"at most one QR entry point is gated on ({label})");
        }
    }

    private static GateFacts Facts(bool run, string? lobby, string? runType) => new(run, lobby, runType);

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"CouchCoopPauseMenuGateTests failed: {because}");
        }
    }
}
