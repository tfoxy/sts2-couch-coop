using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

internal static class SeatStillSourceTests
{
    public static void Run()
    {
        var checks = 0;
        void Check(bool ok) { checks++; if (!ok) throw new Exception($"seat still check {checks} failed"); }
        Check(CouchCoopSeatStillSource.BuildHostUrl("http://127.0.0.1:13337", "/bg/a?v=1")?.AbsoluteUri == "http://127.0.0.1:13337/bg/a?v=1");
        Check(CouchCoopSeatStillSource.BuildHostUrl(null, "/bg/a") is null);
        Check(CouchCoopSeatStillSource.BuildHostUrl("http://127.0.0.1:13337", "//elsewhere/bg/a") is null);
        Check(CouchCoopSeatStillSource.BuildHostUrl("http://host:13337", "/bg/a") is null);
        foreach (var path in new string?[] { null, "", "/other/a", "//host/bg/a", "/bg/a\\b", "/bg/a#part", "/bg/" + new string('x', 1021) })
            Check(CouchCoopSeatStillSource.ValidSourcePath(path) is null);
        Check(CouchCoopSeatStillSource.ValidSourcePath("/bg/a?frame=1,2,3&v=4") == "/bg/a?frame=1,2,3&v=4");
        Check(CouchCoopSeatStillSource.ValidSourcePath("/bg/" + new string('x', 1020))?.Length == 1024);
        Check(CouchCoopSeatStillSource.RequestPath(true, "/bg/seat", "/bg/host?frame=host") == "/bg/host?frame=host");
        Check(CouchCoopSeatStillSource.RequestPath(true, "/bg/seat", null) is null);
        Check(CouchCoopSeatStillSource.RequestPath(false, "/bg/self", "/bg/host") == "/bg/self");
        var envelope = CouchCoop.Mod.Protocol.BrowserJson.Deserialize<CouchCoop.MirrorProtocol.Envelopes.BrowserSettingsRequestEnvelope>(
            """{"type":"settings","streamStaticBg":true,"streamStaticBgSource":"/bg/host","streamStaticBgSourceFor":"seat:id"}""");
        Check(envelope is { StreamStaticBgSource: "/bg/host", StreamStaticBgSourceFor: "seat:id", StreamStaticBgReady: null });
        Check(CouchCoopSeatStillSource.ValidSourceFor(null) is null);
        Check(CouchCoopSeatStillSource.ValidSourceFor("") is null);
        Check(CouchCoopSeatStillSource.ValidSourceFor(new string('x', 1025)) is null);
        Check(CouchCoopSeatStillSource.ValidSourceFor(new string('x', 1024))?.Length == 1024);
        // One page's stale admission cannot mask another page's admission for the published descriptor.
        SeatStillAdmission stale = new("/bg/old", "room-1"), current = new("/bg/current", "room-2");
        Check(SeatStillAdmission.Select([null, stale, current], "room-2") == current);
        Check(SeatStillAdmission.Select([new SeatStillAdmission("", "room-2"), stale], "room-2") == stale);
        Check(SeatStillAdmission.Select([current, new SeatStillAdmission("/bg/current2", "room-2")], "room-2") == current);
        Check(SeatStillAdmission.Select([null], "room-2") is null);
        Check(!CouchCoopSeatStillSource.Successful(null));
        Check(!CouchCoopSeatStillSource.Successful(CouchCoopStaticBackgroundResult.Hit([], "image/png")));
        Check(CouchCoopSeatStillSource.Successful(CouchCoopStaticBackgroundResult.Hit([1], "image/png")));
        Check(!CouchCoopSeatStillSource.Successful(CouchCoopStaticBackgroundResult.Unavailable(new("failed", "failed"))));
        Check(CouchCoopSeatStillSource.ImageFormat(null, [255, 216, 255]) == "jpg");
        Check(CouchCoopSeatStillSource.ImageFormat("image/png; q=1", []) == "png");
        Check(CouchCoopSeatStillSource.ImageFormat(null, "RIFF1234WEBP"u8) == "webp");
        Check(CouchCoopSeatStillSource.ImageFormat(null, [1, 2]) is null);
        var flights = new System.Collections.Concurrent.ConcurrentDictionary<string, object>();
        var oldFlight = new object();
        var newFlight = new object();
        flights["a"] = newFlight;
        Check(!CouchCoopSeatStillSource.ForgetFlight(flights, "a", oldFlight) && flights["a"] == newFlight);
        Check(CouchCoopSeatStillSource.ForgetFlight(flights, "a", newFlight) && flights.IsEmpty);
        var released = new List<string>();
        var completions = new List<string?>();
        var cache = new SeatStillCache<string>(released.Add);
        var first = cache.Request("a", completions.Add)!.Value;
        Check(cache.Request("a", completions.Add) is null);
        var second = cache.Request("b", completions.Add)!.Value;
        cache.Complete(first, "stale");
        Check(completions.Count == 0 && released.SequenceEqual(["stale"]));
        cache.Complete(second, "texture");
        Check(completions.SequenceEqual(["texture"]));
        Check(cache.Request("b", completions.Add) is null && completions.Count == 2);
        cache.Retire();
        Check(released.SequenceEqual(["stale", "texture"]) && !cache.IsCurrent(second));
        var failed = cache.Request("c", completions.Add)!.Value;
        cache.Complete(failed, null);
        Check(cache.Request("c", completions.Add) is null && completions[^1] is null);
        var replacement = cache.Request("d", completions.Add)!.Value;
        Check(!cache.IsCurrent(failed));
        cache.Complete(replacement, "replacement");
        Check(completions[^1] == "replacement");
        var beforeNoSource = completions.Count;
        Check(cache.Request(null, completions.Add) is null && !cache.IsCurrent(replacement));
        Check(completions.Count == beforeNoSource && released[^1] == "replacement");
        cache.Retire();
        Check(cache.Request("c", completions.Add) is not null);
        var env = StreamingSeatLaunch.Environment(new("extension", "calibration"), 13346, "evidence", [], hostBrowserPort: 13337);
        Check(env[CouchCoopSeatStillSource.HostOriginEnvironmentVariable] == "http://127.0.0.1:13337");
        Console.WriteLine($"SeatStillSourceTests passed ({checks} checks)");
    }
}
