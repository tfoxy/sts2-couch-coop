#!/usr/bin/env node
// Real-WebSocket REPLAY SERVER for recorded mirror streams — feeds a recorded scene-delta stream to a real
// WebSocket client (the native Godot client, or anything) so the client can be exercised/benchmarked with NO
// live game. It mirrors the host's mirror-`/ws` behaviour closely enough to drive the client's flow control:
//
//   node scripts/replay-ws-server.mjs                                   # default recording, port 13400, recorded pace
//   node scripts/replay-ws-server.mjs --recording .sts2/bench/combat-XYZ.ndjson --port 13400
//   node scripts/replay-ws-server.mjs --pace max                       # credit-gated: next delta after scene-ack
//   node scripts/replay-ws-server.mjs --chaos latency=80,drop=0.05     # resilience testing (delay/drop frames)
//   node scripts/replay-ws-server.mjs --self-test                      # in-process server+client assertions
//
// Recording format (headered repro/1 NDJSON, produced by scripts/record-mirror-stream.mjs):
//   line 1:  {"meta":{"format":"repro/1",recordedAt,url,durationMs,messages,bytes}}
//   line 2+: {"t":<ms since first message>,"data":"<raw message string>"}
//
// A browser repro recording uses that same header and works here unchanged: its `dir:"in"` lines have exactly
// this shape, and its extra lines — the client's own
// sends (`dir:"out"`) and its input events (`kind:"pointer"`/`"wheel"`/…) — are dropped by loadRecording. See
// docs/agents/repro-recorder.md.
//
// Semantics (matched to scripts/bench-mirror-replay.mjs's in-page fake WS + the record script):
//   * `server-reload` frames are stripped (dev-reload signal, never sent to the client).
//   * If the recording lacks a directView session (a passive mirror recording never has one), a
//     {"type":"session","directView":true} is synthesized on connect so the client renders the scene.
//   * A client `join` is answered with the same directView session; a `ping` is answered with a
//     `pong` echoing t0 (and mainThread if present).
//   * pace=recorded: deliver messages at their recorded timestamps, ignore scene-ack for pacing.
//   * pace=max: 1-credit flow control — the FULL keyframe is free, each later scene-delta needs a credit
//     that a client scene-ack refills (the client's max consumption rate).
//   * --chaos latency=<ms>,drop=<p>: delay every outbound frame by <ms>; drop a fraction <p> of NON-keyframe
//     scene-deltas (keyframe + session/pong always sent). In max pace a dropped delta is skipped WITHOUT
//     consuming a credit, so the stream never deadlocks.
//
// TRANSPORT: prefers the `ws` npm package if it can be resolved from frontend/node_modules (createRequire);
// otherwise falls back to a bundled, self-contained RFC6455 server (below). As of this commit `ws` is NOT
// installed in this repo's node_modules, so the bundled server is what runs — the self-test exercises it
// end-to-end. Node's built-in global WebSocket (Node >= 22) is used for the self-test CLIENT.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter, once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Track T: tiny-PNG transcode threshold — mirrors MinSourceBytesForAstc in
// src/CouchCoop.Mod/Server/AstcTranscodeCache.cs and DEFAULT_MIN_BYTES in scripts/transcode-texture-cache.mjs. Below
// this many origin-response bytes, ASTC never pays off (tiny VFX PNGs inflate up to ~142x on the wire for ~zero GPU
// benefit), so skip the cctx lookup entirely and relay the origin bytes — even if a stale cache still has a tiny
// entry for this hash.
const MIN_ASTC_SOURCE_BYTES = 32768;

// =============================================================================================
// args
// =============================================================================================

function parseArgs(argv) {
  const a = {
    recording: ".sts2/bench/combat-baseline.ndjson",
    port: 13400,
    host: "0.0.0.0",
    pace: "recorded",
    chaos: { latency: 0, drop: 0 },
    assetsOrigin: null,
    astcCache: null,
    loop: false,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [key, inlineVal] = eq > 0 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const val = () => inlineVal ?? argv[++i];
    switch (key) {
      case "--recording": a.recording = val(); break;
      case "--port": a.port = Number(val()); break;
      case "--host": a.host = val(); break;
      case "--pace": a.pace = val(); break;
      case "--chaos": a.chaos = parseChaos(val()); break;
      case "--assets-origin": a.assetsOrigin = val(); break;
      case "--astc-cache": a.astcCache = val(); break;
      case "--loop": a.loop = true; break;
      case "--self-test": a.selfTest = true; break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`Unknown argument: ${arg}`); a.help = true;
    }
  }
  return a;
}

function parseChaos(spec) {
  const chaos = { latency: 0, drop: 0 };
  for (const part of String(spec).split(",")) {
    const [k, v] = part.split("=");
    if (k === "latency") chaos.latency = Math.max(0, Number(v) || 0);
    else if (k === "drop") chaos.drop = Math.min(1, Math.max(0, Number(v) || 0));
  }
  return chaos;
}

// =============================================================================================
// bundled RFC6455 server (fallback when `ws` is not installed)
// =============================================================================================

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptKey = (key) => createHash("sha1").update(key + WS_GUID).digest("base64");

// Encode a SERVER frame (unmasked). opcode: 0x1 text (default), 0x2 binary, 0x8 close, 0xA pong.
function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2); // high 32 bits (JS safe ints only)
    header.writeUInt32BE(len >>> 0, 6); // low 32 bits
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  return Buffer.concat([header, payload]);
}

// Incremental frame reader: buffers TCP chunks, unmasks client frames, reassembles fragments.
class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.fragOpcode = null;
    this.fragParts = [];
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    let frame;
    while ((frame = this._tryParse()) !== null) {
      if (frame.complete) out.push(frame);
    }
    return out;
  }
  _tryParse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      len = b.readUInt32BE(offset) * 2 ** 32 + b.readUInt32BE(offset + 4);
      offset += 8;
    }
    let mask = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      mask = b.subarray(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + len) return null;
    let payload = b.subarray(offset, offset + len);
    if (masked) {
      const un = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
      payload = un;
    }
    this.buf = b.subarray(offset + len);

    // Control frames (close/ping/pong) are never fragmented.
    if (opcode === 0x8 || opcode === 0x9 || opcode === 0xa) {
      return { opcode, payload, complete: true };
    }
    if (opcode === 0x0) {
      this.fragParts.push(payload);
      if (fin) {
        const full = Buffer.concat(this.fragParts);
        const op = this.fragOpcode ?? 0x1;
        this.fragParts = [];
        this.fragOpcode = null;
        return { opcode: op, payload: full, complete: true };
      }
      return { complete: false }; // consumed a continuation, keep reading
    }
    // opcode 0x1 (text) or 0x2 (binary)
    if (!fin) {
      this.fragOpcode = opcode;
      this.fragParts = [payload];
      return { complete: false };
    }
    return { opcode, payload, complete: true };
  }
}

// A normalized per-connection handle (EventEmitter: "message" (string), "close"). send(str) / close().
class MiniConn extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.url = req.url;
    this.closed = false;
    const parser = new FrameParser();
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = parser.push(chunk);
      } catch {
        this._peerClosed();
        return;
      }
      for (const f of frames) {
        if (f.opcode === 0x1 || f.opcode === 0x2) {
          this.emit("message", f.payload.toString("utf8"));
        } else if (f.opcode === 0x8) {
          // Answer the client's close frame (closing handshake) then end the TCP socket.
          try { socket.write(encodeFrame(f.payload, 0x8)); } catch { /* closing */ }
          try { socket.end(); } catch { /* closing */ }
          this._peerClosed();
        } else if (f.opcode === 0x9) {
          try { socket.write(encodeFrame(f.payload, 0xa)); } catch { /* closing */ }
        }
      }
    });
    socket.on("close", () => this._peerClosed());
    socket.on("error", () => this._peerClosed());
  }
  send(data) {
    if (this.closed) return;
    try { this.socket.write(encodeFrame(data, 0x1)); } catch { /* closing */ }
  }
  close() {
    if (this.closed) return;
    try { this.socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch { /* closing */ }
    try { this.socket.end(); } catch { /* closing */ }
    this._peerClosed();
  }
  _peerClosed() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

// Try to resolve the `ws` package from the frontend workspace (preferred), else null.
function tryLoadWs() {
  const bases = [
    new URL("../frontend/package.json", import.meta.url),
    new URL("../frontend/node_modules/ws/package.json", import.meta.url),
  ];
  for (const base of bases) {
    try {
      return createRequire(base)("ws");
    } catch {
      /* not resolvable here */
    }
  }
  return null;
}

// Build an http.Server that upgrades WebSocket connections and calls onConnection(conn) with a MiniConn-shaped
// handle. Uses `ws` if available (wrapped to the same shape), else the bundled server. Returns { httpServer, impl }.
function makeTransport(onConnection, assetsOrigin, astcCache) {
  // Optional read-only asset reverse-proxy: when --assets-origin <url> is set, any NON-upgrade GET (the client's
  // `/res/...` texture/font/shader/spine fetches, built as BaseUrl + relUrl) is forwarded verbatim to the origin
  // host (the live game's HTTP server), so a phone with a COLD AssetDiskCache still gets real art from the recorded
  // combat. WebSocket upgrades are handled separately by the 'upgrade' event, so they never reach this callback.
  //
  // Track F2a: with --astc-cache <dir>, a `?fmt=astc` GET is served from the LOCAL transcode cache (the same
  // <dir>/astc/<sha256>.cctx layout the mod route + batch use) so the phone gets GPU-native ASTC in benches without
  // updating the live mod. The origin is still fetched (over localhost) to obtain the bytes to CONTENT-HASH and to
  // provide the fallback body — the phone only ever receives the small cctx (a hit) or the original (a cold miss).
  const origin = assetsOrigin ? new URL(assetsOrigin) : null;
  const astcDir = astcCache ? join(resolve(astcCache), "astc") : null;

  // Buffer the origin response so we can hash it and pick cctx-vs-original. Used ONLY on the ?fmt=astc path.
  const serveAstc = (req, res, upstreamPath) => {
    const upstream = httpRequest(
      {
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port || 80,
        method: "GET",
        path: upstreamPath,
        headers: { ...req.headers, host: origin.host },
      },
      (up) => {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const body = Buffer.concat(chunks);
          const status = up.statusCode ?? 502;
          if (status >= 200 && status < 300 && body.length > 0 && body.length < MIN_ASTC_SOURCE_BYTES) {
            // Track T: tiny response — skip the cctx lookup entirely (even a stale cache with a tiny entry for
            // this hash is ignored) and fall through to relay the origin bytes below.
            console.log(`[proxy] ASTC SKIP (tiny ${body.length}B < ${MIN_ASTC_SOURCE_BYTES}B) ${upstreamPath}`);
          } else if (status >= 200 && status < 300 && body.length > 0) {
            const hash = createHash("sha256").update(body).digest("hex");
            const cctxPath = join(astcDir, `${hash}.cctx`);
            if (existsSync(cctxPath)) {
              const cctx = readFileSync(cctxPath);
              console.log(`[proxy] ASTC HIT ${upstreamPath} -> ${cctx.length}B cctx (origin ${body.length}B)`);
              res.writeHead(200, {
                "Content-Type": "application/x-cctx",
                "Content-Length": cctx.length,
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Cache": "ASTC",
              });
              res.end(cctx);
              return;
            }
            console.log(`[proxy] ASTC MISS ${upstreamPath} -> origin ${body.length}B ct=${up.headers["content-type"] ?? "?"}`);
          }
          // Cold miss / non-2xx: relay the origin response as-is (client sniffs non-CCTX -> normal decode path).
          const headers = { ...up.headers };
          delete headers["transfer-encoding"]; // we send a fully-buffered body with its own length
          res.writeHead(status, headers);
          res.end(body);
        });
      },
    );
    upstream.on("error", (e) => {
      console.log(`[proxy] ASTC ${upstreamPath} -> ERROR ${e.message}`);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`astc-proxy error: ${e.message}`);
    });
    upstream.end();
  };

  const httpServer = createServer((req, res) => {
    if (origin && (req.method === "GET" || req.method === "HEAD")) {
      // Parse the request URL; a ?fmt=astc GET routes to the local transcode cache. The fmt param is CouchCoop's
      // own response-format selector — the live origin ignores it, but we strip it before proxying so the origin
      // sees a clean path (and its content hash matches what the mod/batch hashed).
      const parsed = new URL(req.url, "http://replay.local");
      const wantsAstc = astcDir && req.method === "GET" && parsed.searchParams.get("fmt") === "astc";
      parsed.searchParams.delete("fmt");
      const upstreamPath = parsed.pathname + (parsed.search ? parsed.search : "");

      if (wantsAstc) {
        serveAstc(req, res, upstreamPath);
        return;
      }

      const upstream = httpRequest(
        {
          protocol: origin.protocol,
          hostname: origin.hostname,
          port: origin.port || 80,
          method: req.method,
          path: upstreamPath,
          headers: { ...req.headers, host: origin.host },
        },
        (up) => {
          let n = 0;
          up.on("data", (c) => { n += c.length; });
          up.on("end", () => console.log(`[proxy] ${req.method} ${upstreamPath} -> ${up.statusCode} ${n}B ct=${up.headers["content-type"] ?? "?"}`));
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        console.log(`[proxy] ${req.method} ${upstreamPath} -> ERROR ${e.message}`);
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`asset-proxy error: ${e.message}`);
      });
      req.pipe(upstream);
      return;
    }

    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required — this is a WebSocket replay server");
  });

  // Track every TCP socket (incl. upgraded ones) so close() can force them down and resolve promptly.
  const sockets = new Set();
  httpServer.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  const wsMod = tryLoadWs();
  if (wsMod) {
    const { WebSocketServer } = wsMod;
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (sock) => {
        const conn = new EventEmitter();
        conn.url = req.url;
        conn.send = (d) => { try { sock.send(d); } catch { /* closing */ } };
        conn.close = () => { try { sock.close(); } catch { /* closing */ } };
        sock.on("message", (d) => conn.emit("message", typeof d === "string" ? d : d.toString("utf8")));
        sock.on("close", () => conn.emit("close"));
        sock.on("error", () => {});
        onConnection(conn);
      });
    });
    return { httpServer, sockets, impl: "ws" };
  }

  httpServer.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    onConnection(new MiniConn(socket, req));
  });
  return { httpServer, sockets, impl: "mini" };
}

// =============================================================================================
// replay engine (per connection)
// =============================================================================================

const isSceneDelta = (d) => d.includes('"type":"scene-delta"');
const isKeyframe = (d) => isSceneDelta(d) && d.includes('"full":true');
const isServerReload = (d) => d.includes('"type":"server-reload"');

function handleConnection(conn, ctx) {
  const id = ++ctx.connSeq;
  const stats = {
    msgsSent: 0, bytesSent: 0, deltasSent: 0, dropped: 0, acks: 0, pings: 0, connectedAt: Date.now(),
  };
  ctx.log(`[conn ${id}] connected url=${conn.url ?? "?"}  (pace=${ctx.pace})`);

  const msgs = ctx.messages; // already stripped of server-reload
  let idx = 0;
  let credits = 1;
  let closed = false;
  const timers = new Set();

  const rawSend = (data) => {
    if (closed) return;
    conn.send(data);
    stats.msgsSent++;
    stats.bytesSent += Buffer.byteLength(data, "utf8");
  };
  // Apply chaos latency (drop is decided in the pace loops so pacing bookkeeping stays coherent).
  const sendNow = (data) => {
    if (closed) return;
    if (ctx.chaos.latency > 0) {
      const t = setTimeout(() => { timers.delete(t); rawSend(data); }, ctx.chaos.latency);
      timers.add(t);
    } else {
      rawSend(data);
    }
  };

  // Synthesize a directView session up front, ALWAYS — even when the recording contains one of its own.
  //
  // Two reasons, and the second is now load-bearing. (1) A passive mirror recording never has one, so without this
  // the client would sit on its pre-join screen. (2) WS-B stream gate: the client now connects with `?watch=0` and
  // DROPS scene-deltas until it decides it may watch, which for a replay target means "until a session grants
  // directView". A recording that carries its own directView session would deliver it at its RECORDED time —
  // potentially after the keyframe — and the client would have thrown that keyframe away. Sending it up front
  // regardless is idempotent on the client (directView is latched) and removes the ordering hazard entirely.
  sendNow('{"type":"session","directView":true}');

  const maybeDropDelta = (keyframe) =>
    !keyframe && ctx.chaos.drop > 0 && Math.random() < ctx.chaos.drop;

  // pace=recorded: deliver at recorded timestamps.
  let startWall = performance.now();
  let loops = 0;
  const scheduleRecorded = () => {
    if (closed) return;
    if (idx >= msgs.length) {
      if (ctx.loop) {
        loops++;
        ctx.log(`[conn ${id}] recording loop #${loops} (recorded, ${stats.deltasSent} deltas so far)`);
        idx = 0;
        startWall = performance.now();
        scheduleRecorded();
        return;
      }
      ctx.log(`[conn ${id}] recording exhausted (recorded, ${stats.deltasSent} deltas sent)`);
      return;
    }
    const wait = Math.max(0, msgs[idx].t - (performance.now() - startWall));
    const t = setTimeout(() => {
      timers.delete(t);
      const now = performance.now() - startWall;
      while (idx < msgs.length && msgs[idx].t <= now) {
        const d = msgs[idx].data;
        idx++;
        if (isSceneDelta(d)) {
          if (maybeDropDelta(isKeyframe(d))) { stats.dropped++; continue; }
          sendNow(d);
          stats.deltasSent++;
        } else {
          sendNow(d);
        }
      }
      scheduleRecorded();
    }, wait);
    timers.add(t);
  };

  // pace=max: 1-credit flow control.
  const pumpMax = () => {
    if (closed) return;
    while (idx < msgs.length) {
      const d = msgs[idx].data;
      const delta = isSceneDelta(d);
      const keyframe = delta && isKeyframe(d);
      if (delta && !keyframe && credits <= 0) return; // wait for a scene-ack
      if (delta && maybeDropDelta(keyframe)) { idx++; stats.dropped++; continue; } // loss w/o consuming credit
      idx++;
      if (delta && !keyframe) credits--;
      sendNow(d);
      if (delta) stats.deltasSent++;
    }
    ctx.log(`[conn ${id}] recording exhausted (max, ${stats.deltasSent} deltas sent)`);
  };

  conn.on("message", (raw) => {
    let msg = null;
    try { msg = JSON.parse(raw); } catch { return; }
    const type = msg && msg.type;
    if (type === "scene-ack") {
      stats.acks++;
      if (ctx.pace === "max") { credits++; pumpMax(); }
      return;
    }
    if (type === "join") {
      sendNow('{"type":"session","directView":true}');
      return;
    }
    if (type === "ping") {
      stats.pings++;
      const echo = { type: "pong", t0: msg.t0 };
      if (msg.mainThread) echo.mainThread = true;
      sendNow(JSON.stringify(echo));
      return;
    }
    // input / settings / anything else — swallow (never reaches a game).
  });

  conn.on("close", () => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    const dur = ((Date.now() - stats.connectedAt) / 1000).toFixed(1);
    ctx.log(
      `[conn ${id}] closed after ${dur}s — sent ${stats.msgsSent} msgs ` +
      `(${stats.deltasSent} deltas, ${(stats.bytesSent / 1024 / 1024).toFixed(2)} MiB), ` +
      `${stats.dropped} dropped, ${stats.acks} acks, ${stats.pings} pings`
    );
  });

  if (ctx.pace === "max") pumpMax();
  else scheduleRecorded();
}

// =============================================================================================
// server bootstrap
// =============================================================================================

function loadRecording(path) {
  const abs = resolve(REPO_ROOT, path);
  const text = readFileSync(abs, "utf8");
  const meta = requireReproHeader(text, abs);
  const lines = text.split("\n").filter((l) => l.length > 0);
  let hasDirectView = false;
  const messages = [];
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (i === 0) continue;
    // A REPRO recording (format "repro/1", see frontend/src/mirror/reproRecorder.ts) carries BOTH directions of
    // the wire plus its own `kind:` lines. Its `dir:"in"` frames are exactly a passive recording's, which is what
    // makes a repro file a drop-in input here — but the client's OWN sends must never be replayed back AT the
    // client, so they are dropped. The `kind:` lines have no `data` and are already skipped below.
    if (obj.dir === "out") continue;
    if (typeof obj.data !== "string") continue;
    if (obj.data.includes('"directView":true')) hasDirectView = true;
    messages.push({ t: typeof obj.t === "number" ? obj.t : 0, data: obj.data });
  }
  return { abs, meta, hasDirectView, messages };
}

function buildCtx({ messages, hasDirectView, pace, chaos, log, loop }) {
  return {
    messages: messages.filter((m) => !isServerReload(m.data)),
    hasDirectView,
    pace,
    chaos,
    loop: !!loop,
    connSeq: 0,
    log,
  };
}

function startServer({ messages, hasDirectView, pace, chaos, port, host, log, assetsOrigin, astcCache, loop }) {
  const ctx = buildCtx({ messages, hasDirectView, pace, chaos, log, loop });
  const { httpServer, sockets, impl } = makeTransport((conn) => handleConnection(conn, ctx), assetsOrigin, astcCache);
  return new Promise((res) => {
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      res({
        impl,
        port: addr.port,
        close: () => new Promise((r) => {
          for (const s of sockets) {
            try { s.destroy(); } catch { /* already gone */ }
          }
          httpServer.close(() => r());
        }),
      });
    });
  });
}

// =============================================================================================
// self-test (in-process server + client; asserts pacing / ack / pong / reload-strip)
// =============================================================================================

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The self-test client drives the replay protocol but does not render trails, so its explicit current
// capability declaration keeps trailDrive=0.
const SELF_TEST_WS_QUERY = "watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0";

async function runSelfTest() {
  if (typeof WebSocket !== "function") {
    console.error("SELF-TEST: global WebSocket unavailable — need Node >= 22 (this is " + process.version + ")");
    process.exit(2);
  }
  const failures = [];
  const assert = (cond, what) => { if (!cond) failures.push(what); };
  const silent = () => {};

  // Synthetic recording: keyframe, a server-reload (must be stripped), then two incremental deltas.
  const kf = JSON.stringify({ type: "scene-delta", full: true, upserts: [{ id: "root", nodeType: "Node2D" }], removedIds: [], orderedIds: ["root"] });
  const d1 = JSON.stringify({ type: "scene-delta", full: false, upserts: [{ id: "a" }], removedIds: [], orderedIds: ["root", "a"] });
  const d2 = JSON.stringify({ type: "scene-delta", full: false, upserts: [{ id: "b" }], removedIds: [], orderedIds: ["root", "a", "b"] });
  const synthetic = [
    { t: 0, data: kf },
    { t: 30, data: JSON.stringify({ type: "server-reload" }) },
    { t: 60, data: d1 },
    { t: 90, data: d2 },
  ];
  const noChaos = { latency: 0, drop: 0 };
  const countDeltas = (arr) => arr.filter((d) => d.includes('"type":"scene-delta"')).length;

  // ---- Test A: recorded pace — all 3 deltas + synthesized session + pong echo; reload stripped. ----
  {
    const srv = await startServer({ messages: synthetic, hasDirectView: false, pace: "recorded", chaos: noChaos, port: 0, host: "127.0.0.1", log: silent });
    const received = [];
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?${SELF_TEST_WS_QUERY}`);
    await once(ws, "open");
    ws.addEventListener("message", (e) => {
      received.push(e.data);
      if (e.data.includes('"type":"scene-delta"')) ws.send('{"type":"scene-ack"}');
    });
    ws.send('{"type":"ping","t0":12345}');
    await delay(400);
    ws.close();
    await srv.close();

    assert(received.some((d) => d.includes('"directView":true')), "A: synthesized directView session");
    assert(countDeltas(received) === 3, `A: 3 scene-deltas delivered (got ${countDeltas(received)})`);
    assert(received.some((d) => d.includes('"type":"pong"') && d.includes("12345")), "A: pong echoes t0");
    assert(!received.some((d) => d.includes('"type":"server-reload"')), "A: server-reload stripped");
  }

  // ---- Test B: max pace — credit gating (keyframe free + 1 delta, then blocked until an ack). ----
  {
    const srv = await startServer({ messages: synthetic, hasDirectView: false, pace: "max", chaos: noChaos, port: 0, host: "127.0.0.1", log: silent });
    const received = [];
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?${SELF_TEST_WS_QUERY}`);
    await once(ws, "open");
    ws.addEventListener("message", (e) => received.push(e.data));
    await delay(200); // NO ack yet
    const before = countDeltas(received);
    assert(before === 2, `B: gated at keyframe+1 delta before ack (got ${before})`);

    ws.send('{"type":"scene-ack"}'); // refill one credit -> unlocks the 2nd incremental delta
    await delay(200);
    const after = countDeltas(received);
    assert(after === 3, `B: 3 deltas after one ack (got ${after})`);

    ws.close();
    await srv.close();
  }

  // ---- Test C: chaos drop=1 in recorded pace — keyframe survives, incremental deltas all dropped. ----
  {
    const srv = await startServer({ messages: synthetic, hasDirectView: false, pace: "recorded", chaos: { latency: 0, drop: 1 }, port: 0, host: "127.0.0.1", log: silent });
    const received = [];
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?${SELF_TEST_WS_QUERY}`);
    await once(ws, "open");
    ws.addEventListener("message", (e) => received.push(e.data));
    await delay(300);
    ws.close();
    await srv.close();
    assert(countDeltas(received) === 1, `C: only the keyframe survives drop=1 (got ${countDeltas(received)})`);
  }

  // ---- Test D: a REPRO recording loads as a passive one — inbound only, `kind:` lines ignored. ----
  // A repro file (frontend/src/mirror/reproRecorder.ts, format "repro/1") is a superset of a passive recording:
  // the same `{t,data}` inbound lines, plus the client's own sends (`dir:"out"`) and its input events
  // (`kind:"pointer"`, …). Replaying an outbound line would hand the mirror its OWN `input` envelope as if the
  // host had sent it, so the loader drops that half — this is the assertion behind that one-line guard.
  {
    const dir = mkdtempSync(join(tmpdir(), "repro-selftest-"));
    const file = join(dir, "repro.ndjson");
    const headerless = join(dir, "headerless.ndjson");
    try {
      writeFileSync(headerless, `${JSON.stringify({ t: 0, data: kf })}\n`);
      try {
        loadRecording(headerless);
        assert(false, "D: headerless recordings are rejected");
      } catch (error) {
        assert(/repro\/1/.test(String(error.message)), `D: rejection names repro/1 (${error.message})`);
      }
      writeFileSync(file, [
        JSON.stringify({ meta: { format: "repro/1", recordedAt: new Date().toISOString() } }),
        JSON.stringify({ t: 0, dir: "in", data: JSON.stringify({ type: "session", directView: true }) }),
        JSON.stringify({ t: 1, kind: "pointer", type: "down", x: 100, y: 200, id: 1, pt: "touch" }),
        JSON.stringify({ t: 2, dir: "out", data: JSON.stringify({ type: "input", kind: "hover" }) }),
        JSON.stringify({ t: 3, dir: "in", data: kf }),
        JSON.stringify({ t: 4, kind: "marker", n: 1 }),
        JSON.stringify({ t: 5, dir: "out", data: '{"type":"scene-ack"}' }),
        JSON.stringify({ t: 6, dir: "in", data: d1 }),
        "",
      ].join("\n"));
      const loaded = loadRecording(file);
      assert(loaded.messages.length === 3, `D: 3 inbound frames kept (got ${loaded.messages.length})`);
      assert(!loaded.messages.some((m) => m.data.includes('"type":"input"')), "D: no outbound input replayed");
      assert(!loaded.messages.some((m) => m.data.includes("scene-ack")), "D: no outbound ack replayed");
      assert(loaded.hasDirectView === true, "D: the inbound directView session is still seen");
      assert(loaded.meta.format === "repro/1", "D: the repro meta line is read as meta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (failures.length === 0) {
    console.log(
      "SELF-TEST: PASS (recorded pacing + max credit gating + chaos drop + pong echo + reload strip + repro/1 load)");
    process.exit(0);
  }
  console.error("SELF-TEST: FAIL\n  " + failures.join("\n  "));
  process.exit(1);
}

// =============================================================================================
// main
// =============================================================================================

const HELP = `replay-ws-server.mjs — real-WebSocket replay server for recorded mirror streams

  --recording <path>   NDJSON recording (default .sts2/bench/combat-baseline.ndjson, rel. to repo root)
  --port <p>           listen port (default 13400)
  --host <h>           bind host (default 0.0.0.0 — reachable from a phone on the LAN)
  --pace <mode>        recorded (default; original timing) | max (credit-gated by scene-ack)
  --chaos <spec>       latency=<ms>,drop=<0..1> — delay every frame / drop a fraction of incremental deltas
  --assets-origin <url> reverse-proxy non-upgrade GETs (/res asset fetches) to this origin (e.g. http://host:13337)
  --astc-cache <dir>   serve ?fmt=astc GETs from <dir>/astc/<sha256>.cctx (Track F2a; else strip fmt + proxy origin)
  --loop               (recorded pace) restart the recording from t0 on exhaustion — continuous stream
  --self-test          spin an in-process server + client and assert pacing/ack/pong/reload behaviour
  --help

Connect a client to  ws://<host>:<port>/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0  (e.g. the native Godot client: --host <ip>:<port>).`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.selfTest) {
    await runSelfTest();
    return;
  }
  if (!["recorded", "max"].includes(args.pace)) {
    console.error(`--pace must be 'recorded' or 'max' (got '${args.pace}')`);
    process.exit(2);
  }

  let rec;
  try {
    rec = loadRecording(args.recording);
  } catch (e) {
    console.error(`Failed to read recording '${args.recording}': ${e.message}`);
    console.error("Record one with:  node scripts/record-mirror-stream.mjs --out .sts2/bench/combat-baseline.ndjson");
    process.exit(2);
  }

  const srv = await startServer({
    messages: rec.messages,
    hasDirectView: rec.hasDirectView,
    pace: args.pace,
    chaos: args.chaos,
    port: args.port,
    host: args.host,
    log: console.log,
    assetsOrigin: args.assetsOrigin,
    astcCache: args.astcCache,
    loop: args.loop,
  });

  const strippedCount = rec.messages.filter((m) => !isServerReload(m.data)).length;
  console.log(`replay-ws-server listening on ${args.host}:${srv.port}  (transport=${srv.impl})`);
  console.log(`  recording:  ${rec.abs}`);
  console.log(`  meta:       ${rec.meta.messages ?? "?"} msgs, ${rec.meta.bytes ?? "?"} bytes, ${rec.meta.durationMs ?? "?"}ms span`);
  console.log(`  replaying:  ${strippedCount} msgs (server-reload stripped), pace=${args.pace}, directView=${rec.hasDirectView ? "in recording" : "SYNTHESIZED"}`);
  if (args.chaos.latency || args.chaos.drop) {
    console.log(`  chaos:      latency=${args.chaos.latency}ms drop=${args.chaos.drop}`);
  }
  if (args.astcCache) {
    console.log(`  astc-cache: ${join(resolve(args.astcCache), "astc")} (?fmt=astc served from here)`);
  }
  console.log(`  connect:    ws://<host>:${srv.port}/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0`);

  process.on("SIGINT", async () => {
    console.log("\nSIGINT — closing");
    await srv.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
