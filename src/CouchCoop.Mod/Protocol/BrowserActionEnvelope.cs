using System.Text.Json;

namespace CouchCoop.Mod.Protocol;

public sealed record BrowserActionRequestEnvelope(
    string Type,
    string RequestId,
    string? ActionRefId = null,
    string? SnapshotId = null,
    string? SemanticActionId = null,
    string? ViewerId = null,
    string? ViewerPlayerId = null,
    string? ScreenType = null,
    // CEL-resolved action arguments (camelCase keys, e.g. { "characterId": "ironclad" }) forwarded by
    // the browser. The executor coerces these onto the EmbeddableActionRequest's named fields + Values.
    Dictionary<string, JsonElement>? Args = null);

public sealed record BrowserJoinRequestEnvelope(
    string Type,
    string RequestId,
    string? Name = null,
    // The SEAT the client picked, as that roster option's state player id ("p:1003"). Sent when the viewer tapped a
    // roster BUTTON; omitted when they typed a free-text name (adding a new player in MP character-select), which
    // keeps the name-only resolution path exactly as it was. Seat-accurate because a name is NOT: a saved seat the
    // host has no remembered name for is labelled with a synthesized "Player 1003", so resolving that label back to
    // a netId by string match is at best fragile and at worst ambiguous. The netId parsed out of this is what the
    // netId-bound spawn binds to, and the game gates a rejoin on exactly that netId.
    string? PlayerId = null,
    // The VISIT ID this page was served with — read by the client out of its own `<meta name="couchcoop-visit">`
    // (see ConnectionArrivalLog / VisitIdTag). It merges the `GET /` that preceded this socket into this
    // connection's row instead of leaving an ownerless arrival beside it. NOT a credential and never trusted as
    // one: it selects nothing and authorises nothing, and a value outside the minted shape is dropped. Omitted
    // by a client that has none (a dev-server page, a non-browser client), which joins exactly as before.
    string? Visit = null);

// Upstream raw-input replay from a controlling mirror client (single-controller foundation). `Kind` selects
// the injection; element-addressed pointer input carries `ElementId` (+ optional normalized 0..1 offset),
// while empty-space/cursor input carries a design-space (1920x1080) `CoordX/CoordY`. Keyboard input carries a
// browser `KeyboardEvent.code` in `Key` (+ comma-separated `Modifiers`, and `Pressed`: down/up, null = a tap).
// Gamepad input carries a device-neutral token in `Input` and reuses the same `Pressed` edge.
public sealed record BrowserInputRequestEnvelope(
    string Type,
    string RequestId,
    string Kind,
    string? ElementId = null,
    double? OffsetX = null,
    double? OffsetY = null,
    string? Button = null,
    double? CoordX = null,
    double? CoordY = null,
    string? Key = null,
    string? Modifiers = null,
    bool? Pressed = null,
    // R10 WS-E — COALESCED WHEEL TICKS. How many identical ticks this message stands for (wheel buttons only, and
    // only on a full click — a press/release is an edge, not a quantity). The eager-scroll client folds the wheel
    // notches it accumulated in one animation frame into ONE message rather than emitting up to a dozen, because the
    // host injects strictly one input per game-thread turn. Absent (the CLI, the pre-feature browser, `?eagerScroll=off`)
    // means exactly one tick and a byte-identical wire; the host clamps to 1..20 on the way into spirectl.
    int? Count = null,
    // GAMEPAD TOKEN (`kind: "pad"` only). A device-neutral name for the button or direction the viewer's pad
    // reports — "faceSouth", "dpadUp", "leftBumper", "start", "stickLeft" — in the browser Gamepad API's standard
    // mapping, minus the device branding, because the client cannot know which glyph set the player expects. The
    // EDGE rides `Pressed` above (true = down, false = up, null = a tap), so a message is a key OR a pad input,
    // never both.
    //
    // What it is NOT. Not a button index, not a keyboard code, and not a coordinate: a pad message addresses
    // nothing on screen, so `ElementId` / `CoordX` / `CoordY` / `Button` / `Count` mean nothing on one and the
    // executor never sets them. Nor is the vocabulary validated here — spirectl owns the token table
    // (`Sts2BrowserPadMap`) and refuses an unknown token, and a token this game build cannot honour, with two
    // distinct messages. A copy of that table in couch would be a second answer to the same question, and the
    // one that drifts.
    //
    // Absent on every non-pad message, so the wire stays byte-identical for every existing client.
    string? Input = null);

public static class BrowserInputKinds
{
    public const string Hover = "hover";
    public const string Click = "click";
    public const string Key = "key";
    // Abstract controller input from a viewer's gamepad. Carries `Input` (the token) + `Pressed` (the edge) and
    // no coordinate — see BrowserInputRequestEnvelope.Input.
    public const string Pad = "pad";
}

public sealed record BrowserActionResultEnvelope(
    string Type,
    string RequestId,
    string? Code = null,
    string? Message = null,
    JsonElement? Result = null,
    string? ActionRefId = null,
    string? SnapshotId = null,
    string? SemanticActionId = null,
    string? ViewerId = null,
    string? ScreenType = null);

public static class BrowserActionErrorCodes
{
    public const string InvalidMessage = "invalid-action-message";
    public const string MissingActionId = "missing-action-id";
    public const string MissingSnapshotId = "missing-snapshot-id";
    public const string StaleActionRef = "stale-action-ref";
    public const string WrongPlayer = "wrong-player";
    public const string WrongScreen = "wrong-screen";
    public const string DisabledAction = "disabled-action";
    public const string UnsupportedPerspective = "unsupported-perspective";
    public const string InternalFailure = "internal-action-failure";
}
