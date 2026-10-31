using System.Diagnostics;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Session;

// "Use new renderer (Beta)", the host half (MIR-3): which seat launch is the streaming seat, the environment it is
// launched with, and the descriptor that seat hands to its own viewer.
//
// What must hold:
//   * the launch environment is the acceptance leg's GRC_* table: loopback listener on the slot's port, /12, token
//     auth, the host's own page origins, and the hook log OFF;
//   * no seat inherits a capture variable from its host; only the one chosen launch gets the table back;
//   * at most one live streaming seat per host: the first viewer who asks gets it, a second does not, and it frees
//     when that seat's process exits — and a host with no capture configured never launches one;
//   * the descriptor goes only to the streaming seat's connection, only for an Origin the hub allows, only with a
//     well-formed token; and nothing on this path writes the token to a log;
//   * PRES-A: the seat is launched at its viewer's aspect: W = clamp(round(1080 * aspect), 1920, cap), even, and
//     stepped past every width Godot's float32 `expand` arithmetic floors to W-1; no usable aspect is 1920; the cap is
//     the operator's COUCHCOOP_RENDER_STREAM_MAX_WIDTH (default 2520).
//
// Pure decisions, a real ProcessStartInfo and the manager over a fake launcher; no engine, no game.
internal static class RenderStreamPairingTests
{
    public const string Verb = "render-stream-pairing";

    private const string Extension = "/opt/capture/render_stream_capture.gdextension";
    private const string Calibration = "/opt/capture/calibration.json";
    private static readonly string Token = new('7', 64);

    public static async Task RunAsync()
    {
        ConfigResolvesTheCalibrationBesideTheCapture();
        APackagedCaptureIsTheFallback();
        AllowedOriginsAreTheHostPageAndValidExtras();
        LaunchEnvironmentIsTheAcceptanceTable();
        PresentationWidthFollowsTheAspect();
        TheFloat32GuardMatchesGodot();
        TheCapIsTheOperatorsSetting();
        AWideLaunchCarriesItsRootSize();
        TheAspectIsReadFromTheWire();
        NoSeatInheritsTheCapture();
        await OneStreamingSeatPerHostAsync();
        await AnUnconfiguredHostNeverStreamsAsync();
        await AReusedSeatKeepsItsRoleAsync();
        await AJoinsAspectSetsItsSeatsWidthAsync();
        DescriptorOnlyForTheStreamingSeatAndAnAllowedOrigin();
        DescriptorNeedsAWellFormedToken();
        TheTokenIsNeverLogged();
        HostCaptureVariableIsConfigurationNotAWarning();
        ItemTaggerGroupsMatchTheModules();
    }

    private static void ConfigResolvesTheCalibrationBesideTheCapture()
    {
        var files = new HashSet<string> { Extension, Calibration, "/elsewhere/cal.json" };
        var beside = StreamingSeatLaunch.ResolveConfig(Extension, null, files.Contains);
        Assert(beside.Config == new StreamingSeatLaunch.Config(Extension, Calibration),
            "no calibration variable: the calibration record next to the capture");
        var named = StreamingSeatLaunch.ResolveConfig(Extension, " /elsewhere/cal.json ", files.Contains);
        Assert(named.Config?.Calibration == "/elsewhere/cal.json", "a calibration variable wins");

        var unset = StreamingSeatLaunch.ResolveConfig(null, null, files.Contains);
        Assert(unset.Config is null && unset.Refusal is null, "an unconfigured host is simply off, with nothing to say");
        Assert(StreamingSeatLaunch.ResolveConfig(Extension, "cal.json", files.Contains).Refusal is not null,
            "a relative calibration path is refused");
        Assert(StreamingSeatLaunch.ResolveConfig(Extension, "/missing.json", files.Contains).Refusal is not null,
            "a missing calibration record is refused");
        Assert(StreamingSeatLaunch.ResolveConfig(Extension, null, path => path == Extension).Refusal is not null,
            "a capture without its calibration record is refused");
        Assert(StreamingSeatLaunch.ResolveConfig("capture.gdextension", null, _ => true).Refusal is not null,
            "a relative capture path is refused");
    }

    private static void APackagedCaptureIsTheFallback()
    {
        // A released payload: the lane assembly sits one directory below the shared tree that carries render-capture/.
        var root = Path.Combine(Path.GetTempPath(), "cc-payload");
        var packaged = Path.Combine(root, "render-capture", "render_stream_capture.gdextension");
        var packagedCalibration = Path.Combine(root, "render-capture", "calibration");
        var files = new HashSet<string> { packaged, packagedCalibration, Extension, Calibration };
        var lane = Path.Combine(root, "lanes", "0.103.0");

        var fromLane = StreamingSeatLaunch.ResolveConfig(null, null, files.Contains, lane);
        Assert(fromLane.Config == new StreamingSeatLaunch.Config(packaged, packagedCalibration),
            $"no variable: the payload's own capture and its extensionless calibration: {fromLane.Refusal}");
        var flat = StreamingSeatLaunch.ResolveConfig(null, null, files.Contains, root);
        Assert(flat.Config?.Extension == packaged, "a flat dev deploy resolves the same directory");
        var operatorWins = StreamingSeatLaunch.ResolveConfig(Extension, null, files.Contains, lane);
        Assert(operatorWins.Config == new StreamingSeatLaunch.Config(Extension, Calibration),
            "an operator's capture wins over the packaged one");
        var none = StreamingSeatLaunch.ResolveConfig(null, null, path => path == Extension, lane);
        Assert(none.Config is null && none.Refusal is null, "a payload without a capture is simply off");
    }

    private static void AllowedOriginsAreTheHostPageAndValidExtras()
    {
        var plain = StreamingSeatLaunch.AllowedOrigins(13337, null);
        Assert(plain is ["http://127.0.0.1:13337", "http://localhost:13337"], "the host's own loopback page, both spellings");

        var extras = StreamingSeatLaunch.AllowedOrigins(13338,
            " http://127.0.0.1:5190 ,https://Example.test:1,http://127.0.0.1:5190/,http://[::1]:5190,ftp:/x,"
            + "http://127.0.0.1:0,http://127.0.0.1:13338,http://lan-box.local:13338");
        Assert(extras is ["http://127.0.0.1:13338", "http://localhost:13338", "http://127.0.0.1:5190",
                "http://[::1]:5190", "http://lan-box.local:13338"],
            $"valid extras appended once, malformed ones dropped (the capture would refuse the whole list): {string.Join(' ', extras)}");
    }

    private static void LaunchEnvironmentIsTheAcceptanceTable()
    {
        var env = StreamingSeatLaunch.Environment(new StreamingSeatLaunch.Config(Extension, Calibration),
            StreamingSeatLaunch.HubPortForSlot(2), "/home/p/couch-coop/render-stream/slot-2",
            StreamingSeatLaunch.AllowedOrigins(13337, null));
        var expected = new Dictionary<string, string>
        {
            ["COUCHCOOP_STREAMING_SEAT"] = "1",
            ["COUCHCOOP_RENDER_CAPTURE_EXTENSION"] = Extension,
            ["GRC_MODE"] = "arm",
            ["GRC_CALIBRATION"] = Calibration,
            ["GRC_LIVE_LISTEN"] = "127.0.0.1:13366",
            ["GRC_STREAM_VERSION"] = "13",
            ["GRC_LIVE_AUTH"] = "token",
            ["GRC_EVIDENCE_DIR"] = "/home/p/couch-coop/render-stream/slot-2",
            ["GRC_LIVE_ALLOWED_ORIGINS"] = "http://127.0.0.1:13337,http://localhost:13337",
            ["GRC_LIVE_MAX_CONNECTIONS"] = "2",
            ["GRC_LIVE_CODING"] = "zstd-base",
            ["GRC_HOOK_LOG"] = "off",
            ["GRC_ADOPT"] = "arm",
            ["GRC_UNKNOWN_ITEM"] = "skip",
            ["GRC_TEXTURE_DECODE"] = "engine",
            ["GRC_TEXTURE_WORKERS"] = "2",
            ["GRC_ROOT_SIZE"] = "presentation:1920x1080",
            ["GRC_MIRROR_MAX_ITEMS"] = "32768",
            ["GRC_MIRROR_MAX_COMMANDS"] = "16384",
            ["GRC_RESOURCE_MAX_PAYLOAD_BYTES"] = "268435456",
            ["GRC_RESOURCE_BUDGET_BYTES"] = "8589934592",
            ["GRC_RESOURCE_FORMATS"] = "L8,LA8,R8,RG8,RGB8,RGBA8,RGBAH,RF,RGF,RGBF,RGBAF",
            ["GRC_RESOURCE_INLINE_MAX_BYTES"] = "4096",
            ["GRC_PERF_TIMELINE_MAX_BYTES"] = "8388608",
            ["GRC_MESH_DYNAMIC"] = "auto",
            ["GRC_ITEM_META"] = "scene,path,script,groups",
        };
        Assert(env.Count == expected.Count && expected.All(kv => env.TryGetValue(kv.Key, out var v) && v == kv.Value),
            "the streaming seat's environment is exactly the acceptance table: "
            + string.Join(' ', env.Where(kv => !expected.TryGetValue(kv.Key, out var v) || v != kv.Value).Select(kv => $"{kv.Key}={kv.Value}")));
        Assert(!env.ContainsKey("GRC_RESOURCE_STORE_DIR") && !env.ContainsKey("GRC_STREAM_PATCH_OUT"),
            "a live-only seat writes no recording and no store to disk");
        Assert(StreamingSeatLaunch.HubPortForSlot(3) == HeadlessClientManager.SlotToPort(3) + 9
               && StreamingSeatLaunch.HubPortForSlot(3) < HeadlessClientManager.SlotToPort(4),
            "the hub port is the last of the slot's own band, stable per slot");
    }

    private static void PresentationWidthFollowsTheAspect()
    {
        const int cap = StreamingSeatLaunch.DefaultMaxPresentationWidth;
        Assert(cap == 2520, "the default cap is 21:9 at 1080, the old renderer's");
        foreach (var absent in new double?[] { null, double.NaN, double.PositiveInfinity, double.NegativeInfinity, 0, -1.5, 0.2, 5.01, 100 })
        {
            Assert(StreamingSeatLaunch.PresentationWidth(absent, cap) == 1920, $"no usable aspect ({absent}) is the 16:9 base");
        }
        Assert(StreamingSeatLaunch.PresentationWidth(16.0 / 9.0, cap) == 1920, "16:9 is the base");
        Assert(StreamingSeatLaunch.PresentationWidth(4.0 / 3.0, cap) == 1920, "narrower than 16:9 clamps up to the base");
        Assert(StreamingSeatLaunch.PresentationWidth(0.25, cap) == 1920, "a portrait phone (in range) clamps to the base");
        Assert(StreamingSeatLaunch.PresentationWidth(2340.0 / 1080.0, cap) == 2340, "19.5:9 is 2340 (and survives the guard)");
        Assert(StreamingSeatLaunch.PresentationWidth(21.0 / 9.0, cap) == 2520, "21:9 is 2520 (and survives the guard)");
        Assert(StreamingSeatLaunch.PresentationWidth(3.0, cap) == 2520, "wider than the cap is the cap");
        Assert(StreamingSeatLaunch.PresentationWidth(5.0, cap) == 2520, "the widest accepted aspect is the cap too");
        Assert(StreamingSeatLaunch.PresentationWidth(2341.0 / 1080.0, cap) == 2340, "an odd width is made even (down)");
        Assert(StreamingSeatLaunch.PresentationWidth(2000.4 / 1080.0, cap) == 2000, "1080 * aspect is rounded first");
        // The guard steps a width Godot would floor to W-1 down to the next even width it reproduces.
        Assert(StreamingSeatLaunch.PresentationWidth(1940.0 / 1080.0, cap) == 1938, "1940 -> 1938");
        Assert(StreamingSeatLaunch.PresentationWidth(2234.0 / 1080.0, cap) == 2232, "2234 -> 2232");
        Assert(StreamingSeatLaunch.PresentationWidth(2260.0 / 1080.0, cap) == 2258, "2260 -> 2258");
        Assert(StreamingSeatLaunch.PresentationWidth(2382.0 / 1080.0, cap) == 2380, "2382 -> 2380");
        Assert(StreamingSeatLaunch.PresentationWidth(2504.0 / 1080.0, cap) == 2502, "2504 -> 2502");
        Assert(StreamingSeatLaunch.PresentationWidth(2530.0 / 1080.0, 2600) == 2528, "2530 -> 2528 under a wider cap");
        Assert(StreamingSeatLaunch.PresentationWidth(2600.0 / 1080.0, 2600) == 2600, "a wider cap is honoured");
        Assert(StreamingSeatLaunch.PresentationWidth(3.0, 1000) == 1920, "a cap below the base is the base");
        for (var aspect = 0.25; aspect <= 5.0; aspect += 0.0137)
        {
            var w = StreamingSeatLaunch.PresentationWidth(aspect, 5400);
            Assert(w >= 1920 && w <= 5400 && w % 2 == 0 && StreamingSeatLaunch.SurvivesExpandStretch(w),
                $"every width is even, in range and reproduced by Godot (aspect {aspect}: {w})");
        }
    }

    private static void TheFloat32GuardMatchesGodot()
    {
        // Measured against Godot 4.5.1 Window::_update_viewport_size: the even widths in [1920, 2600] whose visible width
        // floors to W-1 under canvas_items/expand at a 1080 base. 2340 and 2520 are fine.
        int[] measured = [1940, 2234, 2260, 2382, 2504, 2530];
        var failing = Enumerable.Range(0, (2600 - 1920) / 2 + 1).Select(i => 1920 + i * 2)
            .Where(w => !StreamingSeatLaunch.SurvivesExpandStretch(w)).ToArray();
        Assert(failing.SequenceEqual(measured), $"the float32 guard rejects exactly the measured widths: {string.Join(',', failing)}");
        Assert(StreamingSeatLaunch.SurvivesExpandStretch(1920), "the base itself survives");
    }

    private static void TheCapIsTheOperatorsSetting()
    {
        Assert(StreamingSeatLaunch.MaxPresentationWidthEnvironmentVariable == "COUCHCOOP_RENDER_STREAM_MAX_WIDTH",
            "the cap's variable");
        Assert(new StreamingSeatLaunch.Config(Extension, Calibration).MaxPresentationWidth == 2520, "a config defaults to 2520");
        Assert(StreamingSeatLaunch.ParseMaxPresentationWidth(null, out var w0) == 2520 && w0 is null, "unset is 2520, silently");
        Assert(StreamingSeatLaunch.ParseMaxPresentationWidth("  ", out var w1) == 2520 && w1 is null, "blank is 2520, silently");
        Assert(StreamingSeatLaunch.ParseMaxPresentationWidth("wide", out var w2) == 2520 && w2 is not null,
            "not an integer is 2520, with a warning");
        Assert(StreamingSeatLaunch.ParseMaxPresentationWidth(" 3000 ", out _) == 3000, "an integer is the cap");
        Assert(StreamingSeatLaunch.ParseMaxPresentationWidth("2601", out _) == 2600, "made even");
        Assert(StreamingSeatLaunch.ParseMaxPresentationWidth("1000", out _) == 1920, "at least the base");
        Assert(StreamingSeatLaunch.ParseMaxPresentationWidth("99999", out _) == 5400, "at most 5:1 at 1080");
    }

    private static void AWideLaunchCarriesItsRootSize()
    {
        var env = StreamingSeatLaunch.Environment(new StreamingSeatLaunch.Config(Extension, Calibration),
            StreamingSeatLaunch.HubPortForSlot(2), "/home/p/ev", StreamingSeatLaunch.AllowedOrigins(13337, null),
            StreamingSeatLaunch.PresentationWidth(2340.0 / 1080.0, 2520));
        Assert(env["GRC_ROOT_SIZE"] == "presentation:2340x1080", $"the seat is launched at its viewer's width: {env["GRC_ROOT_SIZE"]}");

        // ...and the seat's own descriptor hands that size to the page, which sizes its canvas from it.
        var seat = new Dictionary<string, string>(SeatEnvironment(auth: "token")) { ["GRC_ROOT_SIZE"] = env["GRC_ROOT_SIZE"] };
        Assert(StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", seat.GetValueOrDefault, _ => Token)
                is { Presentation: [2340, 1080] },
            "the descriptor carries the wide presentation");

        // The host's launch line names the width, for a live leg to read.
        var launcher = File.ReadAllText(Path.Combine(RepoRoot(), "src", "CouchCoop.Mod", "Session", "HeadlessClientManager.cs"));
        var apply = launcher.IndexOf("private void ApplyStreamingSeatLocked(", StringComparison.Ordinal);
        var applyBody = launcher[apply..launcher.IndexOf("\n    }\n", apply, StringComparison.Ordinal)];
        Assert(applyBody.Contains("streaming seat launching slot=", StringComparison.Ordinal)
               && applyBody.Contains("presentation={width.ToString(", StringComparison.Ordinal),
            "the seat-launch log line carries the chosen presentation");
    }

    private static void TheAspectIsReadFromTheWire()
    {
        static BrowserJoinRequestEnvelope Join(string json)
        {
            using var document = System.Text.Json.JsonDocument.Parse(json);
            return System.Text.Json.JsonSerializer.Deserialize<BrowserJoinRequestEnvelope>(document, BrowserJson.Options)!;
        }

        Assert(BrowserAspect.Read(Join("""{"type":"join","requestId":"j","name":"Ann","renderer":"stream","aspect":2.1666}""").Aspect) == 2.1666,
            "a join's numeric aspect is read");
        Assert(BrowserAspect.Read(Join("""{"type":"join","requestId":"j","name":"Ann","renderer":"stream"}""").Aspect) is null,
            "no aspect is null (the base width)");
        foreach (var bad in new[] { "\"wide\"", "null", "true", "[2]", "{}" })
        {
            var join = Join($$"""{"type":"join","requestId":"j","name":"Ann","renderer":"stream","aspect":{{bad}}}""");
            Assert(join.Renderer == "stream" && BrowserAspect.Read(join.Aspect) is null,
                $"a malformed aspect ({bad}) is ignored and never fails the join");
        }
    }

    private static void NoSeatInheritsTheCapture()
    {
        // A real ProcessStartInfo: a copy of this process's environment, with an indexer that throws on a missing key.
        var normal = new ProcessStartInfo("true");
        normal.Environment["GRC_HOOK_LOG"] = "on";
        normal.Environment["GRC_LIVE_LISTEN"] = "0.0.0.0:1";
        normal.Environment[StreamingSeatRole.EnvironmentVariable] = "1";
        normal.Environment[RenderCaptureExtensionLoader.EnvironmentVariable] = Extension;
        normal.Environment[StreamingSeatLaunch.CalibrationEnvironmentVariable] = Calibration;
        normal.Environment[StreamingSeatLaunch.ExtraOriginsEnvironmentVariable] = "http://127.0.0.1:5190";
        normal.Environment[StreamingSeatLaunch.MaxPresentationWidthEnvironmentVariable] = "3000";
        normal.Environment["GRCX_UNRELATED"] = "kept";
        StreamingSeatLaunch.ClearInherited(normal);
        Assert(!normal.Environment.Keys.Any(k => k.StartsWith("GRC_", StringComparison.Ordinal)), "no GRC_* reaches a seat");
        foreach (var key in new[] { StreamingSeatRole.EnvironmentVariable, RenderCaptureExtensionLoader.EnvironmentVariable,
                     StreamingSeatLaunch.CalibrationEnvironmentVariable, StreamingSeatLaunch.ExtraOriginsEnvironmentVariable,
                     StreamingSeatLaunch.MaxPresentationWidthEnvironmentVariable })
        {
            Assert(!normal.Environment.ContainsKey(key), $"{key} does not reach a seat");
        }
        Assert(normal.Environment["GRCX_UNRELATED"] == "kept", "anything else is untouched");

        var streaming = new ProcessStartInfo("true");
        streaming.Environment["GRC_HOOK_LOG"] = "on";
        streaming.Environment["GRC_SABOTAGE"] = "drop-message";
        var table = StreamingSeatLaunch.Environment(new StreamingSeatLaunch.Config(Extension, Calibration), 13366,
            "/tmp/ev", ["http://127.0.0.1:13337"]);
        StreamingSeatLaunch.Apply(streaming, table);
        Assert(streaming.Environment["GRC_HOOK_LOG"] == "off", "the host's table wins over an inherited value");
        Assert(!streaming.Environment.ContainsKey("GRC_SABOTAGE"), "an inherited GRC_* the table does not set is dropped");
        Assert(table.All(kv => streaming.Environment[kv.Key] == kv.Value), "the whole table is applied");

        var launcher = File.ReadAllText(Path.Combine(RepoRoot(), "src", "CouchCoop.Mod", "Session", "HeadlessClientManager.cs"));
        var clear = launcher.IndexOf("StreamingSeatLaunch.ClearInherited(psi);", StringComparison.Ordinal);
        var apply = launcher.IndexOf("ApplyStreamingSeatLocked(slot, psi,", StringComparison.Ordinal);
        var start = launcher.IndexOf("Process.Start(psi)", StringComparison.Ordinal);
        Assert(clear >= 0 && apply > clear && start > apply,
            "LaunchReal clears the capture from every seat, then applies it to the chosen one, before starting it");
    }

    private static async Task OneStreamingSeatPerHostAsync()
    {
        var h = new Harness(configured: true);
        var ann = Guid.NewGuid();
        await h.Manager.EnsureHeadlessAsync(ann, "Ann", default, wantsStreamingSeat: true);
        Assert(h.Launches is [(2, true)], "the first viewer who asks gets their seat launched as the streaming seat");
        Assert(h.Manager.StreamingSlot == 2, "slot 2 streams");

        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Bob", default, wantsStreamingSeat: true);
        Assert(h.Launches[1] == (3, false), "a second viewer who asks gets a normal seat: one streaming seat per host");
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Cat", default);
        Assert(h.Launches[2] == (4, false), "a viewer who does not ask gets a normal seat");
        Assert(h.Manager.StreamingSlot == 2, "still exactly slot 2");

        // Ann's seat dies: the role frees, and the next launch that asks takes it.
        h.Spawned[0].ForceExit();
        Assert(h.Manager.StreamingSlot is null, "an exited streaming seat holds no role");
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Dan", default, wantsStreamingSeat: true);
        Assert(h.Launches[^1].Streaming, "the next viewer who asks gets the freed role");
        Assert(h.Manager.StreamingSlot == h.Launches[^1].Slot, "the new seat is the one streaming seat");
    }

    private static async Task AnUnconfiguredHostNeverStreamsAsync()
    {
        var h = new Harness(configured: false);
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, wantsStreamingSeat: true);
        Assert(h.Launches is [(2, false)] && h.Manager.StreamingSlot is null,
            "with no capture configured, asking launches a normal seat");
    }

    private static async Task AReusedSeatKeepsItsRoleAsync()
    {
        var h = new Harness(configured: true);
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, wantsStreamingSeat: true);
        Assert(h.Launches is [(2, false)] && h.Manager.StreamingSlot is null,
            "a running seat is reused as it is: the choice applies at the seat's next start");

        // Its next start (a respawn on the same slot) honours the request.
        h.Spawned[0].ForceExit();
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, wantsStreamingSeat: true);
        Assert(h.Launches is [(2, false), (2, true)] && h.Manager.StreamingSlot == 2, "the respawned seat streams");
    }

    private static async Task AJoinsAspectSetsItsSeatsWidthAsync()
    {
        var h = new Harness(configured: true);
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, wantsStreamingSeat: true,
            streamingAspect: 2340.0 / 1080.0);
        Assert(h.Launches is [(2, true)] && h.Manager.StreamingSeatPresentationWidth(2) == 2340,
            "a streaming join's aspect is its seat's width");
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Bob", default, wantsStreamingSeat: true);
        Assert(h.Manager.StreamingSeatPresentationWidth(3) == 1920, "a join without an aspect (stretch off) is 1920");
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Cat", default, wantsStreamingSeat: true, streamingAspect: double.NaN);
        Assert(h.Manager.StreamingSeatPresentationWidth(4) == 1920, "an unusable aspect is 1920");

        var capped = new Harness(configured: true, maxWidth: 2200);
        await capped.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, wantsStreamingSeat: true, streamingAspect: 21.0 / 9.0);
        Assert(capped.Manager.StreamingSeatPresentationWidth(2) == 2200, "the operator's cap bounds it");

        // Ann's seat is reused by a join asking with another aspect: the running seat keeps its width until its next
        // start (re-launching on a changed aspect is PRES-R).
        await h.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, wantsStreamingSeat: true, streamingAspect: 2.0);
        Assert(h.Launches.Count == 3 && h.Manager.StreamingSeatPresentationWidth(2) == 2340,
            "no relaunch, and no new width, for a reused seat");
    }

    private static void DescriptorOnlyForTheStreamingSeatAndAnAllowedOrigin()
    {
        var env = SeatEnvironment(auth: "token");
        string? Token_(string _) => Token;
        var ok = StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", env.GetValueOrDefault, Token_);
        Assert(ok is not null && ok.Url == "ws://127.0.0.1:13366/render-stream" && ok.ResourceBase == "http://127.0.0.1:13366"
               && ok.Token == Token && ok.Protocol == 13 && ok.Presentation is [1920, 1080],
            "the streaming seat's own connection from the host page gets the hub, the token, /13 and 1920x1080");
        Assert(StreamingSeatDescriptor.Build(true, "http://localhost:13337", env.GetValueOrDefault, Token_) is not null,
            "the localhost spelling of the host page too");

        foreach (var origin in new string?[] { null, "", "http://192.168.1.20:13337", "https://127.0.0.1:13338",
                     "http://127.0.0.1:13337/", "HTTP://127.0.0.1:13337" })
        {
            Assert(StreamingSeatDescriptor.Build(true, origin, env.GetValueOrDefault, Token_) is null,
                $"no descriptor for origin '{origin}' (the hub would refuse it, or it is not a browser)");
        }

        Assert(StreamingSeatDescriptor.Build(false, "http://127.0.0.1:13337", env.GetValueOrDefault, Token_) is null,
            "a seat that is not the streaming seat never sends one");

        var lan = new Dictionary<string, string>(env) { ["GRC_LIVE_LISTEN"] = "0.0.0.0:13366" };
        Assert(StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", lan.GetValueOrDefault, Token_) is null,
            "a non-loopback listener is never described");
        var v8 = new Dictionary<string, string>(env) { ["GRC_STREAM_VERSION"] = "8" };
        Assert(StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", v8.GetValueOrDefault, Token_) is null,
            "only the wire versions the client speaks (11, 12, 13)");
        var v12 = new Dictionary<string, string>(env) { ["GRC_STREAM_VERSION"] = "12" };
        Assert(StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", v12.GetValueOrDefault, Token_) is { Protocol: 12 },
            "a seat configured at /12 is still described, at /12");

        var open = SeatEnvironment(auth: "none");
        var none = StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", open.GetValueOrDefault,
            _ => throw new InvalidOperationException("no token file is read without token auth"));
        Assert(none is not null && none.Token is null, "a hub without token auth is described with no token");
    }

    private static void DescriptorNeedsAWellFormedToken()
    {
        var env = SeatEnvironment(auth: "token");
        string? asked = null;
        var missing = StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", env.GetValueOrDefault,
            path => { asked = path; return null; });
        Assert(missing is null, "no token file yet: no descriptor");
        Assert(asked == Path.Combine("/home/p/ev", StreamingSeatDescriptor.TokenFileName), "the token is the capture's live-token");
        foreach (var bad in new[] { "", new string('A', 64), new string('7', 63), "not hex" })
        {
            Assert(StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", env.GetValueOrDefault, _ => bad) is null,
                $"a malformed token ('{bad}') is never handed out");
        }
        Assert(StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", env.GetValueOrDefault, _ => Token + "\n")?.Token == Token,
            "the file's trailing newline is not part of the token");
    }

    private static void TheTokenIsNeverLogged()
    {
        var root = RepoRoot();
        foreach (var file in new[] { Path.Combine("Protocol", "StreamingSeatDescriptor.cs"), Path.Combine("Session", "StreamingSeatLaunch.cs") })
        {
            var source = File.ReadAllText(Path.Combine(root, "src", "CouchCoop.Mod", file));
            foreach (var call in new[] { "CouchCoopLog", "Console.", "HeadlessLog", "Stderr", "Debug.", "Trace." })
            {
                Assert(!source.Contains(call, StringComparison.Ordinal), $"{file} logs nothing ({call})");
            }
        }

        var connection = File.ReadAllText(Path.Combine(root, "src", "CouchCoop.Mod", "Server", "CouchCoopWebSocketConnection.cs"));
        var at = connection.IndexOf("private BrowserEnvelope WithRenderStream(", StringComparison.Ordinal);
        Assert(at >= 0, "the connection attaches the descriptor in one place");
        var body = connection[at..connection.IndexOf(';', at)];
        Assert(!body.Contains("Log", StringComparison.Ordinal), "attaching the descriptor logs nothing");

        // The host's launch line names the hub and the evidence dir; the token does not exist yet on the host.
        var launcher = File.ReadAllText(Path.Combine(root, "src", "CouchCoop.Mod", "Session", "HeadlessClientManager.cs"));
        var apply = launcher.IndexOf("private void ApplyStreamingSeatLocked(", StringComparison.Ordinal);
        var applyBody = launcher[apply..launcher.IndexOf("\n    }\n", apply, StringComparison.Ordinal)];
        Assert(!applyBody.Contains("live-token\"", StringComparison.Ordinal) && !applyBody.Contains("ReadAllText", StringComparison.Ordinal),
            "the host never reads the token");
    }

    private static void HostCaptureVariableIsConfigurationNotAWarning()
    {
        var host = StreamingSeatRole.StartCapture(false, Extension, _ => true, _ => throw new InvalidOperationException(),
            isHeadlessClient: false);
        Assert(host.Kind == StreamingSeatRole.CaptureOutcomeKind.Off && host.Message is null,
            "on the host the capture variable configures its streaming seat: nothing loads and nothing warns");
        var seat = StreamingSeatRole.StartCapture(false, Extension, _ => true, _ => throw new InvalidOperationException(),
            isHeadlessClient: true);
        Assert(seat.Kind == StreamingSeatRole.CaptureOutcomeKind.IgnoredExtension, "a normal seat still warns");
        Assert(StreamingSeatRole.EnvironmentVariable == StreamingSeatDescriptor.RoleEnvironmentVariable
               && StreamingSeatRole.EnvironmentVariable == "COUCHCOOP_STREAMING_SEAT",
            "the role and the descriptor read one flag");
    }

    private static void ItemTaggerGroupsMatchTheModules()
    {
        RenderStreamItemTagger.ItemTagFacts F(string name, string type, string? scene = null, string? parentName = null,
            string? parentScene = null, bool rewardAncestor = false)
            => new(name, type, scene, parentName, parentScene, rewardAncestor);

        var groups = (RenderStreamItemTagger.ItemTagFacts f) => RenderStreamItemTagger.GroupsFor(f);
        Assert(groups(F("NHandCardHolder-CARD", "NHandCardHolder")).Contains(RenderStreamItemTagger.HandHolderGroup),
            "a hand card holder is tagged a holder");
        Assert(groups(F("NPlayerHand", "NPlayerHand")).Contains(RenderStreamItemTagger.HandRootGroup),
            "the hand root is tagged");
        Assert(groups(F("CardHolderContainer", "Godot.Control")).Contains(RenderStreamItemTagger.HandContainerGroup),
            "the hand container is tagged by name");
        Assert(groups(F("Arrow", "NTargetingArrow")).Contains(RenderStreamItemTagger.TargetingArrowGroup),
            "a targeting arrow is tagged");
        Assert(groups(F("Screen", "NChooseACardSelectionScreen")).Contains(RenderStreamItemTagger.HandChoiceGroup)
            && groups(F("SelectModeBackstop", "Godot.ColorRect")).Contains(RenderStreamItemTagger.HandChoiceGroup),
            "both hand-choice hosts are tagged");
        Assert(groups(F("HealthBar", "Godot.Control", parentName: "Creature",
            parentScene: "res://scenes/combat/creature.tscn")).Contains(RenderStreamItemTagger.CreatureHudGroup),
            "a creature HealthBar group is tagged");
        Assert(groups(F("Intents", "Godot.Control", parentName: "Creature",
            parentScene: "res://scenes/combat/creature.tscn")).Contains(RenderStreamItemTagger.CreatureHudGroup),
            "a creature Intents group is tagged");
        Assert(groups(F("SelectionReticle", "Godot.Control", parentName: "Creature",
            parentScene: "res://scenes/combat/creature.tscn")).Contains(RenderStreamItemTagger.CreatureReticleGroup),
            "a creature reticle is tagged");
        Assert(groups(F("PowerContainer", "Godot.Control", parentName: "HealthBar",
            parentScene: "res://scenes/combat/creature.tscn")).Contains(RenderStreamItemTagger.CreaturePowerGroup),
            "a creature power container is tagged");
        // The same names outside a creature are NOT tagged (a creature's own inner HealthBar must not move alone).
        Assert(groups(F("HealthBar", "Godot.Control", parentName: "Elsewhere",
            parentScene: "res://scenes/combat/creature_state_display.tscn")).Count == 0,
            "a non-creature HealthBar is not a HUD group");
        Assert(groups(F("CardReward", "NCardRewardSelectionScreen")).Contains(RenderStreamItemTagger.CardRewardRootGroup),
            "the card-reward screen root is tagged");
        Assert(groups(F("Card", "NCard", rewardAncestor: true)).Contains(RenderStreamItemTagger.CardRewardCardGroup)
            && groups(F("Card", "NCard")).Count == 0,
            "an NCard is tagged only under a card-reward screen");
        Assert(groups(F("Relic", "NTreasureRoomRelicHolder")).Contains(RenderStreamItemTagger.TreasureRelicGroup),
            "the treasure relic holder is tagged");
    }

    private static Dictionary<string, string> SeatEnvironment(string auth) => new()
    {
        ["GRC_LIVE_ALLOWED_ORIGINS"] = "http://127.0.0.1:13337, http://localhost:13337",
        ["GRC_LIVE_LISTEN"] = "127.0.0.1:13366",
        ["GRC_STREAM_VERSION"] = "13",
        ["GRC_LIVE_AUTH"] = auth,
        ["GRC_EVIDENCE_DIR"] = "/home/p/ev",
        ["GRC_ROOT_SIZE"] = "presentation:1920x1080",
    };

    // The manager over a launcher that records whether each launch was the streaming seat's — asked from inside the
    // launch, exactly where LaunchReal asks it.
    private sealed class Harness
    {
        public readonly List<(int Slot, bool Streaming)> Launches = [];
        public readonly List<FakeProcess> Spawned = [];
        public readonly HeadlessClientManager Manager;

        public Harness(bool configured, int maxWidth = StreamingSeatLaunch.DefaultMaxPresentationWidth)
        {
            HeadlessClientManager? manager = null;
            Manager = manager = new HeadlessClientManager(
                launcher: slot =>
                {
                    Launches.Add((slot, manager!.IsStreamingLaunch(slot)));
                    var process = new FakeProcess(slot);
                    Spawned.Add(process);
                    return process;
                },
                readinessProbe: (_, _) => Task.FromResult(true),
                streamingConfig: configured ? new StreamingSeatLaunch.Config(Extension, Calibration, maxWidth) : null);
        }
    }

    private sealed class FakeProcess(int slot) : IHeadlessProcess
    {
        private bool _exited;
        public int Id => 30000 + slot;
        public bool HasExited => _exited;
        public int ExitCode => 0;
        public void ForceExit() => _exited = true;
        public bool RequestGracefulStop() { _exited = true; return true; }
        public void Kill() => _exited = true;
        public void Dispose() { }
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "CouchCoop.sln"))) dir = dir.Parent;
        return dir?.FullName ?? throw new Exception("[RenderStreamPairingTests] could not locate the repo root.");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition) throw new Exception($"[RenderStreamPairingTests] FAILED: {label}");
    }
}
