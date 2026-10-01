#!/usr/bin/env node
// Reprice the three accepted, no-JS-profiler Chrome Dev busy captures.
// All source and capture paths are explicit CLI inputs; reports stay in ignored output.
import {createHash} from 'node:crypto';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,relative,sep,basename} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {markerWindow} from './analyze-phone-canvas-cell.mjs';
import {queryTrace,bootOffsetNs} from './lib/perfetto-frame-timeline.mjs';
import {perfettoSchedCpu} from './lib/perfetto-sched-cpu.mjs';
import {analyzeRendererOfflineAttribution} from './lib/renderer-offline-attribution.mjs';
import {attributeCallbackCpu} from './lib/renderer-callback-attribution.mjs';

const HERE=resolve(fileURLToPath(new URL('.',import.meta.url)),'..');
const PINNED={
  recording:'4a2f42011eeb243125e1a5906eccead7527773a372faec7d958094e872038c22',
  index:'11c0f948d8f98e0949042d38dd8bbc85218e1a0978ca3d4122464d766c578e2f',
  bundle:'a9ec36d91e4235d555dfbeae76c5e130fe59c7791b56403d64755966a071cece',
  map:'99bab12bf49a2562fd8e763d6585ee0fbe389ad6d3e1174d72bb61277838e26e',
  cells:{
    '05_busy_full':{trace:'dd8e5d1cb33644d5e4548f060bc2a69d542ff42b87adfb07d200c04c5b088a80',perfetto:'778c9242815a269cd5c3af437fc5a6ffa5ec10ffe4fa98c65293951990b33b57'},
    '10_busy_full':{trace:'ebced13607e822bab5c63b3d2b084418b9d3729908ca006d9211403d4adab6bd',perfetto:'9aebf6a34a54d87bb1c3d9a9daef9758389a3db496cf0b716de121409a68254b'},
    '19_busy_full':{trace:'74f2cf4fc6b1eb07b2d02c75ceb0b6949ffb236a26a8a51272e60fa54f70741d',perfetto:'2edb87b7806b46472f876b42d88a6501398c813258ca2603465ad0c3b8973433'}
  }
};
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const check=(condition,message)=>{if(!condition)throw Error(message);};
const eq=(a,b,message)=>check(a===b,`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
function options(argv){
  const out={};for(let i=0;i<argv.length;i+=2){
    const key=argv[i],value=argv[i+1];
    if(!key?.startsWith('--')||!value)throw Error(`invalid option ${key}`);
    out[key.slice(2)]=resolve(value);
  }
  for(const key of ['cells-root','frontend','recording','build-receipt','processor','out'])
    if(!out[key])throw Error(`missing --${key}`);
  return out;
}
function verifyBuild(o){
  eq(sha(o.recording),PINNED.recording,'recording SHA-256');
  eq(sha(join(o.frontend,'index.html')),PINNED.index,'scratch index SHA-256');
  eq(sha(join(o.frontend,'app/index-CMXU9K1a.js')),PINNED.bundle,'built entry SHA-256');
  eq(sha(join(o.frontend,'app/index-CMXU9K1a.js.map')),PINNED.map,'source map SHA-256');
  const lines=readFileSync(o['build-receipt'],'utf8').trim().split(/\r?\n/),seen=new Set();
  for(const line of lines){
    const match=/^([0-9a-f]{64})  (.+)$/.exec(line);check(match,'invalid build receipt line');
    const rel=relative(o.frontend,match[2]);
    check(rel&&!rel.startsWith('..'+sep)&&rel!=='..',`build receipt outside scratch frontend: ${match[2]}`);
    check(!seen.has(rel),`duplicate build receipt: ${rel}`);seen.add(rel);
    eq(sha(join(o.frontend,rel)),match[1],`built file ${rel}`);
  }
  eq(seen.size,68,'built file receipt count');
  return {recordingSha256:PINNED.recording,indexSha256:PINNED.index,bundleSha256:PINNED.bundle,
    sourceMapSha256:PINNED.map,builtFileCount:seen.size,receiptSha256:sha(o['build-receipt'])};
}
function stablePids(beforePath,afterPath,pattern){
  const parse=path=>readFileSync(path,'utf8').split(/\r?\n/).flatMap(line=>{
    const match=/^\s*(\d+)\s+\d+\s+(com\.chrome\.dev(?::\S+)?)\s*$/.exec(line);
    return match&&pattern.test(match[2])?[Number(match[1])]:[];
  }).sort((a,b)=>a-b);
  const before=parse(beforePath),after=parse(afterPath);
  check(before.length&&before.join(',')===after.join(','),`unstable process ledger ${pattern}`);
  return before;
}
function sourceMapper(frontend){
  const require=createRequire(join(HERE,'frontend/package.json'));
  const {decode}=require('@jridgewell/sourcemap-codec');
  const cache=new Map();
  return script=>{
    if(!script?.url)return {status:'unproved-empty-url',source:null};
    let path;
    try{path=decodeURIComponent(new URL(script.url).pathname);}catch{return {status:'unresolved-url',source:null};}
    const file=basename(path);
    if(!file.endsWith('.js'))return {status:'non-bundle-script',source:null};
    const mapPath=join(frontend,'app',`${file}.map`);
    if(!existsSync(mapPath))return {status:'unmapped-script',source:null};
    if(!cache.has(mapPath)){
      const map=json(mapPath);check(Array.isArray(map.sources)&&Array.isArray(map.sourcesContent),'source map lacks embedded sources');
      cache.set(mapPath,{map,lines:decode(map.mappings),sha256:sha(mapPath)});
    }
    const {map,lines,sha256}=cache.get(mapPath),line=lines[script.lineNumber];
    if(!line?.length||script.columnNumber===null)return {status:'unmapped-position',mapSha256:sha256,source:null};
    let chosen=null;
    for(const segment of line){if(segment[0]>script.columnNumber)break;if(segment.length>=4)chosen=segment;}
    if(!chosen)return {status:'unmapped-position',mapSha256:sha256,source:null};
    const [,,originalLine,originalColumn,nameIndex]=chosen;
    return {status:'source-mapped',mapSha256:sha256,source:map.sources[chosen[1]],line:originalLine+1,
      column:originalColumn+1,name:nameIndex===undefined?null:map.names[nameIndex]??null};
  };
}
function taskInventory(events,window,rendererPid,mainTid,perTid){
  const workerTids=new Set(perTid.filter(t=>/ThreadPoolForegroundWorker/.test(t.threadName)).map(t=>t.tid));
  const counts=new Map();
  for(const e of events){if(e.pid!==rendererPid||!workerTids.has(e.tid)||!Number.isFinite(e.ts)
    ||e.ts<window.startUs||e.ts>=window.endUs)continue;
    const key=`${e.tid}|${e.ph}|${e.name||'(unnamed)'}`;
    const row=counts.get(key)??{tid:e.tid,phase:e.ph,name:e.name||'(unnamed)',count:0,inclusiveTdurMs:0};
    row.count++;if(e.ph==='X'&&Number.isFinite(e.tdur)&&e.tdur>=0)row.inclusiveTdurMs+=e.tdur/1000;
    counts.set(key,row);
  }
  const starts=new Map(),flows=[];
  for(const e of events){if(e.pid!==rendererPid||!['s','f'].includes(e.ph)||!Number.isFinite(e.ts)
    ||e.ts<window.startUs||e.ts>=window.endUs)continue;
    const key=`${e.cat||''}|${e.name||''}|${String(e.id??e.bind_id??'')}`;
    if(e.ph==='s')starts.set(key,e);
    else if(starts.has(key)){
      const start=starts.get(key);starts.delete(key);
      if(workerTids.has(start.tid)||workerTids.has(e.tid))flows.push({name:e.name,id:String(e.id??e.bind_id??''),
        fromTid:start.tid,toTid:e.tid,fromMain:start.tid===mainTid,toMain:e.tid===mainTid,
        wallMs:+((e.ts-start.ts)/1000).toFixed(3)});
    }
  }
  return {workers:perTid.filter(t=>workerTids.has(t.tid)).map(t=>({...t,
    events:[...counts.values()].filter(x=>x.tid===t.tid).sort((a,b)=>b.count-a.count).slice(0,30)
      .map(x=>({...x,inclusiveTdurMs:+x.inclusiveTdurMs.toFixed(3)}))})),
    explicitFlowPairs:flows,unpairedFlowStarts:starts.size};
}
function cell(o,name,mapSource){
  const dir=join(o['cells-root'],name),pin=PINNED.cells[name];
  const paths={trace:join(dir,'trace.json'),perfetto:join(dir,'frame.pftrace'),traceMeta:join(dir,'trace.json.meta.json'),
    frameMeta:join(dir,'frame.meta.json'),metrics:join(dir,'metrics.json'),result:join(dir,'result.json'),
    before:join(dir,'procs.before.txt'),after:join(dir,'procs.after.txt')};
  eq(sha(paths.trace),pin.trace,`${name} trace SHA-256`);
  eq(sha(paths.perfetto),pin.perfetto,`${name} Perfetto SHA-256`);
  const events=json(paths.trace),traceMeta=json(paths.traceMeta),meta=json(paths.frameMeta),metrics=json(paths.metrics),result=json(paths.result);
  check(Array.isArray(events)&&traceMeta.fullRawEvents===true&&traceMeta.tracingComplete===true
    &&traceMeta.dataLossOccurred===false&&traceMeta.rawEventCount===events.length,`${name} trace loss/completion`);
  eq(traceMeta.scope,'active',`${name} trace scope`);
  eq(meta.artifacts?.trace,paths.trace,`${name} trace artifact receipt`);
  eq(meta.artifacts?.perfettoTrace,paths.perfetto,`${name} Perfetto artifact receipt`);
  eq(meta.artifacts?.result,paths.result,`${name} result artifact receipt`);
  eq(metrics.trace?.path,paths.trace,`${name} accepted trace path`);
  eq(meta.browser?.packageName,'com.chrome.dev',`${name} browser package`);
  eq(metrics.source?.chromeVersion,'156.0.8072.0',`${name} Chrome version`);
  eq(metrics.arm,'full',`${name} arm`);eq(metrics.phase,'busy',`${name} phase`);
  eq(metrics.profiler,null,`${name} JS profiler must be absent`);
  eq(result.recording?.sha256,PINNED.recording,`${name} recording identity`);
  eq(result.window?.startMs,2500,`${name} replay start`);eq(result.window?.endMs,6500,`${name} replay end`);
  eq(result.config?.viewport,'872x349',`${name} viewport`);eq(result.config?.devicePixelRatio,2.8125,`${name} DPR`);
  check(result.config?.pace==='recorded'&&result.config?.effects===false&&result.config?.repeats===1,
    `${name} replay settings`);
  const query=new URL(result.config.url).searchParams;
  for(const [key,value] of Object.entries({quality:'very-low',shaders:'off',particles:'off',stage:'pixi',
    pixiScene:'retained',pixiText:'native',spineMode:'static',staticBg:'1',ccTraceFrames:'1'}))
    eq(query.get(key),value,`${name} query ${key}`);
  check(result.pageErrorCount===0&&result.responseErrors?.length===0&&result.crashedRepeats?.length===0,
    `${name} page/response/crash health`);
  const rendererWindow=result.perRepeat?.[0]?.rendererWindow;
  check(rendererWindow?.before?.instance===rendererWindow?.after?.instance
    &&rendererWindow.before?.ready===true&&rendererWindow.after?.ready===true
    &&rendererWindow.before?.resources?.pending===0&&rendererWindow.after?.resources?.pending===0
    &&rendererWindow.before?.resources?.failed===0&&rendererWindow.after?.resources?.failed===0,
    `${name} renderer/resource readiness`);
  check(Number.isSafeInteger(metrics.completedDraws?.delta)&&metrics.completedDraws.delta>=0
    &&Number.isSafeInteger(metrics.actualPresented?.count),`${name} draw/presentation receipt`);
  const window=markerWindow(events,'active');
  eq(window.startUs,metrics.window.startUs,`${name} start marker`);
  eq(window.endUs,metrics.window.endUs,`${name} end marker`);
  const rendererPid=metrics.cpu?.rendererMain?.thread?.pid,mainTid=metrics.cpu?.rendererMain?.thread?.tid;
  check(Number.isSafeInteger(rendererPid)&&Number.isSafeInteger(mainTid),`${name} renderer PID/TID`);
  const rendererPids=stablePids(paths.before,paths.after,/^com\.chrome\.dev:sandboxed_process/);
  check(rendererPids.includes(rendererPid),`${name} renderer PID absent from ledger`);
  const gpuPids=stablePids(paths.before,paths.after,/^com\.chrome\.dev:privileged_process/);
  check(metrics.cpu?.gpuProcess?.pids?.every(pid=>gpuPids.includes(pid)),`${name} GPU ledger mismatch`);
  const perf=perfettoSchedCpu({processor:o.processor,trace:paths.perfetto,
    chromeStartUs:window.startUs,chromeEndUs:window.endUs,gpuPids:[rendererPid]});
  check(perf?.coverage?.unmappedScheduledThreads===0&&perf.coverage.schedTimeline==='continuous-per-online-cpu',
    `${name} incomplete scheduler coverage`);
  eq(perf.cpuMs,metrics.cpu.rendererProcess.cpuMs,`${name} accepted renderer CPU`);
  const clocks=queryTrace(o.processor,paths.perfetto,"SELECT ts, clock_value AS monotonic FROM clock_snapshot WHERE clock_name='MONOTONIC' ORDER BY ts");
  const offset=bootOffsetNs(clocks);
  eq(offset,metrics.cpu.rendererProcess.clock.bootOffsetNs,`${name} clock offset`);
  const offsets=clocks.map(r=>Number(r.ts)-Number(r.monotonic));
  const spreadNs=Math.max(...offsets)-Math.min(...offsets);
  check(Number.isSafeInteger(spreadNs)&&spreadNs<=1000,`${name} clock spread too large`);
  const from=window.startUs*1000+offset,to=window.endUs*1000+offset;
  const sched=queryTrace(o.processor,paths.perfetto,`SELECT p.pid,t.tid,t.name AS threadName,s.ts,s.dur FROM sched_slice s JOIN thread t USING(utid) JOIN process p USING(upid) WHERE p.pid=${rendererPid} AND s.dur>=0 AND s.ts<${to} AND s.ts+s.dur>${from} ORDER BY t.tid,s.ts`)
    .map(r=>({pid:Number(r.pid),tid:Number(r.tid),threadName:r.threadName||'',ts:Number(r.ts),dur:Number(r.dur)}));
  const all=analyzeRendererOfflineAttribution({events,schedRows:sched,startUs:window.startUs,endUs:window.endUs,
    rendererPid,clockOffsetNs:offset,acceptedCpuNs:Math.round(perf.cpuMs*1e6)});
  const main=attributeCallbackCpu({events,schedRows:sched.filter(s=>s.tid===mainTid),startUs:window.startUs,
    endUs:window.endUs,rendererPid,mainTid,clockOffsetNs:offset});
  const mainAccount=all.perTid.find(t=>t.tid===mainTid);
  check(mainAccount&&Math.abs(mainAccount.schedCpuMs-main.mainSchedCpuMs)<=0.002,`${name} main reconciliation`);
  for(const row of main.callbacks) if(row.script) row.source=mapSource(row.script);
  const workers=taskInventory(events,window,rendererPid,mainTid,all.perTid);
  return {name,window:{startUs:window.startUs,endUs:window.endUs,wallMs:window.windowMs},
    rendererPid,mainTid,
    validation:{traceSha256:pin.trace,perfettoSha256:pin.perfetto,rawEvents:events.length,
      clockOffsetNs:offset,clockSpreadNs:spreadNs,schedCoverage:perf.coverage,
      hashes:Object.fromEntries(Object.entries(paths).filter(([k])=>!['trace','perfetto'].includes(k)).map(([k,v])=>[k,sha(v)]))},
    cpu:{rendererScheduledMs:perf.cpuMs,rendererMainScheduledMs:main.mainSchedCpuMs,
      gpuScheduledMs:metrics.cpu.gpuProcess.cpuMs},
    deliveredUpdates:{scope:'whole replay through 6561 ms, not marker window',
      sceneDeltas:result.perRepeatSceneAckLatency?.[0]?.delivered??null,
      acknowledged:result.perRepeatSceneAckLatency?.[0]?.acked??null},
    completedDraws:metrics.completedDraws.delta,actualPresentations:metrics.actualPresented.count,
    main,workers,perTid:all.perTid,families:all.families,
    residualCpuMs:all.totals.residualCpuMs};
}
const median=xs=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
const range=xs=>({median:median(xs),min:Math.min(...xs),max:Math.max(...xs)});
function report(data){
  const lines=['# Chrome Dev busy callback and worker repricing','',
    'Three pinned full-raw **no-JS-profiler** cells from one Chrome Dev 156 scratch-build server. All CPU values below are Perfetto scheduled CPU; inclusive trace `tdur`, draws, and actual content presentations are separate measures.','',
    `Command: \`${data.command}\`. Input SHA-256 values and validation receipts are in \`callbacks.json\`.`, '',
    '## Accepted cells','',
    '| Cell | Renderer ms | Main ms | Unlabeled ms | Draws | Actual presentations | Whole-replay delivered deltas |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for(const c of data.cells)lines.push(`| ${c.name} | ${c.cpu.rendererScheduledMs} | ${c.cpu.rendererMainScheduledMs} | ${c.residualCpuMs} | ${c.completedDraws} | ${c.actualPresentations} | ${c.deliveredUpdates.sceneDeltas??'unknown'} |`);
  lines.push('',`Renderer scheduled CPU, normalized ms/s: ${JSON.stringify(data.summary.rendererCpuMsPerSec)}. Unlabeled renderer CPU, normalized ms/s: ${JSON.stringify(data.summary.residualCpuMsPerSec)}.`,'',
    '## Main callback ownership','',
    'Callback self CPU excludes nested named work. Enclosed CPU includes it and is not added to family CPU. Script IDs are capture-local; empty-URL identities remain unproved.','');
  for(const c of data.cells){
    lines.push(`### ${c.name}`,'',`Main partition: ${c.main.mainSchedCpuMs} ms = ${c.main.callbackEnclosedCpuMs} callback-enclosed + ${c.main.outsideCpuMs} outside + ${c.main.ambiguousCpuMs} ambiguous (rounding may differ by 0.001 ms).`,'',
      '| Kind | Script / source | Calls | Self CPU ms | Enclosed CPU ms | Nested named CPU |',
      '| --- | --- | ---: | ---: | ---: | --- |');
    for(const row of c.main.callbacks.slice(0,15)){
      const src=row.source?.status==='source-mapped'?`${row.source.source}:${row.source.line}:${row.source.column}`:
        row.script?`${row.source?.status??'unknown'}; script ${row.script.scriptId}, ${row.script.lineNumber}:${row.script.columnNumber}`:'root-only';
      lines.push(`| ${row.kind} | ${src.replaceAll('|','/')} | ${row.count} | ${row.selfCpuMs} | ${row.enclosedCpuMs} | ${JSON.stringify(row.nestedCpuMs).replaceAll('|','/')} |`);
    }
    lines.push('');
  }
  lines.push('## Foreground workers','','Worker rows preserve TID separation. Explicit trace flows are evidence of linked tasks, not an assignment of concurrent worker CPU to a main callback.','',
    `Main-thread unlabeled CPU by cell: ${data.cells.map(c=>{
      const row=c.perTid.find(t=>t.tid===c.mainTid);return `${c.name} ${row?.residualCpuMs??'missing'} ms`;
    }).join('; ')}. Foreground-worker unlabeled CPU by TID (median and observed range): ${JSON.stringify(data.summary.workerResidualByTid.slice(0,5))}.`,'',
    '| Cell | Worker TID | Scheduled ms | Unlabeled ms | Largest trace event names |',
    '| --- | ---: | ---: | ---: | --- |');
  for(const c of data.cells)for(const w of c.workers.workers.sort((a,b)=>b.residualCpuMs-a.residualCpuMs).slice(0,8))
    lines.push(`| ${c.name} | ${w.tid} | ${w.schedCpuMs} | ${w.residualCpuMs} | ${w.events.slice(0,4).map(e=>`${e.name} (${e.phase}:${e.count})`).join(', ').replaceAll('|','/')} |`);
  lines.push('','## Decision','',
    `Identity capture gate: **${data.summary.identityCaptureRequired?'triggered':'not triggered'}**. A dominant empty-URL callback exceeds 10% of renderer-main CPU in ${data.summary.dominantUnknown.filter(x=>x.length).length}/3 cells; its runtime source remains unproved.`,
    `Worker residual gate: **${data.summary.workerResidualPersistent?'persistent':'not persistent'}**. The unlabeled CPU exceeds 10% of renderer process CPU in ${data.cells.filter(c=>c.residualCpuMs/c.cpu.rendererScheduledMs>=0.1).length}/3 cells. Foreground-worker flow events repeatedly name GC tasks, but those asynchronous flows do not assign the unlabeled scheduled slices to GC.`,
    '',
    'The machine-readable `callbacks.json` retains every callback, worker event, flow pair, source-map status, input hash, clock receipt and per-TID reconciliation. Empty-URL callbacks are **unknown** until runtime script bytes are proven. No product operation or removable CPU has been qualified by this offline pass.');
  return lines.join('\n')+'\n';
}
const o=options(process.argv.slice(2));
const build=verifyBuild(o),mapSource=sourceMapper(o.frontend);
const cells=Object.keys(PINNED.cells).map(name=>cell(o,name,mapSource));
const origins=new Set(cells.map(c=>new URL(json(join(o['cells-root'],c.name,'result.json')).config.url).origin));
eq(origins.size,1,'single-server origin');
eq(new Set(cells.map(c=>c.rendererPid)).size,1,'same renderer process across accepted cells');
const dominantUnknown=cells.map(c=>c.main.callbacks.filter(r=>r.script?.url===''&&r.selfCpuMs/c.main.mainSchedCpuMs>=0.1)
  .map(r=>({scriptId:r.script.scriptId,isolate:r.script.isolate,lineNumber:r.script.lineNumber,
    columnNumber:r.script.columnNumber,selfCpuMs:r.selfCpuMs,
    rendererMainPct:+(r.selfCpuMs/c.main.mainSchedCpuMs*100).toFixed(2)})));
const signature=rows=>rows.map(r=>`${r.lineNumber}:${r.columnNumber}`).sort().join(',');
const identityCaptureRequired=dominantUnknown.every(rows=>rows.length>0)&&
  new Set(dominantUnknown.map(signature)).size===1;
const workerResidualPersistent=cells.every(c=>c.residualCpuMs/c.cpu.rendererScheduledMs>=0.1);
const workerTids=[...new Set(cells.flatMap(c=>c.workers.workers.map(w=>w.tid)))].sort((a,b)=>a-b);
const workerResidualByTid=workerTids.map(tid=>({tid,...range(cells.map(c=>c.workers.workers.find(w=>w.tid===tid)?.residualCpuMs??0))}))
  .sort((a,b)=>b.median-a.median);
const data={schema:'renderer-callback-reprice/1',build,command:`node scripts/analyze-renderer-callbacks.mjs ${process.argv.slice(2).join(' ')}`,
  cells,summary:{rendererCpuMsPerSec:range(cells.map(c=>+(c.cpu.rendererScheduledMs/c.window.wallMs*1000).toFixed(3))),
    residualCpuMsPerSec:range(cells.map(c=>+(c.residualCpuMs/c.window.wallMs*1000).toFixed(3))),
    dominantUnknown,identityCaptureRequired,workerResidualPersistent,workerResidualByTid}};
mkdirSync(o.out,{recursive:true});
writeFileSync(join(o.out,'callbacks.json'),JSON.stringify(data,null,2)+'\n');
writeFileSync(join(o.out,'decision.md'),report(data));
console.log(JSON.stringify({out:o.out,cells:cells.map(c=>({name:c.name,rendererMs:c.cpu.rendererScheduledMs,
  mainMs:c.main.mainSchedCpuMs,callbacks:c.main.callbacks.length,workers:c.workers.workers.length}))}));
