using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Session;

// When does the host get a MODAL about a degraded hosting transport?
//
// Background: when Steam is initialised but offline the mod silently falls back to a LAN-only ENet host.
// That fact used to surface only as a small tip line inside the QR dialog, which a host who never opens
// that dialog never sees — so they sit in the lobby wondering why a remote friend cannot connect. It now
// also pops a modal.
//
// The rule is "once per lobby mount", and the latch is deliberately IN MEMORY ONLY: no preference file,
// nothing in COUCHCOOP_QR_PREFS, no "don't show again". A modal that could only ever be seen once per
// process would be worse than the tip line the moment a host backs out to the menu and comes back.
//
// The decision is a pure function over an explicit state value (the style QrHostOptions.Build
// established) precisely so this whole rule is testable with no game, no Godot and no clock.
internal static class HostTransportAlertTests
{
    public static void Run()
    {
        OutsideAHostLobbyNothingEverOpens();
        AMountedLobbyWithANoteOpensExactlyOnce();
        UnmountReArmsSoTheNextLobbyShowsItAgain();
        AHealthyTransportNeverOpens();
        ANoteThatArrivesLateInTheSameMountStillOpens();
        TheTextIsTheTransportsOwnNote();
        NothingIsRememberedAcrossAFreshState();

        Console.WriteLine("HostTransportAlertTests: ok");
    }

    private const string Note = "Steam offline — remote friends can't join. Couch/LAN play only.";

    // ---- the negative cases -----------------------------------------------------------------------

    // hostLobbyMounted is CouchCoopLobbyHostGate.ShouldShow plus "a panel is installed on a visible
    // screen", so the main menu, a run in progress, and singleplayer/client lobbies all arrive here as
    // false. None of them may pop a modal — the alert is about REMOTE FRIENDS JOINING, which is only a
    // question in a multiplayer host lobby.
    private static void OutsideAHostLobbyNothingEverOpens()
    {
        var state = HostTransportAlertState.Initial;
        for (var tick = 0; tick < 5; tick++)
        {
            var decision = HostTransportAlert.Decide(state, hostLobbyMounted: false, Note);
            Expect(!decision.Open, $"an unmounted screen never opens the alert (tick {tick})");
            Expect(decision.Text.Length == 0, "a closed decision carries no text");
            state = decision.Next;
        }

        Expect(state == HostTransportAlertState.Initial, "an unmounted tick leaves the latch armed");
    }

    private static void AHealthyTransportNeverOpens()
    {
        foreach (var note in new[] { null, "", "   " })
        {
            var decision = HostTransportAlert.Decide(HostTransportAlertState.Initial, hostLobbyMounted: true, note);
            Expect(!decision.Open, $"no note means no alert (note: {note ?? "null"})");
            // ...and crucially the latch is NOT spent, or a note arriving a tick later would be swallowed.
            Expect(!decision.Next.ShownThisMount, "a healthy tick does not consume the mount's one showing");
        }
    }

    // ---- once per mount ---------------------------------------------------------------------------

    private static void AMountedLobbyWithANoteOpensExactlyOnce()
    {
        var state = HostTransportAlertState.Initial;

        var first = HostTransportAlert.Decide(state, hostLobbyMounted: true, Note);
        Expect(first.Open, "the first mounted tick with a note opens the alert");
        state = first.Next;

        // The scan runs four times a second for as long as the lobby is up; none of those may reopen it.
        for (var tick = 0; tick < 20; tick++)
        {
            var again = HostTransportAlert.Decide(state, hostLobbyMounted: true, Note);
            Expect(!again.Open, $"a later tick in the same mount does not reopen it (tick {tick})");
            state = again.Next;
        }
    }

    private static void UnmountReArmsSoTheNextLobbyShowsItAgain()
    {
        var state = HostTransportAlert.Decide(HostTransportAlertState.Initial, true, Note).Next;
        Expect(HostTransportAlert.Decide(state, true, Note).Open == false, "still latched while mounted");

        // Back out to the menu...
        state = HostTransportAlert.Decide(state, hostLobbyMounted: false, Note).Next;
        Expect(state == HostTransportAlertState.Initial, "unmounting resets the latch to its initial value");

        // ...and back in.
        var second = HostTransportAlert.Decide(state, hostLobbyMounted: true, Note);
        Expect(second.Open, "the next mount shows the alert again");
        Expect(!HostTransportAlert.Decide(second.Next, true, Note).Open, "and is once-per-mount again");

        // Three mounts in a row, to be sure the re-arm is not a one-off.
        var opens = 0;
        var walk = HostTransportAlertState.Initial;
        foreach (var mounted in new[] { true, true, false, true, true, true, false, true })
        {
            var decision = HostTransportAlert.Decide(walk, mounted, Note);
            if (decision.Open)
            {
                opens++;
            }

            walk = decision.Next;
        }

        Expect(opens == 3, $"three mounts produced three alerts (got {opens})");
    }

    private static void ANoteThatArrivesLateInTheSameMountStillOpens()
    {
        // The transport reports its state from a Harmony patch on host start; the lobby screen can be up
        // a tick or two earlier. Swallowing the alert because the first tick happened to see no note
        // would make this feature silently unreliable.
        var state = HostTransportAlertState.Initial;
        for (var tick = 0; tick < 3; tick++)
        {
            var quiet = HostTransportAlert.Decide(state, hostLobbyMounted: true, transportNote: null);
            Expect(!quiet.Open, "no alert while the transport has said nothing");
            state = quiet.Next;
        }

        var late = HostTransportAlert.Decide(state, hostLobbyMounted: true, Note);
        Expect(late.Open, "the note arriving mid-mount still opens the alert");
        Expect(!HostTransportAlert.Decide(late.Next, true, Note).Open, "and only once");
    }

    // ---- the payload ------------------------------------------------------------------------------

    // The seam is a plain string on CouchCoopHostUiNotices precisely so the UI takes no compile-time
    // dependency on the networking layer. This test is the one place the two ends are checked against
    // each other, and it does it by VALUE rather than by wiring the types together.
    private static void TheTextIsTheTransportsOwnNote()
    {
        Expect(CouchCoopHostTransport.SteamOfflineNote == Note,
            $"the transport's Steam-offline note is unchanged (got {CouchCoopHostTransport.SteamOfflineNote})");

        var decision = HostTransportAlert.Decide(
            HostTransportAlertState.Initial, true, CouchCoopHostTransport.SteamOfflineNote);
        Expect(decision.Open, "the transport's own note opens the alert");
        Expect(decision.Text == CouchCoopHostTransport.SteamOfflineNote,
            "the modal renders exactly the note the transport published, with nothing invented");

        // Surrounding whitespace is trimmed rather than rendered.
        Expect(HostTransportAlert.Decide(HostTransportAlertState.Initial, true, $"  {Note}  ").Text == Note,
            "the note is trimmed before it reaches the label");

        // The seam itself: the property the transport writes and both surfaces read.
        var previous = CouchCoopHostUiNotices.HostTransportNote;
        try
        {
            CouchCoopHostUiNotices.HostTransportNote = null;
            Expect(!HostTransportAlert.Decide(HostTransportAlertState.Initial, true, CouchCoopHostUiNotices.HostTransportNote).Open,
                "an unset seam pops nothing");

            CouchCoopHostUiNotices.HostTransportNote = CouchCoopHostTransport.SteamOfflineNote;
            Expect(HostTransportAlert.Decide(HostTransportAlertState.Initial, true, CouchCoopHostUiNotices.HostTransportNote).Open,
                "the seam carries the transport's note through to the decision");
        }
        finally
        {
            CouchCoopHostUiNotices.HostTransportNote = previous;
        }
    }

    // The latch is a value with no hidden storage: constructing a fresh Initial is the entire "re-arm",
    // which is what makes "absolutely no on-disk persistence" structurally true rather than a promise.
    private static void NothingIsRememberedAcrossAFreshState()
    {
        var spent = HostTransportAlert.Decide(HostTransportAlertState.Initial, true, Note).Next;
        Expect(spent.ShownThisMount, "the latch records the showing");
        Expect(HostTransportAlert.Decide(HostTransportAlertState.Initial, true, Note).Open,
            "a fresh Initial state is fully armed regardless of what any other state remembers");
        Expect(HostTransportAlertState.Initial is { Mounted: false, ShownThisMount: false },
            "Initial is the all-false value");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"HostTransportAlertTests failed: {because}");
        }
    }
}
