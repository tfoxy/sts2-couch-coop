using System.Text.Json.Serialization;

namespace CouchCoop.MirrorProtocol.Envelopes;

// Server-produced wire DTOs shared by the mod (which serializes them) and the native Godot client (which will
// consume them). Moved here VERBATIM from CouchCoop.Mod so both sides own one definition; the wire bytes are
// unchanged (System.Text.Json Web camelCase + WhenWritingNull, driven by BrowserJson in the mod). These are pure
// records over BCL types — no spirectl/server dependency — which is why they were safe to relocate.

// The viewer's own session assignment, serialized into the `session` envelope (produce side of SessionAssignment).
public sealed record BrowserSessionDto(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Name,
    string Status,
    bool Joined,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? PlayerId,
    int ConnectionCount);

// One roster entry, serialized into the `session` envelope's `players` (produce side of SessionPlayerOption).
public sealed record BrowserPlayerOption(
    string PlayerId,
    string Name,
    bool IsHost,
    bool IsRunPlayer,
    int ConnectionCount,
    bool Disconnected,
    // True when this player belongs to the REQUESTING connection's own identity. Stamped per-connection by
    // BrowserSessionRegistry.MergePlayers (the session envelope is built per-connection), so each device sees only its
    // OWN players as local. Serialized as `isLocal` (System.Text.Json web camelCase). The STATEFUL roster filter
    // keeps host + local.
    bool IsLocal = false,
    // ---- mirror-seat fields -----------------------------------------------------------------------------
    // The ENet netId behind this option, parsed from the state-snapshot player id ("p:{netId}"). Null for the
    // registry's synthetic lobby-only options, whose id is the raw display name rather than a p:N.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] ulong? NetId = null,
    // True when NetId falls in the couch-coop seat guard band (MirrorSeatNetIds) — i.e. this row is a seat the host
    // can INSTANCE for a phone/browser, as opposed to the host itself or a genuine remote player. The MIRROR roster
    // filter keeps host + mirror seats; the stateful filter ignores this entirely.
    bool IsMirrorSeat = false,
    // Server-derived joinability for a mirror seat (MirrorSeatStatuses): "ready" (tappable — in a lobby that
    // includes a seat whose headless instance is down, since tapping spawns one bound to this netId), "stuck" (a
    // live-but-disconnected zombie instance, lobby only) or "offline" (mid-run, no game-connected instance: the
    // game will not admit it). Both non-ready values render as a genuinely DISABLED row. Non-seat rows are "ready".
    string SeatStatus = MirrorSeatStatuses.Ready,
    // Human-readable WHY for a non-ready seat, rendered next to the disabled row. Null when SeatStatus is "ready".
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? SeatStatusReason = null,
    // R19 WP-2 — the character model id this seat is playing, from the same state snapshot the row's name comes
    // from (lobby: StateCharacterSelectPlayerSnapshot.CharacterId; run: StateRunPlayerSnapshot.CharacterId). The
    // mirror picker renders it as the `/models/characters/{id}/icon` PNG left of the name, which is how a viewer
    // tells four seats apart in a saved-game lobby where several may still be labelled "Player 100x". Null where
    // the game has no answer yet (a lobby seat with no character picked) and on the registry's browser-only
    // options — the client then renders no image at all rather than a broken one. Precedent for a character id on
    // this wire is BrowserLobbyPlayerDto.CharacterId.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? CharacterId = null);

public sealed record BrowserScreenDto(
    string Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Type,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Title,
    // Mirror-view screen discriminator (ignored by the stateful client): "singleplayer-run" | "mp-run" |
    // "mp-character-select" | "sp-character-select" | "mp-load-game" | "main-menu" | "unsupported". Rides EVERY
    // session envelope. The two character-select kinds differ only in whether the host's lobby is joinable at all:
    // "sp-" is a singleplayer lobby, which nobody can join, so the mirror shows no join form and just watches.
    // Produced by BrowserAssignmentClassifier.MirrorModeFor; the allowlist that gates it back off the wire is
    // SessionEnvelope.MirrorScreenKinds (C#) / MIRROR_SCREEN_KINDS (frontend/src/protocol/browserEnvelope.ts).
    string MirrorMode);

public sealed record BrowserAssignmentNotice(
    string Code,
    string Severity,
    string Message,
    string? ScreenType = null,
    string? ScreenTitle = null);

// Echo reply to a client `{type:"ping", t0}` latency probe. `T0` is echoed verbatim so the client computes RTT.
// `MainThread` is echoed for the "game end-to-end" probe (answered from the game main thread); omitted otherwise.
public sealed record BrowserPongEnvelope(
    string Type,
    double T0,
    bool? MainThread = null);

/// <summary>
/// Host → browser JOIN PROGRESS, sent roughly once a second while a `join` request is still being resolved, and
/// only while something it reports has actually changed.
/// <para>
/// It exists because a join is the one request that legitimately takes 20-60 seconds (a cold seat spawn), and
/// until this envelope the browser showed a bare "Joining…" spinner for all of it — byte-identical to the screen
/// a join that had already died showed for the full 75 s deadline. A player cannot tell "slow" from "dead" from a
/// spinner, so they close the tab, and the field report is "it hangs".
/// </para>
/// <para>
/// Every field is copied from the host's existing per-attempt row (ConnectionRegistry's
/// <c>ConnectionStatusRow</c>) — there is no second progress model behind this. <see cref="RequestId"/> echoes the
/// `join` message this progress is about, so a client can ignore progress for a join it has already given up on.
/// <see cref="Stage"/> is a token from <see cref="BrowserJoinProgressStages"/>, never a raw enum name or number:
/// the client maps it to player-facing copy in its own language.
/// </para>
/// <para>
/// Safe to add: unknown envelope types are dropped by every existing client (mirrorClient.ts parses `type` and
/// falls through), so an older browser against a newer host simply keeps the spinner it always had.
/// </para>
/// </summary>
public sealed record BrowserJoinProgressEnvelope(
    string Type,
    string RequestId,
    string Stage,
    // Which of StepTotal steps this attempt is on (ConnectionStageSteps.Current), so the viewer sees movement even
    // while one long step runs.
    int Step,
    int StepTotal,
    // Milliseconds since the attempt began, as the host measures it. The CLIENT does not run its own timer off
    // this — it just renders what the latest envelope says — so a viewer's clock can never disagree with the
    // host's, and a stalled stream visibly stops counting instead of inventing progress.
    long ElapsedMs);

/// <summary>
/// The closed set of <see cref="BrowserJoinProgressEnvelope.Stage"/> tokens. Stable wire spellings for the host's
/// own <c>ConnectionStage</c>, kept separate from the enum on purpose: the enum's names and ordinals are internal
/// bookkeeping the wire must not inherit, and the client turns these tokens into localized copy.
/// TS twin: <c>JOIN_PROGRESS_STAGES</c> in <c>frontend/src/protocol/browserEnvelope.ts</c>.
/// </summary>
public static class BrowserJoinProgressStages
{
    /// <summary>The browser's socket is up; nothing has been requested yet.</summary>
    public const string Connecting = "connecting";
    /// <summary>The host is waiting on a player choice.</summary>
    public const string Choosing = "choosing";
    /// <summary>A seat is being prepared/launched for this player. The long one on a cold start.</summary>
    public const string Initializing = "initializing";
    /// <summary>The seat is up and joining the host's game.</summary>
    public const string Joining = "joining";
    /// <summary>The seat is serving; the browser's view is still loading.</summary>
    public const string LoadingView = "loading-view";
    /// <summary>Everything this attempt needed has arrived.</summary>
    public const string Complete = "complete";
    /// <summary>The attempt failed. Carried for completeness; the terminal reply says what went wrong.</summary>
    public const string Failed = "failed";
}

/// <summary>
/// Host → browser SEAT NOTICE: the host's own named verdict about why this viewer's seat is not serving them,
/// pushed on the socket the viewer already has open.
/// <para>
/// It exists because the one failure a player is most likely to hit is the one the host could not tell them
/// about. With the path from the device to its seat port blocked (a device-scoped firewall rule, guest/AP
/// isolation, a router that separates clients), the host's own loopback probe of that seat SUCCEEDS — so the join
/// is answered as a success and the browser is redirected to a port it cannot open. The host names the cause
/// precisely four times a second and, before this envelope, told only itself: the panel, the host log and the
/// copyable report all knew, and the player saw a spinner.
/// </para>
/// <para>
/// The channel is the host socket the viewer keeps open past its redirect (closing it would trigger the server's
/// Release() and kill the seat, so the client only gates the scene stream off). This is a one-way notification on
/// that socket, not a reply: there is no request id, because the thing it describes is a seat, not a request, and
/// it outlives the join that produced it.
/// </para>
/// <para>
/// <see cref="Cause"/> is a token from <see cref="BrowserSeatNoticeCauses"/>, never a raw enum name or ordinal:
/// the client maps it to player-facing copy in its own language. <see cref="Detail"/> is the host's English
/// technical line — the same sentence the panel shows in grey and the report quotes verbatim — carried so the two
/// surfaces cannot drift, and null on a withdrawal.
/// </para>
/// <para>
/// Safe to add: unknown envelope types are dropped by every existing client, so an older browser against a newer
/// host simply keeps the spinner it always had.
/// </para>
/// </summary>
public sealed record BrowserSeatNoticeEnvelope(
    string Type,
    string Cause,
    string? Detail);

/// <summary>
/// The closed set of <see cref="BrowserSeatNoticeEnvelope.Cause"/> tokens. Stable wire spellings for the host's
/// own <c>SeatReadinessCause</c>, kept separate from that enum on purpose — the enum's names and ordinals are
/// internal bookkeeping the wire must not inherit, and the client turns these tokens into localized copy.
/// <para>
/// There is deliberately NO token for the host's fourth cause, "still starting". That cause is the normal state
/// of every healthy join for its whole 20-60 seconds and there is nothing for a player to do about it, so it is
/// never announced; a seat that returns to it withdraws with <see cref="None"/> instead.
/// </para>
/// TS twin: <c>SEAT_NOTICE_CAUSES</c> in <c>frontend/src/protocol/browserEnvelope.ts</c>.
/// </summary>
public static class BrowserSeatNoticeCauses
{
    /// <summary>
    /// WITHDRAWAL — nothing is wrong any more; clear whatever was on screen. Sent when a named cause clears
    /// (the device finally reached the seat, a browser attached), so a stale accusation cannot outlive the
    /// condition it described. Never the first notice a viewer receives: with nothing outstanding there is
    /// nothing to withdraw.
    /// </summary>
    public const string None = "none";
    /// <summary>Something else on the host computer owns the port this viewer's seat was assigned.</summary>
    public const string PortConflict = "port-conflict";
    /// <summary>The seat is listening where it should be and the HOST computer cannot reach it locally.</summary>
    public const string HostLocalBlock = "host-local-block";
    /// <summary>The seat is up and the host can reach it; this viewer's device never got through to it.</summary>
    public const string NetworkPath = "network-path";
}

// Browser → host runtime settings (the mirror Settings panel). Every field optional; a null field means "leave
// unchanged". Applied per the receiving (headless) game instance. Parsed from what SettingsMessage serializes.
public sealed record BrowserSettingsRequestEnvelope(
    string Type,
    string? RequestId = null,
    // Active game frame-rate cap (the mirror "refresh rate").
    int? RefreshRate = null,
    // Freeze toggles for the game-side visual sim (particle / spine / decorative animators).
    bool? FreezeParticles = null,
    bool? FreezeSpines = null,
    bool? FreezeDecor = null,
    // true = producer sends declarative tween hints + suppresses per-frame tweened props (smooth replay);
    // false = producer streams node properties every frame instead.
    bool? TweenReplay = null,
    // Stage-B walk skip: whether THIS viewer displays the host-rendered static combat background image instead of
    // the live bg subtree (the mirror "Static background" setting, folded with the client's fetch/decode fail-open
    // state — a client that could not show the image reports false even with the setting on). Per-CONNECTION, not a
    // process lever: it feeds the server's unanimity aggregate, which stamps the combat bg root out of the producer
    // walk only when EVERY streaming mirror connection reports true. Null means this partial settings update leaves
    // the connection's current value unchanged; the required `?staticBg=0|1` selector seeds that value at connect.
    bool? StaticBg = null,
    // R14 trail drive: whether THIS viewer drives the card-flight trail ROOT from the declarative flight hint, so
    // the producer may withhold that root's own transform writes in local emit mode. Per-CONNECTION like StaticBg,
    // and a CAPABILITY rather than a preference: it feeds the server's unanimity aggregate, which turns the
    // producer lever on only while EVERY streaming mirror connection reports true. Null means this partial settings
    // update leaves the connection's current capability unchanged; `?trailDrive=0|1` seeds it at connect.
    bool? TrailDrive = null);

public sealed record BrowserServerReloadEnvelope(
    string Type,
    string RequestId,
    string Reason);

/// <summary>
/// The closed set of <see cref="BrowserServerReloadEnvelope.Reason"/> values a CLIENT branches on. The envelope
/// itself is unchanged (this is a value vocabulary, not a schema change): the default meaning stays "the server is
/// coming back — reload the page", and only the reasons listed here get special handling.
/// </summary>
public static class BrowserServerReloadReasons
{
    /// <summary>
    /// Sent by a HEADLESS mirror instance as its LAST GASP: its ENet connection to the host game is permanently
    /// gone (the host process died, or dropped it mid-run), so it is about to exit rather than sit forever behind
    /// STS2's "report a bug" network-error dialog. A viewer that sees this must NOT reload the page against the
    /// dead headless port — it drops back to the join picker on the ORIGINAL host and reconnects there with
    /// backoff, so the seat is re-offered (and re-claimed) the moment the host reloads the saved run.
    /// TS twin: <c>HEADLESS_HOST_DISCONNECTED_REASON</c> in <c>frontend/src/protocol/browserEnvelope.ts</c>.
    /// </summary>
    public const string HeadlessHostDisconnected = "headless-host-disconnected";
}
