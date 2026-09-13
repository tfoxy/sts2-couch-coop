using CouchCoop.Mod.HostUi;

namespace CouchCoop.Mod.Tests;

internal static class ConnectionAttentionTests
{
    public static void Run()
    {
        var time = new FakeTime();
        var attention = new CouchCoopConnectionAttention(time);
        Assert(attention.Update([], 0, false) == (false, false), "empty state has no notification");
        var batch = Enumerable.Range(1, 128).Select(n => n.ToString()).ToArray();
        Assert(attention.Update(batch, 128, false) == (true, true), "a batch of problems shows notice and badge");
        time.Advance(5_999);
        Assert(attention.Update(batch, 128, false) == (true, true), "notice lasts six seconds");
        time.Advance(1);
        Assert(attention.Update(batch, 128, false) == (true, false), "the same batch does not restart the notice");
        Assert(attention.Update(batch.Append("new"), 128, false) == (true, true), "a new retained issue restarts notice even at retention limit");
        Assert(attention.Update(batch, 128, true) == (false, false), "opening the dialog hides and acknowledges the notice");
        Assert(attention.Update(batch, 128, false) == (true, false), "closing the dialog keeps the count without repeating the notice");
        Assert(attention.Update([], 0, false) == (false, false), "dismissal clears the count");
        Assert(attention.Update(["next"], 1, true) == (false, false), "problems seen in the dialog do not notify behind it");
        Assert(attention.Update(["next"], 1, false) == (true, false), "already seen problems retain only the badge");
    }

    private sealed class FakeTime : TimeProvider
    {
        private long _ticks;
        public override long TimestampFrequency => 1_000;
        public override long GetTimestamp() => _ticks;
        public void Advance(long milliseconds) => _ticks += milliseconds;
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"[ConnectionAttentionTests] FAILED: {message}");
    }
}
