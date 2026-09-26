using System.Text.Json;
using CouchCoop.Mod.Contracts;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Protocol;

public sealed class BrowserStateEnvelopeFactory(
    CouchCoopRuntimeHost runtimeHost,
    BrowserSessionRegistry? sessions = null,
    // Resolves the host-served Android APK's relative URL, or null when no APK is deployed. Evaluated per
    // session envelope (the APK can be deployed/removed while the host runs). Wired by the server from
    // StaticSpaFileProvider; null (the default) omits the field from the wire entirely.
    Func<string?>? androidApkUrl = null,
    // Derives the per-mirror-seat joinability stamped onto the roster (and auto-reaps a zombie instance). SHARED
    // across connections — it carries the grace-window bookkeeping a per-connection instance would keep resetting —
    // so the server owns one and hands the same reference to every connection factory. Null on a headless client
    // instance (it owns no seats) and in tests; every seat then reports ready.
    MirrorSeatDirectory? mirrorSeats = null,
    // Reads the roster (and, when asked, the lobby cap) one envelope is classified from. Null (the default, and every
    // shipped path) reads the game through CouchCoopGameFacts. A seam for the hosted-server harness and the route
    // tests, which have no game behind them and say what "the game" reports per server. The bool is whether the seat
    // table needs the lobby's cap.
    Func<bool, SessionFacts>? readSessionFacts = null)
{
    private readonly CouchCoopRuntimeHost _runtimeHost = runtimeHost ?? throw new ArgumentNullException(nameof(runtimeHost));
    private readonly BrowserSessionRegistry _sessions = sessions ?? new();
    private readonly Func<string?>? _androidApkUrl = androidApkUrl;
    private readonly MirrorSeatDirectory? _mirrorSeats = mirrorSeats;
    private readonly Func<bool, SessionFacts>? _readSessionFacts = readSessionFacts;

    internal CouchCoopRuntimeHost RuntimeHost => _runtimeHost;

    /// <summary>The reader this factory was given, so the server's per-connection factories read as it does.</summary>
    internal Func<bool, SessionFacts>? SessionFactsReader => _readSessionFacts;

    /// <summary>
    /// Read what one <c>session</c> envelope is classified from: the roster, and the lobby cap when
    /// <paramref name="seats"/> has a seat table to size from it, in one hop to the game's main thread. A fan-out to many
    /// connections calls this once and hands the result to each (<see cref="CreateSessionEnvelope"/>'s
    /// <c>facts</c>), so N envelopes cost one read; classification stays per connection because it depends on that
    /// connection's session.
    /// <para>
    /// NEVER CALL IT WHILE HOLDING A MOD LOCK: it waits on the game's main thread, which may be waiting on that lock.
    /// </para>
    /// </summary>
    internal SessionFacts ReadSessionFacts(MirrorSeatDirectory? seats)
    {
        var withLobbyCap = seats?.DescribesSeats == true;
        return _readSessionFacts is { } read
            ? read(withLobbyCap)
            : CouchCoopGameFacts.ReadSessionFacts(withLobbyCap);
    }

    /// <summary>
    /// The <c>joinRejection</c> code for a mirror join that targets <paramref name="targetNetId"/>, or null when it
    /// may proceed. Delegates to the shared seat directory, so the join handler enforces exactly the verdict the
    /// picker rendered. Null (never refuse) when there is no directory — a headless client instance owns no seats.
    /// </summary>
    internal string? RefuseSeatJoin(ulong? targetNetId) => _mirrorSeats?.RefuseJoin(targetNetId);

    // Build the per-client `session` message: identity + capabilities/notices + the lobby/run assignment.
    // The rendered game state is NOT in here. The roster the assignment is classified from is READ here (or handed in by
    // a fan-out that already read it for every connection), so a just-joined seat is resolved immediately, rather than
    // trusting whatever the roster observer last read. It is one roster read, and never a full state snapshot.
    public async Task<BrowserEnvelope> CreateSessionEnvelope(
        string? viewerName,
        string requestId,
        BrowserSessionHandle? session,
        int? headlessMirrorPort = null,
        bool? directView = null,
        string? joinRejection = null,
        // Server-fault text for joinRejection == "join-failed" only; ignored (and omitted from the wire) otherwise.
        string? joinRejectionDetail = null,
        string? connectionAttemptId = null,
        CancellationToken cancellationToken = default,
        // What a fan-out read once for all of its connections (see ReadSessionFacts). Null reads it here.
        SessionFacts? facts = null)
    {
        cancellationToken.ThrowIfCancellationRequested();

        // The host's real refresh-rate baseline, so the panel shows a truthful label (0/unlimited → null off the wire).
        //
        // GODOT-OPTIONAL CONTRACT: the browser server must keep serving in a host that has no GodotSharp on its
        // assembly-probing (TPA) list — that is exactly what tests/CouchCoop.HostedServerHarness (the process the
        // frontend playwright e2e suite drives) is. GetEffectiveBaselineMaxFpsAsync is Godot-typed, so resolving the
        // call there throws FileNotFoundException/TypeLoadException *at this call site* rather than inside the method
        // (its own internal try/catch never gets a chance to run). Before this guard the throw escaped through the
        // whole /ws session path and the socket just went quiet after the 101 — zero frames, every session-dependent
        // spec timing out. Degrade to 0, which the wire maps to `RefreshRate: null` below.
        // The same guard covers the freeze read below it: both are calls into the Godot-typed visual suspender, so
        // they degrade together (unknown → omitted from the wire → the client keeps its own defaults).
        int maxFps;
        bool? freezeParticles = null;
        bool? freezeSpines = null;
        bool? freezeDecor = null;
        try
        {
            maxFps = await CouchCoopHeadlessVisualSuspender.GetEffectiveBaselineMaxFpsAsync().ConfigureAwait(false);

            // What THIS instance really has frozen — installed-aware, so a windowed host reports all-false instead
            // of the env defaults its unused static flags still hold. The panel seeds its "Host performance"
            // checkboxes from this, which is what stops them claiming three freezes that aren't running. Pure
            // volatile field reads (no Godot call, no main-thread hop).
            var freezes = CouchCoopHeadlessVisualSuspender.EffectiveFreezes();
            freezeParticles = freezes.Particles;
            freezeSpines = freezes.Spines;
            freezeDecor = freezes.Decor;
        }
        catch (Exception exception) when (
            exception is FileNotFoundException or FileLoadException or TypeLoadException or BadImageFormatException
                or MissingMemberException or TypeInitializationException)
        {
            maxFps = 0;
        }

        // The game's Settings -> Text Effects preference, so the mirror's animated rich text obeys the switch the
        // player at the keyboard set. Its own try/catch rather than the one above, because the two readings are
        // independent: a suspender that cannot be resolved says nothing about the save system, and coupling them
        // would silently drop this field whenever that one degraded. Same guard clause, for the same reason (a
        // Godot-typed call site resolves — and can fail — HERE, not inside the method).
        bool? textEffects = null;
        try
        {
            textEffects = await CouchCoopGamePrefs.GetTextEffectsEnabledAsync().ConfigureAwait(false);
        }
        catch (Exception exception) when (
            exception is FileNotFoundException or FileLoadException or TypeLoadException or BadImageFormatException
                or MissingMemberException or TypeInitializationException)
        {
            textEffects = null;
        }

        var notices = _runtimeHost.Notices.ToList();
        var read = facts ?? ReadSessionFacts(_mirrorSeats);
        if (read.Roster is null)
        {
            // Unreadable, which is "unavailable" and never "nobody here": the screen classifies as unsupported and the
            // envelope says why, as it did when the full state snapshot failed.
            notices.Add(new CouchCoopRuntimeNotice(
                CouchCoopRuntimeHost.StateCapability,
                Supported: false,
                Provisional: true,
                UnsupportedReason: "Runtime state is unavailable."));
        }

        var assignment = BrowserAssignmentClassifier.Classify(
            read.Roster,
            _sessions,
            viewerName,
            session,
            _mirrorSeats,
            // The seat table's size, from the cap read with the roster: describing the seats asks the game nothing.
            _mirrorSeats?.DescribesSeats == true ? CouchCoopLobbyParticipation.MaxCouchSeatsOf(read.LobbyCap) : null);
        // A REFUSED join must not also report itself joined. The classifier answers a different question than the
        // join handler does — it binds the viewer's NAME to a roster option, which is what `session.joined` reports
        // — while `joinRejection` says the mirror join itself was turned away, so a refusal used to ride out
        // alongside `joined: true`. The client gates its rejection handling on `joined != true`, so the
        // contradiction silently swallowed the message and left the join screen spinning forever with no seat
        // coming: exactly what a full lobby looked like. Deny the assignment here so the reply says one thing.
        if (joinRejection is not null)
        {
            assignment = assignment with
            {
                // Matches how BrowserSessionRegistry spells an unbound session, so the three fields stay consistent.
                Session = assignment.Session with { Status = "unassigned", Joined = false, PlayerId = null },
            };
        }

        var envelope = new BrowserEnvelope(
            "session",
            requestId,
            Capabilities: ToJsonElement(_runtimeHost.Capabilities),
            Notices: ToJsonElement(notices),
            Session: assignment.Session,
            Players: assignment.Players,
            Screen: assignment.Screen,
            AssignmentNotices: assignment.Notices,
            HeadlessMirrorPort: headlessMirrorPort,
            DirectView: directView,
            JoinRejection: joinRejection,
            // Detail is meaningless without a rejection to attach it to — drop a stray one rather than emitting a
            // field the client would render under a message that isn't there.
            JoinRejectionDetail: joinRejection is null ? null : joinRejectionDetail,
            RefreshRate: maxFps > 0 ? maxFps : (int?)null,
            FreezeParticles: freezeParticles,
            FreezeSpines: freezeSpines,
            FreezeDecor: freezeDecor,
            TextEffects: textEffects,
            AndroidApkUrl: _androidApkUrl?.Invoke(),
            // WS-U: clients key their asset caches by this token — the native client its disk cache namespace, the
            // browser the `?b=` on every asset url it mints (plus its service-worker /res/ store) — and it changes
            // iff the bytes a given asset url maps to can change. Composed ONCE, in CouchCoopAssetVersion, from
            // the SAME identity CouchCoopCacheRoot keys the host's own disk on, and shared with the /bg/ urls this
            // host mints so the two can never name different builds.
            AssetCacheToken: CouchCoopAssetVersion.Token,
            // The host machine's name, so the native join dialog can name the host it is connecting to alongside
            // its address. Same source as the LAN-discovery reply (CouchCoopHostUiServices), so a discovered host
            // and a hand-typed one show the same label. Cheap (a cached OS string) — no need to hoist it.
            HostName: Environment.MachineName,
            // Static background (Stage A): the tracker's published volatile — the current combat bg image the
            // client's "Static background" setting displays. Null-omitted when unknown (the client fails open to
            // the live subtree). A pure volatile read, no Godot call.
            StaticBackground: CouchCoopStaticBackgroundTracker.Published is { } staticBg
                ? new BrowserStaticBackgroundDto(staticBg.ScenePath, staticBg.Url)
                : null,
            // The atlas pages this game build actually ships, so the browser's idle prefetch asks only for pages
            // that exist. Enumerated ONCE at startup (CouchCoopAtlasManifest.Warm from CouchCoopMod.Init) and read
            // here as a plain volatile — no Godot call, no directory walk per session. Null when this process
            // never enumerated (no engine, unreadable directory): the field is omitted and the client falls back
            // to its own compiled-in list.
            AtlasManifest: CouchCoopAtlasManifest.Pages is { Count: > 0 } atlasPages
                ? new BrowserAtlasManifestDto(CouchCoopAtlasManifest.AtlasDirectory, atlasPages)
                : null,
            ScrollAction: true,
            ConnectionAttemptId: connectionAttemptId);

        return envelope;
    }

    public void Disconnect(string? viewerName) => _sessions.Disconnect(viewerName);

    public BrowserSessionHandle CreateSession() => _sessions.CreateHandle();

    private static JsonElement ToJsonElement<T>(T value)
        => JsonSerializer.SerializeToElement(value, BrowserJson.Options);
}
