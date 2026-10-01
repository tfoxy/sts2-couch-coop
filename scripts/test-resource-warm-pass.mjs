import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./bench-mirror-replay.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function fakeWebSocketInit(config) {');
const end = source.indexOf('\n// ---------------------------------------------------------------------------------------------------------\n// LONG-TASK', start);
assert.ok(start >= 0 && end > start);
const init = source.slice(start, end);
const required = '/res/images/vfx/vfx_attack_slash/vfx_attack_slash_01.png';
// The source recording's envelopes carry no revision; the renderer increments it for each applied delta.
const full = '{"full":true,"screenType":"Combat","screenInstanceId":"one","upserts":[],"removedIds":[],"type":"scene-delta"}';
const delta = '{"full":false,"screenType":"Combat","screenInstanceId":"one","upserts":[],"removedIds":[],"type":"scene-delta"}';
const recording = [{ t: 0, data: full }, { t: 1, data: delta }]
  .map((row) => JSON.stringify(row)).join('\n') + '\n';
if (process.env.COUCHCOOP_WARM_RECORDING) {
  const observed = readFileSync(process.env.COUCHCOOP_WARM_RECORDING,'utf8').split('\n')
    .filter(Boolean).flatMap((line) => { const row = JSON.parse(line);
      return typeof row.data === 'string' && row.data.includes('"type":"scene-delta"')
        ? [JSON.parse(row.data)] : []; });
  assert.ok(observed.length > 2,'the real recording contains a full replay');
  assert.equal(observed.filter((row) => row.full === true).length,1);
  assert.ok(observed.every((row) => row.type === 'scene-delta' && !('revision' in row)),
    'warm revision must be inferred from applied scene order');
  assert.ok(observed.some((row) => JSON.stringify(row).includes('vfx_attack_slash_01')),
    'the required warm texture appears in the recording');
}

async function scenario({ diagnosticClock = false, foreignFetch = false, staleMeasured = false,
  pendingAtRelease = false, watchGate = false, objectPrefetch = false, stalledGate = null,
  traceFlood = false } = {}) {
  let revision = 0, presentEpoch = 0, buildEpoch = 0;
  let pendingSubmission = null;
  const textureCache = new Set(), originalFetches = [], delivered = [];
  const windowObject = {
    __benchSceneAckPending: [], __benchSceneAckLatencies: [],
    __mirrorFrameIdentity: () => ({revision,presentEpoch,buildEpoch}),
    __mirrorSetDiagnosticClock: async () => ({revision,presentEpoch,buildEpoch}),
    __mirrorRendererDiagnostics: () => ({ instance: 7, ready: true, admittedRevision:revision,
      asyncSubmissionRevision:pendingSubmission,asyncAwaitingAckRevision:null,
      resources: { pending: 0, failed: 0 } }),
    fetch: async (url) => {
      originalFetches.push(String(url));
      return String(url).includes('recording') ? { text: async () => recording } : { status: 200 };
    },
  };
  const originalFetch = windowObject.fetch;
  const rustPrefetch = runInNewContext('(function prefetch(url) { return window.fetch(url); })',
    {window:windowObject}, {filename:'/src/mirror/renderer/pixi/createRustDrawListExecutor.ts'});
  const rustObjectPrefetch = runInNewContext('({ prefetch(url) { return window.fetch(url); } })',
    {window:windowObject}, {filename:'/src/mirror/renderer/pixi/createRustDrawListExecutor.ts'});
  const foreignPrefetch = runInNewContext('({ prefetch(url) { return window.fetch(url); } })',
    {window:windowObject}, {filename:'/src/mirror/renderer/pixi/foreignTextureConsumer.ts'});
  const context = { window: windowObject, performance, URL, crypto: webcrypto, TextEncoder,
    location: { href: 'http://127.0.0.1:5351/?stage=rust' },
    setTimeout, EventTarget, Event, MessageEvent, CloseEvent };
  runInNewContext(`(${init})`, context)({ recordingUrl: '/recording', pace: 'recorded',
    synthesizeDirectView: false, diagnosticClock, resourceWarmPass: true,
    resourceWarmTimeoutMs: 60, resourceWarmRequired: [required] });
  const socket = new windowObject.WebSocket(watchGate ? 'ws://local/ws?watch=0' : 'ws://local/ws');
  if (watchGate) setTimeout(() => {
    assert.equal(delivered.length,0,'warm scene waits for direct-view watch');
    socket.send('{"type":"watch","on":true}');
  },20);
  socket.onmessage = (event) => {
    const phase = windowObject.__benchResourceWarmPass?.phase;
    delivered.push({ phase, data: event.data });
    if (event.data === full && phase === 'warm' && !textureCache.has(required)) {
      textureCache.add(required);
      if (traceFlood) for (let index = 0; index < 8200; index++)
        windowObject.__benchWarmAckTrace({kind:'test-event',revision:index});
      if (foreignFetch) void windowObject.fetch(required);
      else if (objectPrefetch) {
        void foreignPrefetch.prefetch('/res/images/foreign.png');
        void rustObjectPrefetch.prefetch(required);
      } else void rustPrefetch(required);
    }
    if (!event.data.includes('"type":"scene-delta"')) return;
    if (staleMeasured && phase === 'measured') return;
    // An ack before the frame identity is current must not admit another warm scene.
    if (event.data === delta && !(phase === 'warm' && stalledGate === 'ack'))
      setTimeout(() => socket.send('{"type":"scene-ack"}'), 0);
    setTimeout(() => {
      if (phase === 'warm' && stalledGate === 'revision' && event.data === delta) return;
      revision++;
      if (!(phase === 'warm' && stalledGate === 'presentation' && event.data === delta)) presentEpoch++;
      buildEpoch++;
    }, 5);
  };
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `timed out: ${windowObject.__benchWsError ?? 'no socket error'}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await waitUntil(() => ['ready','failed'].includes(windowObject.__benchResourceWarmPass?.status));
  if (traceFlood) {
    assert.equal(windowObject.__benchResourceWarmPass.status,'failed');
    assert.match(windowObject.__benchWsError,/warm ack trace ring overflow/);
    assert.equal(windowObject.__benchWarmAckTraceOverflow,8);
    assert.equal(windowObject.__benchResourceWarmPass.ackTraceValid,false);
    const ordered = windowObject.__benchWarmAckTraceSnapshot();
    assert.equal(ordered.length,8192);
    assert.equal(ordered[0].revision,8);
    assert.equal(ordered.at(-1).revision,8199);
    assert.equal(windowObject.__benchDone,undefined);
    return;
  }
  if (stalledGate) {
    const proof = windowObject.__benchResourceWarmPass;
    assert.equal(proof.status,'failed');
    assert.match(proof.failure,/scene 1 revision 2 presentation timed out/);
    assert.equal(proof.sceneDeliveries,2);
    assert.equal(proof.rendererBefore,7);
    assert.equal(proof.lastCompletedGate.messageIndex,0);
    assert.equal(proof.lastCompletedGate.predicates.revision,true);
    const failure = proof.failureSnapshot;
    assert.equal(failure.messageIndex,1);
    assert.equal(failure.recordedTimeMs,1);
    assert.equal(failure.sceneOrdinal,2);
    assert.equal(failure.dataSha256,createHash('sha256').update(delta).digest('hex'));
    assert.equal(failure.dataBytes,new TextEncoder().encode(delta).length);
    assert.equal(failure.expectedRevision,2);
    assert.equal(failure.previousRevision,1);
    assert.equal(failure.previousPresentEpoch,1);
    assert.equal(failure.ackSerialBefore,0);
    assert.equal(failure.clientRevision,null);
    assert.equal(failure.renderer.instance,7);
    assert.equal(failure.renderer.admittedRevision,revision);
    assert.equal(failure.renderer.asyncSubmissionRevision,null);
    assert.equal(failure.socketReadyState,1,'snapshot precedes socket failure');
    assert.equal(failure.predicates[stalledGate === 'presentation' ? 'newerPresentation'
      : stalledGate === 'ack' ? 'postDeliveryAck' : 'revision'],false);
    assert.match(windowObject.__benchWsError,/scene 1 revision 2 presentation timed out/);
    assert.equal(windowObject.__benchDone,undefined);
    return;
  }
  if (foreignFetch) {
    assert.equal(windowObject.__benchResourceWarmPass.status,'failed');
    assert.match(windowObject.__benchWsError,/required renderer resource requests/);
    assert.equal(windowObject.__benchDone,undefined);
    return;
  }
  assert.equal(windowObject.__benchResourceWarmPass.status,'ready',
    `${windowObject.__benchResourceWarmPass.failure}; ${JSON.stringify(windowObject.__benchWarmFetches.map((row) => ({url:row.url,owned:row.rustExecutorOwned,stack:row.initiator?.split('\n').slice(0,4)})))}`);
  assert.equal(windowObject.__benchDone,undefined,'measured replay cannot start before release');
  assert.equal(windowObject.__benchResourceWarmPass.sceneDeliveries,2);
  assert.equal(windowObject.__benchWarmFetchDropped,0);
  if (!objectPrefetch) assert.equal(windowObject.__benchWarmFetches[0].rustExecutorOwned,true);
  if (objectPrefetch) {
    assert.equal(windowObject.__benchWarmFetches.find((row) => row.url === required)?.rustExecutorOwned,true);
    assert.equal(windowObject.__benchWarmFetches.find((row) => row.url === '/res/images/foreign.png')?.rustExecutorOwned,false);
    assert.match(windowObject.__benchWarmFetches.find((row) => row.url === required)?.initiator,
      /at Object\.prefetch/);
  }
  assert.deepEqual(delivered.map((row) => row.phase),['warm','warm']);
  if (pendingAtRelease) pendingSubmission = revision;
  windowObject.__benchResourceWarmRelease();
  if (pendingAtRelease) {
    await waitUntil(() => windowObject.__benchResourceWarmPass.status === 'failed');
    assert.match(windowObject.__benchWsError,/still active at measured release/);
    assert.equal(windowObject.__benchDone,undefined);
    return;
  }
  await waitUntil(() => windowObject.__benchDone === true);
  if (staleMeasured) {
    assert.match(windowObject.__benchWsError,/measured keyframe did not advance warm revision/);
    assert.deepEqual(delivered.map((row) => row.phase),['warm','warm','measured']);
    return;
  }
  assert.deepEqual(delivered.map((row) => row.phase),['warm','warm','measured','measured']);
  assert.equal(windowObject.__benchSceneDeliveries,2,'warm deliveries were reset');
  assert.equal(originalFetches.filter((url) => url === required).length,1,'executor cache retained texture');
  const proof = windowObject.__benchResourceWarmPass;
  assert.equal(proof.status,'released');
  assert.equal(proof.warmFinalRevision,2);
  assert.equal(proof.measuredFirstRevision,3);
  assert.ok(proof.measuredFirstPresentEpoch > proof.warmFinalPresentEpoch);
  assert.ok(proof.measuredFirstBuildEpoch > proof.warmFinalBuildEpoch);
  assert.equal(proof.pendingAckAtRelease,0);
  assert.equal(proof.releaseBaseRevision,2);
  assert.ok(proof.measuredFirstPresentEpoch > proof.releaseBasePresentEpoch);
  assert.equal(proof.fetchRestored,true);
  assert.equal(windowObject.fetch,originalFetch,'stack instrumentation is absent during measurement');
  assert.equal(windowObject.__benchWarmAckTrace,undefined,'trace callback is absent during measurement');
  assert.ok(proof.endEpochMs <= proof.releasedEpochMs);
}

await scenario();
await scenario({diagnosticClock:true});
await scenario({diagnosticClock:true,staleMeasured:true});
await scenario({foreignFetch:true});
await scenario({pendingAtRelease:true});
await scenario({watchGate:true});
await scenario({objectPrefetch:true});
await scenario({stalledGate:'revision'});
await scenario({stalledGate:'presentation'});
await scenario({stalledGate:'ack'});
await scenario({traceFlood:true});
console.log('resource warm pass: revision-bound async ack, diagnostic offset, ownership and reset passed');
