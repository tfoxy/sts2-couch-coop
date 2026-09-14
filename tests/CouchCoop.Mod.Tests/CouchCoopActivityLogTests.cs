using CouchCoop.Mod.Activity;

// F1 host connectivity log: the ring and the copy.
//
// EVERYTHING testable about this feature is in here, because everything that is left of it is PURE. It had
// a Godot side once — CouchCoopActivityPanel, a RichTextLabel that rendered the ring in the lobby — and the
// connections panel replaced it, so the bbcode rendering and its tests went with it. What remains is the
// ring itself and the sentences it records: what a ring drop looks like, and exactly which sentence each
// event prints. All of it lives in Activity/, which has no Godot usings at all and runs in this Godot-less
// host.
//
// NOTE, and it is the reason this suite is worth keeping: the ring currently has NO production reader. The
// writers below are live (seat launches, viewer joins, server state), the display is not. Either this comes
// back in the connections panel or the whole subsystem goes; until then these tests are what stops the copy
// rotting in the meantime.
//
// The message strings are asserted LITERALLY on purpose: they are player-facing sentences in fourteen
// catalogs, so a copy edit has to be a deliberate change rather than something that slips through green.
internal static class CouchCoopActivityLogTests
{
    public static void Run()
    {
        try
        {
            AppendAssignsMonotonicSequences();
            RingWrapsAndKeepsTheNewest();
            AppendDistinctSuppressesOnlyAnImmediateRepeat();
            BlankMessagesAreDropped();
            SnapshotSinceFeedsAReaderIncrementally();
            SnapshotSinceReportsTruncationWhenTheRingOutranTheReader();
            ConcurrentAppendsKeepEverySequence();

            NameFallbackAndTrimming();
            SeatMessagesAreTheContract();
            ViewerMessagesAreTheContract();
            JoinRejectionCopyIsMapped();
            ServerMessagesAreTheContract();
        }
        finally
        {
            // Process-global state: leave it clean for the suites that run after this one (they append to
            // the same ring as a side effect of exercising the manager / the server).
            CouchCoopActivityLog.SetClockForTests(null);
            CouchCoopActivityLog.Reset();
        }

        Console.WriteLine("CouchCoopActivityLogTests: ok");
    }

    // ---- the ring ----------------------------------------------------------------------------------------

    private static void AppendAssignsMonotonicSequences()
    {
        CouchCoopActivityLog.Reset();
        Assert(CouchCoopActivityLog.NewestSequence == 0, "a fresh log has no newest sequence");
        Assert(CouchCoopActivityLog.Count == 0, "a fresh log is empty");
        Assert(CouchCoopActivityLog.NewestSeverity is null, "a fresh log has no severity to report");
        Assert(CouchCoopActivityLog.Snapshot().Count == 0, "a fresh log snapshots empty");

        CouchCoopActivityLog.Append(CouchCoopActivityCategory.Seat, CouchCoopActivitySeverity.Info, "one");
        CouchCoopActivityLog.Append(CouchCoopActivityCategory.Viewer, CouchCoopActivitySeverity.Bad, "two");

        var entries = CouchCoopActivityLog.Snapshot();
        Assert(entries.Count == 2, "both entries are retained");
        Assert(entries[0].Sequence == 1 && entries[1].Sequence == 2, "sequences are 1-based and monotonic");
        Assert(entries[0].Message == "one" && entries[1].Message == "two", "entries come back OLDEST first");
        Assert(entries[0].Category == CouchCoopActivityCategory.Seat, "the category round-trips");
        Assert(CouchCoopActivityLog.NewestSequence == 2, "NewestSequence is the newest entry's sequence");
        Assert(CouchCoopActivityLog.Count == 2, "Count is what is retained");
        Assert(CouchCoopActivityLog.NewestSeverity == CouchCoopActivitySeverity.Bad,
            "NewestSeverity follows the newest entry (this is what puts 'needs attention' on the header)");
    }

    private static void RingWrapsAndKeepsTheNewest()
    {
        CouchCoopActivityLog.Reset();
        const int overflow = CouchCoopActivityLog.Capacity + 17;
        for (var i = 1; i <= overflow; i++)
        {
            CouchCoopActivityLog.Append(CouchCoopActivityCategory.Server, CouchCoopActivitySeverity.Info, $"m{i}");
        }

        var entries = CouchCoopActivityLog.Snapshot();
        Assert(entries.Count == CouchCoopActivityLog.Capacity, "the ring never grows past its capacity");
        Assert(CouchCoopActivityLog.Count == CouchCoopActivityLog.Capacity, "…and Count says so");
        // The OLDEST lines are the ones dropped: a host reads the bottom of this panel, not the top.
        Assert(entries[^1].Message == $"m{overflow}", "the newest entry survives the wrap");
        Assert(entries[0].Message == $"m{overflow - CouchCoopActivityLog.Capacity + 1}",
            "the oldest RETAINED entry is exactly capacity back from the newest");
        Assert(entries[0].Sequence == overflow - CouchCoopActivityLog.Capacity + 1,
            "sequences keep counting past the wrap (they are not ring indices)");

        for (var i = 1; i < entries.Count; i++)
        {
            Assert(entries[i].Sequence == entries[i - 1].Sequence + 1, "a wrapped snapshot is still contiguous");
        }
    }

    private static void AppendDistinctSuppressesOnlyAnImmediateRepeat()
    {
        CouchCoopActivityLog.Reset();
        Assert(
            CouchCoopActivityLog.AppendDistinct(CouchCoopActivityCategory.Server, CouchCoopActivitySeverity.Warn, "seat offline"),
            "the first AppendDistinct always lands");
        Assert(
            !CouchCoopActivityLog.AppendDistinct(CouchCoopActivityCategory.Server, CouchCoopActivitySeverity.Warn, "seat offline"),
            "an identical repeat of the NEWEST entry is suppressed (this is what stops a per-tick evaluator filling the ring)");
        Assert(CouchCoopActivityLog.Count == 1, "…and nothing was appended");

        // Same text, different severity/category is a different fact and is kept.
        Assert(
            CouchCoopActivityLog.AppendDistinct(CouchCoopActivityCategory.Server, CouchCoopActivitySeverity.Good, "seat offline"),
            "a repeat at a different severity is a different entry");
        Assert(
            CouchCoopActivityLog.AppendDistinct(CouchCoopActivityCategory.Seat, CouchCoopActivitySeverity.Good, "seat offline"),
            "a repeat in a different category is a different entry");

        // Only the NEWEST entry is compared: a recurrence after something else happened genuinely recurred.
        CouchCoopActivityLog.Reset();
        CouchCoopActivityLog.AppendDistinct(CouchCoopActivityCategory.Server, CouchCoopActivitySeverity.Warn, "a");
        CouchCoopActivityLog.AppendDistinct(CouchCoopActivityCategory.Server, CouchCoopActivitySeverity.Warn, "b");
        Assert(
            CouchCoopActivityLog.AppendDistinct(CouchCoopActivityCategory.Server, CouchCoopActivitySeverity.Warn, "a"),
            "'a' after 'b' is a new event, not a repeat");
        Assert(CouchCoopActivityLog.Count == 3, "…and all three are retained");
    }

    private static void BlankMessagesAreDropped()
    {
        CouchCoopActivityLog.Reset();
        CouchCoopActivityLog.Append(CouchCoopActivityCategory.Seat, CouchCoopActivitySeverity.Info, "");
        CouchCoopActivityLog.Append(CouchCoopActivityCategory.Seat, CouchCoopActivitySeverity.Info, "   ");
        Assert(
            !CouchCoopActivityLog.AppendDistinct(CouchCoopActivityCategory.Seat, CouchCoopActivitySeverity.Info, "  "),
            "AppendDistinct reports a blank as not appended");
        Assert(CouchCoopActivityLog.Count == 0,
            "a blank message renders as an empty row, which reads as a glitch — it is dropped instead");
    }

    private static void SnapshotSinceFeedsAReaderIncrementally()
    {
        CouchCoopActivityLog.Reset();
        CouchCoopActivityLog.Append(CouchCoopActivityCategory.Seat, CouchCoopActivitySeverity.Info, "one");
        CouchCoopActivityLog.Append(CouchCoopActivityCategory.Seat, CouchCoopActivitySeverity.Info, "two");

        var all = CouchCoopActivityLog.SnapshotSince(0, out var fromScratch);
        Assert(all.Count == 2 && !fromScratch, "since 0 is everything, and nothing was missed");

        var tail = CouchCoopActivityLog.SnapshotSince(1, out var afterOne);
        Assert(tail.Count == 1 && tail[0].Message == "two" && !afterOne, "since 1 is just the newer entry");

        var caughtUp = CouchCoopActivityLog.SnapshotSince(2, out var afterTwo);
        Assert(caughtUp.Count == 0 && !afterTwo,
            "a caught-up reader gets nothing — this is the 4Hz panel tick's normal answer");

        // A cursor ahead of the log (a Reset under a live panel) must not throw or resurrect anything.
        var ahead = CouchCoopActivityLog.SnapshotSince(99, out var aheadTruncated);
        Assert(ahead.Count == 0 && !aheadTruncated, "a cursor past the newest entry reads empty, not negative");

        CouchCoopActivityLog.Reset();
        Assert(CouchCoopActivityLog.SnapshotSince(5, out var emptyTruncated).Count == 0 && !emptyTruncated,
            "an empty log is never 'truncated' — there is nothing the reader missed");
    }

    private static void SnapshotSinceReportsTruncationWhenTheRingOutranTheReader()
    {
        CouchCoopActivityLog.Reset();
        for (var i = 1; i <= CouchCoopActivityLog.Capacity + 10; i++)
        {
            CouchCoopActivityLog.Append(CouchCoopActivityCategory.Seat, CouchCoopActivitySeverity.Info, $"m{i}");
        }

        // A panel that last rendered entry 1 can no longer append its way forward: entries 2..11 are gone.
        var stale = CouchCoopActivityLog.SnapshotSince(1, out var truncated);
        Assert(truncated, "a reader the ring outran is told so, so the panel redraws instead of appending a gap");
        Assert(stale.Count == CouchCoopActivityLog.Capacity, "…and gets everything that is still retained");

        // A reader inside the retained window is NOT truncated.
        var oldestRetained = stale[0].Sequence;
        _ = CouchCoopActivityLog.SnapshotSince(oldestRetained, out var stillFine);
        Assert(!stillFine, "a reader still inside the window appends normally");
        _ = CouchCoopActivityLog.SnapshotSince(oldestRetained - 1, out var justInside);
        Assert(!justInside, "the boundary case (cursor exactly one before the oldest retained) is NOT truncated");
        _ = CouchCoopActivityLog.SnapshotSince(oldestRetained - 2, out var justOutside);
        Assert(justOutside, "…and one further back IS");
    }

    private static void ConcurrentAppendsKeepEverySequence()
    {
        // Producers append from the accept loop, the scene-watcher thread, the readiness poller and the game
        // main thread — several of them from inside their OWN locks. A torn ring would show up as a duplicate
        // or missing sequence.
        CouchCoopActivityLog.Reset();
        const int threads = 8;
        const int perThread = 200;

        var tasks = new Task[threads];
        for (var t = 0; t < threads; t++)
        {
            var id = t;
            tasks[t] = Task.Run(() =>
            {
                for (var i = 0; i < perThread; i++)
                {
                    CouchCoopActivityLog.Append(
                        CouchCoopActivityCategory.Viewer,
                        CouchCoopActivitySeverity.Info,
                        $"t{id}-{i}");
                }
            });
        }

        Task.WaitAll(tasks);

        Assert(CouchCoopActivityLog.NewestSequence == threads * perThread,
            "every concurrent append got its own sequence (no lost updates)");
        var entries = CouchCoopActivityLog.Snapshot();
        Assert(entries.Count == CouchCoopActivityLog.Capacity, "the ring is full");
        for (var i = 1; i < entries.Count; i++)
        {
            Assert(entries[i].Sequence == entries[i - 1].Sequence + 1, "the retained window is contiguous");
        }
    }

    // ---- copy --------------------------------------------------------------------------------------------

    private static void NameFallbackAndTrimming()
    {
        Assert(CouchCoopActivityMessages.Who("Ann") == "Ann", "a name is used as given");
        Assert(CouchCoopActivityMessages.Who("  Ann  ") == "Ann", "incidental whitespace is trimmed");
        Assert(CouchCoopActivityMessages.Who(null) == "A player", "an anonymous viewer has a name to be called");
        Assert(CouchCoopActivityMessages.Who("   ") == "A player", "…and so does a blank one");
    }

    private static void SeatMessagesAreTheContract()
    {
        Assert(CouchCoopActivityMessages.SeatReconnected("Ann") == "Ann is back — reconnected to their game.", "S1/S2");
        Assert(CouchCoopActivityMessages.SeatPoolFull("Ann") == "Ann couldn't join — every player slot is in use.", "S3");
        Assert(CouchCoopActivityMessages.SeatLaunching("Ann") == "Starting Ann's game window…", "S4");
        Assert(CouchCoopActivityMessages.SeatLaunchFailed("Ann") == "Couldn't start Ann's game window.", "S5/S6");
        Assert(
            CouchCoopActivityMessages.SeatLaunchOpened("Ann") == "Ann's game window opened — loading (this takes a moment).",
            "S7 — the copy must say 'loading', or a host thinks the phone is ready when it is 30s away");
        Assert(
            CouchCoopActivityMessages.SeatNoLocalTransport("Ann")
                == "Couldn't start Ann's game window — this host has no local connection for player games.",
            "S8");
        Assert(CouchCoopActivityMessages.SeatExitedEarly("Ann") == "Ann's game window closed while starting up.", "S9");
        Assert(CouchCoopActivityMessages.SeatReady("Ann") == "Ann's game is ready.", "S10");
        Assert(
            CouchCoopActivityMessages.SeatStartTimedOut("Ann") == "Ann's game took too long to start — stopping it.",
            "S11");
        Assert(CouchCoopActivityMessages.SeatReleased("Ann") == "Ann left — their game window was closed.", "S12");
        Assert(
            CouchCoopActivityMessages.SeatDetached("Ann")
                == "Ann's phone disconnected — keeping their game open so they can rejoin.",
            "S13 — 'keeping' is load-bearing: without it a host reads a mid-run drop as a player lost");
        Assert(
            CouchCoopActivityMessages.SeatStuckReaped("Ann")
                == "Ann's game stopped responding — closing it so they can start again.",
            "S14");
        Assert(CouchCoopActivityMessages.SeatWindowGone("Ann") == "Ann's game window is no longer running.", "S15");
        Assert(CouchCoopActivityMessages.SeatRunEndReaped("Ann") == "The run ended — closed Ann's game window.", "S16");
        Assert(
            CouchCoopActivityMessages.SeatsShuttingDown == "Closing Couch Co-Op — shutting down all player game windows.",
            "S17");

        // Seat status transitions (MirrorSeatDirectory).
        Assert(
            CouchCoopActivityMessages.SeatWentOffline("Ann")
                == "Ann's seat is offline — reload the saved run to let them rejoin.",
            "the offline line names the remedy, which is the HOST's to perform");
        Assert(CouchCoopActivityMessages.SeatAvailableAgain("Ann") == "Ann's seat is available again.", "seat recovery");

        // The unnamed shape of the one a host is most likely to meet with no name attached.
        Assert(
            CouchCoopActivityMessages.SeatPoolFull(null) == "A player couldn't join — every player slot is in use.",
            "an anonymous refusal still reads as a sentence");
    }

    private static void ViewerMessagesAreTheContract()
    {
        Assert(CouchCoopActivityMessages.ViewerConnected("Ann") == "Ann connected.", "V1");
        Assert(CouchCoopActivityMessages.ViewerWatching("Ann") == "Ann connected — watching this screen.", "V2");
        Assert(CouchCoopActivityMessages.ViewerHandedOff("Ann") == "Ann is opening their own game window…", "V3");
        Assert(
            CouchCoopActivityMessages.ViewerRejected("Ann", "no-free-instance")
                == "Ann couldn't join: every player slot is in use",
            "V4 composes the mapped reason");
        Assert(CouchCoopActivityMessages.ViewerDisconnected("Ann") == "Ann's phone disconnected.", "V5");
    }

    private static void JoinRejectionCopyIsMapped()
    {
        Assert(
            CouchCoopActivityMessages.DescribeJoinRejection("no-free-instance") == "every player slot is in use",
            "the pool-full code");
        Assert(
            CouchCoopActivityMessages.DescribeJoinRejection("not-a-session-player") == "that name isn't part of this session",
            "the unknown-name code");
        Assert(
            CouchCoopActivityMessages.DescribeJoinRejection("spawn-failed") == "their game window couldn't be started",
            "the spawn-failure code");
        Assert(
            CouchCoopActivityMessages.DescribeJoinRejection("join-failed") == "something went wrong on this PC",
            "the server-fault code");
        Assert(
            CouchCoopActivityMessages.DescribeJoinRejection(CouchCoop.MirrorProtocol.Envelopes.MirrorSeatStatuses.UnavailableRejection)
                == "that seat isn't available right now",
            "the seat-unavailable code — the literal in the switch must track the protocol constant");
        // An unrecognised code falls back to itself rather than to a friendly lie: a raw code on screen is
        // still something a host can report, "something went wrong" is not.
        Assert(CouchCoopActivityMessages.DescribeJoinRejection("brand-new-code") == "brand-new-code",
            "an unknown code is shown verbatim");
        Assert(CouchCoopActivityMessages.DescribeJoinRejection(null) == "the host refused the join",
            "a missing code still produces a sentence");
    }

    private static void ServerMessagesAreTheContract()
    {
        Assert(
            CouchCoopActivityMessages.BrowserServerReady("http://192.168.1.5:13337/")
                == "Phone connection ready — http://192.168.1.5:13337/",
            "B1 carries the ADVERTISED url (a wildcard would be untypeable)");
        Assert(
            CouchCoopActivityMessages.BrowserServerNoAddress
                == "Phone connection started, but this PC has no network address to share.",
            "B2");
        Assert(CouchCoopActivityMessages.BrowserServerFailed == "Couldn't start the phone connection service.", "B3/B7");
        Assert(CouchCoopActivityMessages.SecureOriginReady == "Secure (https) link is ready.", "B4");
        Assert(
            CouchCoopActivityMessages.SecureOriginUnavailable("Needs a normal network address on this PC.")
                == "Secure (https) link unavailable — Needs a normal network address on this PC.",
            "B5 reuses the QR dialog's own player-shaped reason rather than re-writing it");
        Assert(
            CouchCoopActivityMessages.SecureOriginUnavailable(null) == "Secure (https) link unavailable.",
            "B5 without a reason is still a complete sentence");
        Assert(CouchCoopActivityMessages.BrowserServerStopped == "Phone connection stopped.", "B6");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"CouchCoopActivityLogTests failed: {label}.");
        }
    }
}
