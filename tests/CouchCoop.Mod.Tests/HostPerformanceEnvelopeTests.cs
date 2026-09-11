using System.Reflection;
using System.Text.Json;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using CouchCoop.MirrorProtocol.Envelopes;

// WS-2 (host-performance truth). The mirror Settings panel's "Host performance" checkboxes used to be hardcoded ON
// in the browser, so a viewer watching the HOST's own game (direct view: the [Host] row, or a singleplayer run) saw
// three ticked boxes over a game where NOTHING was frozen — CouchCoopMod only installs the visual suspender for a
// WINDOWLESS instance, while the suspender's static `_freeze*` flags read their env defaults (true) regardless.
//
// The fix has two halves; these tests cover the host half:
//   1. EFFECTIVE state — `ComputeEffectiveFreezes` says a process that never installed the machinery applies
//      nothing, whatever its flags hold — and the `session` envelope carries that, so the panel can seed from the
//      instance it is about to control.
//   2. The `settings` message still round-trips all three levers into the host (the channel the panel toggles use,
//      now honoured on ANY instance rather than a headless one only).
//
// Deliberately NOT exercised here: SetFreeze*/Install. Both reach Godot (Engine.GetMainLoop / Callable) which is a
// NATIVE call that segfaults in this runner (see the note at the top of BrowserServerRouteTests.cs) — the rule they
// branch on is the pure ComputeEffectiveFreezes below, and the live behaviour is verified in a real game session.
internal static class HostPerformanceEnvelopeTests
{
    public static void Run()
    {
        NotInstalledMeansNothingIsFrozen();
        InstalledReportsItsFlagsVerbatim();
        SessionEnvelopeReportsAWindowedHostAsAllFalse();
        SessionEnvelopeReportsAnInstalledInstancesFlags();
        RequiredNullableSessionFieldsSerializeAsNull();
        SettingsMessageCarriesTheThreeFreezes();
    }

    // THE user-visible bug, as a rule: a windowed host holds `_freeze* = true` (env defaults) and has no Timer, no
    // rescan and no frozen node. Reporting the raw flags is what made the panel lie.
    private static void NotInstalledMeansNothingIsFrozen()
    {
        var effective = CouchCoopHeadlessVisualSuspender.ComputeEffectiveFreezes(
            installed: false, particles: true, spines: true, decor: true);

        Assert(!effective.Particles, "not installed ⇒ particles report NOT frozen (even with the flag on)");
        Assert(!effective.Spines, "not installed ⇒ spines report NOT frozen");
        Assert(!effective.Decor, "not installed ⇒ decor reports NOT frozen");
    }

    private static void InstalledReportsItsFlagsVerbatim()
    {
        var all = CouchCoopHeadlessVisualSuspender.ComputeEffectiveFreezes(
            installed: true, particles: true, spines: true, decor: true);
        Assert(all.Particles && all.Spines && all.Decor, "installed ⇒ every ON flag reports frozen");

        // A runtime toggle-off must survive the rule.
        var mixed = CouchCoopHeadlessVisualSuspender.ComputeEffectiveFreezes(
            installed: true, particles: true, spines: false, decor: true);
        Assert(mixed.Particles && !mixed.Spines && mixed.Decor, "installed ⇒ a single OFF lever reports OFF alone");
    }

    private static void SessionEnvelopeReportsAWindowedHostAsAllFalse()
    {
        using var restore = SuspenderState.Push(installed: false, particles: true, spines: true, decor: true);

        var envelope = CreateSessionEnvelope();

        Assert(envelope.FreezeParticles == false, "windowed host: session envelope reports freezeParticles=false");
        Assert(envelope.FreezeSpines == false, "windowed host: session envelope reports freezeSpines=false");
        Assert(envelope.FreezeDecor == false, "windowed host: session envelope reports freezeDecor=false");

        // Present-and-false, not omitted: `false` is the seed the panel needs. (Omission means "unknown", which is
        // what a Godot-less host degrades to — the client then keeps its own defaults.)
        var json = JsonSerializer.SerializeToElement(envelope, BrowserJson.Options);
        Assert(json.TryGetProperty("freezeParticles", out var particles) && !particles.GetBoolean(),
            "windowed host: the wire carries freezeParticles:false (present, not omitted)");
        Assert(json.TryGetProperty("freezeSpines", out _) && json.TryGetProperty("freezeDecor", out _),
            "windowed host: the wire carries all three freeze fields");
    }

    private static void SessionEnvelopeReportsAnInstalledInstancesFlags()
    {
        using var restore = SuspenderState.Push(installed: true, particles: true, spines: false, decor: true);

        var envelope = CreateSessionEnvelope();

        Assert(envelope.FreezeParticles == true, "headless seat: session envelope reports freezeParticles=true");
        Assert(envelope.FreezeSpines == false, "headless seat: a lever turned off reports false");
        Assert(envelope.FreezeDecor == true, "headless seat: session envelope reports freezeDecor=true");
    }

    private static void RequiredNullableSessionFieldsSerializeAsNull()
    {
        var json = JsonSerializer.SerializeToElement(new
        {
            session = new BrowserSessionDto(null, "unassigned", Joined: false, PlayerId: null, ConnectionCount: 0),
            player = new BrowserPlayerOption(
                "synthetic", "Synthetic", IsHost: false, IsRunPlayer: false, ConnectionCount: 0,
                Disconnected: false, NetId: null, SeatStatusReason: null, CharacterId: null),
            screen = new BrowserScreenDto("unsupported", Type: null, Title: null, MirrorMode: "unsupported"),
        }, BrowserJson.Options);

        var session = json.GetProperty("session");
        Assert(session.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.Null,
            "current session emits name:null rather than omitting identity");
        Assert(session.TryGetProperty("playerId", out var playerId) && playerId.ValueKind == JsonValueKind.Null,
            "current session emits playerId:null rather than omitting identity");
        var player = json.GetProperty("player");
        Assert(player.TryGetProperty("netId", out var netId) && netId.ValueKind == JsonValueKind.Null,
            "current player emits netId:null rather than omitting identity");
        Assert(player.TryGetProperty("seatStatusReason", out var reason) && reason.ValueKind == JsonValueKind.Null,
            "current player emits seatStatusReason:null rather than omitting status");
        Assert(player.TryGetProperty("characterId", out var character) && character.ValueKind == JsonValueKind.Null,
            "current player emits characterId:null rather than omitting identity");
        var screen = json.GetProperty("screen");
        Assert(screen.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.Null,
            "current screen emits type:null rather than omitting a legitimate runtime null");
        Assert(screen.TryGetProperty("title", out var title) && title.ValueKind == JsonValueKind.Null,
            "current screen emits title:null rather than omitting a legitimate runtime null");
    }

    // The panel's toggles ride `{"type":"settings", ...}`; the host parses it into BrowserSettingsRequestEnvelope and
    // hands each present field to the matching suspender setter. Absent fields must stay null ("leave unchanged"),
    // which is what lets the client push a partial payload without stomping the other levers.
    private static void SettingsMessageCarriesTheThreeFreezes()
    {
        var parsed = BrowserJson.Deserialize<BrowserSettingsRequestEnvelope>(
            """{"type":"settings","requestId":"settings:1","freezeParticles":false,"freezeSpines":true,"freezeDecor":false}""");

        Assert(parsed is not null, "settings message parses");
        Assert(parsed!.FreezeParticles == false, "settings: freezeParticles false round-trips");
        Assert(parsed.FreezeSpines == true, "settings: freezeSpines true round-trips");
        Assert(parsed.FreezeDecor == false, "settings: freezeDecor false round-trips");
        Assert(parsed.RefreshRate is null && parsed.TweenReplay is null, "settings: absent fields stay null (unchanged)");
    }

    private static BrowserEnvelope CreateSessionEnvelope()
        => new BrowserStateEnvelopeFactory(
                new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"), new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0"))))
            .CreateSessionEnvelope("Alice", "session", null).GetAwaiter().GetResult();

    // Drive the suspender's private statics for the duration of one assertion, then put them back — the runner is a
    // single process and the other envelope suite reads the same fields. Also arms the captured-baseline fast path
    // so CreateSessionEnvelope's MaxFps read never hops to the (native, segfaulting) Godot main thread.
    private sealed class SuspenderState : IDisposable
    {
        private static readonly Type Type = typeof(CouchCoopHeadlessVisualSuspender);
        private readonly (FieldInfo Field, object? Value)[] _saved;

        private SuspenderState((FieldInfo, object?)[] saved) => _saved = saved;

        public static SuspenderState Push(bool installed, bool particles, bool spines, bool decor)
        {
            Field("_baselineMaxFps").SetValue(null, 60);
            Field("_baselineCaptured").SetValue(null, true);

            var names = new[] { "_started", "_freezeParticles", "_freezeSpine", "_freezeDecor" };
            var values = new object[] { installed, particles, spines, decor };
            var saved = new (FieldInfo, object?)[names.Length];
            for (var i = 0; i < names.Length; i++)
            {
                var field = Field(names[i]);
                saved[i] = (field, field.GetValue(null));
                field.SetValue(null, values[i]);
            }

            return new SuspenderState(saved);
        }

        public void Dispose()
        {
            foreach (var (field, value) in _saved)
            {
                field.SetValue(null, value);
            }
        }

        private static FieldInfo Field(string name)
        {
            var field = Type.GetField(name, BindingFlags.NonPublic | BindingFlags.Static);
            Assert(field is not null, $"visual-suspender field `{name}` is reflectable (test hook)");
            return field!;
        }
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"HostPerformanceEnvelopeTests: {label}");
        }
    }
}
