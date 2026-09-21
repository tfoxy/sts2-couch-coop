// Admission must be a current session envelope: the browser rejects a bare directView directive. Preserve the
// recording's asset and screen metadata so independent prefetch sees the same workload in every replay arm.
export function replaySession(messages) {
  for (const message of messages) {
    try {
      const value = JSON.parse(message.data);
      if (value?.type === "session" && value.session && Array.isArray(value.players) && value.screen) {
        return JSON.stringify({ ...value, directView: true, headlessMirrorPort: null, joinRejection: null });
      }
    } catch { /* scene recordings can contain non-JSON diagnostic rows */ }
  }
  return JSON.stringify({
    type: "session", directView: true,
    session: { name: null, playerId: null, status: "unassigned", joined: false, connectionCount: 1 },
    players: [], screen: { kind: "unknown", type: null, title: null, mirrorMode: "unsupported" },
    hostName: "Replay", scrollAction: true
  });
}
