// EVERY PEER'S OWN RECORD OF A HOSTED SESSION — the checks scripts/run-session-soak.mjs runs per route step and at
// session end, kept apart from the rig so the full-run E2E can run the same checks on its own route.
//
// Three questions, each answered from what the peers themselves wrote, never from the host's say-so:
//
//   1. DID A DEV-CONSOLE STEP REACH EVERY PEER? In a real multiplayer run the game replicates its networked console
//      commands: the host's console answers `Enqueued <cmd> command: '<line>'`, and then EVERY peer — host included —
//      logs `Executing DevConsole command (player <issuer netId>): \`<line>\`` followed by `DevConsole: <line>`.
//      `waitForConsoleEcho()` tails each peer's godot.log for that pair and records when each peer's line was first
//      seen. The spread between the host's sighting and a seat's is a free, if coarse, measure of queue lag.
//   2. DID ANY PEER DIVERGE? `scanDesync()` greps every peer log for the game's divergence wording. Any hit fails
//      the session.
//   3. DO THE PEERS AGREE ON WHERE THE RUN IS? `compareRunStates()` compares each seat's read-only `sts2 state`
//      (through that seat's own bridge) with the host's: act, floor, and per player deck size, gold and HP. A
//      mismatch is a divergence even when no log line says so.
//
// Only log wording and the `sts2 state` JSON shape are encoded here — the strings the code has to match.
//
// TIMING CAVEAT for (1): godot.log has no timestamps, so "seen at" is when THIS process read the line, not when the
// peer wrote it. The resolution is the poll interval plus however long the peer's log writer holds a line in its
// buffer. Report the spread as an upper bound on delivery delay, and prove the buffering is small (a quiet step's
// host sighting against the CLI's own return) before reading anything finer into it.

import * as nodeFs from "node:fs";
import { performance } from "node:perf_hooks";

/** The divergence wording, as one regular expression (host detection, client notice, abandon, kick reason). */
export const DESYNC_PATTERN_SOURCE = "State divergence|state diverged|StateDivergence|STATE_DIVERGENCE";
export const DESYNC_PATTERN = new RegExp(DESYNC_PATTERN_SOURCE);

/** What the host's console answers when it took the replicating path, and the CLI notice that says so. */
export const enqueuedText = (command, line) => `Enqueued ${command} command: '${line}'`;
export const NETWORKED_CONSOLE_NOTICE = "networked-console-path";

/** The pair of lines every peer writes when it executes a replicated console command. */
export const consoleEchoText = (issuerNetId, line) => `Executing DevConsole command (player ${issuerNetId}): \`${line}\``;
export const consoleExecText = line => `DevConsole: ${line}`;

/**
 * Tails one log file from where it ends now. `poll()` returns the complete lines appended since the last poll,
 * each stamped with the monotonic time it was read. A file that shrinks (replaced or truncated) is re-read from 0.
 */
export class LogTail {
  #fs;
  #now;
  #offset = 0;
  #partial = "";
  #lineNumber = 0;

  constructor(file, { fs = nodeFs, now = () => performance.now(), fromStart = false } = {}) {
    this.file = file;
    this.#fs = fs;
    this.#now = now;
    if (!fromStart) {
      try {
        const text = fs.readFileSync(file, "utf8");
        this.#offset = Buffer.byteLength(text, "utf8");
        const lines = text.split("\n");
        this.#partial = lines.pop();
        this.#lineNumber = lines.length;
        // A trailing partial line is kept so its completion is still reported, numbered correctly.
        this.#offset -= Buffer.byteLength(this.#partial, "utf8");
        this.#partial = "";
      } catch { /* not there yet: tail from its first byte */ }
    }
  }

  poll() {
    let size;
    try {
      size = this.#fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.#offset) {
      this.#offset = 0;
      this.#partial = "";
      this.#lineNumber = 0;
    }
    if (size === this.#offset) return [];
    const fd = this.#fs.openSync(this.file, "r");
    let chunk;
    try {
      const buffer = Buffer.alloc(size - this.#offset);
      const read = this.#fs.readSync(fd, buffer, 0, buffer.length, this.#offset);
      chunk = buffer.subarray(0, read).toString("utf8");
      this.#offset += read;
    } finally {
      this.#fs.closeSync(fd);
    }
    const seenAtMs = this.#now();
    const parts = (this.#partial + chunk).split("\n");
    this.#partial = parts.pop();
    return parts.map(text => ({ lineNumber: ++this.#lineNumber, text: text.replace(/\r$/, ""), seenAtMs }));
  }
}

/** Did the host's console take the replicating path for `line`? Read from the `sts2 dev console --json` payload. */
export function hostConsoleProof(response, command, line) {
  const texts = [response?.output, ...(Array.isArray(response?.outputLines) ? response.outputLines : [])].filter(text => typeof text === "string");
  const notices = Array.isArray(response?.notices) ? response.notices.map(notice => notice?.code) : [];
  return {
    enqueued: texts.some(text => text.includes(enqueuedText(command, line))),
    networkedPath: notices.includes(NETWORKED_CONSOLE_NOTICE)
  };
}

/**
 * Waits until every peer has logged the echo of `line` (issued by `issuerNetId`). `peers` = `[{peer, tail}]`,
 * with the host first by convention — `delayFromHostMs` is measured against the peer named "host".
 *
 * Call `drain(peers)` right before issuing the command so an older identical line cannot satisfy this one.
 * Never throws: a timeout is a result (`ok: false`, `missing`), because a step that never replicated is the
 * evidence, not an exception.
 */
export async function waitForConsoleEcho({ peers, issuerNetId, line, timeoutMs = 60000, pollMs = 100, sleep, now = () => performance.now(), signal = null }) {
  const echo = consoleEchoText(issuerNetId, line);
  const exec = consoleExecText(line);
  const started = now();
  const state = new Map(peers.map(({ peer }) => [peer, { peer, seen: false, seenAtMs: null, lineNumber: null, confirmed: false }]));
  const pause = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (;;) {
    for (const { peer, tail } of peers) {
      const entry = state.get(peer);
      if (entry.seen && entry.confirmed) continue;
      for (const row of tail.poll()) {
        if (!entry.seen && row.text.includes(echo)) {
          Object.assign(entry, { seen: true, seenAtMs: row.seenAtMs, lineNumber: row.lineNumber });
        } else if (entry.seen && !entry.confirmed && row.text.includes(exec)) {
          entry.confirmed = true;
        }
      }
    }
    const all = [...state.values()];
    if (all.every(entry => entry.seen && entry.confirmed) || now() - started >= timeoutMs || signal?.aborted) break;
    // Seen-but-unconfirmed peers get the rest of the window too: the confirming line may trail the echo.
    await pause(pollMs);
  }
  const all = [...state.values()];
  const host = state.get("host");
  return {
    ok: all.every(entry => entry.seen),
    line,
    issuerNetId,
    waitedMs: Math.round(now() - started),
    missing: all.filter(entry => !entry.seen).map(entry => entry.peer),
    unconfirmed: all.filter(entry => entry.seen && !entry.confirmed).map(entry => entry.peer),
    peers: all.map(entry => ({
      peer: entry.peer,
      seen: entry.seen,
      confirmed: entry.confirmed,
      lineNumber: entry.lineNumber,
      afterIssueMs: entry.seenAtMs === null ? null : Math.round(entry.seenAtMs - started),
      delayFromHostMs: entry.seenAtMs === null || !host?.seen ? null : Math.round(entry.seenAtMs - host.seenAtMs)
    }))
  };
}

/** Consumes everything the tails have buffered so far, so the next wait only sees lines written after this call. */
export function drain(peers) {
  for (const { tail } of peers) tail.poll();
}

/**
 * Greps each `{label, path}` for the divergence wording. A file that could not be read is reported as
 * `readable: false` — "no hits" and "not scanned" are different claims.
 */
export function scanDesync(files, { fs = nodeFs, pattern = DESYNC_PATTERN, limit = 20 } = {}) {
  const results = files.map(({ label, path }) => {
    let text;
    try {
      text = fs.readFileSync(path, "utf8");
    } catch {
      return { label, path, readable: false, hits: [] };
    }
    const hits = [];
    text.split("\n").forEach((lineText, index) => {
      if (hits.length < limit && pattern.test(lineText)) hits.push({ line: index + 1, text: lineText.slice(0, 400) });
    });
    return { label, path, readable: true, hits };
  });
  const total = results.reduce((sum, entry) => sum + entry.hits.length, 0);
  return { pattern: pattern.source, ok: total === 0, total, unreadable: results.filter(entry => !entry.readable).map(entry => entry.label), files: results };
}

/**
 * For each console line, how many times each peer's full log carries its echo. Computed after the session from
 * the complete logs, so it also covers a live wait that timed out only because a line sat in a buffer.
 */
export function replicationLedger({ files, issuerNetId, lines, fs = nodeFs }) {
  const texts = files.map(({ label, path }) => {
    try {
      return { label, text: fs.readFileSync(path, "utf8") };
    } catch {
      return { label, text: null };
    }
  });
  return lines.map(line => {
    const echo = consoleEchoText(issuerNetId, line);
    return {
      line,
      peers: Object.fromEntries(texts.map(({ label, text }) => [label, text === null ? null : text.split(echo).length - 1]))
    };
  });
}

/** The run-level facts every peer must agree on, from one `sts2 state --json` payload. Null when there is no run. */
export function summarizeRunState(state) {
  const run = state?.run;
  if (!run || typeof run !== "object") return null;
  const number = value => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    act: number(run.currentActIndex),
    actFloor: number(run.actFloor),
    totalFloor: number(run.totalFloor),
    players: (Array.isArray(run.players) ? run.players : []).map(player => ({
      id: player?.id ?? null,
      netId: player?.netId ?? null,
      deckSize: number(player?.deck?.count) ?? (Array.isArray(player?.deck?.cards) ? player.deck.cards.length : null),
      gold: number(player?.gold),
      hp: number(player?.creature?.currentHp),
      maxHp: number(player?.creature?.maxHp),
      inventoryComplete: player?.inventoryComplete !== false
    }))
  };
}

const RUN_FIELDS = ["act", "actFloor", "totalFloor"];
const PLAYER_FIELDS = ["hp", "maxHp"];
const INVENTORY_FIELDS = ["deckSize", "gold"];

/**
 * Compares every peer's summary with the reference peer's. `views` = `[{peer, summary}]`. A peer with no run, or a
 * player missing from one side, is a mismatch. Inventory fields are compared only when BOTH sides say their view
 * of that player's inventory is complete; otherwise they are listed as incomparable rather than guessed.
 */
export function compareRunStates(views, { reference = "host" } = {}) {
  const base = views.find(view => view.peer === reference);
  const mismatches = [];
  const incomparable = [];
  if (!base?.summary) {
    return { ok: false, reference, mismatches: [{ peer: reference, field: "run", expected: "a run", actual: null }], incomparable };
  }
  for (const view of views) {
    if (view.peer === reference) continue;
    if (!view.summary) {
      mismatches.push({ peer: view.peer, field: "run", expected: "a run", actual: null });
      continue;
    }
    for (const field of RUN_FIELDS) {
      if (view.summary[field] !== base.summary[field]) mismatches.push({ peer: view.peer, field, expected: base.summary[field], actual: view.summary[field] });
    }
    const theirs = new Map(view.summary.players.map(player => [player.id, player]));
    for (const player of base.summary.players) {
      const other = theirs.get(player.id);
      theirs.delete(player.id);
      if (!other) {
        mismatches.push({ peer: view.peer, player: player.id, field: "present", expected: true, actual: false });
        continue;
      }
      for (const field of PLAYER_FIELDS) {
        if (other[field] !== player[field]) mismatches.push({ peer: view.peer, player: player.id, field, expected: player[field], actual: other[field] });
      }
      for (const field of INVENTORY_FIELDS) {
        if (!player.inventoryComplete || !other.inventoryComplete) {
          incomparable.push({ peer: view.peer, player: player.id, field, reason: "inventory not complete on one side" });
        } else if (other[field] !== player[field]) {
          mismatches.push({ peer: view.peer, player: player.id, field, expected: player[field], actual: other[field] });
        }
      }
    }
    for (const extra of theirs.keys()) mismatches.push({ peer: view.peer, player: extra, field: "present", expected: false, actual: true });
  }
  return { ok: mismatches.length === 0, reference, mismatches, incomparable };
}
