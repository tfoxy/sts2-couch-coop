// Disjoint, same-TID callback attribution against validated Perfetto sched rows.
// A callback's nested named work is reported separately from its own CPU.
import { familyOf } from './renderer-offline-attribution.mjs';

const toNs = us => Math.round(us * 1000);
const ms = ns => +(ns / 1e6).toFixed(3);
const inWindow = (e, startUs, endUs) => e.ph === 'X' && Number.isFinite(e.ts)
  && Number.isFinite(e.dur) && e.dur >= 0 && e.ts < endUs && e.ts + e.dur > startUs;
const rootKind = name => name === 'FireAnimationFrame' ? 'animation-frame'
  : name === 'TimerFire' ? 'timer'
  : /EventDispatch|HandlePostMessage|MessageEvent|MessagePort|DispatchEvent/.test(name) ? 'message'
  : null;
const isContainer = name => name === 'RunTask' || name === 'ThreadControllerImpl::RunTask'
  || name === 'ProxyMain::BeginMainFrame';
const scriptOf = e => {
  const d = e.args?.data ?? {};
  return { isolate: String(d.isolate ?? ''), scriptId: String(d.scriptId ?? ''),
    url: String(d.url ?? ''), lineNumber: Number.isSafeInteger(d.lineNumber) ? d.lineNumber : null,
    columnNumber: Number.isSafeInteger(d.columnNumber) ? d.columnNumber : null,
    functionName: String(d.functionName ?? '') };
};
const keyOf = script => JSON.stringify([script.isolate,script.scriptId,script.url,
  script.lineNumber,script.columnNumber,script.functionName]);
function cpuPrefix(rows) {
  const sched = [...rows].sort((a,b)=>a.ts-b.ts);
  for(let i=0;i<sched.length;i++) {
    const row=sched[i];
    if(!Number.isSafeInteger(row.ts)||!Number.isSafeInteger(row.dur)||row.dur<0
      ||(i && row.ts<sched[i-1].ts+sched[i-1].dur)) throw Error('invalid or overlapping main sched slices');
  }
  const prefix=[0];
  for(const row of sched) prefix.push(prefix.at(-1)+row.dur);
  const at=t=>{
    let lo=0,hi=sched.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(sched[mid].ts<t)lo=mid+1;else hi=mid;}
    const i=lo-1;
    return prefix[lo]-(i>=0?Math.max(0,sched[i].ts+sched[i].dur-t):0);
  };
  return (a,b)=>at(b)-at(a);
}
function unionNs(intervals) {
  let total=0,end=-Infinity;
  for(const [a,b] of intervals.sort((x,y)=>x[0]-y[0]||x[1]-y[1])){
    total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);
  }
  return total;
}
function narrowest(events) {
  if(!events.length) return null;
  const sorted=[...events].sort((a,b)=>(a.end-a.start)-(b.end-b.start)||a.start-b.start);
  const first=sorted[0];
  if(sorted.some(e=>e!==first&&(e.start>first.start||e.end<first.end
    ||(e.start===first.start&&e.end===first.end))))return 'ambiguous';
  return first;
}

export function attributeCallbackCpu({events,schedRows,startUs,endUs,rendererPid,mainTid,clockOffsetNs,acceptedMainCpuNs}) {
  if(![startUs,endUs,rendererPid,mainTid,clockOffsetNs].every(Number.isSafeInteger)||endUs<=startUs)
    throw Error('invalid callback clock/PID ledger');
  const start=toNs(startUs),end=toNs(endUs),from=start+clockOffsetNs,to=end+clockOffsetNs;
  if(![start,end,from,to].every(Number.isSafeInteger)) throw Error('unsafe callback clock conversion');
  if(schedRows.some(s=>s.pid!==rendererPid||s.tid!==mainTid)) throw Error('main sched PID/TID mismatch');
  const cpu=cpuPrefix(schedRows), totalNs=cpu(from,to);
  if(acceptedMainCpuNs!==undefined&&Math.abs(totalNs-acceptedMainCpuNs)>1000)
    throw Error(`renderer-main CPU mismatch: ${ms(totalNs)} vs ${ms(acceptedMainCpuNs)}`);
  const spans=events.filter(e=>e.pid===rendererPid&&e.tid===mainTid&&inWindow(e,startUs,endUs))
    .map((e,i)=>({id:i,name:e.name??'',family:familyOf(e.name??''),start:Math.max(start,toNs(e.ts)),
      end:Math.min(end,toNs(e.ts+e.dur)),script:e.name==='FunctionCall'?scriptOf(e):null}));
  const starts=new Map(),ends=new Map(),points=new Set([start,end]);
  for(const s of spans){if(s.end<=s.start)continue;points.add(s.start);points.add(s.end);
    if(!starts.has(s.start))starts.set(s.start,[]);starts.get(s.start).push(s);
    if(!ends.has(s.end))ends.set(s.end,[]);ends.get(s.end).push(s);
  }
  const ticks=[...points].sort((a,b)=>a-b),active=new Map(),rows=new Map();
  let outsideNs=0,ambiguousNs=0;
  for(let i=0;i<ticks.length-1;i++){
    const a=ticks[i],b=ticks[i+1];
    for(const s of ends.get(a)??[])active.delete(s.id);
    for(const s of starts.get(a)??[])active.set(s.id,s);
    const segmentCpu=cpu(a+clockOffsetNs,b+clockOffsetNs);
    if(!segmentCpu)continue;
    const xs=[...active.values()];
    const fn=narrowest(xs.filter(e=>e.name==='FunctionCall'));
    const roots=xs.filter(e=>rootKind(e.name));
    const root=narrowest(fn&&fn!=='ambiguous'
      ?roots.filter(e=>e.start<=fn.start&&e.end>=fn.end):roots);
    if(fn==='ambiguous'||root==='ambiguous'){ambiguousNs+=segmentCpu;continue;}
    const owner=fn||root;
    if(!owner){outsideNs+=segmentCpu;continue;}
    const kind=root ? rootKind(root.name) : fn ? 'function-only' : 'other';
    const key=fn?`script:${keyOf(fn.script)}`:`root:${kind}`;
    if(!rows.has(key))rows.set(key,{key,kind,script:fn?.script??null,count:0,
      eventIds:new Set(),intervals:[],selfNs:0,enclosedNs:0,nestedNs:new Map(),rootKinds:new Map()});
    const row=rows.get(key);row.enclosedNs+=segmentCpu;
    row.rootKinds.set(kind,(row.rootKinds.get(kind)||0)+segmentCpu);
    const children=xs.filter(e=>e!==owner&&!isContainer(e.name)&&e.family!=='Script callbacks'
      &&e.start>=owner.start&&e.end<=owner.end);
    const deepest=narrowest(children);
    if(deepest==='ambiguous'){row.nestedNs.set('Ambiguous nested',(row.nestedNs.get('Ambiguous nested')||0)+segmentCpu);}
    else if(deepest){row.nestedNs.set(deepest.family,(row.nestedNs.get(deepest.family)||0)+segmentCpu);}
    else row.selfNs+=segmentCpu;
  }
  for(const s of spans){if(s.name!=='FunctionCall'&&!rootKind(s.name))continue;
    const key=s.name==='FunctionCall'?`script:${keyOf(s.script)}`:`root:${rootKind(s.name)}`;
    const row=rows.get(key);if(row){row.eventIds.add(s.id);row.intervals.push([s.start,s.end]);}
  }
  const attributedNs=[...rows.values()].reduce((n,r)=>n+r.enclosedNs,0);
  if(attributedNs+outsideNs+ambiguousNs!==totalNs)throw Error('callback partition does not reconcile');
  const callbacks=[...rows.values()].map(r=>({key:r.key,kind:r.kind,script:r.script,
    count:r.eventIds.size,wallUnionMs:ms(unionNs(r.intervals)),selfCpuMs:ms(r.selfNs),
    enclosedCpuMs:ms(r.enclosedNs),nestedCpuMs:Object.fromEntries([...r.nestedNs].map(([k,v])=>[k,ms(v)])),
    rootCpuMs:Object.fromEntries([...r.rootKinds].map(([k,v])=>[k,ms(v)]))}))
    .sort((a,b)=>b.selfCpuMs-a.selfCpuMs||a.key.localeCompare(b.key));
  return {mainTid,mainSchedCpuMs:ms(totalNs),callbackSelfCpuMs:ms([...rows.values()].reduce((n,r)=>n+r.selfNs,0)),
    callbackEnclosedCpuMs:ms(attributedNs),outsideCpuMs:ms(outsideNs),ambiguousCpuMs:ms(ambiguousNs),callbacks};
}
