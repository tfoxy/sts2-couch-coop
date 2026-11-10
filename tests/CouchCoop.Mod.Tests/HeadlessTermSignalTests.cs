using CouchCoop.Mod.Session;

internal static class HeadlessTermSignalTests
{
    public static void Run()
    {
        var reasons = new List<string>();
        Assert(HeadlessTermSignal.Decide(reason => { reasons.Add(reason); return true; }),
            "an available exit sequence cancels the default termination");
        Assert(reasons.SequenceEqual(new[] { "sigterm" }), "SIGTERM requests the common exit sequence exactly once");
        Assert(!HeadlessTermSignal.Decide(_ => false), "no sequence leaves default termination enabled");
        Assert(!HeadlessTermSignal.Decide(_ => throw new Exception("unavailable")),
            "a failed request leaves default termination enabled");
        Console.WriteLine("HeadlessTermSignalTests: 3 passed.");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition) throw new Exception($"[HeadlessTermSignalTests] FAILED: {label}");
    }
}
