// Pure, browser-free helpers for scripts/replay-repro.mjs — split out so they can be unit tested without a
// Playwright browser (scripts/test-replay-repro-session.mjs, scripts/test-replay-repro-seat.mjs).
//
// Anything that has to run INSIDE the page (the fake WebSocket, the CDP input driver, the hand-pose sampler) stays
// in replay-repro.mjs: Playwright's `addInitScript`/`page.evaluate` serialize a function via its own `toString()`,
// so a function that has to run in the page cannot call back into a module import — it must be fully self
// contained. Where this file's logic is also needed in the page (the host/seat URL split, `--as-seat`'s `?name=`
// pick), the page keeps its own tiny, deliberately duplicated copy; this file is the one a test can import.

import { replaySession } from "./replay-session.mjs";

export { replaySession };

/** One recorded line, loaded and bucketed by {@link parseReproText}. */
export function sendKey(parsed) {
  if (!parsed) return "?";
  return parsed.type === "input" ? `input/${parsed.kind}${parsed.button ? `/${parsed.button}` : ""}` : String(parsed.type);
}

/**
 * Parse a repro/1 file's TEXT into its four line kinds, without touching the filesystem (the `requireReproHeader`
 * call that validates line 1 stays the CLI's job, so a bad header still names the file it came from).
 */
export function parseReproText(text) {
  const raw = text.split("\n");
  const inbound = [];   // {t, data} — the host's stream
  const outbound = [];  // {t, type, key, requestId, data} — what the RECORDED client sent
  const input = [];     // pointer / wheel / key lines, in order
  const markers = [];
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i]) continue;
    let obj;
    try { obj = JSON.parse(raw[i]); } catch { continue; }
    if (i === 0) continue;
    const t = typeof obj.t === "number" ? obj.t : 0;
    if (obj.dir === "out" && typeof obj.data === "string") {
      let parsed = null;
      try { parsed = JSON.parse(obj.data); } catch { /* keep it as text */ }
      outbound.push({ t, type: parsed?.type ?? "?", key: sendKey(parsed), requestId: parsed?.requestId ?? null, parsed, data: obj.data });
      continue;
    }
    if (typeof obj.data === "string") {
      // A recorded `pong` answers a ping THIS session never sent, and a `server-reload` would reload the page
      // out from under the replay. Neither is part of the reproduction.
      if (obj.data.includes('"type":"pong"') || obj.data.includes('"type":"server-reload"')) continue;
      // `sock` ("host"/"seat", reproRecorder.ts's own tag — see its file-format comment) names which CONNECTION
      // this line came from. Recordings made before that tag existed carry no `sock` at all; `null` here (not a
      // guessed default) is what tells `--as-seat`'s routing "this file predates tagging, fall back to putting
      // everything on the seat socket" — see partitionInboundBySock.
      inbound.push({ t, data: obj.data, sock: typeof obj.sock === "string" ? obj.sock : null });
      continue;
    }
    if (obj.kind === "pointer" || obj.kind === "wheel" || obj.kind === "key") { input.push({ ...obj, t }); continue; }
    if (obj.kind === "marker") { markers.push({ n: obj.n, t, note: obj.note }); continue; }
    if (obj.kind === "ws") continue; // socket lifecycle — informational only; nothing currently reads it back
  }
  return { inbound, outbound, input, markers };
}

/**
 * How `--as-seat` should route the recorded inbound stream onto its two fake sockets.
 *
 * A TAGGED recording (one made after reproRecorder.ts started stamping `sock`) routes exactly: the seat socket
 * delivers only `sock:"seat"` lines, the host socket (if it ever needs to echo anything recorded — today it
 * doesn't) would get `sock:"host"` ones. An UNTAGGED recording (every file captured before this round, including
 * most repro files still on disk — `sock` is `null` on every line) falls back to today's behaviour: everything
 * goes to the seat socket, since that is where the original spectator-mode replay already put the whole stream
 * and a seat replay's whole point is to reproduce the SAME stream through the SAME-shaped client.
 */
export function partitionInboundBySock(inbound) {
  const tagged = inbound.some((line) => line.sock === "host" || line.sock === "seat");
  if (!tagged) {
    return { tagged: false, seat: inbound, host: [] };
  }
  return {
    tagged: true,
    seat: inbound.filter((line) => line.sock !== "host"), // untagged lines on a partially-tagged file default seat
    host: inbound.filter((line) => line.sock === "host")
  };
}

// START AT THE KEYFRAME. A delta patches the map a `full:true` keyframe established; fed a stream that begins in
// the middle, every id in it addresses a node that was never introduced. So the frames BEFORE the first keyframe
// are dropped (unreplayable by construction) and their absence is reported rather than papered over. Timestamps
// are untouched: this omits frames, it does not re-base the timeline.
export function seedInbound(inbound) {
  const at = inbound.findIndex((line) => line.data.lastIndexOf('"full":true', 64) !== -1);
  if (at <= 0) {
    return { inbound, seed: { index: at, t: at === 0 ? inbound[0]?.t ?? null : null, dropped: 0 } };
  }
  return { inbound: inbound.slice(at), seed: { index: at, t: inbound[at].t, dropped: at } };
}

/**
 * Gestures recorded BEFORE the keyframe (`seed.t`) cannot be replayed meaningfully: the wire pump has nothing to
 * show until it lands, even though — on a recording armed mid-session (`seedKind:"resync"`, the common case)
 * — the real device was already showing a fully-loaded scene throughout; the keyframe is this FILE's own
 * resync, not a cold load. Dispatched anyway, such a gesture lands on whatever the app's pre-scene chrome
 * happens to occupy (found: the settings gear button, on the card-target repro) instead of on anything
 * meaningful. A pure split so "which gestures, how many skipped" is unit testable without a browser.
 */
export function partitionInputBySeed(input, seed) {
  const hasValidSeed = Boolean(seed) && seed.index >= 0 && typeof seed.t === "number";
  if (!hasValidSeed) return { replayable: input, skipped: 0, hasValidSeed: false };
  let skipped = 0;
  const replayable = input.filter((line) => {
    if (line.t >= seed.t) return true;
    skipped++;
    return false;
  });
  return { replayable, skipped, hasValidSeed: true };
}

/**
 * Compare what the RECORDED client sent with what the REPLAYED client sent. Matching is nearest-in-time within a
 * tolerance, keyed on the envelope's SHAPE rather than its id (ids restart from 1 in a fresh session and identify
 * nothing across the two runs).
 */
export function diffSends(recorded, replayed, toleranceMs) {
  const pool = replayed.map((s, index) => ({ ...s, index, taken: false }));
  const matched = [];
  const missing = [];
  for (const want of recorded) {
    let best = null;
    let bestGap = Infinity;
    for (const got of pool) {
      if (got.taken || got.key !== want.key) continue;
      const gap = Math.abs((got.t ?? Infinity) - want.t);
      if (gap < bestGap) { bestGap = gap; best = got; }
    }
    if (best && bestGap <= toleranceMs) {
      best.taken = true;
      matched.push({ t: want.t, key: want.key, gapMs: Math.round(bestGap) });
    } else {
      missing.push(want);
    }
  }
  return { matched, missing, extra: pool.filter((s) => !s.taken) };
}

/** `?name=` off a recorded page URL (the auto-join marker). Null when absent or unparseable. */
export function urlNameParam(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url).searchParams.get("name");
  } catch {
    return null;
  }
}

/**
 * The session a `--as-seat` replay's HOST socket answers with on connect. Built from the real
 * `replaySession(rec.inbound)` (so a recording that DOES carry a session keeps its real host/asset metadata), then
 * overridden for the seat flow:
 *   - `directView: false` — `replaySession` always forces this true (the spectator contract); a seat replay needs
 *     the opposite, or `onDirectView` fires instead of the join picker ever seeing a session to act on.
 *   - `screen.mirrorMode: "mp-run"` — `isNonJoinableMirrorMode` must say no, or the `?name=` auto-join
 *     (`MirrorApp.vue`'s `autoJoinSent`/`submitJoin(urlName)`) never fires at all.
 *   - `headlessMirrorPort: null`, `joinRejection: null` — neither directive is being used: the actual port hop
 *     is driven by the `couchcoop-synthetic-seat` meta tag (`CouchCoopBrowserServer.cs`'s `SyntheticSeatPort`,
 *     the same seam `iphone-burst.e2e.spec.ts` uses), not by answering a `join` with a redirect reply. Most repro
 *     recordings are armed mid-session and carry no join exchange to replay in the first place (this file's
 *     own card-target repro has zero `session` lines in it), so simulating one from scratch would be inventing
 *     wire the recording never had an opinion on.
 */
export function buildSeatHostSession(inboundMessages) {
  const base = JSON.parse(replaySession(inboundMessages));
  return JSON.stringify({
    ...base,
    directView: false,
    headlessMirrorPort: null,
    joinRejection: null,
    screen: { ...base.screen, mirrorMode: "mp-run" }
  });
}

/** Pure port-based routing: the ONLY thing that tells the host and seat fake sockets apart (see
 * `buildHeadlessMirrorWebSocketUrl` — same path, same origin, only the port differs). Mirrored verbatim (not
 * imported — see the file header) inside `reproWebSocketInit`'s serialized body. */
export function classifySeatSocketUrl(url, seatPort) {
  try {
    return new URL(url).port === String(seatPort) ? "seat" : "host";
  } catch {
    return "host";
  }
}

/** `--window a:b` (ms on the recording clock) → `{startMs, endMs}`, or null for an unparseable/absent spec. */
export function parseWindowArg(spec) {
  if (typeof spec !== "string") return null;
  const m = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(spec.trim());
  if (!m) return null;
  const startMs = Number(m[1]);
  const endMs = Number(m[2]);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return { startMs, endMs };
}

// ===========================================================================================================
// applying the recording's OWN settings
// ===========================================================================================================
//
// Nothing read `rec.meta.settings` before this: a replay always ran with whatever `mirrorSettings.ts` defaults
// to on a fresh load, which for `raiseHandCards` is `false` even on a recording that had it `true`
// (`mirrorSettings.ts:732`) — the gap behind an undersized `bySource.local.count` on the card-target repro (5-9
// instead of the ~43 a build with the recording's OWN `raiseHand=on` produces, ~37 of them in the aim window).
//
// Every key below has a `?param=` lever `createMirrorSettings` already reads (mirrorSettings.ts:704-769) —
// "flag" params share the `urlOffFlag`/`urlOnOffFlag` tri-state contract (absent = default/saved, "off" = false,
// anything else = true), "raw" params take the setting's own string verbatim (quality/shaderMode/particleMode/
// stage/spineMode parse themselves, and a value they don't recognise is simply ignored by them, same as it
// would be on a real URL). A key with NO lever here (refreshRate, tweenReplay) is a PERSISTED setting
// (mirrorSettings.ts's PERSISTED_SETTING_KEYS) with no URL override at all — those go into the settings
// storage seam instead, which the page restores from on load.
const SETTINGS_URL_PARAMS = {
  stage: { param: "stage", kind: "raw" },
  quality: { param: "quality", kind: "raw" },
  shaderMode: { param: "shaders", kind: "raw" },
  particleMode: { param: "particles", kind: "raw" },
  spineMode: { param: "spineMode", kind: "raw" },
  stretchEnabled: { param: "stretch", kind: "flag" },
  raiseHeldCard: { param: "raiseCard", kind: "flag" },
  unfocusOnRelease: { param: "unfocus", kind: "flag" },
  tapToFocus: { param: "tapFocus", kind: "flag" },
  confirmTap: { param: "confirmTap", kind: "flag" },
  raiseHandCards: { param: "raiseHand", kind: "flag" },
  uiScaling: { param: "uiScale", kind: "flag" },
  backstopOcclusion: { param: "backstopOcclude", kind: "flag" },
  staticBgEnabled: { param: "staticBg", kind: "flag" },
  gamepad: { param: "gamepad", kind: "flag" },
  keyboard: { param: "keyboard", kind: "flag" }
};

/** `PERSISTED_SETTING_KEYS` minus everything in {@link SETTINGS_URL_PARAMS} above: real viewer preferences with
 * no URL lever, restorable only through the settings storage seam (`MIRROR_SETTINGS_STORAGE_KEY`). */
const SETTINGS_STORAGE_ONLY_KEYS = ["refreshRate", "tweenReplay"];

/**
 * Map a recording's `meta.settings` (or the more faithful `meta.settingsAtArm`, if the file has it — see
 * reproRecorder.ts) onto a target URL plus a storage-only remainder, so a replay runs under the SAME settings
 * the recording did instead of silent framework defaults.
 *
 * An explicit `--url` query always wins: a param already present on `url` is left untouched (not read from
 * `url.search` at call time only — the caller is expected to have already copied its own `--url` query onto
 * `url` before calling this, exactly as replay-repro.mjs does when it builds `target`).
 *
 * Returns `{applied, skipped}` for the caller to print — `applied` maps setting key → the value actually used
 * (on the URL or queued for storage), `skipped` lists keys present in the URL already (so the caller can say
 * WHY a setting it saw in the recording was not forced).
 */
export function applyRecordingSettings(url, settings) {
  const applied = {};
  const skipped = [];
  const storageOnly = {};
  if (!settings || typeof settings !== "object") return { applied, skipped, storageOnly };
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || value === null) continue;
    const spec = SETTINGS_URL_PARAMS[key];
    if (spec) {
      if (url.searchParams.has(spec.param)) {
        skipped.push(key);
        continue;
      }
      url.searchParams.set(spec.param, spec.kind === "flag" ? (value ? "on" : "off") : String(value));
      applied[key] = value;
      continue;
    }
    if (SETTINGS_STORAGE_ONLY_KEYS.includes(key)) {
      storageOnly[key] = value;
      applied[key] = value;
    }
  }
  return { applied, skipped, storageOnly };
}
