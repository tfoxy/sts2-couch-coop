/** Resolve the actual local fixture player from the private instance's read-only CLI state. */
export function localFixturePlayerId(state) {
  const local = state?.run?.players?.filter((player) => player.isLocal === true) ?? [];
  if (local.length !== 1 || typeof local[0].id !== "string" || local[0].id.length === 0) {
    throw new Error("Touch QA requires exactly one local fixture player with a stable id in CLI state");
  }
  return local[0].id;
}

/** Playwright init script: join the CLI-verified player through the ordinary advertised join route. */
export function installLocalFixtureJoin({ localPlayerId }) {
  const originalAdd = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (type, listener, options) {
    if (!this.__touchQaJoinObserved) {
      this.__touchQaJoinObserved = true;
      originalAdd.call(this, "message", (event) => {
        try {
          const session = JSON.parse(String(event.data));
          if (session?.type !== "session" || session.hostAccess?.allowed !== true || this.__touchQaJoined) return;
          // Browser isLocal means already joined on this connection; it cannot identify a player before joining.
          const player = session.players?.find((option) => option.playerId === localPlayerId);
          if (!player || typeof player.name !== "string" || player.name.length === 0) return;
          this.__touchQaJoined = true;
          this.send(JSON.stringify({ type: "join", name: player.name, playerId: player.playerId,
            requestId: "touch-qa-local-player" }));
        } catch { /* unrelated or malformed message */ }
      });
    }
    return originalAdd.call(this, type, listener, options);
  };
}
