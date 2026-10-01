import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('./bench-mirror-replay.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function fakeWebSocketInit(config) {');
const end = source.indexOf('\n// ---------------------------------------------------------------------------------------------------------\n// LONG-TASK', start);
assert.ok(start >= 0 && end > start);
const init = source.slice(start,end);
const scene = id => JSON.stringify({type:'scene-delta',full:id===0,id});
const messages = [0,20,40,60,80].map((t,id) => ({t,data:scene(id)}));
const recording = messages.map(row => JSON.stringify(row)).join('\n')+'\n';
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

async function scenario({closeDuringGate=false,duplicate=false,bindingNever=false,
  ordering='ack-first'}={}) {
  let revision=0,presentEpoch=0,buildEpoch=0;
  const delivered=[];
  const requests=[];
  const wakes=[];
  const windowObject = {
    __benchResourceWarmPass:{releaseBaseRevision:0},
    __benchSceneAckPending:[],__benchSceneAckLatencies:[],
    __mirrorFrameIdentity:()=>({revision,presentEpoch,buildEpoch}),
    __mirrorRendererDiagnostics:()=>({ready:true,instance:1,frameIdentity:{revision,presentEpoch,buildEpoch},
      asyncSubmissionRevision:null,asyncAwaitingAckRevision:null,resources:{pending:0,failed:0}}),
    fetch:async()=>({text:async()=>recording}),
  };
  windowObject.__benchOrdinalBoundaryRequest=async request=>{
    requests.push({stage:request.stage,at:performance.now(),delivered:delivered.length});
    if(request.stage==='failed') return {stage:'failed'};
    if(request.stage==='open'){
      assert.ok(wakes.some(row=>row.id===0&&row.kind==='ack'));
      assert.ok(wakes.some(row=>row.id===0&&row.kind==='commit'));
      assert.equal(windowObject.__benchSceneAckPending.length,0,'prior scene has no outstanding ACK');
      await delay(25);
      windowObject.__benchWs._ordinalShiftClock();
      windowObject.__benchSceneDeliveries=0;
      windowObject.__benchSceneAckPending.length=0;
      windowObject.__benchWindowMark=1;
      windowObject.__benchWindowAt.startedAt=performance.now();
      windowObject.__benchWindowAt.startStreamMs=performance.now()-windowObject.__benchWs._recordedStartMs;
    }else{
      assert.equal(delivered.length,3,'next scene stays held until close marker');
      assert.ok(wakes.some(row=>row.id===2&&row.kind==='ack'));
      assert.ok(wakes.some(row=>row.id===2&&row.kind==='commit'));
      if(bindingNever) return new Promise(()=>{});
      await delay(25);
      windowObject.__benchWs._ordinalShiftClock();
      windowObject.__benchWindowMark=2;
      windowObject.__benchWindowAt.endedAt=performance.now();
      windowObject.__benchWindowAt.endStreamMs=performance.now()-windowObject.__benchWs._recordedStartMs;
    }
    return {stage:request.stage,expectedRevision:request.expectedRevision,messageIndex:request.messageIndex};
  };
  const context={window:windowObject,performance,URL,location:{href:'http://localhost/'},
    setTimeout:(fn,ms)=>setTimeout(fn,bindingNever&&ms===10_000?100:ms),
    clearTimeout,EventTarget,Event,MessageEvent,CloseEvent};
  runInNewContext(`(${init})`,context)({recordingUrl:'/recording',pace:'recorded',resourceWarmPass:false,
    synthesizeDirectView:false,window:{startMs:10,endMs:50},
    ordinalWindow:{firstIndex:1,lastIndex:2,sceneCount:2,recordingSha256:'a'.repeat(64),
      selectedDataJsonSha256:'d'.repeat(64),
      boundaryRows:[0,1,2,3].map(messageIndex => ({messageIndex,
        recordedMs:messageIndex,dataUtf8Sha256:'b'.repeat(64)})),nonSceneIndices:[]}});
  const socket=new windowObject.WebSocket('ws://local/ws');
  socket.onmessage=event=>{
    const id=JSON.parse(event.data).id;
    delivered.push({id,at:performance.now()});
    const slow=id===0?35:id===2?45:1;
    const fast=id===0?20:id===2?20:1;
    const ackAt=ordering==='ack-first'?fast:slow;
    const commitAt=ordering==='ack-first'?slow:fast;
    setTimeout(()=>{
      revision++;presentEpoch++;buildEpoch++;
      wakes.push({id,kind:'commit'});
      windowObject.__benchStartupCommittedPresentation({sceneRevision:revision,presented:true,
        frameIdentity:{revision,presentEpoch,buildEpoch}});
    },commitAt);
    setTimeout(()=>{
      wakes.push({id,kind:'ack'});
      socket.send('{"type":"scene-ack"}');
    },ackAt);
  };
  const wait=async predicate=>{const until=Date.now()+2000;while(!predicate()){
    assert.ok(Date.now()<until,windowObject.__benchWsError??'timed out');await delay(5);
  }};
  if(closeDuringGate){
    await wait(()=>socket._ordinalState.stage==='opening');
    socket.close();
    await wait(()=>socket._ordinalState.failure!==null);
    assert.match(socket._ordinalState.failure,/closed|canceled/);
    assert.deepEqual(delivered.map(row=>row.id),[0]);
    return;
  }
  if(bindingNever){
    await wait(()=>windowObject.__benchWsError!==undefined);
    assert.match(windowObject.__benchWsError,/ordinal close handshake timed out/);
    assert.deepEqual(delivered.map(row=>row.id),[0,1,2],
      'a timed-out Node binding never resumes the next recorded scene');
    assert.equal(windowObject.__benchWindowMark,1);
    return;
  }
  await wait(()=>windowObject.__benchDone===true);
  assert.deepEqual(delivered.map(row=>row.id),[0,1,2,3,4]);
  assert.deepEqual(requests.filter(row=>row.stage!=='failed').map(row=>row.stage),['open','close']);
  assert.equal(requests[0].delivered,1);
  assert.equal(requests[1].delivered,3);
  assert.equal(socket._ordinalState.stage,'closed');
  assert.equal(socket._ordinalState.requests,2);
  assert.ok(socket._ordinalState.startPauseMs>=25);
  assert.ok(socket._ordinalState.endPauseMs>=25);
  assert.ok(delivered[3].at-requests[1].at>=20,'next scene cannot catch up inside close handshake');
  assert.equal(windowObject.__benchWsError,undefined);
  if(duplicate) await assert.rejects(socket._ordinalBoundary('open',revision,null,-1),/duplicate, stale/);
}

test('index boundary waits for prior and final presentation and ACK, then resumes without catch-up',async()=>{
  await scenario({duplicate:true,ordering:'ack-first'});
  await scenario({ordering:'commit-first'});
});
test('socket cancellation fails an outstanding ordinal boundary closed',async()=>{
  await scenario({closeDuringGate:true});
});
test('unresolved Node close binding times out without delivering the next scene',async()=>{
  await scenario({bindingNever:true});
});
