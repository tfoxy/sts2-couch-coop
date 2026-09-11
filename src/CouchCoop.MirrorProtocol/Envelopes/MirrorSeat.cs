using System.Globalization;

namespace CouchCoop.MirrorProtocol.Envelopes;

// Shared vocabulary for a MIRROR SEAT — one of the couch-coop headless client slots the host spawns so a phone /
// browser can play as a real networked player. Lives in the protocol library (not the mod) because the SERVER
// derives these values and BOTH clients render them, so the closed string set and the "which netIds are seats"
// test have to be one definition. See MirrorSeatStatuses for the status vocabulary.

public static class MirrorSeatStatuses
{
    /// <summary>
    /// Joinable. In a LOBBY (mp-character-select / mp-load-game) this covers BOTH "the seat's headless instance is
    /// up and ENet-connected to the host's game" and "there is no instance at all" — the latter is still tappable
    /// because tapping spawns a fresh headless bound to THAT seat's netId. Mid-RUN only the first of those is ready
    /// (see <see cref="Offline"/>): a seat whose instance is still ENet-connected but whose browser walked away is
    /// the common reconnect path, and taking it back works.
    /// </summary>
    public const string Ready = "ready";

    /// <summary>
    /// Not joinable. The seat's headless instance is UP but is NOT connected to the host's game session — a zombie:
    /// the game refused (or dropped) its ENet peer, so it can neither play nor be rejoined, and it is squatting on
    /// the slot. The host auto-reaps such an instance (see the mod's MirrorSeatDirectory) so a later netId-bound
    /// spawn starts clean; until then the clients render the seat disabled with <c>SeatStatusReason</c>.
    /// <para>Only ever derived on a LOBBY screen — mid-run the same observation is <see cref="Offline"/>.</para>
    /// </summary>
    public const string Stuck = "stuck";

    /// <summary>
    /// Not joinable, and NOT self-healing: this seat has no game-connected instance while a multiplayer RUN is in
    /// progress, and the game will not admit a client that is not already in the run (<c>NetError.RunInProgress</c>).
    /// Spawning into the netId would produce a join that silently fails, so the row is rendered genuinely disabled
    /// (with <c>SeatStatusReason</c>) rather than tappable — that inverted signal is what sent a viewer tapping a
    /// seat that could never take them.
    /// <para>
    /// Distinct from <see cref="Stuck"/> on purpose: the copy differs (nothing here is broken — the run simply
    /// cannot be joined) and, unlike a zombie, an offline seat is NOT auto-reaped. There is nothing to remediate
    /// mid-run; when the host returns to a lobby screen the same seat re-derives as stuck (and is reaped) or ready.
    /// </para>
    /// </summary>
    public const string Offline = "offline";

    /// <summary>True only for a status emitted by the current browser-session contract.</summary>
    public static bool IsKnown(string? status)
        => status is Ready or Stuck or Offline;

    /// <summary>True for any status the clients must render as a genuinely disabled (untappable) row.</summary>
    public static bool IsJoinable(string? status)
        => string.Equals(Normalize(status), Ready, StringComparison.Ordinal);

    /// <summary>
    /// The `joinRejection` code the host replies with when a client asks to join a seat whose status is not
    /// <see cref="Ready"/> — a stale picker (or a hand-crafted client) must not be able to drive a join the current
    /// picker would refuse to offer.
    /// </summary>
    public const string UnavailableRejection = "seat-unavailable";

    /// <summary>Normalize an unknown or absent wire value to unavailable.</summary>
    public static string Normalize(string? raw)
        => raw switch
        {
            Ready => Ready,
            Stuck => Stuck,
            Offline => Offline,
            _ => Offline,
        };
}

public static class MirrorSeatNetIds
{
    // Couch-coop mirror seats are netId 1000 + slot, and the mod allocates slots 2..4 — so the REAL seat netIds are
    // 1002/1003/1004. The membership test deliberately spans a wider GUARD BAND (1001..1099) rather than the exact
    // three: it is the documented reservation for couch-coop seats, so widening the slot range later (or a host that
    // numbered its slots differently) still classifies correctly, while every identity that must NOT be offered in
    // the mirror picker stays outside it — a genuine remote (non-couch-coop) player is netId 1000 or a Steam id,
    // and the HOST is netId 1 on an ENet-hosted session or its own SteamID64 on a Steam-hosted one (either way
    // outside the band). Nothing else may be listed: the mirror can only ever serve seats it can instance.
    //
    // Caveat, deliberately accepted: spirectl's SYNTHETIC host-local lobby seats (the stateful browser view's
    // JoinLobbyPlayer) are numbered max(existing)+1, so with a mirror seat already at 1002 a synthetic seat can land
    // at 1003 and read as a mirror seat here. That combination needs a stateful browser AND a mirror client on the
    // same host lobby, and the failure mode is a spurious extra picker row rather than a wrong join (the join still
    // resolves by netId). Narrowing it would mean asking the live game which peers are real, which is exactly the
    // reusable-STS2 reflection this repo must not grow.
    public const ulong MinNetId = 1001UL;
    public const ulong MaxNetId = 1099UL;

    public static bool IsMirrorSeat(ulong netId) => netId >= MinNetId && netId <= MaxNetId;

    /// <summary>The state-snapshot player id for a netId. Every player id in a StateSnapshot is <c>"p:{netId}"</c>.</summary>
    public static string ToPlayerId(ulong netId)
        => "p:" + netId.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// Inverse of <see cref="ToPlayerId"/>: recover a netId from a <c>"p:{netId}"</c> player id. False for anything
    /// else — notably the registry's synthetic lobby-only options, whose id is the raw display name.
    /// </summary>
    public static bool TryParsePlayerId(string? playerId, out ulong netId)
    {
        netId = 0;
        if (playerId is null || !playerId.StartsWith("p:", StringComparison.Ordinal))
        {
            return false;
        }

        return ulong.TryParse(
            playerId.AsSpan(2),
            NumberStyles.None,
            CultureInfo.InvariantCulture,
            out netId);
    }
}
