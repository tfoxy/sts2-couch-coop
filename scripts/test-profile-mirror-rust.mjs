import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receipt, validate, validateSpeedReceipt, validateCpuOutputReceipt, markerCpuInterval, conservativeCpuSaving, duplicateProcessDisagreements, compareCpuOutputCells, validateTraceOnlyDiagnostic, validateVisualOnlyDiagnostic, cpuAttribution, validateV8Deltas, bindEvidence, servedArtifactMatches, visualOracleServedArtifactsMatch, hitGridMatches, hitGridSemanticHash, imagePixelDifference, postCaptureServerProof, qualifiedSamples, servedResourceHashes, verifyRustMarks, replayMessageDigest, procIntervalCpuMetric, comparableEnvironment, comparableProductionOutput } from './profile-mirror-rust.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseExtraChromeArgs } from './lib/chrome-args.mjs';
import { emitBenchResult } from './lib/bench-result-file.mjs';
import { buildUntracedReport } from './lib/untraced-report.mjs';
const gswRoot = process.env.COUCHCOOP_GSW_ROOT ?? '../godot-scene-web';
test('ordinary comparison requires the same delivered revisions, resources, hits, and visual oracle', () => {
  const make = () => ({resourceDelivery:{count:122,sha256:'resources'},output:{valid:true,
    hit:{equal:true,semanticSha256:'hits'},visualOracle:{valid:true,imageSha256:'pixels'},
    production:{valid:true,window:{startMs:12000,endMs:19000},
      delivery:{before:0,after:291,index:678,count:717},
      deliveryTiming:{rows:716,dropped:0,inWindow:291,firstIndex:387,lastIndex:677},
      frame:{before:{revision:386},after:{revision:677}},sceneAckLatency:{count:291}}}});
  const a = make(), b = make();
  assert.equal(comparableProductionOutput(a,b),true);
  b.output.production.sceneAckLatency.count++;
  assert.equal(comparableProductionOutput(a,b),true);
  b.output.production.delivery.after++;
  assert.equal(comparableProductionOutput(a,b),false);
  b.output.production.delivery.after--;
  b.output.visualOracle.imageSha256 = 'changed';
  assert.equal(comparableProductionOutput(a,b),false);
  b.output.visualOracle.imageSha256 = 'pixels';
  a.resourceDelivery.phases = {warm:{count:1,sha256:'warm'},measured:{count:1,sha256:'measured'}};
  b.resourceDelivery.phases = {warm:{count:1,sha256:'warm'},measured:{count:1,sha256:'measured'}};
  assert.equal(comparableProductionOutput(a,b),true);
  b.resourceDelivery.phases.measured.sha256 = 'shifted';
  assert.equal(comparableProductionOutput(a,b),false,
    'the same total requests cannot hide a request moving between warm and measured phases');
  b.output.production.window.endMs = 18500;
  assert.equal(comparableProductionOutput(a,b),false);
  b.output.production.window.endMs = 19000;
  b.resourceDelivery.sha256 = 'changed';
  assert.equal(comparableProductionOutput(a,b),false);
});
test('visual oracle binds transformed served glue and serializer bytes, including post-capture fetch', () => {
  const proof = {served:{glue:{servedSha256:'transformed-glue'},
    serializer:{servedSha256:'transformed-serializer'}},
  servedAfter:{glue:{servedSha256:'transformed-glue'},
    serializer:{servedSha256:'transformed-serializer'}}};
  assert.equal(visualOracleServedArtifactsMatch(proof,structuredClone(proof)),true);
  const changed = structuredClone(proof);
  changed.served.serializer.servedSha256 = 'other-transformation';
  assert.equal(visualOracleServedArtifactsMatch(proof,changed),false);
  changed.served.serializer.servedSha256 = 'transformed-serializer';
  changed.servedAfter.glue.servedSha256 = 'drifted';
  assert.equal(visualOracleServedArtifactsMatch(proof,changed),false);
});
const base = () => {
  const hash = Object.fromEntries(['source','wasm','glue','input','resources','imageReference'].map(k => [k, 'a'.repeat(64)]));
  const config = { gswRoot, recording: 'fixture.ndjson' };
  const result = receipt(config,'run',hash,hash,{ perRepeat: [{ rendererWindow: { after: { effective: { canvasProfile:
    { rendererInstanceId: '1', droppedEvents: 0, events: [] } } } } }], window: { start: 1, end: 2 },
    processIdentity: [{pid: 1,tid: 1,startIdentity:'123',role:'renderer'}],
    clockMappings: [{from:'performance.timeOrigin+now',to:'monotonic',offsetUs:0,uncertaintyUs:1}],
    presentationEvidence: {source:'compositor',count:2}, hitEvidence: {equal:true} },[],[]);
  result.receipt.output.witness = [true];
  result.receipt.effective.backend = 'rust';
  result.receipt.processes = [{pid:1,tid:1,startIdentity:'123',role:'renderer',
    threadStartBefore:'123',threadStartAfter:'123',processStartBefore:'123',processStartAfter:'123'}];
  result.receipt.clocks = [{from:'performance.timeOrigin+now',to:'monotonic',offsetUs:0,uncertaintyUs:1}];
  result.receipt.markers = {begin:1,end:2,rust:{count:4,unjoined:0,unbalanced:0,
    phases:['admit','upload','encode-submit','resume']}};
  result.receipt.workload.valid = true;
  result.receipt.output.valid = true;
  result.receipt.output.hit = {equal:true};
  result.receipt.output.image = {equal:true,differentPixels:0};
  result.receipt.presentations = {source:'compositor',count:2};
  result.receipt.losses.trace = 0;
  result.receipt.workload.observed = [{ready:true,pending:0,failed:0,witness:{sampleHits:1,sampleCount:1}}];
  result.receipt.output.observed = result.receipt.workload.observed;
  result.receipt.serverProof = {schema:'canvas-profile-server/1',gswRoot:resolve(gswRoot),served:Object.fromEntries(
    ['wasm','glue','serializer'].map(name => [name,{matches:true,servedSha256:'a',sourcePath:name}])),
    servedAfter:Object.fromEntries(['wasm','glue','serializer'].map(name => [name,{matches:true,servedSha256:'a'}])),
    wasmSha256:hash.wasm,glueSha256:hash.glue};
  return result;
};
test('canonical validation rejects missing markers, process identity, loss, hash drift, and displayed without evidence', async () => {
  const one = base(); assert.deepEqual(await validate(one.receipt,one.events,gswRoot),[]);
  one.receipt.markers.begin = null; assert.match((await validate(one.receipt,one.events,gswRoot)).join(),/marker/);
  const two = base(); two.receipt.processes[0].startIdentity = ''; assert.match((await validate(two.receipt,two.events,gswRoot)).join(),/PID/);
  const three = base(); three.receipt.losses.collector = 1; assert.match((await validate(three.receipt,three.events,gswRoot)).join(),/lost/);
  const four = base(); four.receipt.hashes.wasm.after = 'b'.repeat(64); assert.match((await validate(four.receipt,four.events,gswRoot)).join(),/drift/);
  const five = base(); five.receipt.presentations.count = null; five.receipt.presentations.reason = 'unavailable';
  five.events.push({schema:'canvas-profile/1',runId:'run',rendererInstanceId:'1',operationId:1,kind:'full-build',
    eventType:'outcome',clockDomain:'performance.timeOrigin+now',timestampUs:'100',outcome:'displayed'});
  assert.match((await validate(five.receipt,five.events,gswRoot)).join(),/displayed/);
  const six = base(); six.receipt.output.valid = false;
  assert.match((await validate(six.receipt,six.events,gswRoot)).join(),/output mismatch/);
  const seven = base(); seven.receipt.gpu.disjoint = true;
  assert.match((await validate(seven.receipt,seven.events,gswRoot)).join(),/disjoint GPU/);
  const eight = base(); eight.receipt.losses.trace = null;
  assert.match((await validate(eight.receipt,eight.events,gswRoot)).join(),/trace loss status unavailable/);
  const nine = base(); nine.receipt.serverProof.served.wasm.matches = false;
  assert.match((await validate(nine.receipt,nine.events,gswRoot)).join(),/served artifact bytes/);
  const ten = base(); delete ten.receipt.serverProof;
  assert.match((await validate(ten.receipt,ten.events,gswRoot)).join(),/server proof unavailable/);
});
test('zero and negative V8 deltas cannot become timed attribution', () => {
  const make = timeDeltas => ({ startTime:1,endTime:100,samples:[1,2],timeDeltas });
  assert.equal(validateV8Deltas(make([2,3])).timedAttribution,true);
  assert.equal(validateV8Deltas(make([0,3])).timedAttribution,false);
  assert.equal(validateV8Deltas(make([-1,3])).timedAttribution,false);
});
test('trace-only diagnostics report absent phase hooks without inventing a Rust mark failure', () => {
  const r = base().receipt;
  r.profiler = {chromeTraceEnabled:true,phaseHooksEnabled:false};
  assert.deepEqual(validateTraceOnlyDiagnostic(r,[]),
    ['trace-only diagnostic has no Rust phase hooks and cannot qualify a speed claim']);
  r.losses.trace = null;
  r.output.valid = false;
  assert.match(validateTraceOnlyDiagnostic(r,[]).join(),/Chrome trace loss/);
  assert.match(validateTraceOnlyDiagnostic(r,[]).join(),/pinned image/);
});
test('visual-only diagnostics report their missing clock and presentation evidence directly', () => {
  const r = base().receipt;
  r.effective.config.captureMode = 'visual';
  r.profiler = {chromeTraceEnabled:false,phaseHooksEnabled:false};
  r.markers = {begin:null,end:null,rust:null};
  r.presentations.count = null;
  assert.deepEqual(validateVisualOnlyDiagnostic(r,[]), [
    'visual-only diagnostic has no direct trace markers and cannot qualify a speed claim',
    'actual content presentations unavailable']);
  r.output.valid = false;
  assert.match(validateVisualOnlyDiagnostic(r,[]).join(),/pinned image/);
});
test('unresolved sample bucket conserves each thread denominator', () => {
  const result = cpuAttribution([{tid:3,symbol:'foo'},{tid:3,symbol:'[unknown]'},{tid:4,symbol:null},{tid:5,symbol:null}],
    [{tid:3,role:'main'},{tid:4,role:'worker'}]);
  assert.equal(result.total,4); assert.equal(result.unresolved,3);
  assert.deepEqual(result.byThread.map(x => x.namedLeafSamples+x.unresolvedSamples),[2,1,1]);
});
test('sidecars must bind run and raw benchmark identity', () => {
  const r = base().receipt;
  assert.throws(() => bindEvidence(r,{schema:'canvas-profile-evidence/1',runId:'other',benchmarkSha256:'a'},'a','/tmp'),/not bound/);
  assert.throws(() => bindEvidence(r,{schema:'canvas-profile-evidence/1',runId:r.runId,benchmarkSha256:'wrong'},'a','/tmp'),/not bound/);
  assert.throws(() => bindEvidence(r,{schema:'canvas-profile-evidence/1',runId:r.runId,benchmarkSha256:'a',
    markers:{begin:9,end:10}},'a','/tmp'),/marker identity/);
  assert.throws(() => bindEvidence(r,{schema:'canvas-profile-evidence/1',runId:r.runId,benchmarkSha256:'a',
    presentations:{source:'display',count:2}},'a','/tmp'),/requires its own hashed artifact/);
});
test('matching hash on arbitrary files does not prove workload, output, or display', () => {
  const dir = mkdtempSync(join(tmpdir(),'canvas-profile-test-'));
  try {
    const r = base().receipt, content = '{}', path = join(dir,'fake.json');
    writeFileSync(path,content);
    const artifacts = [{path:'fake.json',sha256:createHash('sha256').update(content).digest('hex')}];
    const common = {schema:'canvas-profile-evidence/1',runId:r.runId,benchmarkSha256:'a',artifacts};
    assert.throws(() => bindEvidence(r,{...common,workload:{valid:true,artifact:'fake.json'}},'a',dir),/workload delivery proof/);
    assert.throws(() => bindEvidence(r,{...common,output:{valid:true,imageArtifact:'fake.json',hitArtifact:'fake.json'}},'a',dir),/output fidelity proof/);
    assert.throws(() => bindEvidence(r,{...common,presentations:{source:'DRM pageflip',count:1,artifact:'fake.json'}},'a',dir),/display-layer proof/);
    assert.throws(() => bindEvidence(r,{...common,losses:{trace:0}},'a',dir),/cannot be replaced/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('served artifact bytes must match pinned local SHA-256', () => {
  const bytes = Buffer.from('pinned');
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(servedArtifactMatches(bytes,hash).matches,true);
  assert.equal(servedArtifactMatches(Buffer.from('different'),hash).matches,false);
});
test('post-capture server failure is a diagnostic proof, not an exception', async () => {
  const proof = {served:Object.fromEntries(['wasm','glue','serializer'].map(name => [name,{localSha256:'a'.repeat(64)}]))};
  const config = {url:'http://127.0.0.1:5339',wasmUrl:'/wasm',rustModuleUrl:'/glue',sceneSerializerUrl:'/serializer'};
  const updated = await postCaptureServerProof(proof,config,async url => {
    if (url.pathname === '/glue') throw new Error('server exited');
    return {ok:true,arrayBuffer:async () => Uint8Array.of(1,2,3).buffer};
  });
  assert.equal(updated.servedAfter.wasm.matches,false);
  assert.match(updated.servedAfter.glue.reason,/server exited/);
  assert.equal(updated.servedAfter.glue.servedSha256,null);
  assert.ok(updated.servedAfter.serializer.servedSha256);
  const diagnostic = base(); diagnostic.receipt.serverProof = {...diagnostic.receipt.serverProof,...updated};
  assert.match((await validate(diagnostic.receipt,diagnostic.events,gswRoot)).join(),/served artifact bytes/);
});
test('post-capture proof retries one transient server failure', async () => {
  const bytes = Buffer.from('pinned'), hash = createHash('sha256').update(bytes).digest('hex');
  const proof = {served:Object.fromEntries(['wasm','glue','serializer'].map(name => [name,{localSha256:hash}]))};
  const config = {url:'http://127.0.0.1:5339',wasmUrl:'/wasm',rustModuleUrl:'/glue',sceneSerializerUrl:'/serializer'};
  let wasmAttempts = 0;
  const updated = await postCaptureServerProof(proof,config,async url => {
    if (url.pathname === '/wasm' && ++wasmAttempts === 1) throw new Error('transient');
    return {ok:true,arrayBuffer:async () => bytes};
  });
  assert.equal(updated.servedAfter.wasm.matches,true);
  assert.equal(updated.servedAfter.wasm.attempts,2);
  assert.equal(updated.servedAfter.glue.attempts,1);
});
test('Rust mark verifier joins exact GSW tuple and direct trace window', async () => {
  const id = {runId:'run',rendererInstanceId:'mount',operationId:1};
  const mark = (edge,ts) => ({name:'TimeStamp',pid:7,tid:8,ts,
    args:{data:{message:`canvas-profile/1:${JSON.stringify({...id,phase:'rust.upload',edge})}`}}});
  const trace = [{name:'TimeStamp',pid:7,tid:8,ts:1,args:{data:{message:'cc-report-start'}}},
    mark('start',2),mark('end',3),
    {name:'TimeStamp',pid:7,tid:8,ts:4,args:{data:{message:'cc-report-end'}}}];
  trace.unshift(mark('start',0),mark('end',0.5));
  assert.deepEqual(await verifyRustMarks(trace,[id],gswRoot),
    {count:2,foreign:0,unjoined:0,unbalanced:0,phases:['upload']});
  trace[4].tid = 9;
  assert.equal((await verifyRustMarks(trace,[id],gswRoot)).unjoined,1);
  await assert.rejects(verifyRustMarks(trace.slice(3),[id],gswRoot),/direct Rust mark window/);
});
test('recording digest pins delivered data bytes, excluding outbound entries', () => {
  const dir = mkdtempSync(join(tmpdir(),'canvas-replay-test-'));
  try {
    const path = join(dir,'repro.ndjson');
    writeFileSync(path,JSON.stringify({meta:{schema:'repro/1'}})+'\n'+
      JSON.stringify({t:1,data:'one'})+'\n'+JSON.stringify({dir:'out',t:2,data:'ignored'})+'\n');
    assert.deepEqual(replayMessageDigest(path),{count:1,
      sha256:createHash('sha256').update(JSON.stringify([{t:1,data:'one'}])).digest('hex')});
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('bench result survives stdout failure and V8 Chrome switches stay one argument', () => {
  const dir = mkdtempSync(join(tmpdir(),'canvas-bench-result-test-'));
  try {
    const path = join(dir,'result.json'), payload = {schema:'raw-bench/1',large:'x'.repeat(200_000)};
    assert.throws(() => emitBenchResult(payload,path,() => { throw new Error('stdout closed'); }),/stdout closed/);
    assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),payload);
    assert.deepEqual(parseExtraChromeArgs({COUCHCOOP_BENCH_CHROME_ARGS_JSON:
      JSON.stringify(['--js-flags=--perf-prof --interpreted-frames-native-stack','--use-angle=vulkan'])}),
    ['--js-flags=--perf-prof --interpreted-frames-native-stack','--use-angle=vulkan']);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('untraced report records CPU and output without fabricating a trace artifact', () => {
  const accepted = [{geometry:{fitScale:1},presented:{sampleHits:1,sampleCount:1,screenshot:'shot.png'}}];
  const report = buildUntracedReport({accepted,failures:[],recordingSha256:'a'.repeat(64),
    window:{startMs:12_000,endMs:19_000},browser:'143',result:{perRepeat:[{
      processIdentity:[{pid:7,processCpuMs:4}],pageMarkerClock:{beginEpochUs:1,endEpochUs:2}}]}});
  assert.equal(report.schema,'couchcoop-untraced-report/1');
  assert.equal(report.trace,null);
  assert.equal(report.processCpu[0].processIdentity[0].processCpuMs,4);
  assert.equal(report.repeats[0].outputWitness.sampleHits,1);
  assert.throws(() => buildUntracedReport({accepted:[],result:{}}),/accepted/);
});
test('speed qualification requires untraced process CPU and physical content presentations', () => {
  const dir = mkdtempSync(join(tmpdir(),'canvas-visual-oracle-test-'));
  writeFileSync(join(dir,'receipt.json'),'{}');
  writeFileSync(join(dir,'benchmark.json'),'{}');
  const r = base().receipt;
  r.effective.config.captureMode = 'speed';
  r.profiler = {chromeTraceEnabled:false,phaseHooksEnabled:false,chromeArgs:[],procCpuBracketsEnabled:true,
    procClockTicksPerSecond:100};
  r.browser = {version:'143.0.0',mode:'launched',binarySha256:'b'.repeat(64),pid:3,startIdentity:'789'};
  r.hostIdentity = {platform:'linux',arch:'x64',kernelRelease:'6.1',cpuModel:'test',logicalCpus:8,
    nvidiaDriver:{version:'1.2'}};
  r.resourceDelivery = {count:2,sha256:'a'.repeat(64)};
  r.benchmarkStatus = {exitCode:0,parseFailure:null,rejectedRepeats:0,crashedRepeats:0};
  r.processes[0].processCpuMs = 12;
  r.processes[0].sampleBeforeEpochUs = 0; r.processes[0].sampleAfterEpochUs = 3;
  r.processes[0].sampleClockUncertaintyUs = 0.1;
  r.processes[0].procClockTicksPerSecond = 100;
  r.processes.push({pid:2,tid:2,role:'GPU/untraced',startIdentity:'456',processStartBefore:'456',
    processStartAfter:'456',processCpuMs:4,sampleBeforeEpochUs:0,sampleAfterEpochUs:3,
    sampleClockUncertaintyUs:0.1,procClockTicksPerSecond:100});
  r.processes.push({pid:3,tid:3,role:'browser/untraced',startIdentity:'789',processStartBefore:'789',
    processStartAfter:'789',processCpuMs:1,sampleBeforeEpochUs:0,sampleAfterEpochUs:3,
    sampleClockUncertaintyUs:0.1,procClockTicksPerSecond:100});
  r.metrics.rendererCpuMs = procIntervalCpuMetric(r.processes,'renderer',1,2);
  r.metrics.gpuProcessCpuMs = procIntervalCpuMetric(r.processes,'gpu',1,2);
  r.output.production = {valid:true};
  r.output.visualOracle = {valid:true,run:dir,
    receiptSha256:createHash('sha256').update('{}').digest('hex'),
    benchmarkSha256:createHash('sha256').update('{}').digest('hex')};
  assert.deepEqual(validateSpeedReceipt(r,[]),[]);
  r.processCpuResidual = [{threadOvercountMs:200,roundingUncertaintyMs:100}];
  assert.match(validateSpeedReceipt(r,[]).join(),/thread CPU counters do not reconcile/);
  r.processCpuResidual = [{threadOvercountMs:20,roundingUncertaintyMs:100}];
  assert.deepEqual(validateSpeedReceipt(r,[]),[]);
  assert.equal(r.metrics.rendererCpuMs.coverage,null);
  assert.equal(r.metrics.rendererCpuMs.scoreWindow,'proc-sample-interval');
  r.metrics.rendererCpuMs.sampleIntervals[0].beforeOverhangMs = 99;
  assert.match(validateSpeedReceipt(r,[]).join(),/sample-interval provenance/);
  r.metrics.rendererCpuMs = procIntervalCpuMetric(r.processes,'renderer',1,2);
  r.profiler.chromeTraceEnabled = true;
  assert.match(validateSpeedReceipt(r,[]).join(),/traced/);
  r.profiler.chromeTraceEnabled = false;
  r.processes[1].processStartAfter = 'reused';
  assert.match(validateSpeedReceipt(r,[]).join(),/PID start identity/);
  r.processes[1].processStartAfter = '456';
  r.presentations.count = null;
  assert.match(validateSpeedReceipt(r,[]).join(),/physical presentations/);
  rmSync(dir,{recursive:true,force:true});
});
test('comparison rejects changed browser or host kernel, CPU, and driver identity', () => {
  const a = {browser:{version:'147',mode:'launched',binarySha256:'a'.repeat(64)},
    hostIdentity:{platform:'linux',arch:'x64',kernelRelease:'6.1',cpuModel:'CPU',logicalCpus:8,
      nvidiaDriver:{version:'595'}}};
  const b = structuredClone(a);
  assert.deepEqual(comparableEnvironment(a,b),[]);
  b.browser.version = '148';
  assert.match(comparableEnvironment(a,b).join(),/browser/);
  b.browser.version = '147'; b.browser.binarySha256 = 'b'.repeat(64);
  assert.match(comparableEnvironment(a,b).join(),/browser/);
  b.browser.binarySha256 = a.browser.binarySha256; b.hostIdentity.kernelRelease = '6.2';
  assert.match(comparableEnvironment(a,b).join(),/host/);
  b.hostIdentity.kernelRelease = '6.1'; b.hostIdentity.nvidiaDriver.version = '596';
  assert.match(comparableEnvironment(a,b).join(),/driver/);
  delete b.hostIdentity.cpuModel;
  assert.match(comparableEnvironment(a,b).join(),/CPU/);
});
test('proc CPU score exposes before/after overhang and jiffy uncertainty', () => {
  const row = {pid:7,role:'renderer/untraced',processCpuMs:4700,processStartBefore:'100',
    processStartAfter:'100',sampleBeforeEpochUs:1000,sampleAfterEpochUs:8000,
    sampleClockUncertaintyUs:500,procClockTicksPerSecond:100};
  const metric = procIntervalCpuMetric([row],'renderer',4000,6000);
  assert.equal(metric.value,4700);
  assert.equal(metric.sampleIntervals[0].beforeOverhangMs,3);
  assert.equal(metric.sampleIntervals[0].afterOverhangMs,2);
  assert.equal(metric.sampleIntervals[0].jiffyUncertaintyMs,20);
  assert.equal(metric.coverage,null);
  assert.equal(procIntervalCpuMetric([{...row,processStartAfter:'reused'}],'renderer',4000,6000),null);
});
test('marker CPU interval bounds read and marker calls on one Node monotonic clock', () => {
  const calls = {openStartMs:100,openEndMs:101,closeStartMs:109,closeEndMs:110};
  const row = {pid:7,tid:7,processCpuMs:80,cpuMs:40,procClockTicksPerSecond:100,
    processStartBefore:'p',processStartAfter:'p',threadStartBefore:'t',threadStartAfter:'t',
    processReadBeforeStartMs:98,processReadBeforeEndMs:99,
    processReadAfterStartMs:111,processReadAfterEndMs:112,
    threadReadBeforeStartMs:98,threadReadBeforeEndMs:99,
    threadReadAfterStartMs:111,threadReadAfterEndMs:112};
  const markers = {begin:12000000,end:19000000,nodeCalls:calls};
  const process = markerCpuInterval(row,markers,4);
  assert.equal(process.overhangMs,6);
  assert.equal(process.lowerMs,36);
  assert.equal(process.upperMs,100);
  const thread = markerCpuInterval(row,markers,4,true);
  assert.equal(thread.lowerMs,14);
  assert.equal(thread.upperMs,60);
  assert.equal(markerCpuInterval({...row,processReadBeforeEndMs:101},markers,4),null);
  assert.equal(markerCpuInterval({...row,processReadAfterStartMs:109},markers,4),null);
  assert.equal(markerCpuInterval({...row,processStartAfter:'reused'},markers,4),null);
  assert.equal(markerCpuInterval({...row,processReadBeforeStartMs:null},markers,4),null);
  assert.equal(markerCpuInterval(row,{...markers,nodeCalls:null},4),null);
});
test('CPU/output comparison does not turn missing presentation into display FPS', () => {
  const result = compareCpuOutputCells([]);
  assert.equal(result.comparable,false);
  assert.equal(result.saving,null);
  assert.equal(result.physicalPresentations,null);
  assert.equal(result.framesPerSecond,null);
  assert.equal(result.gpuExecutionMs,null);
  assert.match(result.failures.join(),/cell count/);
  assert.equal(typeof validateCpuOutputReceipt,'function');
});
test('warm-resource CPU/output cells require the transition and raw phase evidence', () => {
  const r = base().receipt;
  r.effective.config.captureMode = 'speed';
  r.effective.config.benchArgs = ['--resource-warm-pass'];
  const failures = validateCpuOutputReceipt(r,[],{perRepeat:[{}]});
  assert.match(failures.join(),/warm-resource preparation, same renderer, or phase request ledger unavailable/);
});
test('conservative CPU saving must exceed full control interval spread once', () => {
  const controls = [{lowerMs:90,upperMs:100},{lowerMs:95,upperMs:105},
    {lowerMs:92,upperMs:101}];
  const close = conservativeCpuSaving(controls,[{lowerMs:70,upperMs:74},
    {lowerMs:73,upperMs:75}]);
  assert.equal(close.spreadMs,15);
  assert.equal(close.savingMs,15);
  assert.equal(close.exceedsSpread,false);
  const clear = conservativeCpuSaving(controls,[{lowerMs:60,upperMs:70},
    {lowerMs:65,upperMs:72}]);
  assert.equal(clear.savingMs,18);
  assert.equal(clear.exceedsSpread,true);
  assert.equal(conservativeCpuSaving(controls,[{lowerMs:1,upperMs:2}]),null);
});
test('repeated process rows require identical CPU evidence before PID deduplication', () => {
  const one = {pid:17,role:'renderer/untraced',processStartBefore:'a',processStartAfter:'a',
    processCpuTicksBefore:10,processCpuTicksAfter:20,processCpuMs:100,
    processReadBeforeStartMs:1,processReadBeforeEndMs:2,
    processReadAfterStartMs:10,processReadAfterEndMs:11,procClockTicksPerSecond:100};
  assert.deepEqual(duplicateProcessDisagreements([one,{...one,tid:18}]),[]);
  assert.match(duplicateProcessDisagreements([one,{...one,tid:18,processCpuTicksAfter:21}]).join(),/PID 17/);
  assert.match(duplicateProcessDisagreements([one,{...one,tid:18,processReadAfterEndMs:12}]).join(),/PID 17/);
});
test('hit equality requires the same pinned sampled rows', () => {
  const header = '# recording=r\n# viewport=703x281\n# stageBox=703x281\n# step=96\n# samples=1\n';
  const one = `${header}P 1,1 top=a depth=1 blocked=- painter=a map=- confirm=- cover=- stack=a\n`;
  const two = `${header}P 1,1 top=b depth=1 blocked=- painter=b map=- confirm=- cover=- stack=b\n`;
  assert.equal(hitGridMatches(one,one),true);
  assert.equal(hitGridMatches(one,two),false);
  assert.equal(hitGridMatches(one,one.replace('painter=a','painter=?')),true);
  const emptyOne = `${header}P 1,1 top=- depth=0 blocked=false painter=? map=- confirm=- cover=- stack=-\n`;
  const emptyTwo = emptyOne.replace('painter=?','painter=null');
  assert.equal(hitGridMatches(emptyOne,emptyTwo),true);
  assert.equal(hitGridSemanticHash(emptyOne),hitGridSemanticHash(emptyTwo));
  assert.equal(hitGridMatches(emptyOne,emptyTwo.replace('blocked=false','blocked=true')),false);
});
test('receipt retains first-party hit proof when painter provenance is unknown', () => {
  const dir = mkdtempSync(join(tmpdir(),'canvas-hit-receipt-test-'));
  try {
    const header = '# recording=r\n# viewport=703x281\n# stageBox=703x281\n# step=96\n# samples=1\n';
    const grid = `${header}P 1,1 top=a depth=1 blocked=false painter=? map=- confirm=- cover=- stack=a\n`;
    const reference = join(dir,'reference.txt'), candidate = join(dir,'hit-grid.txt');
    writeFileSync(reference,grid.replace('painter=?','painter=a'));
    writeFileSync(candidate,grid);
    const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    const config = {captureOut:dir,hitReferencePath:reference,hitReferenceSha256:hash(reference)};
    const result = receipt(config,'run',{source:'a'}, {source:'a'},
      {perRepeat:[{rendererWindow:{after:{}}}]},[],[{path:'hit-grid.txt',sha256:hash(candidate)}]);
    assert.equal(result.receipt.output.hit.equal,true);
    assert.equal(result.receipt.output.hit.unknownPainterSamples,1);
    assert.equal(result.receipt.output.image.equal,false);
    writeFileSync(candidate,grid.replace('top=a','top=b'));
    const changed = receipt(config,'run',{source:'a'}, {source:'a'},
      {perRepeat:[{rendererWindow:{after:{}}}]},[],[{path:'hit-grid.txt',sha256:hash(candidate)}]);
    assert.equal(changed.receipt.output.hit.equal,false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('pixel output proof requires a pinned file and an exact decoded-pixel count', () => {
  const dir = mkdtempSync(join(tmpdir(),'canvas-pixel-test-'));
  try {
    const a = join(dir,'a.png'), b = join(dir,'b.png');
    writeFileSync(a,'candidate'); writeFileSync(b,'reference');
    assert.deepEqual(imagePixelDifference(a,b,() => ({status:0,stderr:'0'})),
      {differentPixels:0,reason:null});
    assert.equal(imagePixelDifference(a,b,() => ({status:1,stderr:'9'})).differentPixels,9);
    assert.equal(imagePixelDifference(a,b,() => ({status:2,stderr:'bad'})).differentPixels,null);
    assert.equal(imagePixelDifference(a,join(dir,'missing'),() => { throw Error('must not run'); }).differentPixels,null);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('symbol samples require a hashed artifact and live PID/TID marker identity', () => {
  const dir = mkdtempSync(join(tmpdir(),'canvas-sample-test-'));
  try {
    const r = base().receipt;
    const value = {schema:'canvas-profile-samples/1',runId:r.runId,samples:[
      {pid:1,tid:1,processStartIdentity:'123',timestampUs:1.5,category:'native',symbol:'draw'}]};
    const content = JSON.stringify(value), path = join(dir,'samples.json');
    writeFileSync(path,content);
    assert.match(qualifiedSamples(r,dir).failures.join(),/artifact/);
    r.artifacts = [{path:'samples.json',sha256:createHash('sha256').update(content).digest('hex')}];
    assert.equal(qualifiedSamples(r,dir).samples.length,1);
    value.samples[0].tid = 99;
    const changed = JSON.stringify(value); writeFileSync(path,changed);
    r.artifacts[0].sha256 = createHash('sha256').update(changed).digest('hex');
    assert.match(qualifiedSamples(r,dir).failures.join(),/PID\/TID/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('served resource identity binds delivered bytes and detects later drift', () => {
  const dir = mkdtempSync(join(tmpdir(),'canvas-resource-test-'));
  try {
    const asset = join(dir,'asset.txt'), other = join(dir,'other.txt'), manifest = join(dir,'served.ndjson');
    writeFileSync(asset,'one');
    writeFileSync(other,'two');
    const digest = createHash('sha256').update('one').digest('hex');
    const rows = [{url:'/res/asset.txt',source:'recovered',path:asset,size:3,sha256:digest,complete:true},
      {url:'/res/other.txt',source:'recovered',path:other,size:3,
        sha256:createHash('sha256').update('two').digest('hex'),complete:true}];
    writeFileSync(manifest,rows.map(JSON.stringify).join('\n')+'\n');
    const first = servedResourceHashes(manifest,'a','a');
    assert.equal(first.before,first.after);
    assert.equal(first.count,2);
    writeFileSync(manifest,rows.reverse().map(JSON.stringify).join('\n')+'\n');
    const reordered = servedResourceHashes(manifest,'a','a');
    assert.equal(reordered.before,first.before);
    writeFileSync(manifest,rows.map((row,index) => JSON.stringify({...row,
      phase:index === 0 ? 'warm' : 'measured',requestStartNodeNs:'1',bodyReadyNodeNs:'2'})).join('\n')+'\n');
    const phased = servedResourceHashes(manifest,'a','a');
    assert.equal(phased.phases.warm.count,1);
    assert.equal(phased.phases.measured.count,1);
    assert.equal(phased.before,first.before,'timing and phase labels do not change canonical byte identity');
    writeFileSync(asset,'new');
    const second = servedResourceHashes(manifest,'a','a');
    assert.notEqual(second.before,second.after);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('physical presentations require matching first-party raw trace events', () => {
  const dir = mkdtempSync(join(tmpdir(),'canvas-display-test-'));
  try {
    const r = base().receipt;
    r.markers.begin = 10_000; r.markers.end = 20_000;
    const hash = text => createHash('sha256').update(text).digest('hex');
    const display = {schema:'canvas-physical-presentations/1',runId:r.runId,rawArtifact:'physical.json',
      markerBegin:10_000,markerEnd:20_000,source:'DRM pageflip',pid:99,processStartIdentity:'ext-123',
      layerId:'layer-1',frames:[{contentId:'frame-1',displayId:'display-1',layerId:'layer-1',timestampUs:15_000}]};
    const raw = {schema:'canvas-physical-trace/1',runId:r.runId,producer:'DRM pageflip',
      clockDomain:'drm-monotonic',processes:[{pid:99,role:'compositor',startBefore:'ext-123',startAfter:'ext-123'}],
      dataLossOccurred:false,lostEvents:0,traceEvents:[
      {name:'ProfileClockSync',ts:10_000,pid:99,tid:101,args:{runId:r.runId,edge:'begin',uncertaintyUs:100}},
      {name:'ActualContentPresentation',cat:'drm.pageflip',ph:'i',ts:15_000,
        pid:99,tid:101,args:{contentId:'frame-1',displayId:'display-1',layerId:'layer-1'}},
      {name:'ProfileClockSync',ts:20_000,pid:99,tid:101,args:{runId:r.runId,edge:'end',uncertaintyUs:100}}]};
    const rawText = JSON.stringify(raw), displayText = JSON.stringify(display);
    writeFileSync(join(dir,'physical.json'),rawText);
    writeFileSync(join(dir,'display.json'),displayText);
    r.artifacts = [];
    const evidence = {schema:'canvas-profile-evidence/1',runId:r.runId,benchmarkSha256:'bench',
      artifacts:[{path:'display.json',sha256:hash(displayText)},{path:'physical.json',sha256:hash(rawText)}],
      presentations:{source:'DRM pageflip',count:1,artifact:'display.json'}};
    const bound = bindEvidence(r,evidence,'bench',dir);
    assert.equal(bound.presentations.count,1);
    assert.equal(bound.metrics.actualPresentations.value,1);
    assert.equal(bound.clocks.at(-1).uncertaintyUs,1000);
    assert.equal(bound.clocks.at(-1).from,'drm-monotonic');
    raw.traceEvents[1].ts = 10_500;
    display.frames[0].timestampUs = 10_500;
    writeFileSync(join(dir,'physical.json'),JSON.stringify(raw));
    writeFileSync(join(dir,'display.json'),JSON.stringify(display));
    evidence.artifacts[0].sha256 = hash(JSON.stringify(display));
    evidence.artifacts[1].sha256 = hash(JSON.stringify(raw));
    assert.throws(() => bindEvidence(r,evidence,'bench',dir),/not independently present/);
    raw.traceEvents[1].ts = 15_000; display.frames[0].timestampUs = 15_000;
    writeFileSync(join(dir,'physical.json'),JSON.stringify(raw));
    writeFileSync(join(dir,'display.json'),JSON.stringify(display));
    evidence.artifacts[0].sha256 = hash(JSON.stringify(display));
    evidence.artifacts[1].sha256 = hash(JSON.stringify(raw));
    raw.processes[0].startAfter = 'reused';
    writeFileSync(join(dir,'physical.json'),JSON.stringify(raw));
    evidence.artifacts[1].sha256 = hash(JSON.stringify(raw));
    assert.throws(() => bindEvidence(r,evidence,'bench',dir),/external compositor PID/);
    raw.processes[0].startAfter = 'ext-123';
    writeFileSync(join(dir,'physical.json'),JSON.stringify(raw));
    evidence.artifacts[1].sha256 = hash(JSON.stringify(raw));
    raw.dataLossOccurred = true;
    writeFileSync(join(dir,'physical.json'),JSON.stringify(raw));
    evidence.artifacts[1].sha256 = hash(JSON.stringify(raw));
    assert.throws(() => bindEvidence(r,evidence,'bench',dir),/separately captured raw trace/);
    raw.dataLossOccurred = false;
    raw.traceEvents[1].args.contentId = 'forged';
    writeFileSync(join(dir,'physical.json'),JSON.stringify(raw));
    assert.throws(() => bindEvidence(r,evidence,'bench',dir),/artifact missing or hash mismatch/);
    evidence.artifacts[1].sha256 = hash(JSON.stringify(raw));
    assert.throws(() => bindEvidence(r,evidence,'bench',dir),/not independently present/);
    raw.traceEvents[1].args.contentId = 'frame-1';
    raw.traceEvents[2].ts = 10_000;
    writeFileSync(join(dir,'physical.json'),JSON.stringify(raw));
    evidence.artifacts[1].sha256 = hash(JSON.stringify(raw));
    assert.throws(() => bindEvidence(r,evidence,'bench',dir),/clock or process identity/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
