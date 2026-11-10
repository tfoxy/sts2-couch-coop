using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Server;
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
        TheNetModuleAddsWebTransport();
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
        DescriptorOffersWebTransportWithItsCertificate();
        DescriptorJsonOmitsAbsentMembers();
        LanPageOriginsAreTheHostsOwnPages();
        LanLaunchListensOnEveryInterface();
        LanPairIsWrittenOwnerOnly();
        LanReadsTheSecureOriginCertificate();
        await LanReadsTheDirectIpLeafAsync();
        LanDescriptorMatrix();
        LanOfferIsAlwaysMade();
        TheTokenIsNeverLogged();
        HostCaptureVariableIsConfigurationNotAWarning();
        ItemTaggerGroupsMatchTheModules();
        ItemTaggerGroupNamesMatchTheSharedTable();
        ItemTaggerReadsParentFactsOnlyForCreatureNames();
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
            ["GRC_LIVE_CARRIERS"] = "ws",
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
            ["GRC_ITEM_META"] = "scene,path,script,groups,instance_id,mouse_filter",
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

    private static void TheNetModuleAddsWebTransport()
    {
        const string net = "/opt/capture/librender_stream_net.so";
        var files = new HashSet<string> { Extension, Calibration, net };
        var found = StreamingSeatLaunch.ResolveConfig(Extension, null, files.Contains);
        Assert(found.Config == new StreamingSeatLaunch.Config(Extension, Calibration, NetModule: net),
            "the net module beside the capture is found");
        var without = StreamingSeatLaunch.ResolveConfig(Extension, null, new HashSet<string> { Extension, Calibration }.Contains);
        Assert(without.Config is { NetModule: null }, "no net module beside the capture: none");

        var env = StreamingSeatLaunch.Environment(found.Config!, StreamingSeatLaunch.HubPortForSlot(2), "/ev",
            StreamingSeatLaunch.AllowedOrigins(13337, null));
        Assert(env["GRC_LIVE_CARRIERS"] == "ws,wt" && env["GRC_LIVE_NET_MODULE"] == net
               && env["GRC_LIVE_WT_LISTEN"] == "127.0.0.1:13366" && env["GRC_LIVE_WT_CERT"] == "self",
            "with the module: WebSocket and WebTransport on one port number, the module named, a self-signed certificate");
        Assert(env["GRC_LIVE_LISTEN"] == "127.0.0.1:13366" && !env.ContainsKey("GRC_LIVE_EXPOSE")
               && !env.ContainsKey("GRC_LIVE_TLS_CERT"),
            "still loopback only, with no consumer certificate");
        var plain = StreamingSeatLaunch.Environment(without.Config!, StreamingSeatLaunch.HubPortForSlot(2), "/ev",
            StreamingSeatLaunch.AllowedOrigins(13337, null));
        Assert(plain["GRC_LIVE_CARRIERS"] == "ws" && !plain.ContainsKey("GRC_LIVE_NET_MODULE") && !plain.ContainsKey("GRC_LIVE_WT_LISTEN"),
            "without it: WebSocket alone (listing wt with no module would refuse the whole listener)");

        var root = Path.Combine(Path.GetTempPath(), "cc-payload");
        var packaged = Path.Combine(root, "render-capture", "render_stream_capture.gdextension");
        var payload = new HashSet<string> { packaged, Path.Combine(root, "render-capture", "calibration"),
            Path.Combine(root, "render-capture", StreamingSeatLaunch.NetModuleFileName) };
        Assert(StreamingSeatLaunch.ResolveConfig(null, null, payload.Contains, root).Config?.NetModule
               == Path.Combine(root, "render-capture", StreamingSeatLaunch.NetModuleFileName),
            "a deployed render-capture/ carries the net module beside the capture");
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

    private static void DescriptorOffersWebTransportWithItsCertificate()
    {
        var hash = new string('c', 64);
        var env = new Dictionary<string, string>(SeatEnvironment(auth: "token"))
        {
            ["GRC_LIVE_CARRIERS"] = "ws,wt",
            ["GRC_LIVE_WT_LISTEN"] = "127.0.0.1:13366",
        };
        string? Token_(string _) => Token;
        string? asked = null;
        var both = StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", env.GetValueOrDefault, Token_,
            path => { asked = path; return hash + "\n"; });
        Assert(both?.WebTransport is { Url: "https://127.0.0.1:13366/render-stream", CertificateHashes: [var pinned] } && pinned == hash,
            "wt listed and its hash written: webTransport on the same port, pinned by that hash");
        Assert(asked == Path.Combine("/home/p/ev", StreamingSeatDescriptor.CertificateHashFileName),
            "the hash is the net module's live-cert-sha256");
        Assert(both!.Url == "ws://127.0.0.1:13366/render-stream", "the WebSocket url stays, as the fallback");

        var defaulted = new Dictionary<string, string>(env);
        defaulted.Remove("GRC_LIVE_WT_LISTEN");
        Assert(StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", defaulted.GetValueOrDefault, Token_, _ => hash)
               ?.WebTransport?.Url == "https://127.0.0.1:13366/render-stream",
            "no GRC_LIVE_WT_LISTEN: the capture's default, GRC_LIVE_LISTEN's host and port");

        foreach (var bad in new string?[] { null, "", new string('C', 64), new string('c', 63) })
        {
            var described = StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", env.GetValueOrDefault, Token_, _ => bad);
            Assert(described is { WebTransport: null }, $"no or a malformed hash ('{bad}'): WebSocket only, never a guess");
        }

        var wsOnly = new Dictionary<string, string>(env) { ["GRC_LIVE_CARRIERS"] = "ws" };
        Assert(StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", wsOnly.GetValueOrDefault, Token_,
                   _ => throw new InvalidOperationException("no hash is read when wt is not listed")) is { WebTransport: null },
            "wt not listed: no webTransport, and no hash read");
        var lanWt = new Dictionary<string, string>(env) { ["GRC_LIVE_WT_LISTEN"] = "0.0.0.0:13366" };
        Assert(StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", lanWt.GetValueOrDefault, Token_, _ => hash)
               is { WebTransport: null },
            "a non-loopback wt listener is not described to a loopback page");
        Assert(StreamingSeatDescriptor.Build(true, "http://127.0.0.1:13337", env.GetValueOrDefault, Token_) is { WebTransport: null },
            "no hash reader: no webTransport");
    }

    private static void DescriptorJsonOmitsAbsentMembers()
    {
        // The client's validator is strict: an unknown key or an explicit null `webTransport` fails the descriptor.
        var plain = BrowserJson.Serialize(new BrowserRenderStreamDto("ws://127.0.0.1:13366/render-stream",
            "http://127.0.0.1:13366", Token, 13, [1920, 1080]));
        Assert(!plain.Contains("webTransport", StringComparison.Ordinal), $"no webTransport member at all: {plain}");
        var wt = BrowserJson.Serialize(new BrowserRenderStreamDto("ws://127.0.0.1:13366/render-stream",
            "http://127.0.0.1:13366", Token, 13, [1920, 1080],
            new BrowserRenderStreamWebTransportDto("https://127.0.0.1:13366/render-stream", [new string('c', 64)])));
        Assert(wt.Contains("\"webTransport\":{\"url\":\"https://127.0.0.1:13366/render-stream\",\"certificateHashes\":[\"", StringComparison.Ordinal),
            $"the client's key names: {wt}");
        var unpinned = BrowserJson.Serialize(new BrowserRenderStreamWebTransportDto("https://h:1/render-stream"));
        Assert(unpinned == "{\"url\":\"https://h:1/render-stream\"}", $"no certificateHashes member when unpinned: {unpinned}");
    }

    // ---- CAR7b: streaming the new renderer to the host's LAN pages ------------------------------------------------

    private static readonly IPAddress LanAddress = IPAddress.Parse("192.168.1.77");

    private static void LanPageOriginsAreTheHostsOwnPages()
    {
        var context = new StreamingSeatLan.Context(
            [LanAddress, IPAddress.Parse("10.0.0.5"), IPAddress.Loopback, IPAddress.IPv6Loopback], "Worky.local", "my.local-ip.co", null);
        var origins = StreamingSeatLan.PageOrigins(context, 13337);
        string[] expected =
        [
            "http://192.168.1.77:13337", "https://192.168.1.77:13337", "http://10.0.0.5:13337", "https://10.0.0.5:13337",
            "http://worky.local:13337", "https://worky.local:13337",
            "https://192-168-1-77.my.local-ip.co:13337", "https://10-0-0-5.my.local-ip.co:13337",
        ];
        Assert(origins.SequenceEqual(expected), $"http+https per LAN address and the mDNS name, https per secure host: {string.Join(' ', origins)}");
        // Every one survives the capture's exact-origin rule (AllowedOrigins drops anything that would not).
        var kept = StreamingSeatLaunch.AllowedOrigins(13337, string.Join(',', origins));
        Assert(expected.All(kept.Contains), "each LAN origin is a valid scheme://host:port entry");
        Assert(StreamingSeatLan.PageOrigins(new StreamingSeatLan.Context([], null, null, null), 13337).Count == 0,
            "no LAN addresses and no names: no LAN origins");
    }

    private static void LanLaunchListensOnEveryInterface()
    {
        var config = new StreamingSeatLaunch.Config(Extension, Calibration, NetModule: "/opt/capture/librender_stream_net.so");
        var origins = StreamingSeatLaunch.AllowedOrigins(13337, "https://192.168.1.77:13337");
        var env = StreamingSeatLaunch.Environment(config, 13366, "/ev", origins, lan: new StreamingSeatLaunch.LanLaunch("/ev/c.pem", "/ev/k.pem"));
        Assert(env["GRC_LIVE_EXPOSE"] == "lan" && env["GRC_LIVE_LISTEN"] == "0.0.0.0:13366" && env["GRC_LIVE_WT_LISTEN"] == "0.0.0.0:13366",
            "LAN: exposed, the hub on every interface for both carriers");
        Assert(env["GRC_LIVE_AUTH"] == "token" && env["GRC_LIVE_ALLOWED_ORIGINS"].Contains("https://192.168.1.77:13337", StringComparison.Ordinal),
            "with the token and the LAN origins godot-scene-web requires for lan");
        Assert(env["GRC_LIVE_TLS_CERT"] == "/ev/c.pem" && env["GRC_LIVE_TLS_KEY"] == "/ev/k.pem" && env["GRC_LIVE_WT_CERT"] == "self",
            "wss through the host's pair; WebTransport keeps its pinned self-signed certificate");
        Assert(env[StreamingSeatDescriptor.LanPlaintextEnvironmentVariable] == "allow",
            "with a pair, plain ws is still served to the host's http LAN pages");
        var noTls = StreamingSeatLaunch.Environment(config, 13366, "/ev", origins, lan: new StreamingSeatLaunch.LanLaunch());
        Assert(noTls["GRC_LIVE_EXPOSE"] == "lan" && !noTls.ContainsKey("GRC_LIVE_TLS_CERT") && !noTls.ContainsKey("GRC_LIVE_TLS_KEY")
               && !noTls.ContainsKey(StreamingSeatDescriptor.LanPlaintextEnvironmentVariable),
            "no host certificate: LAN without wss (plain ws, F6, needs no option)");
        var off = StreamingSeatLaunch.Environment(config, 13366, "/ev", origins);
        Assert(off["GRC_LIVE_LISTEN"] == "127.0.0.1:13366" && !off.ContainsKey("GRC_LIVE_EXPOSE") && !off.ContainsKey("GRC_LIVE_TLS_CERT"),
            "no LAN launch: loopback exactly as before");
    }

    private static void LanPairIsWrittenOwnerOnly()
    {
        var dir = Directory.CreateTempSubdirectory("cc-lan-pair").FullName;
        try
        {
            File.WriteAllText(Path.Combine(dir, StreamingSeatLan.KeyFileName), "stale");
            IReadOnlyList<string> origins;
            var lanHarness = new Harness(configured: true);
            lanHarness.Manager.StreamingSeatLanContext = () => new StreamingSeatLan.Context([LanAddress], null, null,
                new StreamingSeatLan.TlsPair("direct-ip", "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n", "SECRET-KEY"));
            origins = ["http://127.0.0.1:13337"];
            var (lan, kind) = lanHarness.Manager.PrepareStreamingSeatLanLocked(dir, 13337, ref origins);
            var key = Path.Combine(dir, StreamingSeatLan.KeyFileName);
            Assert(lan is { TlsCertificate: not null, TlsKey: not null } && kind == "direct-ip" && lan.TlsKey == key,
                "a certificate: a LAN launch with the pair's paths and its kind (never the key) for the log, the stale key replaced");
            Assert(origins.Contains("https://192.168.1.77:13337") && origins[0] == "http://127.0.0.1:13337",
                $"the LAN origins appended after the loopback ones: {string.Join(' ', origins)}");
            Assert(File.ReadAllText(key) == "SECRET-KEY", "the key is written as given");
            if (!OperatingSystem.IsWindows())
            {
                Assert(File.GetUnixFileMode(key) == (UnixFileMode.UserRead | UnixFileMode.UserWrite),
                    $"the key file is owner-only: {File.GetUnixFileMode(key)}");
            }

            lanHarness.Manager.StreamingSeatLanContext = () => new StreamingSeatLan.Context([LanAddress], null, null, null);
            origins = ["http://127.0.0.1:13337"];
            var (bare, bareKind) = lanHarness.Manager.PrepareStreamingSeatLanLocked(dir, 13337, ref origins);
            Assert(bare is { TlsCertificate: null } && bareKind == "none" && !File.Exists(key),
                "no certificate this time: LAN without wss, and the previous pair is gone");
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static void LanReadsTheSecureOriginCertificate()
    {
        var dir = Directory.CreateTempSubdirectory("cc-secure-cert").FullName;
        try
        {
            void Write(string dns, DateTimeOffset notBefore, DateTimeOffset notAfter)
            {
                using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
                var request = new CertificateRequest("CN=" + dns, key, HashAlgorithmName.SHA256);
                var san = new SubjectAlternativeNameBuilder();
                san.AddDnsName(dns);
                request.CertificateExtensions.Add(san.Build());
                using var certificate = request.CreateSelfSigned(notBefore, notAfter);
                File.WriteAllText(Path.Combine(dir, "server.pem"), certificate.ExportCertificatePem());
                File.WriteAllText(Path.Combine(dir, "server.key"), key.ExportPkcs8PrivateKeyPem());
            }

            var now = DateTimeOffset.UtcNow;
            Write("*.my.local-ip.co", now.AddDays(-1), now.AddDays(30));
            File.WriteAllText(Path.Combine(dir, "intermediates.pem"), "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n");
            var read = StreamingSeatLan.ReadSecureOrigin(dir, now);
            Assert(read is { Domain: "my.local-ip.co" } && read.Value.Pair.Kind == "secure-origin"
                   && read.Value.Pair.CertificatePem.Contains("AA==", StringComparison.Ordinal),
                "a valid cached wildcard: its domain, and the leaf followed by the intermediates");
            Assert(StreamingSeatLan.ReadSecureOrigin(dir, now.AddDays(31)) is null, "an expired one is not used");
            Write("host.example", now.AddDays(-1), now.AddDays(30));
            Assert(StreamingSeatLan.ReadSecureOrigin(dir, now) is null, "a certificate with no single-label wildcard is not a secure origin");
            Assert(StreamingSeatLan.ReadSecureOrigin(Path.Combine(dir, "missing"), now) is null, "no cache: none");
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static async Task LanReadsTheDirectIpLeafAsync()
    {
        var dir = Directory.CreateTempSubdirectory("cc-direct-ip").FullName;
        try
        {
            using var authority = new DirectIpCertificates(dir);
            using var material = await authority.PrepareAsync([LanAddress]);
            authority.SaveSeatMaterial(material);
            var pair = StreamingSeatLan.ReadDirectIp(Path.Combine(dir, "seat-leaves"), [IPAddress.Parse("10.9.9.9"), LanAddress]);
            Assert(pair is { Kind: "direct-ip" }, "the leaf the host published for its seats is found for a LAN address it covers");
            using var reloaded = X509Certificate2.CreateFromPem(pair!.CertificatePem, pair.KeyPem);
            Assert(reloaded.MatchesHostname("192.168.1.77", allowWildcards: false, allowCommonName: false) && reloaded.HasPrivateKey,
                "its PEM pair is the IP-SAN leaf and its key");
            Assert(StreamingSeatLan.ReadDirectIp(Path.Combine(dir, "seat-leaves"), [IPAddress.Parse("10.9.9.9")]) is null,
                "a leaf that names none of this host's addresses is not used");
            Assert(StreamingSeatLan.ReadDirectIp(Path.Combine(dir, "nope"), [LanAddress]) is null, "no seat material: none");
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static void LanDescriptorMatrix()
    {
        var hash = new string('c', 64);
        var env = new Dictionary<string, string>(SeatEnvironment(auth: "token"))
        {
            ["GRC_LIVE_EXPOSE"] = "lan",
            ["GRC_LIVE_LISTEN"] = "0.0.0.0:13366",
            ["GRC_LIVE_WT_LISTEN"] = "0.0.0.0:13366",
            ["GRC_LIVE_CARRIERS"] = "ws,wt",
            ["GRC_LIVE_TLS_CERT"] = "/ev/tls-cert.pem",
            ["GRC_LIVE_ALLOWED_ORIGINS"] = "http://127.0.0.1:13337,http://localhost:13337,http://192.168.1.77:13337,"
                + "https://192.168.1.77:13337,https://192-168-1-77.my.local-ip.co:13337",
        };
        string? Token_(string _) => Token;
        string? Hash(string _) => hash;
        // The pair is the Direct-IP leaf: it names the IP, not the secure-origin host name.
        bool Covers(string path, string host) => path == "/ev/tls-cert.pem" && host == "192.168.1.77";
        BrowserRenderStreamDto? D(IDictionary<string, string> e, string origin, Func<string, string?>? hashReader = null)
            => StreamingSeatDescriptor.Build(true, origin, k => e.TryGetValue(k, out var v) ? v : null, Token_, hashReader ?? Hash, Covers);

        var loop = D(env, "http://127.0.0.1:13337");
        Assert(loop is { Url: "ws://127.0.0.1:13366/render-stream", ResourceBase: "http://127.0.0.1:13366" }
               && loop.WebTransport?.Url == "https://127.0.0.1:13366/render-stream",
            "the loopback page under LAN: the hub on loopback, as before, plus WebTransport");

        var httpsIp = D(env, "https://192.168.1.77:13337");
        Assert(httpsIp is { Url: "wss://192.168.1.77:13366/render-stream", ResourceBase: "https://192.168.1.77:13366" }
               && httpsIp.WebTransport?.Url == "https://192.168.1.77:13366/render-stream" && httpsIp.Token == Token,
            "an https LAN page the certificate names: wss and WebTransport at the page's host, with the token");

        var httpsName = D(env, "https://192-168-1-77.my.local-ip.co:13337");
        Assert(httpsName?.WebTransport?.Url == "https://192-168-1-77.my.local-ip.co:13366/render-stream",
            "an https page the certificate does not name: WebTransport (pinned by hash, any host name)");
        Assert(D(env, "https://192-168-1-77.my.local-ip.co:13337", _ => null) is null,
            "... and with no WebTransport either, nothing it could use: no descriptor");

        var httpIp = D(env, "http://192.168.1.77:13337");
        Assert(httpIp is { Url: "wss://192.168.1.77:13366/render-stream", WebTransport: null },
            "a plain-http LAN page on a hub that refuses LAN plaintext: no WebTransport (not a secure context); wss");
        var both = new Dictionary<string, string>(env) { [StreamingSeatDescriptor.LanPlaintextEnvironmentVariable] = "allow" };
        Assert(D(both, "http://192.168.1.77:13337") is
               { Url: "ws://192.168.1.77:13366/render-stream", ResourceBase: "http://192.168.1.77:13366", WebTransport: null },
            "a hub serving LAN plaintext beside wss: the plain-http page gets plain ws, no certificate to trust");
        Assert(D(both, "http://192-168-1-77.my.local-ip.co:13337") is null, "... still only for an origin the host allowed");
        Assert(D(both, "https://192.168.1.77:13337") is { Url: "wss://192.168.1.77:13366/render-stream" },
            "... and an https page keeps wss");

        var plain = new Dictionary<string, string>(env);
        plain.Remove("GRC_LIVE_TLS_CERT");
        var httpPlain = D(plain, "http://192.168.1.77:13337");
        Assert(httpPlain is { Url: "ws://192.168.1.77:13366/render-stream", ResourceBase: "http://192.168.1.77:13366", WebTransport: null },
            "no host certificate: a plain-http LAN page gets plain ws (F6)");
        var httpsPlain = D(plain, "https://192.168.1.77:13337");
        Assert(httpsPlain?.WebTransport is not null && httpsPlain.Url.StartsWith("ws://", StringComparison.Ordinal),
            "no host certificate, an https page: WebTransport (its ws fallback is mixed content and cannot help)");
        Assert(D(plain, "https://192.168.1.77:13337", _ => null) is null, "... and without WebTransport: no descriptor");

        var nameOnly = new Dictionary<string, string>(env) { ["GRC_LIVE_CARRIERS"] = "ws" };
        Assert(D(nameOnly, "http://192-168-1-77.my.local-ip.co:13337") is null, "an origin the host did not allow: none");

        var loopbackHub = new Dictionary<string, string>(env) { ["GRC_LIVE_LISTEN"] = "127.0.0.1:13366" };
        loopbackHub.Remove("GRC_LIVE_EXPOSE");
        Assert(D(loopbackHub, "https://192.168.1.77:13337") is null, "a LAN page on a loopback-only hub (no lan exposure): none");
        var lanListenNoExpose = new Dictionary<string, string>(env);
        lanListenNoExpose.Remove("GRC_LIVE_EXPOSE");
        Assert(D(lanListenNoExpose, "http://127.0.0.1:13337") is null, "0.0.0.0 without lan exposure is not this host's launch");
    }

    private static void LanOfferIsAlwaysMade()
    {
        Assert(new Harness(configured: false).Manager.RenderStreamLanOffer("https://192.168.1.77:13337") is null, "no capture: no offer");
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=wild", key, HashAlgorithmName.SHA256);
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("*.my.local-ip.co");
        request.CertificateExtensions.Add(san.Build());
        using var leaf = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(9));
        var lan = new Harness(configured: true);
        lan.Manager.StreamingSeatLanContext = () => new StreamingSeatLan.Context([LanAddress], null, "my.local-ip.co",
            new StreamingSeatLan.TlsPair("secure-origin", leaf.ExportCertificatePem(), "k"));
        Assert(lan.Manager.RenderStreamLanOffer("https://192-168-1-77.my.local-ip.co:13337") is (false, true, true),
            "no net module, a certificate naming this page's host: tls, and plain ws (served beside it)");
        Assert(lan.Manager.RenderStreamLanOffer("http://192.168.1.77:13337") is (false, false, true),
            "the same certificate does not name an IP page: no tls for it, but plain ws for its plain-http page");
        Assert(lan.Manager.RenderStreamLanOffer(null) is (false, false, true), "no Origin: no certificate it could name");
        var plain = new Harness(configured: true);
        plain.Manager.StreamingSeatLanContext = () => new StreamingSeatLan.Context([LanAddress], null, null, null);
        Assert(plain.Manager.RenderStreamLanOffer("http://192.168.1.77:13337") is (false, false, true),
            "no certificate at all: plain ws for a plain-http LAN page (CAR9)");
        var json = BrowserJson.Serialize(new BrowserRenderStreamLanDto(true, false, true));
        Assert(json == "{\"webTransport\":true,\"tls\":false,\"ws\":true}", $"the wire shape: {json}");
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
        RenderStreamItemTagger.ItemTagFacts F(string name, string type, string? parentName = null,
            string? parentScene = null, bool rewardAncestor = false)
            => new(name, type, parentName, parentScene, rewardAncestor);

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
        Assert(groups(F("Option", "NEventOptionButton")).Contains(RenderStreamItemTagger.EventOptionGroup),
            "an event option button is tagged");
        Assert(groups(F("Rest", "NRestSiteButton")).Contains(RenderStreamItemTagger.RestSiteGroup),
            "a rest-site choice is tagged");
        foreach (var shop in new[] { "NMerchantRelic", "NMerchantPotion", "NMerchantCard", "NMerchantCardRemoval" })
        {
            Assert(groups(F("Item", shop)).Contains(RenderStreamItemTagger.ShopItemGroup),
                $"a merchant inventory item ({shop}) is tagged a shop item");
        }
        Assert(groups(F("Else", "NCard")).Count == 0, "an ordinary widget is not confirm-tagged");

    }

    // TWO-SIDED LOCKSTEP (C# side): the tagger's `<Role>Group` consts equal tests/fixtures/render-stream/item-groups.json,
    // keyed by role (`HandHolderGroup` ↔ `hand_holder`). The frontend's stream-ext/__tests__/groups.spec.ts asserts its
    // `RS_GROUP_<ROLE>` exports equal the same table, so a name renamed on one side only fails a test.
    private static void ItemTaggerGroupNamesMatchTheSharedTable()
    {
        var path = Path.Combine(RepoRoot(), "tests", "fixtures", "render-stream", "item-groups.json");
        var table = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path))!
            .Where(entry => !entry.Key.StartsWith('_'))
            .ToDictionary(entry => entry.Key, entry => entry.Value);

        var consts = typeof(RenderStreamItemTagger)
            .GetFields(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic)
            .Where(field => field.IsLiteral && field.FieldType == typeof(string) && field.Name.EndsWith("Group", StringComparison.Ordinal))
            .ToDictionary(field => RoleKey(field.Name[..^"Group".Length]), field => (string)field.GetRawConstantValue()!);

        Assert(table.Count == 14, $"the shared table lists the 14 groups (got {table.Count})");
        Assert(consts.Count == table.Count && consts.All(entry => table.TryGetValue(entry.Key, out var name) && name == entry.Value),
            "the tagger's group consts equal the shared table: "
            + string.Join(", ", consts.OrderBy(entry => entry.Key).Select(entry => $"{entry.Key}={entry.Value}")));

        static string RoleKey(string pascal) =>
            string.Concat(pascal.Select((c, i) => char.IsUpper(c) && i > 0 ? "_" + char.ToLowerInvariant(c) : char.ToLowerInvariant(c).ToString()));
    }

    // BuildFacts runs for every node on the streaming seat, so the parent's facts are read only for names a creature
    // HUD rule keys on. Every rule that reads ParentName/ParentSceneFile must key on one of those names.
    private static void ItemTaggerReadsParentFactsOnlyForCreatureNames()
    {
        foreach (var name in new[] { "HealthBar", "Intents", "SelectionReticle", "PowerContainer" })
        {
            Assert(RenderStreamItemTagger.NeedsParentFacts(name), $"{name} reads its parent's facts");
        }

        foreach (var name in new[] { "Card", "CardHolderContainer", "SelectModeBackstop", "Creature", "healthbar" })
        {
            Assert(!RenderStreamItemTagger.NeedsParentFacts(name), $"{name} does not read its parent's facts");
        }

        // Any other name groups the same whatever its parent is: the facts BuildFacts leaves null cannot matter.
        const string creature = "res://scenes/combat/creature.tscn";
        foreach (var (name, type) in new[] { ("Arrow", "NTargetingArrow"), ("Relic", "NTreasureRoomRelicHolder"), ("Else", "Godot.Control") })
        {
            var bare = RenderStreamItemTagger.GroupsFor(new(name, type, null, null, false));
            var withParent = RenderStreamItemTagger.GroupsFor(new(name, type, "HealthBar", creature, false));
            Assert(bare.SequenceEqual(withParent), $"{name}'s groups do not depend on its parent");
        }
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
                streamingConfig: configured ? new StreamingSeatLaunch.Config(Extension, Calibration, maxWidth) : null, registerProcessExit: false);
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
