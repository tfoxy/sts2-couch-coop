using CouchCoop.Mod.Activity;

// F1 host connectivity log: the ring, the copy and the bbcode rendering.
//
// EVERYTHING testable about this feature is in here, because everything testable about it is PURE. The
// Godot side (CouchCoopActivityPanel) is a thin adapter that positions nodes and calls AppendText; the
// decisions worth pinning — what a ring drop looks like, whether a viewer name can inject bbcode into the
// host's television, exactly which sentence each event prints — all live in Activity/, which has no Godot
// usings at all and runs in this Godot-less host.
//
// The message strings are asserted LITERALLY on purpose. They are a QA contract shared with
// scripts/probe-pc-lobby-activity-log.mjs (which greps the rendered panel for them), so a copy edit has to
// be a deliberate three-file change rather than something that slips through green.
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
            SnapshotSinceFeedsThePanelIncrementally();
            SnapshotSinceReportsTruncationWhenTheRingOutranTheReader();
            ConcurrentAppendsKeepEverySequence();

            NameFallbackAndTrimming();
            SeatMessagesAreTheContract();
            ViewerMessagesAreTheContract();
            JoinRejectionCopyIsMapped();
            ServerMessagesAreTheContract();

            BbcodeIsEscapedInUntrustedText();
            SeverityColoursAreStable();
            RowCarriesAnInjectedClocksTime();
            ToBbcodeRendersEveryRowInOrder();
            TruncatedHeadIsRenderedOnce();
            HeaderSummaryVariants();
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

    private static void SnapshotSinceFeedsThePanelIncrementally()
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

    // ---- rendering ---------------------------------------------------------------------------------------

    private static void BbcodeIsEscapedInUntrustedText()
    {
        // THE security-shaped assertion in this file. Half of what the panel prints is a display name typed
        // into a browser by whoever is on the couch, and the label has bbcode ENABLED — so an unescaped
        // name lets a phone recolour, bold, or (with an unclosed tag) swallow the host's television.
        // `[lb]` is Godot's own escape for a literal '['. Only the OPENING bracket needs it: with no tag able
        // to open, the trailing ']' is inert text.
        Assert(CouchCoopActivityRender.EscapeBbcode("[b]Ann") == "[lb]b]Ann",
            "an opening tag bracket becomes the literal-bracket escape");
        Assert(CouchCoopActivityRender.EscapeBbcode("[b]Ann[/b]") == "[lb]b]Ann[lb]/b]",
            "…and so does EVERY one of them, not just the first");
        Assert(CouchCoopActivityRender.EscapeBbcode("plain") == "plain", "ordinary text is untouched");
        Assert(CouchCoopActivityRender.EscapeBbcode("a]b") == "a]b", "a lone ']' is inert once no tag can open");
        Assert(CouchCoopActivityRender.EscapeBbcode(null) == string.Empty, "null renders as nothing, not as 'null'");

        var entry = new CouchCoopActivityEntry(
            1,
            new DateTimeOffset(2026, 9, 2, 21, 5, 9, TimeSpan.Zero),
            CouchCoopActivityCategory.Viewer,
            CouchCoopActivitySeverity.Good,
            "[color=red]Ann[/color] connected.");
        var row = CouchCoopActivityRender.RowBbcode(entry);
        Assert(!row.Contains("[color=red]", StringComparison.Ordinal),
            "a name carrying a colour tag cannot reach the label as markup");
        Assert(row.Contains("[lb]color=red]", StringComparison.Ordinal), "…it reaches it as text");
    }

    private static void SeverityColoursAreStable()
    {
        Assert(CouchCoopActivityRender.ColorFor(CouchCoopActivitySeverity.Info) == "#fdf4e3", "info is the lobby cream");
        Assert(CouchCoopActivityRender.ColorFor(CouchCoopActivitySeverity.Good) == "#8fd6a0", "good is green");
        Assert(CouchCoopActivityRender.ColorFor(CouchCoopActivitySeverity.Warn) == "#f0c674", "warn is amber");
        Assert(CouchCoopActivityRender.ColorFor(CouchCoopActivitySeverity.Bad) == "#e88b8b", "bad is red");
        Assert(CouchCoopActivityRender.ColorFor((CouchCoopActivitySeverity)99) == "#fdf4e3",
            "an unknown severity degrades to neutral rather than rendering an empty colour tag");
    }

    private static void RowCarriesAnInjectedClocksTime()
    {
        CouchCoopActivityLog.Reset();
        CouchCoopActivityLog.SetClockForTests(() => new DateTimeOffset(2026, 9, 2, 21, 5, 9, TimeSpan.Zero));
        try
        {
            CouchCoopActivityLog.Append(CouchCoopActivityCategory.Seat, CouchCoopActivitySeverity.Warn, "Ann's game is ready.");
            var entry = CouchCoopActivityLog.Snapshot()[0];
            Assert(CouchCoopActivityLog.FormatTimestamp(entry.Timestamp) == "21:05:09",
                "the row's clock is HH:mm:ss — a host reads it against the wall, not against a date");
            Assert(
                CouchCoopActivityRender.RowBbcode(entry)
                    == "[color=#8a94a6]21:05:09[/color]  [color=#f0c674]Ann's game is ready.[/color]\n",
                "a row is: dim clock, two spaces, severity-coloured message, newline");
        }
        finally
        {
            CouchCoopActivityLog.SetClockForTests(null);
        }
    }

    private static void ToBbcodeRendersEveryRowInOrder()
    {
        var at = new DateTimeOffset(2026, 9, 2, 21, 0, 0, TimeSpan.Zero);
        var entries = new List<CouchCoopActivityEntry>
        {
            new(1, at, CouchCoopActivityCategory.Server, CouchCoopActivitySeverity.Good, "first"),
            new(2, at.AddSeconds(1), CouchCoopActivityCategory.Seat, CouchCoopActivitySeverity.Bad, "second"),
        };

        var rendered = CouchCoopActivityRender.ToBbcode(entries, truncatedHead: false);
        Assert(
            rendered == CouchCoopActivityRender.RowBbcode(entries[0]) + CouchCoopActivityRender.RowBbcode(entries[1]),
            "a full render is exactly the concatenated rows, so an append and a redraw produce the same text");
        Assert(CouchCoopActivityRender.ToBbcode([], truncatedHead: false) == string.Empty,
            "an empty log renders an empty body, not a placeholder row");
    }

    private static void TruncatedHeadIsRenderedOnce()
    {
        var entry = new CouchCoopActivityEntry(
            300,
            new DateTimeOffset(2026, 9, 2, 21, 0, 0, TimeSpan.Zero),
            CouchCoopActivityCategory.Seat,
            CouchCoopActivitySeverity.Info,
            "kept");

        var rendered = CouchCoopActivityRender.ToBbcode([entry], truncatedHead: true);
        Assert(rendered.StartsWith("[i][color=#8a94a6]…earlier events not shown[/color][/i]\n", StringComparison.Ordinal),
            "the dropped-lines marker is the FIRST thing in the block, in the same dim colour as the clocks");
        Assert(rendered.EndsWith(CouchCoopActivityRender.RowBbcode(entry), StringComparison.Ordinal),
            "…and the retained rows follow it unchanged");
        Assert(
            !CouchCoopActivityRender.ToBbcode([entry], truncatedHead: false)
                .Contains(CouchCoopActivityRender.TruncatedHeadText, StringComparison.Ordinal),
            "an untruncated render carries no marker");
    }

    private static void HeaderSummaryVariants()
    {
        Assert(CouchCoopActivityRender.HeaderSummary(0, null) == "Couch Co-Op activity — no events yet",
            "the panel is up before anything happens, so the empty header has to read as a state and not a bug");
        Assert(CouchCoopActivityRender.HeaderSummary(1, CouchCoopActivitySeverity.Info) == "Couch Co-Op activity — 1 event",
            "one event is singular");
        Assert(CouchCoopActivityRender.HeaderSummary(12, CouchCoopActivitySeverity.Good) == "Couch Co-Op activity — 12 events",
            "many events are plural");
        Assert(
            CouchCoopActivityRender.HeaderSummary(3, CouchCoopActivitySeverity.Warn)
                == "Couch Co-Op activity — 3 events (needs attention)",
            "a warning newest entry flags the header — the point of which is to be readable COLLAPSED");
        Assert(
            CouchCoopActivityRender.HeaderSummary(3, CouchCoopActivitySeverity.Bad)
                == "Couch Co-Op activity — 3 events (needs attention)",
            "…and so does a failure");
        Assert(
            !CouchCoopActivityRender.HeaderSummary(3, CouchCoopActivitySeverity.Good).Contains("attention", StringComparison.Ordinal),
            "a recovered log drops the flag again (the newest entry, not a high-water mark)");
        Assert(CouchCoopActivityRender.HeaderSummary(0, CouchCoopActivitySeverity.Bad) == "Couch Co-Op activity — no events yet",
            "an empty log has nothing to flag whatever it is handed");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"CouchCoopActivityLogTests failed: {label}.");
        }
    }
}
