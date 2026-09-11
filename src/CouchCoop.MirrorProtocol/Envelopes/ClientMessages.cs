namespace CouchCoop.MirrorProtocol.Envelopes;

// SEND-side client → host control messages, byte-compatible with what frontend/src/mirror/mirrorClient.ts sends
// (camelCase, omit nulls). The host parses these tolerantly by key (see CouchCoopWebSocketConnection's receive
// loop + BrowserActionEnvelope/BrowserEnvelope), so field ORDER is irrelevant — only names/types must match. Each
// message's `Type` discriminator is a get-only property so callers can't set it wrong.

// `{type:"join", requestId, name, playerId?}` — the co-op join request (host replies with a `session`).
//
// `PlayerId` is the SEAT-ACCURATE form, sent when the viewer tapped a roster BUTTON: it is that option's state
// player id ("p:1003"), and the host resolves the seat's netId straight from it. Name-only resolution is ambiguous
// for a rejoin — a saved seat the host has no name for is labelled with a synthesized "Player 1003", and two
// devices can pick the same label — so the id is what actually pins the seat. Optional and omitted when the viewer
// typed a FREE-TEXT name instead (adding a new player in MP character-select): that path has no seat yet and keeps
// today's name-resolution behavior exactly.
public sealed record JoinMessage(string RequestId, string Name, string? PlayerId = null)
{
    public string Type => "join";
}

// `{type:"input", requestId, kind, button?, coordX?, coordY?, key?, modifiers?, pressed?, count?}` — upstream
// raw-input replay. Pointer input is COORDINATE-ONLY (design-space 1920x1080 coordX/coordY); keyboard carries a
// browser KeyboardEvent.code in `key`. Mirrors MirrorInputMessage; the host's BrowserInputRequestEnvelope ALSO
// accepts elementId/offset for the spirectl CLI, which the mirror never sends.
//
// `Count` (R10 WS-E) is the COALESCED WHEEL TICK count: how many identical notches one message stands for. Only a
// full wheel click may carry it (the host refuses to repeat anything else) and it is OMITTED for a single tick, so
// an un-coalesced wheel message is byte-identical to the pre-feature wire.
public sealed record InputMessage(
    string RequestId,
    string Kind,
    string? Button = null,
    double? CoordX = null,
    double? CoordY = null,
    string? Key = null,
    string? Modifiers = null,
    bool? Pressed = null,
    int? Count = null)
{
    public string Type => "input";
}

// `{type:"scene-ack"}` — flow control: sent after each rendered frame so the host releases the next coalesced delta.
public sealed record SceneAckMessage
{
    public string Type => "scene-ack";
}

// `{type:"watch", on}` — the WS-B stream gate, flipped live. `on:false` tells the host to send this connection NO
// scene bytes at all (it is showing the join picker, or it is a host socket kept open after a headless redirect);
// `on:true` re-opens the stream and the host answers with a fresh FULL keyframe. The INITIAL value rides the
// connect query instead (`?watch=0`) — a message cannot arrive early enough to suppress the connect keyframe.
public sealed record WatchMessage(bool On)
{
    public string Type => "watch";
}

// `{type:"ping", t0, mainThread?}` — latency probe. Plain form → network RTT (answered from the send loop);
// `mainThread:true` → game end-to-end RTT (answered from the game main thread).
public sealed record PingMessage(double T0, bool? MainThread = null)
{
    public string Type => "ping";
}

// `{type:"settings", requestId?, refreshRate?, freezeParticles?, freezeSpines?, freezeDecor?, tweenReplay?,
// staticBg?, trailDrive?}` — a server-side settings change (the mirror Settings panel). Every field optional; the
// host treats an absent field as unchanged. Mirrors MirrorSettingsPayload + the host's
// BrowserSettingsRequestEnvelope.
public sealed record SettingsMessage(
    string? RequestId = null,
    int? RefreshRate = null,
    bool? FreezeParticles = null,
    bool? FreezeSpines = null,
    bool? FreezeDecor = null,
    bool? TweenReplay = null,
    // Stage-B walk skip: this viewer's effective "Static background" state (see BrowserSettingsRequestEnvelope.
    // StaticBg — per-connection unanimity input, not a process lever). Omit-null keeps the pre-field wire identical.
    bool? StaticBg = null,
    // R14 trail drive: this viewer's trail-root CAPABILITY (see BrowserSettingsRequestEnvelope.TrailDrive — the
    // other per-connection unanimity input). Omit-null keeps the pre-field wire identical, and reads as NOT capable.
    bool? TrailDrive = null)
{
    public string Type => "settings";
}
