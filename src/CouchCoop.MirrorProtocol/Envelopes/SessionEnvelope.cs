using System.Text.Json;

namespace CouchCoop.MirrorProtocol.Envelopes;

// PARSE-side subset of the `session` message the native Godot client consumes, matching EXACTLY what
// frontend/src/protocol/browserEnvelope.ts's session branch reads (normalizeSession / normalizePlayers /
// normalizeScreen + the mirror-directive fields). Everything the mirror needs for the shared join screen + the
// three mutually-exclusive join-reply directives (directView / headlessMirrorPort / joinRejection), and nothing
// the stateful-only view uses.

// The viewer's own assignment (TS BrowserSessionAssignment).
public sealed record SessionAssignment(
    string? Name,
    string Status,
    bool Joined,
    string? PlayerId,
    int ConnectionCount);

// One roster entry (TS BrowserPlayerOption).
public sealed record SessionPlayerOption(
    string PlayerId,
    string Name,
    bool IsHost,
    bool IsRunPlayer,
    int ConnectionCount,
    bool Disconnected,
    // True when this player belongs to THIS connection's own device (per-connection stamp from the host). The
    // mirror roster IGNORES it (see JoinModel.MirrorRosterFor); it survives on the wire because the picker still
    // reports which rows are this device's.
    bool IsLocal = false,
    // ---- mirror-seat fields (produce side: BrowserPlayerOption) ------------------------------------------
    // The ENet netId behind this option, from the "p:{netId}" player id. Null for a synthetic lobby-only option.
    ulong? NetId = null,
    // True when this row is a couch-coop SEAT (netId in the MirrorSeatNetIds guard band) — the rows the MIRROR
    // roster filter (JoinModel.MirrorRosterFor) keeps alongside the host.
    bool IsMirrorSeat = false,
    // Server-derived joinability (MirrorSeatStatuses.Ready / .Stuck / .Offline).
    string SeatStatus = MirrorSeatStatuses.Ready,
    // Human-readable WHY for a non-ready seat; null when SeatStatus is Ready.
    string? SeatStatusReason = null,
    // R19 WP-2 — the character model id this seat is playing (produce side: BrowserPlayerOption.CharacterId).
    // The web picker renders it as the seat's icon; the native client does not draw one yet, so this is parsed
    // purely to keep the two sides' shape in lockstep. A blank string normalizes to null, so "no character" has
    // exactly one spelling on both sides of the wire.
    string? CharacterId = null);

// The current screen summary (TS BrowserScreenSummary). `MirrorMode` is the mirror-view discriminator.
public sealed record SessionScreen(
    string Kind,
    string? Type,
    string? Title,
    string? MirrorMode);

// The parsed `session` envelope (TS BrowserSessionEnvelope, mirror-relevant subset).
public sealed record SessionEnvelope(
    SessionAssignment Session,
    IReadOnlyList<SessionPlayerOption> Players,
    SessionScreen Screen,
    int? HeadlessMirrorPort,
    bool DirectView,
    string? JoinRejection,
    int? RefreshRate,
    // Current hosts always stamp the disk-cache namespace and host identity.
    string AssetCacheToken,
    string HostName,
    bool ScrollAction,
    bool RewardAction)
{
    // Mirror-view screen discriminators (TS MirrorScreenKind).
    private static readonly string[] MirrorScreenKinds =
    [
        "singleplayer-run",
        "mp-run",
        "mp-character-select",
        "sp-character-select",
        "mp-load-game",
        "main-menu",
        "unsupported",
    ];

    public static SessionEnvelope? Parse(ReadOnlySpan<byte> utf8Json)
    {
        try
        {
            using var doc = JsonDocument.Parse(utf8Json.ToArray());
            return Parse(doc.RootElement);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static SessionEnvelope? Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return Parse(doc.RootElement);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static SessionEnvelope? Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        // parseBrowserEnvelope guards `value.type === "session"` before running the session normalizers.
        if (AsStringOrNull(Get(root, "type")) != "session")
        {
            return null;
        }

        var session = NormalizeSession(Get(root, "session"));
        var players = NormalizePlayers(Get(root, "players"));
        var screen = NormalizeScreen(Get(root, "screen"));
        if (session is null || players is null || screen is null
            || AsStringOrNull(Get(root, "assetCacheToken")) is not { } assetCacheToken
            || AsStringOrNull(Get(root, "hostName")) is not { } hostName
            || Get(root, "scrollAction") is not { ValueKind: JsonValueKind.True }
            || Get(root, "rewardAction") is not { ValueKind: JsonValueKind.True })
        {
            return null;
        }

        return new SessionEnvelope(
            session,
            players,
            screen,
            Get(root, "headlessMirrorPort") is { ValueKind: JsonValueKind.Number } p ? (int)p.GetDouble() : null,
            IsTrue(Get(root, "directView")),
            AsStringOrNull(Get(root, "joinRejection")),
            Get(root, "refreshRate") is { ValueKind: JsonValueKind.Number } r ? (int)r.GetDouble() : null,
            assetCacheToken,
            hostName,
            ScrollAction: true,
            RewardAction: true);
    }

    private static SessionAssignment? NormalizeSession(JsonElement? raw)
    {
        if (AsRecord(raw) is not { } record
            || !IsExplicitNullableString(Get(record, "name"))
            || AsStringOrNull(Get(record, "status")) is not { }
            || Get(record, "joined") is not { ValueKind: JsonValueKind.True or JsonValueKind.False }
            || !IsExplicitNullableString(Get(record, "playerId"))
            || Get(record, "connectionCount") is not { ValueKind: JsonValueKind.Number } count
            || !count.TryGetInt32(out _))
        {
            return null;
        }

        return new SessionAssignment(
            AsStringOrNull(Get(record, "name")),
            AsStringOrNull(Get(record, "status"))!,
            IsTrue(Get(record, "joined")),
            AsStringOrNull(Get(record, "playerId")),
            count.GetInt32());
    }

    private static IReadOnlyList<SessionPlayerOption>? NormalizePlayers(JsonElement? raw)
    {
        if (raw is not { ValueKind: JsonValueKind.Array } arr)
        {
            return null;
        }

        var players = new List<SessionPlayerOption>(arr.GetArrayLength());
        foreach (var entry in arr.EnumerateArray())
        {
            if (AsRecord(entry) is not { } record
                || AsStringOrNull(Get(record, "playerId")) is not { } playerIdValue
                || AsStringOrNull(Get(record, "name")) is not { } nameValue
                || Get(record, "isHost") is not { ValueKind: JsonValueKind.True or JsonValueKind.False }
                || Get(record, "isRunPlayer") is not { ValueKind: JsonValueKind.True or JsonValueKind.False }
                || Get(record, "connectionCount") is not { ValueKind: JsonValueKind.Number } connectionCount || !connectionCount.TryGetInt32(out _)
                || Get(record, "disconnected") is not { ValueKind: JsonValueKind.True or JsonValueKind.False }
                || Get(record, "isLocal") is not { ValueKind: JsonValueKind.True or JsonValueKind.False }
                || Get(record, "isMirrorSeat") is not { ValueKind: JsonValueKind.True or JsonValueKind.False }
                || AsStringOrNull(Get(record, "seatStatus")) is not { } seatStatus
                || !MirrorSeatStatuses.IsKnown(seatStatus)
                || !IsExplicitNullableString(Get(record, "seatStatusReason"))
                || !IsExplicitNullableString(Get(record, "characterId"))
                || !TryNullableNetId(Get(record, "netId"), out var netId))
            {
                return null;
            }
            players.Add(new SessionPlayerOption(
                playerIdValue,
                nameValue,
                IsTrue(Get(record, "isHost")),
                IsTrue(Get(record, "isRunPlayer")),
                connectionCount.GetInt32(),
                IsTrue(Get(record, "disconnected")),
                IsTrue(Get(record, "isLocal")),
                netId,
                IsTrue(Get(record, "isMirrorSeat")),
                seatStatus,
                AsStringOrNull(Get(record, "seatStatusReason")),
                // Blank → null, exactly as the TS normalizer does: "" would only ever build a
                // `/models/characters//icon` request that cannot resolve.
                NullIfBlank(AsStringOrNull(Get(record, "characterId")))));
        }

        return players;
    }

    private static bool TryNullableNetId(JsonElement? raw, out ulong? netId)
    {
        if (raw is { ValueKind: JsonValueKind.Null })
        {
            netId = null;
            return true;
        }

        if (raw is { ValueKind: JsonValueKind.Number } number && number.TryGetUInt64(out var value))
        {
            netId = value;
            return true;
        }

        netId = null;
        return false;
    }

    private static SessionScreen? NormalizeScreen(JsonElement? raw)
    {
        if (AsRecord(raw) is not { } record
            || AsStringOrNull(Get(record, "kind")) is not { } kind
            || !IsExplicitNullableString(Get(record, "type"))
            || !IsExplicitNullableString(Get(record, "title"))
            || AsStringOrNull(Get(record, "mirrorMode")) is not { } mirrorMode
            || Array.IndexOf(MirrorScreenKinds, mirrorMode) < 0)
        {
            return null;
        }

        return new SessionScreen(
            kind,
            AsStringOrNull(Get(record, "type")),
            AsStringOrNull(Get(record, "title")),
            mirrorMode);
    }

    // ---- helpers (JS `??` / String() / == null / === true / typeof) --------------------------------------------

    private static JsonElement? Get(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v) ? v : null;

    private static JsonElement? AsRecord(JsonElement? v) =>
        v is { ValueKind: JsonValueKind.Object } e ? e : null;

    private static bool IsExplicitNullableString(JsonElement? v) =>
        v is { ValueKind: JsonValueKind.Null or JsonValueKind.String };

    private static bool IsTrue(JsonElement? v) => v is { ValueKind: JsonValueKind.True };

    // typeof x === "string" ? x : null
    private static string? AsStringOrNull(JsonElement? v) =>
        v is { ValueKind: JsonValueKind.String } e ? e.GetString() : null;

    private static string? NullIfBlank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
