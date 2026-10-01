import test from 'node:test';
import assert from 'node:assert/strict';
import {attributeCallbackCpu} from './renderer-callback-attribution.mjs';

const x=(name,ts,dur,extra={})=>({ph:'X',pid:7,tid:11,name,ts,dur,...extra});
const sched=(ts,dur,tid=11)=>({pid:7,tid,ts:ts*1000,dur:dur*1000});
const base={startUs:0,endUs:10000,rendererPid:7,mainTid:11,clockOffsetNs:0};
const analyze=(events,rows=[sched(0,10000)])=>attributeCallbackCpu({...base,events,schedRows:rows});

test('nested animation callback and GC reconcile without assigning nested CPU twice',()=>{
  const script={isolate:'i',scriptId:'16',url:'',lineNumber:19,columnNumber:9};
  const result=analyze([
    x('FireAnimationFrame',1000,4000),x('FunctionCall',1500,3000,{args:{data:script}}),
    x('MinorGC',2000,500),x('TimerFire',6000,2000),
    x('FunctionCall',6200,1600,{args:{data:{...script,scriptId:'5',url:'https://example.test/app.js'}}}),
    x('Decode Image',1000,4000,{tid:12}) // concurrent worker event cannot own main CPU
  ]);
  assert.equal(result.mainSchedCpuMs,10);
  assert.equal(result.callbackEnclosedCpuMs,6);
  assert.equal(result.outsideCpuMs,4);
  const unknown=result.callbacks.find(r=>r.script?.scriptId==='16');
  assert.equal(unknown.kind,'animation-frame');
  assert.equal(unknown.count,1);
  assert.equal(unknown.selfCpuMs,2.5);
  assert.equal(unknown.enclosedCpuMs,3);
  assert.equal(unknown.nestedCpuMs['V8 GC'],0.5);
  assert.equal(unknown.script.url,'');
  assert.equal(result.callbacks.find(r=>r.key==='root:animation-frame').selfCpuMs,1);
  assert.equal(result.callbacks.find(r=>r.key==='root:timer').selfCpuMs,0.4);
});

test('message callback, scheduler gaps and nonzero clock offset use exact intersections',()=>{
  const result=attributeCallbackCpu({...base,clockOffsetNs:5000,
    events:[x('EventDispatch',1000,6000),x('FunctionCall',1500,4000,{args:{data:{scriptId:'2',url:'https://example.test/app.js'}}})],
    schedRows:[{pid:7,tid:11,ts:5000,dur:4000000},{pid:7,tid:11,ts:5005000,dur:5000000}]});
  assert.equal(result.mainSchedCpuMs,9);
  assert.equal(result.callbackEnclosedCpuMs,5);
  assert.equal(result.outsideCpuMs,4);
  assert.equal(result.callbacks.find(r=>r.script?.scriptId==='2').kind,'message');
});

test('crossing FunctionCall intervals stay ambiguous',()=>{
  const result=analyze([x('FunctionCall',1000,3000,{args:{data:{scriptId:'1'}}}),
    x('FunctionCall',3000,3000,{args:{data:{scriptId:'2'}}})]);
  assert.equal(result.ambiguousCpuMs,1);
  assert.equal(result.outsideCpuMs,5);
});

test('rejects invalid clock, PID/TID and overlapping scheduler rows',()=>{
  assert.throws(()=>attributeCallbackCpu({...base,clockOffsetNs:NaN,events:[],schedRows:[]}),/clock\/PID/);
  assert.throws(()=>analyze([], [sched(0,1000,12)]),/PID\/TID/);
  assert.throws(()=>analyze([], [sched(0,6000),sched(5000,5000)]),/overlapping main sched/);
  assert.throws(()=>attributeCallbackCpu({...base,events:[],schedRows:[sched(0,10000)],acceptedMainCpuNs:1}),/CPU mismatch/);
});
