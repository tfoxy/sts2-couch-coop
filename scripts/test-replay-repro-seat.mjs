#!/usr/bin/env node
// Unit tests for --as-seat's browser-free half: the host/seat socket split and the session the quiet HOST
// socket answers with. The in-page mechanics (the fake WebSocket class, the `couchcoop-synthetic-seat` meta
// insertion, the CDP input driver) only run inside a real page and are exercised by actually running
// replay-repro.mjs --as-seat against a dev server (see docs/agents/repro-recorder.md) — this file checks the
// pure decisions that drive that page-side code, the same way scripts/test-replay-repro-session.mjs checks
// session synthesis.

import assert from "node:assert/strict";

import { buildSeatHostSession, classifySeatSocketUrl, partitionInboundBySock } from "./lib/repro-replay.mjs";

// ---------------------------------------------------------------------------------------------------------
// classifySeatSocketUrl — the ONLY thing that tells the host and seat fake sockets apart (same origin, same
// `/ws` path; buildHeadlessMirrorWebSocketUrl only changes the port — mirrorClient.ts).
// ---------------------------------------------------------------------------------------------------------

assert.equal(classifySeatSocketUrl("ws://127.0.0.1:5312/ws?watch=1", 44199), "host");
assert.equal(classifySeatSocketUrl("ws://127.0.0.1:44199/ws?watch=1", 44199), "seat");
assert.equal(classifySeatSocketUrl("ws://127.0.0.1:44199/ws?watch=1&staticBg=0", 44199), "seat",
  "the full headless-mirror query string doesn't change the port-based classification");
// A malformed URL is a HOST, not a crash — `new URL()` throws, and the page-side copy of this logic treats
// anything it cannot parse as the (quiet, harmless) default rather than risking the real seat stream going to
// the wrong socket.
assert.equal(classifySeatSocketUrl("not a url", 44199), "host");
assert.equal(classifySeatSocketUrl("ws://127.0.0.1:5312/?token=abc", 44199), "host",
  "Vite's own HMR socket (no seat port, no /ws) is never mistaken for the seat");

// ---------------------------------------------------------------------------------------------------------
// buildSeatHostSession — the HOST socket's connect-time (and `join`-reply) session in --as-seat mode.
// ---------------------------------------------------------------------------------------------------------

{
  // The common case this round's own repro hits: no session anywhere in the recording (armed mid-session).
  const session = JSON.parse(buildSeatHostSession([{ data: '{"type":"scene-delta"}' }]));
  assert.equal(session.type, "session");
  // directView MUST be false (not merely falsy-omitted) — `replaySession`'s own contract forces it true for the
  // spectator case, and this is the one caller that needs the opposite: `onDirectView` firing instead of the
  // join picker ever reading a session would mean `submitJoin`'s auto-join effect never runs at all.
  assert.equal(session.directView, false);
  // Neither directive mirrorClient.ts's session handler would act on is present — this harness reaches a seat
  // view through the `couchcoop-synthetic-seat` meta tag (the same seam iphone-burst's hermetic harness uses),
  // not by answering `join` with a redirect.
  assert.equal(session.headlessMirrorPort, null);
  assert.equal(session.joinRejection, null);
  // MUST be a JOINABLE mirror mode, or MirrorApp's auto-join guard (`isNonJoinableMirrorMode`) refuses to ever
  // call `submitJoin` and the replay sits on the picker forever.
  assert.equal(session.screen.mirrorMode, "mp-run");
  // Still a browserEnvelope.ts-valid envelope: hostName a string, scrollAction true, session/players/screen
  // present — exactly what WP0 item 1 found a bare directive fails on.
  assert.equal(typeof session.hostName, "string");
  assert.equal(session.scrollAction, true);
  assert.ok(session.session);
  assert.ok(Array.isArray(session.players));
}
{
  // A recording that DOES carry a real session: its host/asset metadata survives the seat overrides.
  const real = {
    type: "session",
    directView: true,
    hostName: "Phone Host",
    scrollAction: true,
    assetCacheToken: "build-456",
    session: { name: null, status: "unassigned", joined: false, connectionCount: 1 },
    players: [],
    screen: { kind: "unknown", type: null, title: null, mirrorMode: "mp-character-select" }
  };
  const session = JSON.parse(buildSeatHostSession([{ data: JSON.stringify(real) }]));
  assert.equal(session.hostName, "Phone Host");
  assert.equal(session.assetCacheToken, "build-456");
  // The seat override still wins over whatever mirrorMode the recording's own session carried — a seat replay
  // always needs a joinable one, regardless of what screen the recording happened to be on.
  assert.equal(session.screen.mirrorMode, "mp-run");
  assert.equal(session.directView, false);
}

// ---------------------------------------------------------------------------------------------------------
// partitionInboundBySock — WP0 review item 5: route a recording's inbound wire by reproRecorder.ts's `sock`
// tag when present, falling back to "everything goes to the seat socket" for an older, untagged file.
// ---------------------------------------------------------------------------------------------------------

{
  const inbound = [
    { t: 0, data: "a", sock: "host" },
    { t: 10, data: "b", sock: "seat" },
    { t: 20, data: "c", sock: "seat" }
  ];
  const { tagged, seat, host } = partitionInboundBySock(inbound);
  assert.equal(tagged, true);
  assert.deepEqual(seat.map((l) => l.data), ["b", "c"]);
  assert.deepEqual(host.map((l) => l.data), ["a"]);
}
{
  // An UNTAGGED recording (every line's `sock` is `null` — parseReproText's own default for a file that
  // predates the tag): falls back to today's behaviour, everything on the seat socket, nothing on the host.
  const inbound = [{ t: 0, data: "a", sock: null }, { t: 10, data: "b", sock: null }];
  const { tagged, seat, host } = partitionInboundBySock(inbound);
  assert.equal(tagged, false);
  assert.deepEqual(seat, inbound);
  assert.equal(host.length, 0);
}
{
  // A PARTIALLY tagged file (shouldn't happen from a real recorder, but a hand-edited or truncated one could):
  // still routes correctly — "host" lines are the only ones ever excluded from the seat socket.
  const inbound = [{ t: 0, data: "a", sock: "host" }, { t: 10, data: "b", sock: null }];
  const { seat, host } = partitionInboundBySock(inbound);
  assert.deepEqual(seat.map((l) => l.data), ["b"]);
  assert.deepEqual(host.map((l) => l.data), ["a"]);
}

console.log("replay-repro seat-mode routing tests passed");
