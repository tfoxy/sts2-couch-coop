#!/usr/bin/env node
// Instrument validation only: a synthetic page and native WebSocket. No game-performance claim.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "../frontend/node_modules/playwright/index.mjs";

const sockets = new Set();
const server = createServer((_, res) => {
  res.setHeader("Content-Type", "text/html");
  // The witness must work with CSP: there is deliberately no unsafe-eval allowance.
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'nonce-fixture'; style-src 'unsafe-inline'; connect-src 'self'");
  res.end(`<!doctype html><body style="margin:0"><div class="mirror-stage" style="width:1280px;height:720px;background:#123">
    <div id="cardA" data-node-id="targetA" style="position:absolute;left:350px;top:450px;width:100px;height:150px;background:#777;z-index:0"></div>
    <div id="cardB" data-node-id="targetB" style="position:absolute;left:500px;top:450px;width:100px;height:150px;background:#777;z-index:0"></div>
    <div id="unrelated"></div></div><script nonce="fixture">
    const canvasMode = new URLSearchParams(location.search).get('stage') === 'canvas';
    const transientPose = new URLSearchParams(location.search).has('transientPose');
    const initialFocus = new URLSearchParams(location.search).has('initialFocus') &&
      !sessionStorage.getItem('firstReturnInitialFocus');
    if (initialFocus) sessionStorage.setItem('firstReturnInitialFocus', '1');
    const focused = { targetA: false, targetB: false };
    const publishedFocused = { targetA: false, targetB: false };
    let unsettledUntil = 0;
    let sequence = 0;
    let gl = null;
    if (canvasMode) {
      const canvas = document.createElement('canvas');
      canvas.className = 'mirror-canvas-stage';
      canvas.width = 1280; canvas.height = 720;
      canvas.style.cssText = 'position:absolute;inset:0;width:1280px;height:720px;pointer-events:none';
      document.querySelector('.mirror-stage').prepend(canvas);
      gl = canvas.getContext('webgl2');
      if (!gl) throw new Error('synthetic canvas fixture needs WebGL2');
      gl.clearColor(.2, .2, .2, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArraysInstanced(gl.POINTS, 0, 1, 1);
    }
    const socket = new WebSocket('ws://' + location.host + '/ws?watch=1&initialFocus=' + (initialFocus ? '1' : '0'));
    socket.addEventListener('message', e => {
      const message = JSON.parse(e.data);
      if (message.type === 'scene-delta' && Object.hasOwn(focused, message.upserts[0].id)) {
        const id = message.upserts[0].id;
        focused[id] = message.upserts[0].zIndex === 1;
        if (transientPose && focused[id]) unsettledUntil = performance.now() + 300;
        if (canvasMode) {
          requestAnimationFrame(() => {
            publishedFocused[id] = focused[id];
            const anyFocused = publishedFocused.targetA || publishedFocused.targetB;
            gl.clearColor(anyFocused ? 1 : .2, anyFocused ? 1 : .2, anyFocused ? 1 : .2, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArraysInstanced(gl.POINTS, 0, 1, 1);
          });
        } else {
          publishedFocused[id] = focused[id];
          const card = document.getElementById(id === 'targetA' ? 'cardA' : 'cardB');
          card.style.background = focused[id] ? '#fff' : '#777';
          card.style.zIndex = focused[id] ? '1' : '0';
        }
      }
    });
    window.__mirrorHandPoses = () => ({ stage:canvasMode?'canvas':'dom', holders:['targetA','targetB'].map((id,index) => ({
      id, hitboxId:id+'hit', cardId:id+'-card', cardContentKey:'fixture', inFan:true, zIndex:publishedFocused[id]?1:0,
      channelLive:transientPose && !publishedFocused[id] && performance.now() < unsettledUntil,
      mDrawn:[1,0,0,1,index?500:350,450]})) });
    window.__mirrorInteractiveRects = () => ['targetA','targetB'].map((id,index) => ({
      id:id+'hit',transform:[1,0,0,1,index?500:350,450],
      localRect:{x:0,y:0,width:100,height:150}, spreadDx:0,raiseDy:0}));
    window.__mirrorHitProbe = (cx, cy) => ({ stack: {
      ids: cy >= 450 && cy <= 600 && cx >= 350 && cx <= 450 ? ['targetA-card'] :
        cy >= 450 && cy <= 600 && cx >= 500 && cx <= 600 ? ['targetB-card'] : [],
      blocked: false, topStamp: 'other' } });
    window.addEventListener('pointermove', e => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({type:'input',kind:'hover',requestId:'input:'+ ++sequence,coordX:e.clientX,coordY:e.clientY}));
    });
    setInterval(() => unrelated.textContent = performance.now(), 10);
    </script>`);
});
server.on("upgrade", (request, socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = message => {
    if (socket.destroyed) return;
    const bytes = Buffer.from(JSON.stringify(message));
    assert.ok(bytes.length < 65536);
    const header = bytes.length < 126 ? Buffer.from([0x81, bytes.length]) :
      Buffer.from([0x81, 126, bytes.length >>> 8, bytes.length & 255]);
    socket.write(Buffer.concat([header, bytes]));
  };
  const initialFocus = new URL(request.url, 'http://localhost').searchParams.get('initialFocus') === '1';
  setImmediate(() => send({type:'scene-delta',full:true,screenInstanceId:'synthetic',screenType:'combat',
    upserts:[{id:'targetA',zIndex:initialFocus ? 1 : 0},{id:'targetB',zIndex:0}],orderedIds:['targetA','targetB']}));
  let buffered = Buffer.alloc(0);
  socket.on("data", chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      if ((buffered[0] & 15) === 8) { socket.end(); return; }
      const code = buffered[1] & 127;
      if (code === 127) throw new Error("fixture message too large");
      if (code === 126 && buffered.length < 4) return;
      const length = code === 126 ? buffered.readUInt16BE(2) : code;
      const header = code === 126 ? 4 : 2;
      if (buffered.length < header + 4 + length) return;
      const mask = buffered.subarray(header, header + 4);
      const bytes = Buffer.from(buffered.subarray(header + 4, header + 4 + length));
      for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[i % 4];
      buffered = buffered.subarray(header + 4 + length);
      const input = JSON.parse(bytes);
      const target = input.coordY >= 450 ?
        (input.coordX >= 350 && input.coordX <= 450 ? 'targetA' :
          input.coordX >= 500 && input.coordX <= 600 ? 'targetB' : null) : null;
      send({type:'pong'});
      send({type:'scene-delta', upserts:[{id:'other',zIndex:1}]});
      setTimeout(() => {
        for (const id of ['targetA','targetB']) if (id !== target)
          send({type:'scene-delta',upserts:[{id,zIndex:0}]});
        if (target) send({type:'scene-delta',upserts:[{id:target,zIndex:1}]});
      }, 80);
    }
  });
});
const fixturePort = Number(process.env.LATENCY_SYNTHETIC_HTTP_PORT ?? 0);
const fixedCdpPort = Number(process.env.LATENCY_SYNTHETIC_CDP_PORT ?? 0);
const firstReturnOnly = process.argv.includes("--first-return-only");
for (const port of [fixturePort, fixedCdpPort])
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid synthetic test port");
await new Promise(resolve => server.listen(fixturePort, "127.0.0.1", resolve));
const outputs = [];
try {
  if (!firstReturnOnly) {
  for (const stage of ["dom", "canvas"]) {
    const out = await mkdtemp(path.join(tmpdir(), `input-witness-selftest-${stage}-`));
    outputs.push(out);
    const status = await new Promise(resolve => {
      const child = spawn(process.execPath, ["scripts/measure-latency.mjs", "--synthetic-fixture", "--out", out, "--samples", "4", "--idle-ms", "100"],
        { env: { ...process.env, COUCHCOOP_VALIDATE_URL: `http://127.0.0.1:${server.address().port}/?stage=${stage}` }, stdio: "inherit" });
      child.on("exit", resolve);
    });
    const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
    assert.equal(status, 0);
    assert.equal(report.complete, true);
    assert.equal(report.schema, "input-response-latency/3");
    assert.equal(report.browserVersion, "147.0.7727.15");
    assert.equal(report.samples.length, 4);
    assert.ok(report.samples.every(sample => sample.inputToResponseMs >= 75 && sample.valid));
    assert.equal(report.preSampleInputs?.count, 0);
    assert.equal(report.preSampleInputs.inputs.length, report.preSampleInputs.count);
    assert.ok(report.preSampleInputs.inputs.every(input => input.kind === "hover" && input.socketId > 0 && input.socketUrl.endsWith("/ws?watch=1")));
    assert.ok(report.samples.every(sample => sample.inputSocketId === sample.responseSocketId &&
      sample.inputSocketUrl === sample.responseSocketUrl));
    assert.ok(report.samples.every(sample => sample.targetBeforeZIndex === 0 &&
      sample.targetBeforeChannelLive === false));
    assert.ok(report.samples.every(sample => sample.witnessSource === (stage === "dom" ? "dom-style-mutation" : "canvas-webgl-submit")));
    assert.ok(report.samples.every(sample => sample.traceFrameId &&
      sample.traceBeginFrameId.source_id === sample.tracePresentedFrameId.source_id &&
      sample.tracePresentedFrameId.sequence_number >= sample.traceBeginFrameId.sequence_number &&
      sample.inputToPresentedLowerMs <= sample.inputToPresentedMs &&
      sample.inputToPresentedMs <= sample.inputToPresentedUpperMs &&
      sample.presentationClockUncertaintyMs >= 1.2));
    assert.equal(report.metric, "input-to-first-browser-presentation-callback");
    assert.ok(report.decoderStats.maxQueueDepth <= 2 && report.decoderStats.matched === 4);
    assert.equal(report.decoderStats.errors, 0);
    assert.ok(report.decoderStats.submitted >= report.decoderStats.decoded &&
      report.decoderStats.decoded >= report.decoderStats.matched);
    assert.match(report.harnessFiles["scripts/lib/latency-frame-decoder-worker.mjs"], /^[a-f0-9]{64}$/);
    assert.equal(report.firstInput.count, 1);
    assert.equal(report.active.count, 1);
    assert.equal(report.firstAfterIdle.count, 2);
    assert.deepEqual(report.samples.map(sample => sample.population),
      ["first-input", "first-after-idle", "active", "first-after-idle"]);
    assert.ok(report.samples.slice(1).every(sample => Number.isFinite(sample.observedUserIdleGapMs)));
  }
  // The preceding response may be visible while the next hand pose is still marked live.
  // A no-input eligibility wait must recover and leave the measured-seat gap classification intact.
  {
    const out = await mkdtemp(path.join(tmpdir(), "input-witness-selftest-transient-pose-"));
    outputs.push(out);
    const status = await new Promise(resolve => {
      const child = spawn(process.execPath, ["scripts/measure-latency.mjs", "--synthetic-fixture",
        "--out", out, "--samples", "4", "--idle-ms", "100"],
      { env: { ...process.env,
        COUCHCOOP_VALIDATE_URL: `http://127.0.0.1:${server.address().port}/?stage=dom&transientPose` },
        stdio: "inherit" });
      child.on("exit", resolve);
    });
    const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
    assert.equal(status, 0);
    assert.equal(report.complete, true);
    assert.ok(report.samples.every(sample => sample.valid));
    assert.ok(report.targetSelections.some(selection => selection.attempts > 1 &&
      selection.firstMiss?.unsettledCount > 0));
    assert.equal(report.preSampleInputs.count, 0);
  }
  }
  // CDP retries replace the old page before installing instrumentation. Three named pages
  // share a matching prefix while only Seat1's exact URL is safe to use for its reload.
  let cdpPort = fixedCdpPort;
  if (!cdpPort) {
    const portProbe = createServer();
    await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
    cdpPort = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
  }
  if (!firstReturnOnly) {
  const cdpBrowser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
  try {
    const context = await cdpBrowser.newContext({ viewport: { width: 1280, height: 720 } });
    const matchUrlPrefix = `http://127.0.0.1:${server.address().port}/?stage=dom&name=HostPerfSeat`;
    const fixtureUrl = `${matchUrlPrefix}1`;
    const oldPage = await context.newPage();
    await oldPage.goto(fixtureUrl);
    const companionContexts = await Promise.all([2, 3].map(async seat => {
      const companionContext = await cdpBrowser.newContext({ viewport: { width: 1280, height: 720 } });
      await (await companionContext.newPage()).goto(`${matchUrlPrefix}${seat}`);
      return companionContext;
    }));
    const out = await mkdtemp(path.join(tmpdir(), "input-witness-selftest-cdp-fresh-"));
    outputs.push(out);
    const status = await new Promise(resolve => {
      const child = spawn(process.execPath, ["scripts/measure-latency.mjs", "--synthetic-fixture", "--cdp",
        `http://127.0.0.1:${cdpPort}`, "--fresh-page", "--viewport", "1280x720",
        "--match-url-prefix", matchUrlPrefix, "--expected-pages", "3",
        "--out", out, "--samples", "2", "--idle-ms", "100"],
        { env: { ...process.env, COUCHCOOP_VALIDATE_URL: fixtureUrl }, stdio: "inherit" });
      child.on("exit", resolve);
    });
    const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
    assert.equal(status, 0);
    assert.equal(report.complete, true);
    assert.equal(report.freshPage, true);
    assert.equal(report.expectedPages, 3);
    assert.equal(report.matchUrlPrefix, matchUrlPrefix);
    assert.equal(report.pageUrl, fixtureUrl);
    assert.ok(Number.isInteger(report.selectedPageIndex) && report.selectedPageIndex >= 0 && report.selectedPageIndex < 3);
    assert.deepEqual(report.viewport && [report.viewport.innerWidth, report.viewport.innerHeight], [1280, 720]);
    assert.equal(report.preSampleInputs.inputs.length, report.preSampleInputs.count);
    assert.ok(report.samples.every(sample => sample.valid && sample.inputSocketId === sample.responseSocketId));
    await Promise.all(companionContexts.map(companionContext => companionContext.close()));
  } finally {
    await cdpBrowser.close();
  }
  }
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/?stage=dom&name=HostPerfSeat1`;
  for (const scenario of [
      { name: "focused", url: fixtureUrl + "&initialFocus=1", focused: true },
      { name: "neutral", url: fixtureUrl, focused: false },
  ]) {
    const returnBrowser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
    try {
    const context = await returnBrowser.newContext({ viewport: { width: 1280, height: 720 } });
    await (await context.newPage()).goto(scenario.url);
    const returnOut = await mkdtemp(path.join(tmpdir(), "input-witness-selftest-first-return-"));
    outputs.push(returnOut);
    const returnStatus = await new Promise(resolve => {
      const child = spawn(process.execPath, ["scripts/measure-latency.mjs", "--synthetic-fixture", "--cdp",
        `http://127.0.0.1:${cdpPort}`, "--fresh-page", "--viewport", "1280x720",
        "--first-return", ...(scenario.focused ? ["--require-focused-return-setup"] : []),
        "--samples", "1", "--disconnect-ms", "1000", "--out", returnOut],
      { env: { ...process.env, COUCHCOOP_VALIDATE_URL: scenario.url }, stdio: "inherit" });
      child.on("exit", resolve);
    });
    const returned = JSON.parse(await readFile(path.join(returnOut, "report.json"), "utf8"));
    assert.equal(returnStatus, 0);
    assert.equal(returned.complete, true);
    assert.equal(returned.firstReturn, true);
    assert.equal(returned.requireFocusedReturnSetup, scenario.focused);
    assert.equal(returned.returnLifecycle.preDisconnectPark.before.hand.some(h => h.zIndex === 1), scenario.focused);
    assert.equal(returned.returnLifecycle.preDisconnectPark.before.preSampleInputCount, 0);
    assert.equal(returned.returnLifecycle.preDisconnectPark.after.hand.some(h => h.zIndex === 1), false);
    assert.equal(returned.returnLifecycle.preDisconnectPark.after.preSampleInputCount -
      returned.returnLifecycle.preDisconnectPark.before.preSampleInputCount, 1);
    assert.equal(returned.returnLifecycle.preDisconnectPark.after.setupInput.kind, "hover");
    assert.equal(returned.returnLifecycle.stream.preSampleInputCount, 0);
    assert.equal(returned.returnLifecycle.stream.firstFullScene.screenInstanceId, "synthetic");
    assert.ok(returned.samples[0].valid);
    assert.equal(returned.returnLifecycle.immediateInputQualified, true);
    assert.ok(returned.returnLifecycle.handReadyToPreparedMs >= 0 &&
      returned.returnLifecycle.preparedToInputMs >= 0);
    assert.ok(Math.abs(returned.returnLifecycle.handReadyToPreparedMs +
      returned.returnLifecycle.preparedToInputMs - returned.returnLifecycle.handReadyToInputMs) < .01);
    } finally {
      await returnBrowser.close();
    }
  }
  if (!firstReturnOnly) {
  const delayedOut = await mkdtemp(path.join(tmpdir(), "input-witness-selftest-delayed-capture-"));
  outputs.push(delayedOut);
  const delayedStatus = await new Promise(resolve => {
    const child = spawn(process.execPath, ["scripts/measure-latency.mjs", "--synthetic-fixture",
      "--synthetic-ack-delay-ms", "200", "--out", delayedOut, "--samples", "1"],
    { env: { ...process.env, COUCHCOOP_VALIDATE_URL: `http://127.0.0.1:${server.address().port}/?stage=dom` },
      stdio: "inherit" });
    child.on("exit", resolve);
  });
  const delayed = JSON.parse(await readFile(path.join(delayedOut, "report.json"), "utf8"));
  assert.equal(delayedStatus, 0);
  assert.equal(delayed.complete, true);
  assert.equal(delayed.samples.length, 1);
  assert.ok(delayed.samples[0].valid && delayed.samples[0].inputToPresentedUpperMs <
    delayed.samples[0].inputToPngConsumerMs);
  for (const omitted of [1, 3]) {
    const out = await mkdtemp(path.join(tmpdir(), `input-witness-selftest-omit-${omitted}-`));
    outputs.push(out);
    const status = await new Promise(resolve => {
      const child = spawn(process.execPath, ["scripts/measure-latency.mjs", "--synthetic-fixture",
        "--synthetic-omit-first-acks", String(omitted), "--out", out, "--samples", "1"],
      { env: { ...process.env, COUCHCOOP_VALIDATE_URL: `http://127.0.0.1:${server.address().port}/?stage=dom` },
        stdio: "inherit" });
      child.on("exit", resolve);
    });
    const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
    assert.equal(status, omitted === 1 ? 0 : 1);
    assert.equal(report.complete, omitted === 1);
    if (omitted === 1) assert.ok(report.samples[0].valid);
    else assert.equal(report.active, null);
  }
  }
  console.log(`${firstReturnOnly ? "First-return witness" : "Causal DOM+canvas witness"} self-test passed; synthetic artifacts: ${outputs.join(", ")}`);
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
