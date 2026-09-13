using System.Text.Json;
using System.Text.Json.Serialization;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Protocol;

public sealed record BrowserEnvelope(
    string Type,
    string RequestId,
    long? Revision = null,
    JsonElement? Payload = null,
    JsonElement? Capabilities = null,
    JsonElement? Notices = null,
    BrowserSessionDto? Session = null,
    IReadOnlyList<BrowserPlayerOption>? Players = null,
    BrowserScreenDto? Screen = null,
    IReadOnlyList<BrowserAssignmentNotice>? AssignmentNotices = null,
    // Present when this player's game view is served by a per-player headless instance rather
    // than the host. The browser should reconnect its mirror WebSocket to this port.
    int? HeadlessMirrorPort = null,
    // Mirror directive: true → the viewer watches the HOST's own stream in place (no headless, no redirect).
    // Set for a singleplayer run and for a host/watch-only selection. Mutually exclusive with HeadlessMirrorPort.
    bool? DirectView = null,
    // Mirror join rejection code when the requested name is not servable: "not-a-session-player" (rules 2 & 5) |
    // "no-free-instance" (slot pool full) | "spawn-failed" | "seat-unavailable" (the picked seat's server-derived
    // status is not "ready" — see MirrorSeatStatuses) | "join-failed" (the join handler itself threw — see
    // JoinRejectionDetail). The client shows the picker with a mapped message.
    string? JoinRejection = null,
    // Free-text server-fault detail, populated ONLY alongside JoinRejection == "join-failed" (the four codes above
    // are self-describing and stay detail-free, so no path that works today changes on the wire). This exists
    // because an unexpected throw inside the join handler used to leave the browser on "Joining…" forever: the
    // receive loop's catch answers with an `action-result`, which the mirror client does not read. Converting the
    // fault into the rejection channel the client already handles TERMINALLY makes it visible, and this field is
    // what carries the actual exception text to the viewer instead of a generic apology.
    string? JoinRejectionDetail = null,
    // The host's real ACTIVE frame-rate baseline (the mirror "refresh rate"), so the Settings panel can show a
    // TRUTHFUL label instead of the hardcoded 24 client seed. Sourced from
    // CouchCoopHeadlessVisualSuspender.GetEffectiveBaselineMaxFpsAsync (tracked headless baseline, else the desktop
    // host's live Engine.MaxFps). Null means an unlimited/vsync host or unavailable runtime reading.
    int? RefreshRate = null,
    // The three "Host performance" freezes as THIS instance actually applies them, so the mirror Settings panel can
    // seed its checkboxes from the instance it is about to control instead of assuming the headless defaults. A
    // per-viewer headless seat reports its env defaults (normally all true); the host's OWN windowed game reports
    // all false, because CouchCoopMod only installs the suspender for a windowless instance — nothing is frozen
    // there until a viewer turns it on. Sourced from CouchCoopHeadlessVisualSuspender.EffectiveFreezes(). Omitted
    // (null) when the suspender can't be read at all (a Godot-less host, e.g. the hosted-server test harness) or by
    // a Godot-less runtime; the client keeps its own defaults.
    bool? FreezeParticles = null,
    bool? FreezeSpines = null,
    bool? FreezeDecor = null,
    // Relative URL of the host-served native Android client APK ("/couchcoop-client.apk"), present only when the
    // locally-built APK is deployed next to the SPA. The browser join page renders an install link from it; the
    // native client's SessionEnvelope.Parse ignores it (unknown fields are tolerated).
    string? AndroidApkUrl = null,
    // The native client's disk asset-cache invalidation token. Every current host stamps it.
    string AssetCacheToken = "",
    // The HOST MACHINE's name (Environment.MachineName), stamped in BrowserStateEnvelopeFactory. Purely
    // informational: the native join dialog renders "<machine>  ·  <ip>:<port>" so a viewer can identify the
    // host on the LAN. This is the value the LAN-discovery responder advertises.
    string HostName = "",
    // Static background (Stage A): the CURRENT combat room's background image descriptor — the live bg scene
    // root's res:// path plus a ready-to-fetch /bg/ URL (digest-qualified when the tracker read the mounted layer
    // variant). Filled in BrowserStateEnvelopeFactory from CouchCoopStaticBackgroundTracker.Published; null
    // (omitted from the wire by BrowserJson) when unknown — non-combat screens, an older
    // host, or a host that has not probed yet. A client with the "Static background" setting ON displays this
    // image and hides the live bg subtree; when absent it fails open to the live subtree.
    BrowserStaticBackgroundDto? StaticBackground = null,
    // Current hosts accept absolute scroll offsets and element-addressed reward claims.
    bool ScrollAction = true,
    bool RewardAction = true,
    string? ConnectionAttemptId = null);

// The wire shape Stage B also consumes: { "scenePath": "res://scenes/backgrounds/<id>/<id>_background.tscn",
// "url": "/bg/<id>?layers=<digest>&v=1" } (camelCased by BrowserJson).
public sealed record BrowserStaticBackgroundDto(
    string ScenePath,
    string Url);

public sealed record BrowserErrorEnvelope(
    string Type,
    string RequestId,
    string Code,
    string Message);

// BrowserPongEnvelope + BrowserSettingsRequestEnvelope moved to CouchCoop.MirrorProtocol (namespace
// CouchCoop.MirrorProtocol.Envelopes) — wire bytes unchanged. See ServerDtos.cs in the shared library.
public static class BrowserJson
{
    public static JsonSerializerOptions Options { get; } = CreateOptions();

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);

    private static JsonSerializerOptions CreateOptions()
    {
        return new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            PropertyNameCaseInsensitive = true
        };
    }
}
