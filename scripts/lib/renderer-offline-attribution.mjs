// Offline attribution of Chrome X spans against Perfetto sched slices. All times
// in the accounting core are integer nanoseconds; tdur remains inclusive evidence.
const ms = ns => +(ns / 1e6).toFixed(3);
const ns = us => Math.round(us * 1000);
export const familyOf = name => {
  if (/^V8\.GC_|^MinorGC$|^MajorGC$|^V8\.GC|^ComputeWeaknessProcessor|^ClearWeaknessProcessor|^Parallel scavenge/.test(name)) return 'V8 GC';
  if (/Decode Image|ImageDecode|image decode/i.test(name)) return 'Image decode';
  if (/Raster|Tile|DisplayItemList|PictureLayer/.test(name)) return 'Raster and tiles';
  if (/Scheduler|AnimationHost|BeginImplFrame|LayerTreeHostImpl|ProxyImpl|Commit/.test(name)) return 'Compositor';
  if (/FunctionCall|EvaluateScript|FireAnimationFrame|TimerFire|v8\.execute/i.test(name)) return 'Script callbacks';
  if (/Layout|Paint|PrePaint|Layerize|UpdateLayer/.test(name)) return 'Layout and paint';
  return 'Other named';
};
const validTdur = x => Number.isFinite(x) && x >= 0;
const overlap = (a,b,c,d) => Math.max(0, Math.min(b,d)-Math.max(a,c));
const add = (map,key,initial) => { if (!map.has(key)) map.set(key,initial()); return map.get(key); };
const sorted = m => [...m.values()].sort((a,b)=>b.cpuNs-a.cpuNs || String(a.name).localeCompare(String(b.name)));
function cpuIn(slices,a,b) {
  let total=0;
  for(const s of slices){ if(s.ts>=b) break; if(s.ts+s.dur<=a) continue; total+=overlap(a,b,s.ts,s.ts+s.dur); }
  return total;
}
function unionLength(intervals) {
  let total=0, end=-Infinity;
  for(const [a,b] of intervals.sort((x,y)=>x[0]-y[0]||x[1]-y[1])) { total+=Math.max(0,b-Math.max(a,end)); end=Math.max(end,b); }
  return total;
}
// Exported separately for synthetic clipping, nesting and overlap fixtures.
export function partitionTidEvents(events,{startUs,endUs}) {
  if (!Number.isSafeInteger(startUs)||!Number.isSafeInteger(endUs)||endUs<=startUs) throw Error('invalid marker interval');
  const start=ns(startUs), end=ns(endUs), spans=[], points=new Set([start,end]);
  for(const e of events){
    if(e.ph!=='X'||!Number.isFinite(e.ts)||!Number.isFinite(e.dur)||e.dur<0) continue;
    const rawStart=ns(e.ts),rawEnd=ns(e.ts+e.dur),a=Math.max(start,rawStart),b=Math.min(end,rawEnd);
    if(b<=a) continue;
    spans.push({name:e.name||'(unnamed)',family:familyOf(e.name||''),tid:e.tid,startNs:a,endNs:b,
      rawStartNs:rawStart,rawEndNs:rawEnd,clipped:a!==rawStart||b!==rawEnd,
      tdurNs:validTdur(e.tdur)?ns(e.tdur):null,args:e.args??{},category:e.cat??''});
    points.add(a);points.add(b);
  }
  const ticks=[...points].sort((a,b)=>a-b), segments=[];
  for(let i=1;i<ticks.length;i++){
    const a=ticks[i-1],b=ticks[i]; if(a===b) continue;
    const active=spans.filter(s=>s.startNs<=a&&s.endNs>=b);
    if(!active.length) continue;
    // A strictly nested stack has a unique deepest span. Crossing intervals,
    // or equal-sized spans with different names, cannot be assigned exclusively.
    const deepest=active.filter(s=>!active.some(t=>t!==s&&t.startNs>=s.startNs&&t.endNs<=s.endNs
      &&(t.startNs>s.startNs||t.endNs<s.endNs)));
    let label='Ambiguous overlap';
    if(deepest.length===1) {
      const d=deepest[0];
      if(active.every(s=>s===d||(s.startNs<=d.startNs&&s.endNs>=d.endNs))) label=d.family;
    } else if(deepest.length>1&&new Set(deepest.map(x=>x.name)).size===1) label=deepest[0].family;
    const previous=segments.at(-1);
    if(previous?.endNs===a&&previous.family===label) previous.endNs=b;
    else segments.push({startNs:a,endNs:b,family:label});
  }
  return {spans,segments};
}

export function summarizeGcEpochs(events,{startUs,endUs,rendererPid,mainTid}) {
  const wanted=new Set(['MinorGC','V8.GC_SCAVENGER','V8.GC_SCAVENGER_BACKGROUND_SCAVENGE_PARALLEL','V8.GC_MC_BACKGROUND_MARKING']);
  const xs=events.filter(e=>e.ph==='X'&&e.pid===rendererPid&&wanted.has(e.name)
    &&Number.isFinite(e.ts)&&Number.isFinite(e.dur)&&e.dur>0&&e.ts>=startUs&&e.ts+e.dur<=endUs);
  const minor=xs.filter(e=>e.name==='MinorGC'&&e.tid===mainTid);
  const main=xs.filter(e=>e.name==='V8.GC_SCAVENGER'&&e.tid===mainTid);
  const background=xs.filter(e=>e.name==='V8.GC_SCAVENGER_BACKGROUND_SCAVENGE_PARALLEL');
  const marking=xs.filter(e=>e.name==='V8.GC_MC_BACKGROUND_MARKING');
  const epoch=e=>Number.isSafeInteger(e.args?.epoch)?e.args.epoch:null;
  const epochs=[...new Set(main.map(epoch).filter(x=>x!==null))].sort((a,b)=>a-b);
  const epochRows=epochs.map(id=>({epoch:id,mainScavengerSpans:main.filter(e=>epoch(e)===id).length,
    backgroundParallelSpans:background.filter(e=>epoch(e)===id).length,
    backgroundTids:[...new Set(background.filter(e=>epoch(e)===id).map(e=>e.tid))].sort((a,b)=>a-b),
    backgroundMarkingSpans:marking.filter(e=>epoch(e)===id).length}));
  const mainNestedInMinor=main.filter(e=>minor.some(m=>m.ts<=e.ts&&m.ts+m.dur>=e.ts+e.dur)).length;
  return {minorGcMainSpans:minor.length,mainScavengerSpans:main.length,mainScavengerNestedInMinor:mainNestedInMinor,
    epochCount:epochs.length,epochMin:epochs[0]??null,epochMax:epochs.at(-1)??null,
    backgroundParallelSpans:background.length,backgroundParallelTids:[...new Set(background.map(e=>e.tid))].sort((a,b)=>a-b),
    backgroundParallelMatchedEpochs:epochs.filter(id=>background.some(e=>epoch(e)===id)).length,
    backgroundMarkingSpans:marking.length,backgroundMarkingEpochs:[...new Set(marking.map(epoch).filter(x=>x!==null))].sort((a,b)=>a-b),
    epochs:epochRows};
}

export function analyzeRendererOfflineAttribution({events,schedRows,startUs,endUs,rendererPid,clockOffsetNs,acceptedCpuNs}) {
  if(!Number.isSafeInteger(rendererPid)||!Number.isSafeInteger(clockOffsetNs)) throw Error('invalid PID/clock ledger');
  const from=ns(startUs)+clockOffsetNs,to=ns(endUs)+clockOffsetNs;
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<=from) throw Error('invalid clock conversion');
  const bySched=new Map();
  for(const s of schedRows){
    if(s.pid!==rendererPid||!Number.isSafeInteger(s.tid)||!Number.isSafeInteger(s.ts)||!Number.isSafeInteger(s.dur)||s.dur<0) throw Error('invalid renderer sched mapping');
    add(bySched,s.tid,()=>[]).push(s);
  }
  for(const rows of bySched.values()) rows.sort((a,b)=>a.ts-b.ts);
  const names=new Map(), families=new Map(), overlaps=new Map(), hierarchy=new Map(), perTid=[], tdurComparisons=[];
  let processSchedNs=0;
  const threadNames=new Map(events.filter(e=>e.ph==='M'&&e.name==='thread_name'&&e.pid===rendererPid).map(e=>[e.tid,e.args?.name]));
  const byTrace=new Map();
  for(const e of events){ if(e.ph!=='X'||e.pid!==rendererPid) continue;
    if(!Number.isFinite(e.ts)||!Number.isFinite(e.dur)||e.dur<0) continue;
    if(e.ts>=endUs||e.ts+e.dur<=startUs) continue;
    add(byTrace,e.tid,()=>[]).push(e);
  }
  const tids=new Set([...bySched.keys(),...byTrace.keys()]);
  for(const tid of [...tids].sort((a,b)=>a-b)){
    const sched=bySched.get(tid)||[], {spans,segments}=partitionTidEvents(byTrace.get(tid)||[],{startUs,endUs});
    if(spans.length&&!sched.length) throw Error(`trace TID ${tid} has no Perfetto sched mapping`);
    const totalNs=cpuIn(sched,from,to), byFamily=new Map(); processSchedNs+=totalNs;
    for(const s of spans) if(!s.clipped&&s.tdurNs!==null&&spans.every(t=>t===s||overlap(s.startNs,s.endNs,t.startNs,t.endNs)===0)) {
      const scheduledNs=cpuIn(sched,s.startNs+clockOffsetNs,s.endNs+clockOffsetNs);
      if(scheduledNs>=1_000_000) tdurComparisons.push({tid,name:s.name,tdurMs:ms(s.tdurNs),scheduledCpuMs:ms(scheduledNs),differencePct:+(Math.abs(s.tdurNs-scheduledNs)/scheduledNs*100).toFixed(2)});
    }
    for(const s of spans){
      const row=add(names,s.name,()=>({name:s.name,family:s.family,count:0,complete:0,clipped:0,missingTdur:0,inclusiveTdurNs:0,clippedTdurEstimateNs:0,tidSet:new Set(),intervalsByTid:new Map(),examples:[]}));
      row.count++;row[s.clipped?'clipped':'complete']++;row.tidSet.add(tid);
      add(row.intervalsByTid,tid,()=>[]).push([s.startNs,s.endNs]);
      if(s.tdurNs===null) row.missingTdur++;
      else if(s.clipped) row.clippedTdurEstimateNs+=s.tdurNs*(s.endNs-s.startNs)/(s.rawEndNs-s.rawStartNs);
      else row.inclusiveTdurNs+=s.tdurNs;
      row.examples.push({tid,startUs:s.rawStartNs/1000,durUs:(s.rawEndNs-s.rawStartNs)/1000,tdurUs:s.tdurNs===null?null:s.tdurNs/1000,clipped:s.clipped,args:s.args});
      row.examples.sort((a,b)=>b.durUs-a.durUs);if(row.examples.length>5)row.examples.pop();
      const f=add(families,s.family,()=>({name:s.family,count:0,complete:0,clipped:0,missingTdur:0,inclusiveTdurNs:0,clippedTdurEstimateNs:0,tidSet:new Set(),intervalsByTid:new Map(),cpuNs:0}));
      f.count++;f[s.clipped?'clipped':'complete']++;f.tidSet.add(tid);add(f.intervalsByTid,tid,()=>[]).push([s.startNs,s.endNs]);
      if(s.tdurNs===null) f.missingTdur++;else if(s.clipped) f.clippedTdurEstimateNs+=s.tdurNs*(s.endNs-s.startNs)/(s.rawEndNs-s.rawStartNs);else f.inclusiveTdurNs+=s.tdurNs;
    }
    for(const child of spans){
      const parents=spans.filter(parent=>parent!==child&&parent.startNs<=child.startNs&&parent.endNs>=child.endNs
        &&(parent.startNs<child.startNs||parent.endNs>child.endNs));
      parents.sort((a,b)=>(a.endNs-a.startNs)-(b.endNs-b.startNs));
      if(parents.length){const key=`${parents[0].name} → ${child.name}`;hierarchy.set(key,(hierarchy.get(key)||0)+1);}
    }
    const familyIntervals=new Map();
    for(const s of spans)add(familyIntervals,s.family,()=>[]).push([s.startNs,s.endNs]);
    const merged=[...familyIntervals].map(([name,intervals])=>{
      const out=[];
      for(const [a,b] of intervals.sort((x,y)=>x[0]-y[0]||x[1]-y[1])){
        if(out.length&&a<=out.at(-1)[1])out.at(-1)[1]=Math.max(out.at(-1)[1],b);
        else out.push([a,b]);
      }
      return [name,out];
    });
    for(let i=0;i<merged.length;i++)for(let j=i+1;j<merged.length;j++){
      const [left,a]=merged[i],[right,b]=merged[j];let p=0,q=0,n=0;
      while(p<a.length&&q<b.length){n+=overlap(a[p][0],a[p][1],b[q][0],b[q][1]);if(a[p][1]<=b[q][1])p++;else q++;}
      if(n){const key=[left,right].sort().join(' / ');overlaps.set(key,(overlaps.get(key)||0)+n);}
    }
    let assignedNs=0;
    for(const seg of segments){const cpuNs=cpuIn(sched,seg.startNs+clockOffsetNs,seg.endNs+clockOffsetNs);assignedNs+=cpuNs;
      const f=add(families,seg.family,()=>({name:seg.family,count:0,complete:0,clipped:0,missingTdur:0,inclusiveTdurNs:0,clippedTdurEstimateNs:0,tidSet:new Set(),intervalsByTid:new Map(),cpuNs:0})); f.cpuNs+=cpuNs;f.tidSet.add(tid);
      byFamily.set(seg.family,(byFamily.get(seg.family)||0)+cpuNs);
    }
    if(assignedNs>totalNs) throw Error(`TID ${tid} partition exceeds sched CPU`);
    const residualNs=totalNs-assignedNs;
    const residualLabel=/ProfEvntProc/i.test(threadNames.get(tid)||sched[0]?.threadName||'')?'JS profiler worker (likely capture overhead)':'Residual/unlabeled';
    add(families,residualLabel,()=>({name:residualLabel,count:0,complete:0,clipped:0,missingTdur:0,inclusiveTdurNs:0,clippedTdurEstimateNs:0,tidSet:new Set(),intervalsByTid:new Map(),cpuNs:0})).cpuNs+=residualNs;
    if(residualNs) families.get(residualLabel).tidSet.add(tid);
    perTid.push({tid,threadName:threadNames.get(tid)||sched[0]?.threadName||'',role:tid===rendererPid||threadNames.get(tid)==='CrRendererMain'?'renderer-main':/Compositor|VizCompositor|CrRendererCompositor/i.test(threadNames.get(tid)||sched[0]?.threadName||'')?'compositor':'renderer-worker',schedCpuMs:ms(totalNs),assignedCpuMs:ms(assignedNs),residualCpuMs:ms(residualNs),families:Object.fromEntries([...byFamily].map(([k,v])=>[k,ms(v)]))});
  }
  const exactNs=[...families.values()].reduce((v,r)=>v+r.cpuNs,0);
  if(exactNs!==processSchedNs) throw Error('process partition does not reconcile');
  if(acceptedCpuNs!==undefined&&Math.abs(exactNs-acceptedCpuNs)>1000) throw Error(`accepted renderer CPU mismatch: ${ms(exactNs)} vs ${ms(acceptedCpuNs)}`);
  const present=r=>({name:r.name,family:r.family,count:r.count,complete:r.complete,clipped:r.clipped,missingTdur:r.missingTdur,tids:[...r.tidSet].sort((a,b)=>a-b),unionWallMs:r.intervalsByTid.size?ms([...r.intervalsByTid.values()].reduce((v,a)=>v+unionLength(a),0)):null,inclusiveTdurMs:r.count?ms(r.inclusiveTdurNs):null,clippedTdurEstimateMs:ms(r.clippedTdurEstimateNs),scheduledCpuMs:ms(r.cpuNs||0),rendererCpuPct:+((r.cpuNs||0)/exactNs*100).toFixed(3),status:r.name==='Residual/unlabeled'?'unlabeled':r.name.startsWith('JS profiler worker')?'likely capture overhead':r.name==='Ambiguous overlap'?'ambiguous':'exclusive scheduled / inclusive tdur',...(r.examples?{examples:r.examples}:{})});
  return {schema:'renderer-offline-attribution/1',window:{startUs,endUs,clockOffsetNs},rendererPid,totals:{scheduledCpuMs:ms(exactNs),acceptedCpuMs:acceptedCpuNs===undefined?null:ms(acceptedCpuNs),residualCpuMs:ms(families.get('Residual/unlabeled')?.cpuNs||0),profilerCpuMs:ms(families.get('JS profiler worker (likely capture overhead)')?.cpuNs||0)},families:sorted(families).map(present),inventory:[...names.values()].map(r=>({...present(r),scheduledCpuMs:null,rendererCpuPct:null,status:'inclusive trace inventory; exact-name sched CPU unassigned'})).sort((a,b)=>b.count-a.count),perTid,gcEpochs:summarizeGcEpochs(events,{startUs,endUs,rendererPid,mainTid:[...threadNames].find(([,name])=>name==='CrRendererMain')?.[0]??rendererPid}),hierarchy:[...hierarchy].map(([edge,count])=>({edge,count})).sort((a,b)=>b.count-a.count).slice(0,100),tdurComparison:{completeNonOverlappingCount:tdurComparisons.length,withinFivePct:tdurComparisons.filter(x=>x.differencePct<=5).length,largestDifferences:tdurComparisons.sort((a,b)=>b.differencePct-a.differencePct).slice(0,20)},overlapMatrix:[...overlaps].map(([pair,ns])=>({pair,overlapMs:ms(ns)})).sort((a,b)=>b.overlapMs-a.overlapMs)};
}
