using System.Net;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

// Proof that the default is safe, not that the documentation is good.
//
// CouchCoopLog.Info/Error call STS2's own logger. Outside a game process that call does not throw — it kills
// the process: exit 139, SIGSEGV, no managed exception, so the try/catch inside CouchCoopLog is powerless.
// The shared connection arrival log's DEFAULT sink is CouchCoopLog.Info, which made
// `ConnectionArrivalLog.Shared.Record(...)` a process-killer for any test that reached it, and the rule that
// came out of that ("never record into the shared log from a test; always inject your own log action") lived
// only in a memory note. CouchCoopLog.GameRuntimeAvailable is the latch that replaces it: off by default, set
// once from CouchCoopMod.Init(), i.e. only inside a real game.
//
// So THIS SUITE DELIBERATELY DOES THE THING THAT USED TO CRASH. Its whole assertion is that the runner is
// still alive on the next line; there is no way to express that other than by doing it. If this file ever
// starts taking the runner down with exit 139 and no output after the banner, the latch has been removed, or
// something has set it in a process that is not the game.
internal static class NativeLogLatchTests
{
    public static void Run()
    {
        TheLatchIsOffInAProcessThatNeverRanModInit();
        TheSharedArrivalLogIsRecordableWithNoInjectedSink();
        Console.WriteLine("NativeLogLatchTests: ok");
    }

    private static void TheLatchIsOffInAProcessThatNeverRanModInit()
    {
        Expect(!CouchCoopLog.GameRuntimeAvailable,
            "a test runner never calls CouchCoopMod.Init(), so the native logger stays untouched");

        // Both levels, straight at the guard, with no sink injected anywhere. Before the latch these two lines
        // alone would have ended the run.
        CouchCoopLog.Info("[couchcoop][test] native info line that must not reach the engine");
        CouchCoopLog.Error("[couchcoop][test] native error line that must not reach the engine");
    }

    private static void TheSharedArrivalLogIsRecordableWithNoInjectedSink()
    {
        var before = ConnectionArrivalLog.Shared.ViewerArrivalCount;

        // The exact call the Sep-15 round recorded as fatal from a test process: the PROCESS-WIDE log, its
        // default sink, a non-loopback address so it counts as a viewer arrival and the Console.Error half of
        // the sink definitely runs.
        ConnectionArrivalLog.Shared.Record(IPAddress.Parse("192.0.2.7"), "/", "served", userAgent: "latch-test");

        Expect(ConnectionArrivalLog.Shared.ViewerArrivalCount == before + 1,
            "the record landed — the sink ran to completion rather than taking the process with it");
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
