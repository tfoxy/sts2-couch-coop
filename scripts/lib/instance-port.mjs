// WHICH PORT IS THIS INSTANCE'S BROWSER SERVER ON? — the reader for `BrowserPortFile`.
//
// `COUCHCOOP_PREFERRED_PORT` is a preference. `CouchCoopBrowserServer.StartAsync` walks upward when the port is
// taken, so a script that launches an instance and then waits on the port it asked for has two failure modes and
// no way to tell them apart: the game is still booting, or the game is up on a port nobody told it about. The
// second one reads as an infinite boot and has cost more than one round.
//
// The mod now writes the port it actually bound into its own Godot user dir. That dir is addressable from the
// INSTANCE NAME, which is the one handle a QA script always has.
//
//   .sts2/instances/<name>/instance.json   → { "userDir": "<abs>/user" }
//   <userDir>/SlayTheSpire2/couch-coop/browser-port   → "13457\n"
//
// A HARD KILL LEAVES THE FILE BEHIND — and `sts2 game close` IS a hard kill, so that is the normal case rather
// than the edge one. Two guards, because a stale port is worse than no port (another process can bind it, and a
// reader that trusted the file would then drive somebody else's game): the record carries the WRITER'S PID and is
// ignored when that process is gone, and even a live-looking record is still only a hint — the caller connects.

import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

/** Where the mod writes the port, relative to an instance's `userDir`. Mirrors `BrowserPortFile.FileName`. */
export const BROWSER_PORT_RELATIVE = path.join("SlayTheSpire2", "couch-coop", "browser-port");

/** The `instance.json` for `name` under `repoRoot`, or null when there is no such instance. */
export async function readInstanceMeta(repoRoot, name) {
  try {
    const raw = await readFile(path.join(repoRoot, ".sts2", "instances", name, "instance.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The port `name`'s browser server last reported binding, or null when it has never reported one.
 *
 * `userDir` comes from the instance record rather than being rebuilt from `name`, because the record is what the
 * `sts2` CLI actually launched the game with — a path this file guessed would be right until somebody moved an
 * instance and then silently wrong.
 */
export async function readInstancePort(repoRoot, name) {
  const meta = await readInstanceMeta(repoRoot, name);
  const userDir = meta?.userDir;
  if (typeof userDir !== "string" || userDir.length === 0) {
    return null;
  }
  let record;
  try {
    record = JSON.parse(await readFile(path.join(userDir, BROWSER_PORT_RELATIVE), "utf8"));
  } catch {
    return null; // absent, or a half-written / pre-JSON file: either way there is no port to report
  }
  const { port, pid } = record ?? {};
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  // Signal 0 asks "does this pid exist and may I signal it" without delivering anything. A dead writer means the
  // record describes a listener that is gone, and reporting its port would hand the caller whatever bound it next.
  if (Number.isInteger(pid)) {
    try {
      process.kill(pid, 0);
    } catch {
      return null;
    }
  }
  return port;
}

/** Is something accepting connections on `port`? One connect, no request — the file is a hint, this is the proof. */
export function portIsOpen(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * WAIT FOR `name`'s BROWSER SERVER AND RETURN ITS REAL PORT.
 *
 * `preferred` is what the caller asked for; the answer is what the game says it bound, and they differ exactly
 * when the preferred port was taken. Both are polled in the same loop, so an instance running an older build (no
 * port file) still resolves through the preferred port and nothing regresses — it just cannot report a walk.
 *
 * Throws with both facts on a timeout, because "the port never opened" and "the port opened somewhere else" want
 * different next steps and a bare timeout has told a reader neither.
 */
export async function waitForInstancePort(repoRoot, name, preferred, timeoutMs = 180000, log = () => {}) {
  const deadline = Date.now() + timeoutMs;
  let lastReported = null;
  for (;;) {
    const reported = await readInstancePort(repoRoot, name);
    if (reported !== null && reported !== lastReported) {
      lastReported = reported;
      if (reported !== preferred) {
        log(`[setup] instance '${name}' walked past :${preferred} and bound :${reported}`);
      }
    }
    for (const candidate of reported !== null && reported !== preferred ? [reported, preferred] : [preferred]) {
      if (await portIsOpen(candidate)) {
        return candidate;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for instance '${name}'s browser server. ` +
          (lastReported === null
            ? `It never wrote a port file (${BROWSER_PORT_RELATIVE}), so it likely never got as far as starting ` +
              `the server — check <instanceDir>/user/SlayTheSpire2/logs/godot.log.`
            : `It reported :${lastReported} but nothing is accepting there.`)
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
