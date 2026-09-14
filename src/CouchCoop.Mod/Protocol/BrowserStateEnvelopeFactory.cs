using System.Reflection;
using System.Text.Json;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.State;
using Spirectl.Sts2.Embedding;

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
    MirrorSeatDirectory? mirrorSeats = null)
{
    private readonly CouchCoopRuntimeHost _runtimeHost = runtimeHost ?? throw new ArgumentNullException(nameof(runtimeHost));
    private readonly BrowserSessionRegistry _sessions = sessions ?? new();
    private readonly Func<string?>? _androidApkUrl = androidApkUrl;
    private readonly MirrorSeatDirectory? _mirrorSeats = mirrorSeats;

    // The mod assembly's version, folded into the client disk-cache token (WS-U). The mod csproj sets no explicit
    // version, so this resolves to the SDK default (e.g. "1.0.0") — stable per build, changing only across releases.
    private static readonly string ModAssemblyVersion =
        typeof(BrowserStateEnvelopeFactory).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(BrowserStateEnvelopeFactory).Assembly.GetName().Version?.ToString()
        ?? "0";

    internal CouchCoopRuntimeHost RuntimeHost => _runtimeHost;

    /// <summary>
    /// The game build, as one token component: version, content hash, Steam build id and branch.
    /// </summary>
    /// <remarks>
    /// All four, because each covers a gap the others leave. The version alone repeats across a rebuild that
    /// keeps its string; the hash alone is 0 when <c>release_info.json</c> is unreadable; the build id alone is 0
    /// off Steam; and the branch alone is what two branches sharing a version would differ by. Any one of them
    /// moving must move the token, so they are concatenated rather than chosen between.
    /// </remarks>
    internal static string DescribeGameBuild(CouchCoopCacheIdentity identity) =>
        $"{identity.GameVersion}/{identity.MainAssemblyHash}/{identity.SteamBuildId}/{identity.Branch}";

    /// <summary>
    /// The <c>joinRejection</c> code for a mirror join that targets <paramref name="targetNetId"/>, or null when it
    /// may proceed. Delegates to the shared seat directory, so the join handler enforces exactly the verdict the
    /// picker rendered. Null (never refuse) when there is no directory — a headless client instance owns no seats.
    /// </summary>
    internal string? RefuseSeatJoin(ulong? targetNetId) => _mirrorSeats?.RefuseJoin(targetNetId);

    // Build the per-client `session` message: identity + capabilities/notices + the lobby/run assignment.
    // The rendered game state (stateV2) is NOT in here — it rides the shared `state` broadcast. The current
    // game state is still PULLED here (cheap, identity-only) so a just-joined seat is resolved immediately
    // (the observer cache can lag a tick after EnsureLobbyPlayer).
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
        CancellationToken cancellationToken = default)
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

        var notices = _runtimeHost.Notices.ToList();
        var stateV2 = CreateStateV2(notices);
        var assignment = BrowserAssignmentClassifier.Classify(stateV2, _sessions, viewerName, session, _mirrorSeats);
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
            AndroidApkUrl: _androidApkUrl?.Invoke(),
            // WS-U: clients key their asset caches by this token — the native client its disk cache namespace, the
            // browser its service-worker /res/ store — and it changes iff the bytes a given asset url maps to can
            // change. That is the SAME question CouchCoopCacheRoot answers for the host's own disk, so it is
            // composed from the same identity rather than from a second, separately-drifting notion of "which
            // build is this". It deliberately does NOT come from Capabilities.GameVersion, which the embedded
            // runtime facade reports as the empty string — the token used to normalize that to "unknown" and so
            // never moved when the game updated at all.
            AssetCacheToken: CouchCoop.MirrorProtocol.Assets.AssetCacheToken.Compose(
                DescribeGameBuild(CouchCoopCacheRoot.Identity),
                ModAssemblyVersion,
                SpirectlAssetBinaryCache.SchemaVersion),
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
            RewardAction: true,
            ConnectionAttemptId: connectionAttemptId);

        return envelope;
    }

    public void Disconnect(string? viewerName) => _sessions.Disconnect(viewerName);

    // Disconnect a session and return the synthetic lobby player id to remove from the live game
    // (null when none / when a run player is kept). See BrowserSessionRegistry.DisconnectAndCaptureRemoval.
    public string? DisconnectSession(BrowserSessionHandle session) => _sessions.DisconnectAndCaptureRemoval(session);

    public BrowserSessionHandle CreateSession() => _sessions.CreateHandle();

    private static JsonElement ToJsonElement<T>(T value)
        => JsonSerializer.SerializeToElement(value, BrowserJson.Options);

    private StateSnapshot? CreateStateV2(List<CouchCoopRuntimeNotice> notices)
    {
        if (!_runtimeHost.HasCapability(CouchCoopRuntimeHost.StateCapability))
        {
            return null;
        }

        var result = _runtimeHost.GetCurrentState(new CurrentStateRequest());
        if (result.Success && result.State is not null)
        {
            return result.State;
        }

        var error = result.Error;
        notices.Add(new CouchCoopRuntimeNotice(
            CouchCoopRuntimeHost.StateCapability,
            Supported: false,
            Provisional: true,
            UnsupportedReason: error?.Message ?? "Runtime state is unavailable."));
        return null;
    }
}
