#!/usr/bin/env node
// Unit tests for the browser-free half of replay-repro.mjs: parsing a repro/1 file's body, finding its keyframe
// seed, and synthesizing the session a direct-view replay needs. None of this touches a page or a socket — see
// scripts/lib/repro-replay.mjs's file header for why the browser-side logic (the fake WebSocket, the CDP input
// driver) stays out of this file instead.

import assert from "node:assert/strict";

import {
  applyRecordingSettings,
  diffSends,
  parseReproText,
  parseWindowArg,
  partitionInputBySeed,
  replaySession,
  seedInbound,
  sendKey,
  urlNameParam
} from "./lib/repro-replay.mjs";

// ---------------------------------------------------------------------------------------------------------
// parseReproText
// ---------------------------------------------------------------------------------------------------------

{
  const header = JSON.stringify({ meta: { format: "repro/1" } });
  const lines = [
    header,
    JSON.stringify({ t: 0, data: '{"full":true,"type":"scene-delta"}' }),
    JSON.stringify({ t: 10, dir: "out", data: '{"type":"input","kind":"hover","requestId":"input:1"}' }),
    JSON.stringify({ t: 20, data: '{"type":"pong","t0":5}' }), // dropped: answers a ping this session never sent
    JSON.stringify({ t: 30, data: '{"type":"server-reload"}' }), // dropped: would reload the replay out from under it
    JSON.stringify({ t: 40, kind: "pointer", type: "down", id: 1, x: 5, y: 6, pt: "touch" }),
    JSON.stringify({ t: 50, kind: "marker", n: 1, note: "bug here" }),
    JSON.stringify({ t: 60, kind: "ws", ev: "ctor", url: "ws://x/ws" }) // socket lifecycle — read elsewhere, not a stream line
  ];
  const { inbound, outbound, input, markers } = parseReproText(lines.join("\n"));
  assert.equal(inbound.length, 1, "only the keyframe line counts as inbound (pong/server-reload dropped)");
  assert.equal(inbound[0].t, 0);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].key, "input/hover");
  assert.equal(input.length, 1);
  assert.equal(input[0].kind, "pointer");
  assert.equal(markers.length, 1);
  assert.equal(markers[0].n, 1);
}

// ---------------------------------------------------------------------------------------------------------
// sendKey
// ---------------------------------------------------------------------------------------------------------

assert.equal(sendKey(null), "?");
assert.equal(sendKey({ type: "input", kind: "hover" }), "input/hover");
assert.equal(sendKey({ type: "input", kind: "click", button: "left" }), "input/click/left");
assert.equal(sendKey({ type: "scene-ack" }), "scene-ack");

// ---------------------------------------------------------------------------------------------------------
// seedInbound — START AT THE KEYFRAME
// ---------------------------------------------------------------------------------------------------------

{
  // No keyframe at all: unreplayable, and seedInbound says so rather than guessing a start point.
  const none = seedInbound([{ t: 0, data: '{"type":"scene-delta","full":false}' }]);
  assert.equal(none.seed.index, -1);
  assert.equal(none.inbound.length, 1, "nothing is dropped when there is no keyframe to seed from");
}
{
  // A keyframe already at the front: nothing to drop.
  const atFront = seedInbound([{ t: 0, data: '{"full":true}' }, { t: 5, data: '{"full":false}' }]);
  assert.equal(atFront.seed.index, 0);
  assert.equal(atFront.seed.dropped, 0);
  assert.equal(atFront.inbound.length, 2);
}
{
  // Two unreplayable deltas before the keyframe: dropped, timestamps of the KEPT lines untouched.
  const dropped = seedInbound([
    { t: 0, data: '{"full":false}' },
    { t: 5, data: '{"full":false}' },
    { t: 10, data: '{"full":true}' },
    { t: 15, data: '{"full":false}' }
  ]);
  assert.equal(dropped.seed.index, 2);
  assert.equal(dropped.seed.dropped, 2);
  assert.equal(dropped.seed.t, 10);
  assert.deepEqual(dropped.inbound.map((l) => l.t), [10, 15]);
}

// ---------------------------------------------------------------------------------------------------------
// replaySession — the fix for WP0 item 1: a bare `{"type":"session","directView":true}` is REJECTED by
// browserEnvelope.ts (it requires hostName, scrollAction, screen, players). replaySession must always produce a
// complete envelope, whether or not the recording carries a real session to reuse fields from.
// ---------------------------------------------------------------------------------------------------------

{
  // No session anywhere in the recording (the common case: a recorder armed mid-session never saw the connect
  // reply) — a complete, generic fallback, not a bare directive.
  const fallback = JSON.parse(replaySession([{ data: '{"type":"scene-delta"}' }]));
  assert.equal(fallback.type, "session");
  assert.equal(fallback.directView, true);
  assert.equal(typeof fallback.hostName, "string");
  assert.equal(fallback.scrollAction, true);
  assert.ok(fallback.session);
  assert.ok(Array.isArray(fallback.players));
  assert.ok(fallback.screen);
}
{
  // A real session IS in the recording: reuse its host/screen/asset fields, but the GRANT is always forced to
  // directView (the one a solo direct-view replay needs), never whatever directive the recording itself carried.
  const real = {
    type: "session",
    directView: false,
    headlessMirrorPort: 9001,
    joinRejection: "unavailable",
    hostName: "Real Host",
    scrollAction: true,
    assetCacheToken: "build-123",
    session: { name: "Ann", status: "joined", joined: true, connectionCount: 1 },
    players: [{ playerId: "1", name: "Ann" }],
    screen: { kind: "run", type: "combat", title: null, mirrorMode: "mp-run" }
  };
  const reused = JSON.parse(replaySession([{ data: JSON.stringify(real) }]));
  assert.equal(reused.hostName, "Real Host");
  assert.equal(reused.assetCacheToken, "build-123");
  assert.equal(reused.screen.mirrorMode, "mp-run");
  assert.deepEqual(reused.players, real.players);
  assert.equal(reused.directView, true, "replaySession always forces directView, overriding the recorded directive");
  assert.equal(reused.headlessMirrorPort, null);
  assert.equal(reused.joinRejection, null);
}

// ---------------------------------------------------------------------------------------------------------
// diffSends — nearest-in-time matching keyed on envelope SHAPE, not id
// ---------------------------------------------------------------------------------------------------------

{
  const recorded = [
    { t: 100, key: "input/hover" },
    { t: 200, key: "input/click/left" },
    { t: 900, key: "input/hover" }
  ];
  const replayed = [
    { t: 105, key: "input/hover" }, // matches the first (within tolerance)
    { t: 205, key: "input/click/left" } // matches the second
    // the third (t=900) is simply missing
  ];
  const diff = diffSends(recorded, replayed, 50);
  assert.equal(diff.matched.length, 2);
  assert.equal(diff.missing.length, 1);
  assert.equal(diff.missing[0].t, 900);
  assert.equal(diff.extra.length, 0);
}
{
  // A replayed send with no recorded counterpart within tolerance is EXTRA, not silently absorbed.
  const diff = diffSends([{ t: 0, key: "input/hover" }], [{ t: 0, key: "input/hover" }, { t: 5000, key: "input/hover" }], 50);
  assert.equal(diff.matched.length, 1);
  assert.equal(diff.extra.length, 1);
  assert.equal(diff.extra[0].t, 5000);
}

// ---------------------------------------------------------------------------------------------------------
// urlNameParam / parseWindowArg
// ---------------------------------------------------------------------------------------------------------

assert.equal(urlNameParam("http://10.1.2.3:13337/?name=Tesy1"), "Tesy1");
assert.equal(urlNameParam("http://10.1.2.3:13337/"), null);
assert.equal(urlNameParam(null), null);
assert.equal(urlNameParam("not a url"), null);

assert.deepEqual(parseWindowArg("100:200"), { startMs: 100, endMs: 200 });
assert.deepEqual(parseWindowArg("-50:50"), { startMs: -50, endMs: 50 });
assert.equal(parseWindowArg("200:100"), null, "end before start is rejected");
assert.equal(parseWindowArg("nonsense"), null);
assert.equal(parseWindowArg(undefined), null);

// ---------------------------------------------------------------------------------------------------------
// partitionInputBySeed — gestures recorded before the keyframe cannot be replayed meaningfully (WP0 review
// item 3: they used to be dispatched anyway, landing on whatever pre-scene chrome happened to occupy that
// point instead of being skipped and reported).
// ---------------------------------------------------------------------------------------------------------

{
  const input = [{ t: 100 }, { t: 500 }, { t: 900 }, { t: 1500 }];
  const seed = { index: 2, t: 900, dropped: 2 };
  const { replayable, skipped, hasValidSeed } = partitionInputBySeed(input, seed);
  assert.equal(hasValidSeed, true);
  assert.equal(skipped, 2);
  assert.deepEqual(replayable.map((l) => l.t), [900, 1500], "t >= seed.t is kept, including the boundary itself");
}
{
  // No keyframe at all in the file (seed.index === -1): nothing is skipped — there is no valid cutoff, and the
  // "NO KEYFRAME" warning already covers telling the operator this replay is not expected to work.
  const input = [{ t: 0 }, { t: 100 }];
  const { replayable, skipped, hasValidSeed } = partitionInputBySeed(input, { index: -1, t: null, dropped: 0 });
  assert.equal(hasValidSeed, false);
  assert.equal(skipped, 0);
  assert.equal(replayable.length, 2);
}
{
  // The keyframe is the very first kept line (seed.index === 0, dropped === 0): every gesture is at or after it.
  const input = [{ t: 0 }, { t: 50 }];
  const { skipped } = partitionInputBySeed(input, { index: 0, t: 0, dropped: 0 });
  assert.equal(skipped, 0);
}

// ---------------------------------------------------------------------------------------------------------
// applyRecordingSettings — mapping a recording's meta.settings onto the replay page (WP0 review item 1).
// ---------------------------------------------------------------------------------------------------------

{
  const url = new URL("http://127.0.0.1:5312/?stage=canvas");
  const { applied, skipped, storageOnly } = applyRecordingSettings(url, {
    raiseHandCards: true,
    stretchEnabled: false,
    quality: "high",
    refreshRate: 24,
    stage: "dom" // already on the URL — must be left alone
  });
  assert.equal(url.searchParams.get("raiseHand"), "on");
  assert.equal(url.searchParams.get("stretch"), "off");
  assert.equal(url.searchParams.get("quality"), "high");
  assert.equal(url.searchParams.get("stage"), "canvas", "an explicit --url query always wins over the recording");
  assert.deepEqual(skipped, ["stage"]);
  assert.deepEqual(applied.raiseHandCards, true);
  assert.deepEqual(applied.stretchEnabled, false);
  assert.deepEqual(storageOnly, { refreshRate: 24 }, "refreshRate has no URL lever — it goes to storage only");
  assert.equal(applied.refreshRate, 24);
}
{
  // null/undefined settings object: a no-op, not a throw — a recording older than settingsAtArm/settings, or
  // one whose supplier threw, must still replay (just without this fidelity improvement).
  const url = new URL("http://127.0.0.1:5312/");
  const result = applyRecordingSettings(url, null);
  assert.deepEqual(result.applied, {});
  assert.deepEqual(result.skipped, []);
  assert.equal(url.search, "");
}
{
  // An unrecognised key (not in SETTINGS_URL_PARAMS or the storage-only list) is silently ignored — a future
  // settings field with no replay lever yet must not throw, and must not be reported as "applied".
  const url = new URL("http://127.0.0.1:5312/");
  const { applied } = applyRecordingSettings(url, { someFutureField: true });
  assert.deepEqual(applied, {});
}

console.log("replay-repro session/parsing tests passed");
