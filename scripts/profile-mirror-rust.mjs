#!/usr/bin/env node
// Consumer profile receipt around the established mirror replay harness.
// All raw evidence stays in a new ignored directory. A diagnostic is not a speed claim.
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';
import { REPO_ROOT } from './lib/repo-layout.mjs';
import { profileTimingHealth } from './lib/profile-timing-health.mjs';
import { productionWindowProof } from './lib/production-window-proof.mjs';
import { exclusivePhaseLeads } from './lib/exclusive-phase-leads.mjs';
import { resolveAssetRequest } from './serve-res-root.mjs';
import { parseExtraChromeArgs } from './lib/chrome-args.mjs';
import { assertLiveLease } from './live-qa-lock.mjs';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const args = process.argv.slice(2);
const command = args.shift();
const opt = name => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1]; };
const unavailable = (unit, reason, method = 'unavailable') => ({ value: null, unit, method, coverage: null, reason });
function fileHash(path) { return path && existsSync(path) && statSync(path).isFile() ? sha(readFileSync(path)) : null; }
function treeHash(root) {
  if (!root || !existsSync(root)) return null;
  const rows = [];
  function walk(dir) { for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === 'target' || name === 'dist' || name === '.git') continue;
    const path = join(dir, name), s = statSync(path); if (s.isDirectory()) walk(path); else if (s.isFile()) rows.push(`${path.slice(root.length)} ${fileHash(path)}`);
  } }
  walk(root); return sha(rows.join('\n'));
}
function hashes(config) {
  const gsw = config.gswRoot ? resolve(config.gswRoot) : null;
  const paths = { source: REPO_ROOT, wasm: config.wasmPath ? resolve(config.wasmPath) : null,
    glue: config.gluePath ? resolve(config.gluePath) : null,
    input: config.recording ? resolve(config.recording) : null,
    hitReference: config.hitReferencePath ? resolve(config.hitReferencePath) : null,
    imageReference: config.imageReferencePath ? resolve(config.imageReferencePath) : null,
    resources: config.resourceManifest ? resolve(config.resourceManifest) : null };
  const source = sha(`${treeHash(join(REPO_ROOT, 'frontend/src')) ?? ''}:${fileHash(join(REPO_ROOT,'frontend/vite.config.ts')) ?? ''}:${fileHash(join(REPO_ROOT,'frontend/package.json')) ?? ''}:${fileHash(join(REPO_ROOT,'frontend/package-lock.json')) ?? ''}:${treeHash(join(REPO_ROOT, 'scripts')) ?? ''}:${gsw ? treeHash(join(gsw, 'packages/canvas/src')) ?? '' : ''}:${gsw ? treeHash(join(gsw, 'packages/canvas/rust-prototype/src')) ?? '' : ''}:${gsw ? fileHash(join(gsw,'packages/canvas/rust-prototype/Cargo.toml')) ?? '' : ''}:${gsw ? fileHash(join(gsw,'packages/canvas/rust-prototype/Cargo.lock')) ?? '' : ''}:${gsw ? fileHash(join(gsw,'packages/canvas/rust-prototype/scripts/build-web.sh')) ?? '' : ''}:${gsw ? fileHash(join(gsw,'package.json')) ?? '' : ''}:${gsw ? fileHash(join(gsw,'pnpm-lock.yaml')) ?? '' : ''}`);
  const manifestHash = fileHash(config.resourceManifest && resolve(config.resourceManifest));
  const bgHash = config.bgFixtureDir ? treeHash(resolve(config.bgFixtureDir)) : null;
  const cacheHash = config.assetCacheRoot ? treeHash(resolve(config.assetCacheRoot)) : null;
  const resources = manifestHash && bgHash && cacheHash ? sha(JSON.stringify({manifestHash,bgHash,cacheHash})) : null;
  return Object.fromEntries(Object.entries(paths).map(([key, path]) => [key,
    key === 'source' ? source : key === 'resources' ? resources : fileHash(path)]));
}
export function servedArtifactMatches(bytes, localSha256) {
  const servedSha256 = sha(bytes);
  return { servedSha256, localSha256, matches: !!localSha256 && servedSha256 === localSha256 };
}
export async function postCaptureServerProof(proof, config, request = fetch) {
  const servedAfter = {};
  for (const [name, url] of [['wasm',config.wasmUrl],['glue',config.rustModuleUrl],['serializer',config.sceneSerializerUrl]]) {
    const startedAt = performance.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await request(new URL(url,config.url),{signal:AbortSignal.timeout(5000)});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        servedAfter[name] = { ...servedArtifactMatches(Buffer.from(await response.arrayBuffer()),
          proof.served[name].localSha256), elapsedMs:performance.now()-startedAt,attempts:attempt };
        break;
      } catch (error) {
        servedAfter[name] = {servedSha256:null,localSha256:proof.served?.[name]?.localSha256 ?? null,
          matches:false,elapsedMs:performance.now()-startedAt,attempts:attempt,
          reason:`post-capture fetch unavailable: ${error instanceof Error ? error.message : String(error)}`};
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve,300));
      }
    }
  }
  return {...proof,servedAfter};
}

export async function verifyRustMarks(trace, events, gswRoot) {
  // Load the exact GSW verifier without importing its fixture runner and TS dependencies.
  const ts = require('typescript');
  const path = join(resolve(gswRoot),'scripts/profile-canvas-rust.mjs');
  const source = readFileSync(path,'utf8');
  const ast = ts.createSourceFile(path,source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'rustMarkHealth');
  if (!fn) throw new Error('GSW Rust mark verifier is absent');
  const { rustMarkHealth } = await import(`data:text/javascript;base64,${Buffer.from(fn.getText(ast)).toString('base64')}`);
  const marker = name => trace.filter(e => e.name === 'TimeStamp' && e.args?.data?.message === name);
  const starts = marker('cc-report-start'), ends = marker('cc-report-end');
  const start = starts.length === 1 ? starts[0] : null;
  const end = ends.length === 1 && start && ends[0].pid === start.pid && ends[0].tid === start.tid &&
    ends[0].ts > start.ts ? ends[0] : null;
  if (!start || !end) throw new Error('unique same-thread direct Rust mark window unavailable');
  // Chrome tracing may begin before the direct active marker. Earlier operation
  // marks are outside this measurement, while a span crossing the marker still
  // leaves an unmatched edge inside the window and fails qualification.
  return rustMarkHealth(trace.filter(e => e.ts >= start.ts && e.ts <= end.ts),start,end,events);
}
export function servedResourceHashes(manifestPath, baseBefore, baseAfter, config = null) {
  if (!fileHash(manifestPath)) return {before:null,after:null,count:0,reason:'served-resource manifest unavailable'};
  const rows = readFileSync(manifestPath,'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const valid = rows.length > 0 && rows.every(row => row.complete === true &&
    typeof row.url === 'string' && ['recovered','cache'].includes(row.source) &&
    (typeof row.path === 'string' || row.path === null) && Number.isInteger(row.size) && row.size >= 0 &&
    /^[0-9a-f]{64}$/.test(row.sha256));
  if (!valid) return {before:null,after:null,count:rows.length,reason:'served resources incomplete or not file-backed'};
  const normalized = rows.map(row => ({url:row.url,source:row.source,path:row.path,size:row.size,sha256:row.sha256}));
  const reread = normalized.map(row => {
    if (row.path) return {...row,sha256:fileHash(row.path),size:existsSync(row.path) ? statSync(row.path).size : null};
    const answer = config && resolveAssetRequest({root:config.resRoot,assetCacheRoot:config.assetCacheRoot,url:row.url});
    return {...row,sha256:answer?.status === 200 && answer.body != null ? sha(answer.body) : null,
      size:answer?.body != null ? Buffer.byteLength(answer.body) : null};
  });
  const canonical = entries => entries.map(({url,source,size,sha256}) => ({url,source,size,sha256}))
    .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const phases = rows.some(row => row.phase != null) ? Object.fromEntries(['warm','measured'].map(phase => {
    const selected = rows.filter(row => row.phase === phase);
    return [phase,{count:selected.length,sha256:sha(JSON.stringify(canonical(selected)))}];
  })) : null;
  return {before:baseBefore && sha(JSON.stringify({base:baseBefore,served:canonical(normalized)})),
    after:baseAfter && reread.every(row => row.sha256 && row.size != null)
      ? sha(JSON.stringify({base:baseAfter,served:canonical(reread)})) : null,
    canonicalSha256:sha(JSON.stringify(canonical(normalized))),count:rows.length,phases,reason:null};
}
export function hitGridSemanticHash(textValue) {
  const hitProjection = line => {
    const fields = Object.fromEntries(line.split(' ').slice(2).map(pair => {
      const i = pair.indexOf('='); return [pair.slice(0,i),pair.slice(i+1)];
    }));
    // Painter provenance is diagnostic; top/depth/block/map/confirm/cover/stack
    // are the actual hit contract. Pixel output has its own image comparison.
    delete fields.painter;
    return `${line.split(' ').slice(0,2).join(' ')} ${JSON.stringify(fields)}`;
  };
  const parse = text => {
    const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
    const header = Object.fromEntries(lines.filter(x => x.startsWith('# ')).map(x => {
      const i = x.indexOf('='); return [x.slice(2,i),x.slice(i+1)];
    }));
    const points = lines.filter(x => x.startsWith('P '));
    return {header,points};
  };
  const grid = parse(textValue);
  const keys = ['recording','viewport','stageBox','step','samples'];
  return grid.points.length > 0 && keys.every(key => grid.header[key])
    ? sha(JSON.stringify({header:keys.map(key => grid.header[key]),points:grid.points.map(hitProjection)})) : null;
}
export function hitGridMatches(candidate, reference) {
  const one = hitGridSemanticHash(candidate), two = hitGridSemanticHash(reference);
  return !!one && one === two;
}
export function visualOracleServedArtifactsMatch(oracle, ordinary) {
  return ['glue','serializer'].every(name => {
    const expected = oracle?.served?.[name]?.servedSha256;
    return !!expected && expected === oracle?.servedAfter?.[name]?.servedSha256 &&
      expected === ordinary?.served?.[name]?.servedSha256 &&
      expected === ordinary?.servedAfter?.[name]?.servedSha256;
  });
}
export function imagePixelDifference(candidatePath, referencePath, run = spawnSync) {
  if (!fileHash(candidatePath) || !fileHash(referencePath))
    return {differentPixels:null,reason:'candidate or pinned reference image unavailable'};
  const result = run('compare',['-metric','AE',referencePath,candidatePath,'null:'],
    {encoding:'utf8',timeout:30000});
  const raw = (result.stderr ?? '').trim();
  const count = Number(raw);
  if (result.error || ![0,1].includes(result.status) || !/^\d+$/.test(raw) || !Number.isSafeInteger(count))
    return {differentPixels:null,reason:`pixel comparison unavailable: ${result.error?.message ?? raw ?? 'unknown error'}`};
  return {differentPixels:count,reason:null};
}
export function replayMessageDigest(recordingPath) {
  if (!recordingPath || !existsSync(recordingPath)) return null;
  const messages = readFileSync(recordingPath,'utf8').split('\n').filter(Boolean).flatMap(line => {
    let row;
    try { row = JSON.parse(line); } catch { return []; }
    if (row.meta || row.dir === 'out' || typeof row.data !== 'string' ||
        row.data.includes('"type":"server-reload"')) return [];
    return [{t:typeof row.t === 'number' ? row.t : 0,data:row.data}];
  });
  return {count:messages.length,sha256:sha(Buffer.from(JSON.stringify(messages)))};
}
export function procIntervalCpuMetric(threads, role, markerBegin, markerEnd) {
  const rows = [...new Map(threads.filter(row => String(row.role ?? '').toLowerCase().startsWith(role))
    .map(row => [row.pid,row])).values()];
  if (!rows.length || !Number.isFinite(markerBegin) || !Number.isFinite(markerEnd) ||
      !rows.every(row => Number.isFinite(row.processCpuMs) && row.processCpuMs >= 0 &&
        row.processStartBefore && row.processStartBefore === row.processStartAfter &&
        Number.isFinite(row.sampleBeforeEpochUs) && Number.isFinite(row.sampleAfterEpochUs) &&
        Number.isFinite(row.sampleClockUncertaintyUs) && row.sampleClockUncertaintyUs >= 0 &&
        row.sampleBeforeEpochUs + row.sampleClockUncertaintyUs <= markerBegin &&
        row.sampleAfterEpochUs - row.sampleClockUncertaintyUs >= markerEnd &&
        row.procClockTicksPerSecond > 0)) return null;
  const sampleIntervals = rows.map(row => ({pid:row.pid,
    beforeEpochUs:row.sampleBeforeEpochUs,afterEpochUs:row.sampleAfterEpochUs,
    beforeOverhangMs:(markerBegin-row.sampleBeforeEpochUs)/1000,
    afterOverhangMs:(row.sampleAfterEpochUs-markerEnd)/1000,
    clockUncertaintyMs:row.sampleClockUncertaintyUs/1000,
    jiffyUncertaintyMs:2000/row.procClockTicksPerSecond}));
  return {value:rows.reduce((sum,row) => sum+row.processCpuMs,0),unit:'ms',
    method:'bounded /proc process utime+stime over sample intervals',
    scoreWindow:'proc-sample-interval',coverage:null,
    reason:'sample intervals bracket direct markers; CPU in overhang cannot be separated',
    sampleIntervals,
    overhangTotalMs:sampleIntervals.reduce((sum,row) => sum+row.beforeOverhangMs+row.afterOverhangMs,0),
    jiffyUncertaintyMs:sampleIntervals.reduce((sum,row) => sum+row.jiffyUncertaintyMs,0)};
}
function tool(name, argv = ['--version']) {
  const r = spawnSync(name, argv, { encoding: 'utf8', timeout: 3000 });
  return { available: !r.error && r.status === 0, detail: r.error?.message ?? (r.stdout || r.stderr || '').trim().split('\n')[0] ?? null };
}
function capabilities(config) {
  const paranoid = fileHash('/proc/sys/kernel/perf_event_paranoid') ? readFileSync('/proc/sys/kernel/perf_event_paranoid','utf8').trim() : null;
  return { schema: 'canvas-profile-capabilities/1', at: new Date().toISOString(), platform: process.platform,
    host: { cpus: os.cpus().map(c => c.model).filter((v,i,a) => a.indexOf(v) === i), release: os.release() },
    browser: config.browserExecutable ? { path: config.browserExecutable, sha256: fileHash(config.browserExecutable) } : null,
    perf: { ...tool('perf'), perfEventParanoid: paranoid }, perfetto: tool('perfetto'), uprof: tool('AMDuProfCLI'),
    adb: tool('adb'), cdp: { available: true, detail: 'replay harness uses Playwright CDP' },
    hostNvidiaDriver: hostNvidiaDriver(),
    gpuTimer: { available: null, reason: 'must probe actual Rust WebGL2 context in page' },
    presentations: { available: null, reason: 'requires compositor or display-layer capture and identity' } };
}
function hostNvidiaDriver() {
  const result = spawnSync('nvidia-smi',['--query-gpu=driver_version','--format=csv,noheader'],
    {encoding:'utf8',timeout:3000});
  const version = result.status === 0 ? result.stdout?.trim().split('\n')[0] : null;
  return {version:version || null,source:'host nvidia-smi inventory, not browser adapter proof',
    ...(version ? {} : {reason:result.error?.message ?? result.stderr?.trim() ?? 'nvidia-smi unavailable'})};
}
function hostIdentity() {
  const cpus = os.cpus();
  return {platform:process.platform,arch:process.arch,kernelRelease:os.release(),
    cpuModel:cpus[0]?.model ?? null,logicalCpus:cpus.length,
    nvidiaDriver:hostNvidiaDriver()};
}
function browserIdentity(benchmark) {
  const browser = benchmark.browser ?? {};
  return {...browser,binarySha256:browser.binarySha256 ?? null,
    ...(browser.binarySha256 ? {} : {binaryReason:browser.reason ?? 'launched binary proof unavailable'})};
}
export function comparableEnvironment(a,b) {
  const failures = [];
  const x = a.hostIdentity, y = b.hostIdentity;
  if (!x?.platform || !x.arch || !x.kernelRelease || !x.cpuModel || !x.logicalCpus ||
      !y?.platform || !y.arch || !y.kernelRelease || !y.cpuModel || !y.logicalCpus ||
      JSON.stringify(x) !== JSON.stringify(y)) failures.push('host OS/kernel/CPU/driver identity differs or is unavailable');
  const first = a.browser, second = b.browser;
  if (!first?.version || !first.binarySha256 || !second?.version || !second.binarySha256 ||
      first.mode !== 'launched' || second.mode !== 'launched' ||
      first.version !== second.version || first.binarySha256 !== second.binarySha256)
    failures.push('browser version, launch mode, or binary identity differs or is unavailable');
  return failures;
}
export function comparableProductionOutput(reference, cell) {
  const a = reference?.output, b = cell?.output;
  const delivery = proof => proof?.production?.delivery;
  const frame = proof => proof?.production?.frame;
  const timing = proof => proof?.production?.deliveryTiming;
  if (a?.valid !== true || b?.valid !== true || a?.production?.valid !== true ||
      b?.production?.valid !== true || a?.visualOracle?.valid !== true ||
      b?.visualOracle?.valid !== true || a?.hit?.equal !== true || b?.hit?.equal !== true ||
      !reference.resourceDelivery?.sha256 || !cell.resourceDelivery?.sha256)
    return false;
  return a.hit.semanticSha256 === b.hit.semanticSha256 &&
    a.visualOracle.imageSha256 === b.visualOracle.imageSha256 &&
    a.production.window?.startMs === b.production.window?.startMs &&
    a.production.window?.endMs === b.production.window?.endMs &&
    reference.resourceDelivery?.sha256 === cell.resourceDelivery?.sha256 &&
    reference.resourceDelivery?.count === cell.resourceDelivery?.count &&
    JSON.stringify(reference.resourceDelivery?.phases ?? null) ===
      JSON.stringify(cell.resourceDelivery?.phases ?? null) &&
    ['before','after','index','count'].every(key => delivery(a)?.[key] === delivery(b)?.[key]) &&
    ['revision'].every(key => frame(a)?.before?.[key] === frame(b)?.before?.[key] &&
      frame(a)?.after?.[key] === frame(b)?.after?.[key]) &&
    ['rows','dropped','inWindow','firstIndex','lastIndex',
      'deliveredInWindow','firstDeliveredIndex','lastDeliveredIndex'].every(key =>
      timing(a)?.[key] === timing(b)?.[key]);
}
async function startScratchServer(config, out) {
  const url = new URL(config.url);
  if (!['127.0.0.1','localhost'].includes(url.hostname) || !url.port || ['5219','5220'].includes(url.port))
    throw new Error('capture needs a dedicated loopback Vite port other than 5219/5220');
  if (!config.gswRoot || !config.wasmPath || !config.gluePath || !config.rustModuleUrl || !config.sceneSerializerUrl ||
      !config.wasmUrl || !config.sceneSerializerPath || !config.bgFixtureDir || !config.assetCacheRoot || !config.resourceManifest ||
      !config.resRoot || !config.assetPort || ['5219','5220',url.port].includes(String(config.assetPort)))
    throw new Error('capture needs GSW, WASM/glue/serializer URLs and paths, background fixture, asset cache and resource manifest');
  const assetLog = [];
  const assets = spawn(process.execPath,['scripts/serve-res-root.mjs','--port',String(config.assetPort),
    '--root',resolve(config.resRoot),'--asset-cache-root',resolve(config.assetCacheRoot),
    '--served-manifest',join(out,'served-resources.ndjson')],
    {cwd:REPO_ROOT,env:process.env,stdio:['ignore','pipe','pipe'],detached:true});
  assets.stdout.on('data',b => assetLog.push(b.toString())); assets.stderr.on('data',b => assetLog.push(b.toString()));
  const env = { ...process.env, COUCHCOOP_GSW_ROOT: resolve(config.gswRoot),
    COUCHCOOP_DEV_BG_FIXTURE: resolve(config.bgFixtureDir),
    COUCHCOOP_DEV_PROXY_TARGET:`http://127.0.0.1:${config.assetPort}`,
    VITE_RUST_PROTOTYPE_MODULE_URL: config.rustModuleUrl,
    VITE_RUST_SCENE_SERIALIZER_URL: config.sceneSerializerUrl };
  const log = [];
  const server = spawn('npm', ['run','dev','--','--host','127.0.0.1','--port',url.port,'--strictPort'],
    { cwd: join(REPO_ROOT,'frontend'), env, stdio: ['ignore','pipe','pipe'], detached: true });
  server.stdout.on('data', b => log.push(b.toString())); server.stderr.on('data', b => log.push(b.toString()));
  const deadline = Date.now()+30000;
  try {
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`scratch Vite exited: ${log.join('')}`);
      try {
        const r = await fetch(config.url, { signal: AbortSignal.timeout(1000) });
        const resource = await fetch(new URL('/res/project.godot',config.url), {signal:AbortSignal.timeout(1000)});
        if (r.ok && resource.ok) {
          const served = {};
          for (const [name, servedUrl, localPath] of [
            ['wasm',config.wasmUrl,config.wasmPath], ['glue',config.rustModuleUrl,config.gluePath],
            ['serializer',config.sceneSerializerUrl,config.sceneSerializerPath]]) {
            const response = await fetch(new URL(servedUrl, config.url), { signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error(`served ${name} returned HTTP ${response.status}`);
            served[name] = { url:response.url, sourcePath:resolve(localPath),
              ...servedArtifactMatches(Buffer.from(await response.arrayBuffer()),fileHash(resolve(localPath))) };
          }
          const proof = { schema:'canvas-profile-server/1', url:config.url, pid:server.pid,
            gswRoot:resolve(config.gswRoot), wasmPath:resolve(config.wasmPath), gluePath:resolve(config.gluePath),
            rustModuleUrl:config.rustModuleUrl, sceneSerializerUrl:config.sceneSerializerUrl,
            sourceHash:treeHash(join(resolve(config.gswRoot),'packages/canvas/src')),
            wasmSha256:fileHash(resolve(config.wasmPath)), glueSha256:fileHash(resolve(config.gluePath)),
            serializerSha256:fileHash(resolve(config.sceneSerializerPath)), served,
            backgroundFixtureSha256:treeHash(resolve(config.bgFixtureDir)),
            assetCacheSha256:treeHash(resolve(config.assetCacheRoot)),
            resourceManifestSha256:fileHash(resolve(config.resourceManifest)) };
          save(join(out,'server-proof.json'),proof);
          return { server, assets, proof, log, assetLog };
        }
      } catch {}
      await new Promise(r => setTimeout(r,250));
    }
    throw new Error(`scratch Vite readiness timed out: ${log.join('')}`);
  } catch (error) { try { process.kill(-server.pid,'SIGTERM'); } catch {}
    try { process.kill(-assets.pid,'SIGTERM'); } catch {} throw error; }
}
function receipt(config, runId, before, after, benchmark, captureCommand, artifacts, serverProof = null) {
  const speed = config.captureMode === 'speed';
  const ordinary = speed || config.captureMode === 'production-diagnostic';
  const traced = ['diagnostic','visual-diagnostic','visual-phase-diagnostic','display','production-diagnostic'].includes(config.captureMode);
  const hashRows = Object.fromEntries(Object.keys(before).map(k => [k, { before: before[k], after: after[k],
    ...(!before[k] || !after[k] ? { reason: 'path missing from config or source tree' } : {}) }]));
  const snapshots = (benchmark.perRepeat ?? []).map(r => r.rendererWindow?.after?.effective?.canvasProfile).filter(Boolean);
  const events = snapshots.flatMap(s => s.events ?? []);
  const droppedEvents = snapshots.reduce((n,s) => n + (s.droppedEvents ?? 0), 0);
  // External scheduler/display evidence is attached only by analyze, after it
  // can be bound to this run's raw benchmark hash and direct marker identity.
  const evidence = {};
  const presentationCount = evidence.presentations?.count ?? null;
  const cpu = benchmark.perRepeat?.[0]?.cpu ?? null;
  const markers = benchmark.perRepeat?.[0]?.traceMarkers ?? null;
  const pageClock = benchmark.perRepeat?.[0]?.pageMarkerClock ?? null;
  const procThreads = benchmark.perRepeat?.[0]?.processIdentity ?? [];
  const procCpu = role => procIntervalCpuMetric(procThreads,role,
    markers?.begin ?? pageClock?.beginEpochUs,markers?.end ?? pageClock?.endEpochUs);
  const procResidual = [...new Map(procThreads.map(row => [row.pid,row])).values()].map(row => {
    const acceptedThreads = procThreads.filter(t => t.pid === row.pid && Number.isFinite(t.cpuMs))
      .reduce((sum,t) => sum+t.cpuMs,0);
    return {pid:row.pid,role:row.role,processCpuMs:row.processCpuMs ?? null,
      acceptedThreadCpuMs:acceptedThreads,
      unresolvedCpuMs:row.processCpuMs == null ? null : Math.max(0,row.processCpuMs-acceptedThreads),
      threadOvercountMs:row.processCpuMs == null ? null : Math.max(0,acceptedThreads-row.processCpuMs),
      roundingUncertaintyMs:procThreads.filter(t => t.pid === row.pid).length *
        (1000/(row.procClockTicksPerSecond || 100)) + 1000/(row.procClockTicksPerSecond || 100),
      reason:row.processCpuMs == null ? 'process counter or start identity unavailable' :
        'signed thread/process difference retained as unresolved or overcount; thread churn and clock-tick rounding remain'};
  });
  const offsets = markers && pageClock && Number.isFinite(pageClock.beginEpochUs) && Number.isFinite(pageClock.endEpochUs)
    ? [markers.begin - pageClock.beginEpochUs, markers.end - pageClock.endEpochUs] : null;
  const derivedClock = offsets ? [{ from: 'performance.timeOrigin+now', to: 'chrome-trace-ts',
    offsetUs: (offsets[0]+offsets[1])/2,
    uncertaintyUs: 1000 + Math.abs(offsets[1]-offsets[0])/2,
    method: 'paired page console.timeStamp then performance clock reads' }] : [];
  const identity = snapshots[0] ?? {};
  const observed = (benchmark.perRepeat ?? []).map(r => ({
    ready:r.rendererWindow?.after?.ready === true,
    pending:r.rendererWindow?.after?.resources?.pending ?? null,
    failed:r.rendererWindow?.after?.resources?.failed ?? null,
    witness:r.outputWitness ?? null,
    replayDelivery:r.replayDelivery ?? null,
  }));
  const gridArtifact = artifacts.find(a => a.path === 'hit-grid.txt');
  const gridPath = gridArtifact && config.captureOut ? join(resolve(config.captureOut),'hit-grid.txt') : null;
  const gridLines = gridPath && fileHash(gridPath) === gridArtifact.sha256
    ? readFileSync(gridPath,'utf8').split('\n').filter(line => line.startsWith('P ')) : [];
  const hitGridValid = gridLines.length > 0 && gridLines.every(line =>
    !line.includes('!err') && !line.includes('undef'));
  const referenceHash = fileHash(config.hitReferencePath && resolve(config.hitReferencePath));
  const hitEqual = hitGridValid && referenceHash && referenceHash === config.hitReferenceSha256 &&
    hitGridMatches(readFileSync(gridPath,'utf8'),readFileSync(resolve(config.hitReferencePath),'utf8'));
  const hitSemanticSha256 = hitGridValid ? hitGridSemanticHash(readFileSync(gridPath,'utf8')) : null;
  const imageReferenceHash = fileHash(config.imageReferencePath && resolve(config.imageReferencePath));
  const imageDifference = config.captureOut && imageReferenceHash &&
      imageReferenceHash === config.imageReferenceSha256
    ? imagePixelDifference(join(resolve(config.captureOut),'final.png'),resolve(config.imageReferencePath))
    : {differentPixels:null,reason:'pinned image reference unavailable or hash mismatch'};
  const imageEqual = imageDifference.differentPixels === 0;
  const windowArg = (config.benchArgs ?? []).indexOf('--window');
  const windowMatch = windowArg >= 0 ? /^(\d+):(\d+)$/.exec(config.benchArgs[windowArg+1] ?? '') : null;
  const expectedWindow = windowMatch ? {startMs:Number(windowMatch[1]),endMs:Number(windowMatch[2])} : null;
  const production = ordinary ? productionWindowProof(benchmark.perRepeat?.[0],expectedWindow) : null;
  let visualOracle = null;
  if (ordinary && config.visualOracleRun) {
    const run = resolve(config.visualOracleRun), path = join(run,'receipt.json');
    if (fileHash(path)) {
      const oracle = json(path);
      const sameBytes = ['source','wasm','glue','input'].every(name =>
        oracle.hashes?.[name]?.before && oracle.hashes[name].before === before[name] &&
        oracle.hashes[name].before === oracle.hashes[name].after) &&
        oracle.serverProof?.resourceManifestSha256 === fileHash(resolve(config.resourceManifest)) &&
        oracle.serverProof?.backgroundFixtureSha256 === treeHash(resolve(config.bgFixtureDir)) &&
        oracle.serverProof?.assetCacheSha256 === treeHash(resolve(config.assetCacheRoot));
      visualOracle = {run,receiptSha256:fileHash(path),benchmarkSha256:fileHash(join(run,'benchmark.json')),
        imageSha256:oracle.output?.image?.candidateSha256 ?? null,
        hitSemanticSha256:oracle.output?.hit?.semanticSha256 ?? null,
        // Forced diagnostic paints may fetch resources never requested by ordinary replay.
        // Pin the same static asset corpus; record served rows separately per workload.
        valid:sameBytes && visualOracleServedArtifactsMatch(oracle.serverProof,serverProof) &&
          oracle.effective?.config?.captureMode === 'visual' &&
          oracle.effective?.config?.quality === config.quality &&
          oracle.effective?.config?.effects === config.effects &&
          oracle.effective?.backend === 'rust' && oracle.workload?.valid === true &&
          oracle.output?.valid === true && oracle.output?.framePin?.valid === true &&
          oracle.output?.hit?.semanticSha256 === hitSemanticSha256};
    }
  }
  const framePin = benchmark.perRepeat?.[0]?.shotClockProof ?? null;
  const framePinValid = config.shotClockMs == null || (framePin?.valid === true &&
    framePin.requestedClockMs === config.shotClockMs &&
    framePin.after?.clock === config.shotClockMs &&
    framePin.replay?.done === true && framePin.replay.index === framePin.replay.count);
  const outputWitnessValid = observed.length > 0 && observed.every((row,index) =>
    row.witness?.sampleCount > 0 && row.witness.sampleHits === row.witness.sampleCount &&
    row.witness.screenshot && artifacts.some(a => a.path === `witness-r${index}.png` &&
      a.sha256 === fileHash(resolve(REPO_ROOT,row.witness.screenshot))));
  const expectedReplay = replayMessageDigest(config.recording);
  const replayDeliveryValid = observed.length > 0 && expectedReplay != null && benchmark.recording != null &&
    benchmark.recording.sha256 === before.input &&
    expectedReplay?.count === benchmark.recording?.messages && expectedReplay.count > 0 &&
    observed.every(row => row.ready && row.pending === 0 && row.failed === 0 &&
      row.replayDelivery?.count === benchmark.recording.messages &&
      row.replayDelivery?.final?.done === true &&
      row.replayDelivery.final.index === benchmark.recording.messages &&
      row.replayDelivery.final.count === benchmark.recording.messages &&
      row.replayDelivery.final.prefixSha256 === expectedReplay.sha256 &&
      Number.isInteger(row.replayDelivery.index) && row.replayDelivery.index > 0 &&
      row.replayDelivery.index <= row.replayDelivery.final.index &&
      Number.isInteger(row.replayDelivery.after) && row.replayDelivery.after >= 0 &&
      row.replayDelivery.final.delivered >= row.replayDelivery.after);
  const result = { schema: 'canvas-profile/1', runId, rendererInstanceId: identity.rendererInstanceId ?? 'unobserved',
    capturedAt: new Date().toISOString(),
    command: captureCommand.join(' '), profiler: { maxClockUncertaintyUs:2000,maxProcOverhangMs:25,
      ...(config.profiler ?? {}),
      chromeArgs:parseExtraChromeArgs(),
      chromeTraceEnabled:traced,phaseHooksEnabled:config.phases === true,
      procCpuBracketsEnabled:!!benchmark.perRepeat?.[0]?.processIdentity?.length,
      procClockTicksPerSecond:procThreads[0]?.procClockTicksPerSecond ?? null }, hashes: hashRows,
    effective: { config, backend: benchmark.perRepeat?.[0]?.rendererWindow?.after?.backend ?? null,
      benchmark: benchmark.effectiveSettings ?? null }, hostIdentity:hostIdentity(),
    browser:browserIdentity(benchmark),
    gpu: {identity:benchmark.perRepeat?.[0]?.gpuIdentity ?? null,
      timerCapability:benchmark.perRepeat?.[0]?.gpuTimerCapability ?? null,
      rustTimerCapability:benchmark.perRepeat?.[0]?.rustGpuTimerCapability ?? null,
      hostNvidiaDriver:hostNvidiaDriver(),
      hardware:benchmark.perRepeat?.[0]?.gpuIdentity?.unmasked === true &&
        !/SwiftShader|llvmpipe|software/i.test(benchmark.perRepeat?.[0]?.gpuIdentity?.renderer ?? ''),
      reason:benchmark.perRepeat?.[0]?.gpuIdentity?.unmasked === true ? null : 'unmasked Rust WebGL2 renderer unavailable'},
    processes: evidence.processes ?? procThreads,
    clocks: evidence.clocks ?? (speed ? [{from:'performance.timeOrigin+now',to:'performance.timeOrigin+now',
      offsetUs:0,uncertaintyUs:1000,method:'paired active page markers'}] : derivedClock),
    markers: { begin: evidence.markers?.begin ?? markers?.begin ?? (speed ? pageClock?.beginEpochUs : null) ?? null,
      end: evidence.markers?.end ?? markers?.end ?? (speed ? pageClock?.endEpochUs : null) ?? null,
      window: benchmark.window ?? null, direct: evidence.markers ?? null,
      nodeCalls:pageClock ? {openStartMs:pageClock.openCallStartMs ?? null,
        openEndMs:pageClock.openCallEndMs ?? null,
        closeStartMs:pageClock.closeCallStartMs ?? null,
        closeEndMs:pageClock.closeCallEndMs ?? null} : null },
    workload: { valid: replayDeliveryValid, recording: config.recording,
      observed, recordingSha256:benchmark.recording?.sha256 ?? null,
      replayMessageSha256:expectedReplay?.sha256 ?? null,
      delivery: evidence.delivery ?? null, benchmarkResult: benchmark.config ?? null },
    output: { valid: !!hitEqual && outputWitnessValid && framePinValid &&
        (ordinary ? production?.valid === true && visualOracle?.valid === true : imageEqual), observed,
      production, visualOracle,
      framePin: { valid: framePinValid, proof: framePin },
      witness: benchmark.perRepeat?.map(r => r.outputWitness ?? null) ?? null,
      image: {equal:imageEqual,differentPixels:imageDifference.differentPixels,
        reason:imageDifference.reason,referenceSha256:imageReferenceHash ?? null,
        candidateSha256:artifacts.find(a => a.path === 'final.png')?.sha256 ?? null},
      hit: gridLines.length ? { equal:!!hitEqual, method:'semantic hit fields against pinned reference; painter is diagnostic',
        samples:gridLines.length, sha256:gridArtifact.sha256,semanticSha256:hitSemanticSha256,
        unknownPainterSamples:gridLines.filter(line => line.includes('painter=?')).length,
        ...(hitGridValid ? {} : {reason:'hit grid contains an error or undefined field'}),
        referenceSha256:referenceHash ?? null } : null,
      images: artifacts.filter(a => /\.png$/.test(a.path)).map(a => a.path) },
    symbols: {byThread:(benchmark.perRepeat?.[0]?.processIdentity ?? []).map(p => ({pid:p.pid,tid:p.tid,
      leafCoverage:null,callerCoverage:null,js:null,wasm:null,native:null,
      reason:'symbolized samples not collected'})),invalidSampleDeltas:null,
      reason:'symbolized samples not collected'}, benchmarkContract: evidence.benchmarkContract ?? null,
    processCpuResidual:procResidual,
    threadCpu: (benchmark.perRepeat?.[0]?.processIdentity ?? []).map(p => {
      const trace = cpu?.byTid?.find(t => t.pid === p.pid && t.tid === p.tid);
      return { pid:p.pid, tid:p.tid, role:p.role, cpuMs:speed ? p.cpuMs ?? null : trace?.cpuMs ?? null,
        unresolvedCpuMs:speed ? p.cpuMs ?? null : trace?.cpuMs ?? null,
        reason:speed ? 'bounded /proc CPU; no validated leaf symbol attribution' :
          trace ? 'trace tdur lower bound; no validated leaf symbol attribution' : 'thread has no traced CPU span' };
    }),
    losses: { trace: benchmark.traceLoss ?? null, collector: droppedEvents,
      profiler: evidence.losses?.profiler ?? null, profilerReason: 'profile loss not measured' },
    presentations: { source: evidence.presentations?.source ?? null, count: presentationCount,
      ...(presentationCount === null ? { reason: 'actual content presentations not captured' } : {}) },
    metrics: { rendererCpuMs: speed && procCpu('renderer') != null
      ? procCpu('renderer')
      : cpu?.byProcess?.renderer?.cpuMs != null
      ? { value: cpu.byProcess.renderer.cpuMs, unit: 'ms', method: 'Chrome trace maximal RunTask tdur lower bound', coverage: cpu.cpuCoverage ?? null }
      : unavailable('ms', 'renderer trace tdur unavailable'),
      gpuProcessCpuMs: speed && procCpu('gpu') != null
        ? procCpu('gpu')
        : cpu?.byProcess?.gpu?.cpuMs != null
        ? { value: cpu.byProcess.gpu.cpuMs, unit: 'ms', method: 'Chrome trace maximal RunTask tdur lower bound', coverage: cpu.cpuCoverage ?? null }
        : unavailable('ms', 'GPU process trace tdur unavailable'),
      browserProcessCpuMs:speed && procCpu('browser') != null
        ? procCpu('browser')
        : unavailable('ms','browser process scheduled CPU unavailable'),
      utilityProcessCpuMs:speed && procCpu('utility') != null
        ? procCpu('utility')
        : unavailable('ms','utility process scheduled CPU unavailable'),
      gpuExecutionMs: unavailable('ms', 'actual Rust context GPU timer unavailable'),
      actualPresentations: presentationCount === null ? unavailable('count', 'no display evidence')
        : { value: presentationCount, unit: 'count', method: 'display-layer evidence', coverage: 1 } }, artifacts };
  return { receipt: result, events };
}
async function validate(receipt, events, gswRoot) {
  const path = join(resolve(gswRoot), 'packages/canvas/src/profile.ts');
  const ts = require('typescript');
  const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { validateCanvasProfile } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const failures = validateCanvasProfile(receipt, events);
  if (receipt.losses?.trace === null) failures.push('trace loss status unavailable');
  if (receipt.serverProof?.schema !== 'canvas-profile-server/1' ||
      receipt.serverProof.served?.wasm?.matches !== true ||
      receipt.serverProof.servedAfter?.wasm?.matches !== true ||
      !['glue','serializer'].every(name => receipt.serverProof.served?.[name]?.servedSha256 &&
        receipt.serverProof.served?.[name]?.sourcePath &&
        receipt.serverProof.served?.[name]?.servedSha256 === receipt.serverProof.servedAfter?.[name]?.servedSha256) ||
      (receipt.effective?.config?.gluePath && receipt.serverProof.served.glue.sourcePath !== resolve(receipt.effective.config.gluePath)) ||
      (receipt.effective?.config?.sceneSerializerPath && receipt.serverProof.served.serializer.sourcePath !== resolve(receipt.effective.config.sceneSerializerPath)) ||
      receipt.serverProof.wasmSha256 !== receipt.hashes.wasm.before ||
      receipt.serverProof.glueSha256 !== receipt.hashes.glue.before ||
      (receipt.effective?.config?.gswRoot && receipt.serverProof.gswRoot !== resolve(receipt.effective.config.gswRoot)))
    failures.push('served artifact bytes differ from pinned files or server proof unavailable');
  if (!receipt.workload?.observed?.length || receipt.workload.observed.some(row =>
      !row.ready || row.pending !== 0 || row.failed !== 0))
    failures.push('renderer readiness or resources unverified');
  if (receipt.effective?.backend !== 'rust') failures.push('captured renderer is not Rust');
  if (receipt.gpu?.hardware === true && (!receipt.gpu.identity?.unmasked ||
      /SwiftShader|llvmpipe|software/i.test(receipt.gpu.identity.renderer ?? '')))
    failures.push('hardware GPU identity unverified or software renderer');
  if (!(receipt.markers?.end > receipt.markers?.begin)) failures.push('missing direct window markers');
  if (!receipt.output?.witness?.every(Boolean)) failures.push('output readiness missing');
  if (receipt.effective?.config?.captureMode === 'production-diagnostic') {
    if (receipt.output?.production?.valid !== true || receipt.output?.visualOracle?.valid !== true)
      failures.push('production output or visual oracle unavailable');
    const oracle = receipt.output?.visualOracle;
    if (!oracle?.run || fileHash(join(oracle.run,'receipt.json')) !== oracle.receiptSha256 ||
        fileHash(join(oracle.run,'benchmark.json')) !== oracle.benchmarkSha256)
      failures.push('visual oracle source receipt or benchmark drifted');
  } else if (receipt.output?.image?.equal !== true || receipt.output.image?.differentPixels !== 0)
    failures.push('pinned image pixel output mismatch or unavailable');
  if (receipt.output?.hit === null) failures.push('hit fidelity unavailable');
  if (receipt.output?.hit?.sha256 && receipt.output.hit.sha256 !==
      receipt.artifacts?.find(a => a.path === 'hit-grid.txt')?.sha256)
    failures.push('hit grid differs from raw artifact');
  if (events.some(e => e.outcome === 'displayed') && receipt.presentations.count === null) failures.push('displayed without physical evidence');
  return [...new Set(failures)];
}
export function validateSpeedReceipt(r, events) {
  const failures = [];
  if (r.effective?.config?.captureMode !== 'speed' || r.profiler?.chromeTraceEnabled !== false ||
      r.profiler?.phaseHooksEnabled !== false || events.length ||
      r.artifacts?.some(a => a.path === 'trace.json')) failures.push('speed cell is traced or has phase hooks');
  if (r.benchmarkStatus?.exitCode !== 0 || r.benchmarkStatus?.parseFailure ||
      r.benchmarkStatus?.rejectedRepeats > 0 || r.benchmarkStatus?.crashedRepeats > 0)
    failures.push('benchmark process or repeat contract rejected');
  if (r.profiler?.chromeArgs?.some(arg => /perf-prof|cpu-prof|enable-precise-memory-info/.test(arg)))
    failures.push('speed cell has profiler Chrome switches');
  for (const name of ['source','wasm','glue','input','resources'])
    if (!r.hashes?.[name]?.before || r.hashes[name].before !== r.hashes[name].after)
      failures.push(`${name} missing or drifted`);
  if (r.serverProof?.served?.wasm?.matches !== true || r.serverProof?.servedAfter?.wasm?.matches !== true ||
      !['glue','serializer'].every(name => r.serverProof?.served?.[name]?.servedSha256 &&
        r.serverProof.served[name].servedSha256 === r.serverProof?.servedAfter?.[name]?.servedSha256))
    failures.push('served WASM/glue/serializer identity unavailable');
  if (!r.resourceDelivery?.count || !r.resourceDelivery?.sha256) failures.push('actual served resources unavailable');
  if (!(r.markers?.end > r.markers?.begin) || !r.clocks?.some(c => c.offsetUs === 0 && c.uncertaintyUs <= 1000))
    failures.push('page clock markers unavailable');
  if (!r.browser?.version || r.browser.mode !== 'launched' || !r.browser.binarySha256)
    failures.push('launched browser binary identity unavailable');
  if (!r.processes?.some(p => p.pid === r.browser.pid &&
      p.processStartBefore === r.browser.startIdentity &&
      p.processStartAfter === r.browser.startIdentity))
    failures.push('browser binary PID/start identity not joined to CPU process ledger');
  if (!r.hostIdentity?.kernelRelease || !r.hostIdentity.cpuModel || !r.hostIdentity.logicalCpus ||
      (r.gpu?.hardware && /NVIDIA/i.test(r.gpu.identity?.renderer ?? '') &&
        !r.hostIdentity.nvidiaDriver?.version))
    failures.push('host OS/kernel/CPU/driver identity unavailable');
  if (r.effective?.backend !== 'rust') failures.push('captured renderer is not Rust');
  if (!r.workload?.valid) failures.push('workload delivery mismatch');
  if (!r.output?.valid || r.output.hit?.equal !== true ||
      r.output.production?.valid !== true || r.output.visualOracle?.valid !== true)
    failures.push('production output, visual oracle, or hit fidelity mismatch');
  const oracle = r.output?.visualOracle;
  if (!oracle?.run || fileHash(join(oracle.run,'receipt.json')) !== oracle.receiptSha256 ||
      fileHash(join(oracle.run,'benchmark.json')) !== oracle.benchmarkSha256)
    failures.push('visual oracle source receipt or benchmark drifted');
  if (r.output?.framePin?.proof != null || /\s--(?:shot-clock-ms|parity-capture)\s/.test(r.command ?? ''))
    failures.push('speed cell used a diagnostic clock');
  if (!(r.presentations?.count > 0)) failures.push('actual physical presentations unavailable');
  if (r.gpu?.hardware === true && (!r.gpu.identity?.unmasked ||
      /SwiftShader|llvmpipe|software/i.test(r.gpu.identity.renderer ?? '')))
    failures.push('hardware GPU claim unverified');
  const processes = [...new Map((r.processes ?? []).map(p => [p.pid,p])).values()];
  if (!processes.length || !processes.some(p => /^renderer/i.test(p.role ?? '')) ||
      !processes.some(p => /^gpu/i.test(p.role ?? '')) || processes.some(p =>
        !p.processStartBefore || p.processStartBefore !== p.processStartAfter ||
        !Number.isFinite(p.processCpuMs) || p.processCpuMs < 0 ||
        !Number.isFinite(p.sampleBeforeEpochUs) || !Number.isFinite(p.sampleAfterEpochUs) ||
        !Number.isFinite(p.sampleClockUncertaintyUs) || p.sampleClockUncertaintyUs < 0 ||
        p.sampleBeforeEpochUs + p.sampleClockUncertaintyUs > r.markers.begin ||
        p.sampleAfterEpochUs - p.sampleClockUncertaintyUs < r.markers.end))
    failures.push('bounded /proc process CPU or PID start identity unavailable');
  if (!(r.profiler?.procClockTicksPerSecond > 0)) failures.push('proc CPU tick rate unavailable');
  if (![r.metrics?.rendererCpuMs?.value,r.metrics?.gpuProcessCpuMs?.value].every(Number.isFinite))
    failures.push('renderer or GPU process scheduled CPU unavailable');
  for (const [role,name] of [['renderer','rendererCpuMs'],['gpu','gpuProcessCpuMs']]) {
    const metric = r.metrics?.[name];
    const matching = processes.filter(row => String(row.role ?? '').toLowerCase().startsWith(role));
    const intervals = metric?.sampleIntervals ?? [];
    const maxOverhang = r.profiler?.maxProcOverhangMs ?? 25;
    if (metric?.scoreWindow !== 'proc-sample-interval' || metric.coverage !== null ||
        metric.method !== 'bounded /proc process utime+stime over sample intervals' ||
        intervals.length !== matching.length || !(maxOverhang > 0) ||
        intervals.some(interval => {
          const process = matching.find(row => row.pid === interval.pid);
          return !process || interval.beforeEpochUs !== process.sampleBeforeEpochUs ||
            interval.afterEpochUs !== process.sampleAfterEpochUs ||
            !Number.isFinite(interval.beforeOverhangMs) || !Number.isFinite(interval.afterOverhangMs) ||
            interval.beforeOverhangMs < 0 || interval.afterOverhangMs < 0 ||
            interval.beforeOverhangMs > maxOverhang || interval.afterOverhangMs > maxOverhang ||
            Math.abs(interval.beforeOverhangMs-(r.markers.begin-process.sampleBeforeEpochUs)/1000) > 1e-6 ||
            Math.abs(interval.afterOverhangMs-(process.sampleAfterEpochUs-r.markers.end)/1000) > 1e-6 ||
            interval.clockUncertaintyMs !== process.sampleClockUncertaintyUs/1000 ||
            interval.jiffyUncertaintyMs !== 2000/process.procClockTicksPerSecond;
        }) ||
        Math.abs(metric.value-matching.reduce((sum,row) => sum+row.processCpuMs,0)) > 1e-6)
      failures.push(`${role} CPU score lacks bounded sample-interval provenance`);
  }
  if (r.processCpuResidual?.some(row => row.threadOvercountMs != null &&
      row.threadOvercountMs > row.roundingUncertaintyMs))
    failures.push('process and thread CPU counters do not reconcile within clock-tick uncertainty');
  return [...new Set(failures)];
}
// CPU/output qualification is independent of the physical-presentation speed
// path and uses causal Node monotonic brackets for process CPU.
export function validateCpuOutputReceipt(r, events, benchmark) {
  const failures = [];
  if (r.effective?.config?.captureMode !== 'speed' ||
      r.profiler?.chromeTraceEnabled !== false || r.profiler?.phaseHooksEnabled !== false ||
      events.length || r.artifacts?.some(a => a.path === 'trace.json') ||
      r.profiler?.chromeArgs?.some(arg => /perf-prof|cpu-prof|enable-precise-memory-info/.test(arg)))
    failures.push('CPU/output cell is instrumented or not ordinary speed capture');
  if (r.benchmarkStatus?.exitCode !== 0 || r.benchmarkStatus?.parseFailure ||
      r.benchmarkStatus?.rejectedRepeats > 0 || r.benchmarkStatus?.crashedRepeats > 0)
    failures.push('benchmark process or repeat contract rejected');
  for (const name of ['source','wasm','glue','input','resources'])
    if (!r.hashes?.[name]?.before || r.hashes[name].before !== r.hashes[name].after)
      failures.push(`${name} missing or drifted`);
  if (r.serverProof?.served?.wasm?.matches !== true ||
      r.serverProof?.servedAfter?.wasm?.matches !== true ||
      !['glue','serializer'].every(name => r.serverProof?.served?.[name]?.servedSha256 &&
        r.serverProof.served[name].servedSha256 === r.serverProof?.servedAfter?.[name]?.servedSha256))
    failures.push('served WASM/glue/serializer identity unavailable');
  if (!r.resourceDelivery?.count || !r.resourceDelivery?.sha256)
    failures.push('actual served resources unavailable');
  const warmEnabled = (r.effective?.config?.benchArgs ?? []).includes('--resource-warm-pass');
  if (warmEnabled) {
    const proof = benchmark?.perRepeat?.[0]?.resourceWarmPass;
    const artifact = r.artifacts?.find(row => row.path === 'resource-warm-pass.json');
    const out = r.effective?.config?.captureOut;
    const warmRaw = out && fileHash(join(out,'resource-warm-pass.json')) === artifact?.sha256
      ? json(join(out,'resource-warm-pass.json')) : null;
    const resourceRaw = r.artifacts?.find(row => row.path === 'bench-served-resources.ndjson');
    const resourcePath = out && join(out,'bench-served-resources.ndjson');
    const resourceRecheck = resourcePath && fileHash(resourcePath) === resourceRaw?.sha256
      ? servedResourceHashes(resourcePath,'pinned','pinned',r.effective.config) : null;
    const resourceRows = resourceRecheck
      ? readFileSync(resourcePath,'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    const timingArtifact = r.artifacts?.find(row => row.path === 'resource-request-timing.ndjson');
    const timingPath = out && join(out,'resource-request-timing.ndjson');
    const timingRows = timingPath && fileHash(timingPath) === timingArtifact?.sha256
      ? readFileSync(timingPath,'utf8').split('\n').filter(Boolean).map(JSON.parse) : null;
    const requestKey = row => JSON.stringify({url:(() => { const u = new URL(row.url,'http://localhost');
      return u.pathname+u.search; })(),phase:row.phase,size:row.size,sha256:row.sha256});
    const servedKeys = resourceRows.map(requestKey).sort();
    const timingKeys = timingRows?.filter(row => row.status === 200).map(requestKey).sort();
    if (!proof || proof.status !== 'released' || proof.phase !== 'measured' ||
        !(proof.startEpochMs < proof.endEpochMs && proof.endEpochMs <= proof.releasedEpochMs) ||
        !(proof.releasedEpochMs*1000 < r.markers?.begin) ||
        proof.fetchRestored !== true || proof.pendingAckAtRelease !== 0 ||
        !Number.isInteger(proof.initialRevision) ||
        proof.warmFinalRevision !== proof.initialRevision+proof.sceneDeliveries ||
        proof.releaseBaseRevision !== proof.warmFinalRevision ||
        !(proof.releaseBasePresentEpoch >= proof.warmFinalPresentEpoch) ||
        !(proof.releaseBaseBuildEpoch >= proof.warmFinalBuildEpoch) ||
        proof.measuredFirstRevision !== proof.releaseBaseRevision+1 ||
        !(proof.measuredFirstPresentEpoch > proof.releaseBasePresentEpoch) ||
        !(proof.measuredFirstBuildEpoch > proof.releaseBaseBuildEpoch) ||
        !proof.rendererBefore || JSON.stringify(proof.rendererBefore) !== JSON.stringify(proof.rendererAfter) ||
        JSON.stringify(proof.rendererAfter) !== JSON.stringify(proof.rendererAtEnd?.instance ?? null) ||
        !Array.isArray(proof.requiredUrls) || proof.requiredUrls.length === 0 ||
        !Array.isArray(proof.fetches) || proof.fetchDropped !== 0 ||
        proof.fetches?.some(row => !row.initiator || !Number.isFinite(row.startEpochMs) ||
          !Number.isFinite(row.endEpochMs) || row.endEpochMs < row.startEpochMs) ||
        proof.requiredUrls?.some(path => !proof.fetches.some(row => row.phase === 'warm' &&
          row.status === 200 && row.rustExecutorOwned === true &&
          /\bat prefetch\b/.test(row.initiator ?? '') &&
          /\/createRustDrawListExecutor\.ts(?:\?|:|\b)/.test(row.initiator ?? '') &&
          row.endEpochMs <= proof.endEpochMs &&
          new URL(row.url,'http://localhost').pathname === path)) ||
        !artifact?.sha256 || JSON.stringify(warmRaw?.proof) !== JSON.stringify(proof) ||
        !resourceRecheck || resourceRaw?.sha256 !== r.resourceDelivery?.rawSha256 ||
        resourceRecheck.canonicalSha256 !== r.resourceDelivery?.sha256 ||
        JSON.stringify(resourceRecheck.phases) !== JSON.stringify(r.resourceDelivery?.phases) ||
        !timingRows || timingRows.length !== resourceRows.length ||
        timingRows.some(row => row.status !== 200 || !/^\d+$/.test(row.requestStartNodeNs ?? '') ||
          !/^\d+$/.test(row.bodyReadyNodeNs ?? '') ||
          BigInt(row.bodyReadyNodeNs) < BigInt(row.requestStartNodeNs)) ||
        JSON.stringify(timingKeys) !== JSON.stringify(servedKeys) ||
        proof?.requiredUrls?.some(path =>
          !resourceRows.some(row => row.phase === 'warm' && new URL(row.url,'http://localhost').pathname === path) ||
          resourceRows.some(row => row.phase === 'measured' && new URL(row.url,'http://localhost').pathname === path)) ||
        !r.resourceDelivery?.phases?.warm?.count || !r.resourceDelivery?.phases?.measured)
      failures.push('warm-resource preparation, same renderer, or phase request ledger unavailable');
  }
  if (!(r.markers?.end > r.markers?.begin) ||
      r.markers?.begin !== benchmark?.perRepeat?.[0]?.pageMarkerClock?.beginEpochUs ||
      r.markers?.end !== benchmark?.perRepeat?.[0]?.pageMarkerClock?.endEpochUs)
    failures.push('direct page marker identity unavailable');
  if (!r.browser?.version || r.browser.mode !== 'launched' || !r.browser.binarySha256 ||
      !r.processes?.some(p => p.pid === r.browser.pid &&
        p.processStartBefore === r.browser.startIdentity &&
        p.processStartAfter === r.browser.startIdentity))
    failures.push('launched browser binary or PID/start identity unavailable');
  if (!r.hostIdentity?.kernelRelease || !r.hostIdentity.cpuModel ||
      !Number.isInteger(r.hostIdentity.logicalCpus) || r.hostIdentity.logicalCpus < 1 ||
      (r.gpu?.hardware && /NVIDIA/i.test(r.gpu.identity?.renderer ?? '') &&
        !r.hostIdentity.nvidiaDriver?.version))
    failures.push('host OS/kernel/CPU/driver identity unavailable');
  if (r.effective?.backend !== 'rust' || r.gpu?.hardware !== true ||
      !r.gpu?.identity?.unmasked || /SwiftShader|llvmpipe|software/i.test(r.gpu.identity.renderer ?? ''))
    failures.push('hardware Rust WebGL2 backend unavailable');
  if (!r.workload?.valid || !r.output?.valid || r.output.hit?.equal !== true ||
      r.output.production?.valid !== true || r.output.visualOracle?.valid !== true)
    failures.push('workload, ordinary output, fixed-clock oracle, or semantic hits unavailable');
  const oracle = r.output?.visualOracle;
  if (!oracle?.run || fileHash(join(oracle.run,'receipt.json')) !== oracle.receiptSha256 ||
      fileHash(join(oracle.run,'benchmark.json')) !== oracle.benchmarkSha256)
    failures.push('fixed-clock oracle raw identity unavailable');
  if (r.output?.framePin?.proof != null || /\s--(?:shot-clock-ms|parity-capture)\s/.test(r.command ?? ''))
    failures.push('ordinary cell used a diagnostic clock');
  if (r.presentations?.count != null || r.metrics?.actualPresentations?.value != null)
    failures.push('CPU/output cell must not assert physical presentations');
  if (r.metrics?.gpuExecutionMs?.value != null)
    failures.push('CPU/output cell must not assert GPU execution');
  const args = r.effective?.config?.benchArgs ?? [];
  const index = args.indexOf('--window');
  const match = index >= 0 ? /^(\d+):(\d+)$/.exec(args[index+1] ?? '') : null;
  const expected = match ? {startMs:Number(match[1]),endMs:Number(match[2])} : null;
  const raw = productionWindowProof(benchmark?.perRepeat?.[0],expected);
  if (!expected || expected.startMs !== 12000 || expected.endMs !== 19000 ||
      !raw.valid || JSON.stringify(raw) !== JSON.stringify(r.output?.production))
    failures.push('raw 12–19 s ordinary output proof unavailable or differs from receipt');
  if (benchmark?.perRepeat?.length !== 1 || !r.workload?.observed?.length ||
      r.workload.observed.length !== 1 ||
      r.workload.observed[0]?.replayDelivery?.final?.deliveryLedger?.dropped !== 0)
    failures.push('single-repeat full delivery ledger unavailable');
  if (!Number.isInteger(raw.deliveryTiming?.deliveredInWindow) ||
      raw.deliveryTiming.deliveredInWindow !== raw.delivery.after-raw.delivery.before ||
      raw.deliveryTiming.firstDeliveredIndex == null ||
      raw.deliveryTiming.lastDeliveredIndex == null)
    failures.push('actual marker-window deliveries differ from boundary count');
  const unique = [...new Map((r.processes ?? []).map(row => [row.pid,row])).values()];
  if (!unique.some(row => /^renderer/i.test(row.role ?? '')) ||
      !unique.some(row => /^gpu/i.test(row.role ?? '')) ||
      unique.some(row => !markerCpuInterval(row,r.markers,r.hostIdentity?.logicalCpus)))
    failures.push('causal Node /proc process CPU interval unavailable');
  return [...new Set(failures)];
}

export function markerCpuInterval(row, markers, logicalCpus, thread = false) {
  const clock = row?.procClockTicksPerSecond;
  const cpu = thread ? row?.cpuMs : row?.processCpuMs;
  const startBefore = thread ? row?.threadStartBefore : row?.processStartBefore;
  const startAfter = thread ? row?.threadStartAfter : row?.processStartAfter;
  const beforeStart = thread ? row?.threadReadBeforeStartMs : row?.processReadBeforeStartMs;
  const beforeEnd = thread ? row?.threadReadBeforeEndMs : row?.processReadBeforeEndMs;
  const afterStart = thread ? row?.threadReadAfterStartMs : row?.processReadAfterStartMs;
  const afterEnd = thread ? row?.threadReadAfterEndMs : row?.processReadAfterEndMs;
  const calls = markers?.nodeCalls;
  if (!Number.isFinite(cpu) || cpu < 0 || !(clock > 0) ||
      !startBefore || startBefore !== startAfter ||
      !Number.isInteger(logicalCpus) || logicalCpus < 1 ||
      ![beforeStart,beforeEnd,afterStart,afterEnd,calls?.openStartMs,calls?.openEndMs,
        calls?.closeStartMs,calls?.closeEndMs].every(Number.isFinite) ||
      !Number.isFinite(markers?.begin) || !Number.isFinite(markers?.end) ||
      beforeStart > beforeEnd || beforeEnd > calls.openStartMs ||
      calls.openStartMs > calls.openEndMs || calls.openEndMs > calls.closeStartMs ||
      calls.closeStartMs > calls.closeEndMs || calls.closeEndMs > afterStart ||
      afterStart > afterEnd || markers.begin >= markers.end) return null;
  const roundingMs = 2000/clock;
  const overhangMs = calls.openEndMs-beforeStart+afterEnd-calls.closeStartMs;
  const overhangCpuMs = Math.min(cpu+roundingMs,(thread ? 1 : logicalCpus)*overhangMs);
  return {lowerMs:Math.max(0,cpu-roundingMs-overhangCpuMs),upperMs:cpu+roundingMs,
    sampledCpuMs:cpu,roundingMs,overhangMs,overhangCpuMs,
    method:'marker-window /proc interval with tick and multicore overhang bounds'};
}

export function conservativeCpuSaving(control, candidate) {
  if (control.length < 3 || candidate.length < 2 ||
      [...control,...candidate].some(row => !row ||
        !Number.isFinite(row.lowerMs) || !Number.isFinite(row.upperMs) ||
        row.lowerMs < 0 || row.upperMs < row.lowerMs)) return null;
  const spreadMs = Math.max(...control.map(row => row.upperMs))-
    Math.min(...control.map(row => row.lowerMs));
  const lowerControlMs = Math.min(...control.map(row => row.lowerMs));
  const savingMs = lowerControlMs-Math.max(...candidate.map(row => row.upperMs));
  return {spreadMs,savingMs,savingPct:lowerControlMs > 0 ? 100*savingMs/lowerControlMs : null,
    exceedsSpread:savingMs > spreadMs};
}

export function duplicateProcessDisagreements(rows) {
  const fields = ['role','processStartBefore','processStartAfter','processCpuTicksBefore',
    'processCpuTicksAfter','processCpuMs','processReadBeforeStartMs','processReadBeforeEndMs',
    'processReadAfterStartMs','processReadAfterEndMs','procClockTicksPerSecond'];
  const seen = new Map(), failures = [];
  for (const row of rows) {
    if (!Number.isInteger(row.pid)) { failures.push('process PID unavailable'); continue; }
    const signature = JSON.stringify(fields.map(name => row[name] ?? null));
    if (seen.has(row.pid) && seen.get(row.pid) !== signature)
      failures.push(`PID ${row.pid} has inconsistent repeated process evidence`);
    else seen.set(row.pid,signature);
  }
  return [...new Set(failures)];
}

export function compareCpuOutputCells(cells) {
  const failures = [];
  const controls = cells.filter(cell => cell.label === 'control');
  const candidates = cells.filter(cell => cell.label === 'candidate');
  if (controls.length !== 3 || ![0,2].includes(candidates.length) ||
      cells.some(cell => !['control','candidate'].includes(cell.label)))
    failures.push('predeclared control/candidate cell count unavailable');
  const reference = controls[0]?.receipt;
  let referenceWork = null;
  const reports = cells.map((cell,index) => {
    const r = cell.receipt, benchmark = cell.benchmark;
    const cellFailures = validateCpuOutputReceipt(r,cell.events ?? [],benchmark);
    if (reference && (comparableEnvironment(reference,r).length ||
        !comparableProductionOutput(reference,r) ||
        ['input','resources','hitReference','imageReference'].some(name =>
          r.hashes?.[name]?.before !== reference.hashes?.[name]?.before) ||
        r.effective?.config?.quality !== reference.effective?.config?.quality ||
        r.effective?.config?.effects !== reference.effective?.config?.effects ||
        JSON.stringify(r.effective?.benchmark) !== JSON.stringify(reference.effective?.benchmark) ||
        JSON.stringify(r.gpu?.identity) !== JSON.stringify(reference.gpu?.identity)))
      cellFailures.push('environment, workload, resource, or output mismatch');
    if (reference &&
        (['source','wasm','glue'].some(name => r.hashes?.[name]?.before !== reference.hashes?.[name]?.before) ||
         r.serverProof?.served?.serializer?.servedSha256 !==
           reference.serverProof?.served?.serializer?.servedSha256))
      cellFailures.push('cohort source or artifact differs');
    const rows = r.processes ?? [];
    cellFailures.push(...duplicateProcessDisagreements(rows));
    const processes = [...new Map(rows.map(row => [row.pid,row])).values()];
    const roles = ['renderer','gpu'];
    const cpu = Object.fromEntries(roles.map(role => {
      const matching = processes.filter(row => String(row.role ?? '').toLowerCase().startsWith(role));
      const parts = matching.map(row => markerCpuInterval(row,r.markers,r.hostIdentity?.logicalCpus));
      return [role,matching.length && parts.every(Boolean) ? {
        lowerMs:parts.reduce((sum,part) => sum+part.lowerMs,0),
        upperMs:parts.reduce((sum,part) => sum+part.upperMs,0),
        sampledCpuMs:parts.reduce((sum,part) => sum+part.sampledCpuMs,0),
        byProcess:matching.map((row,i) => ({pid:row.pid,...parts[i]}))} : null];
    }));
    if (!cpu.renderer || !cpu.gpu) cellFailures.push('marker-window renderer or GPU process CPU unavailable');
    const rendererThreads = rows.filter(row => String(row.role ?? '').toLowerCase().startsWith('renderer'))
      .map(row => ({pid:row.pid,tid:row.tid,kind:row.pid === row.tid ? 'main' : 'other',
        interval:markerCpuInterval(row,r.markers,r.hostIdentity?.logicalCpus,true)}));
    if (!rendererThreads.some(row => row.kind === 'main' && row.interval) ||
        rendererThreads.some(row => !row.interval))
      cellFailures.push('renderer main or other TID marker CPU unavailable');
    const proof = r.output?.production;
    const usefulWork = {scheduledMessages:proof?.deliveryTiming?.inWindow ?? null,
      deliveredMessages:proof?.deliveryTiming?.deliveredInWindow ?? null,
      firstDeliveredIndex:proof?.deliveryTiming?.firstDeliveredIndex ?? null,
      lastDeliveredIndex:proof?.deliveryTiming?.lastDeliveredIndex ?? null,
      completedFrames:proof?.frame?.completedAfter != null && proof?.frame?.completedBefore != null
        ? proof.frame.completedAfter-proof.frame.completedBefore : null,
      revisionDelta:proof?.frame?.after?.revision != null && proof?.frame?.before?.revision != null
        ? proof.frame.after.revision-proof.frame.before.revision : null};
    if (!index) referenceWork = usefulWork;
    if (index && ['scheduledMessages','deliveredMessages','firstDeliveredIndex',
      'lastDeliveredIndex','revisionDelta'].some(key =>
      usefulWork[key] !== referenceWork[key]))
      cellFailures.push('scheduled, delivered, or scene-revision work differs');
    failures.push(...cellFailures.map(failure => `cell ${index+1}: ${failure}`));
    return {label:cell.label,runId:r.runId,eligible:cellFailures.length === 0,failures:cellFailures,
      usefulWork,markerWindowMs:r.markers?.end != null && r.markers?.begin != null
        ? (r.markers.end-r.markers.begin)/1000 : null,
      cpu:{rendererProcess:cpu.renderer,gpuProcess:cpu.gpu,rendererThreads},
      physicalPresentations:null,framesPerSecond:null,gpuExecutionMs:null};
  });
  const controlFrames = reports.filter(row => row.label === 'control')
    .map(row => row.usefulWork.completedFrames);
  if (controlFrames.length && controlFrames.every(Number.isFinite)) {
    const minimum = Math.max(...controlFrames);
    for (const [index,row] of reports.entries()) if (row.label === 'candidate' &&
        (!(row.usefulWork.completedFrames >= minimum))) {
      row.failures.push('candidate completed fewer frames than a contemporary control');
      row.eligible = false;
      failures.push(`cell ${index+1}: candidate completed fewer frames than a contemporary control`);
    }
  } else failures.push('control completed-frame count unavailable');
  let saving = null;
  if (!failures.length && candidates.length) {
    const control = reports.filter(row => row.label === 'control').map(row => row.cpu.rendererProcess);
    const candidate = reports.filter(row => row.label === 'candidate').map(row => row.cpu.rendererProcess);
    saving = conservativeCpuSaving(control,candidate);
  }
  return {schema:'canvas-cpu-output-comparison/1',comparable:failures.length === 0,
    failures,reports,saving,physicalPresentations:null,framesPerSecond:null,gpuExecutionMs:null};
}
export function validateTraceOnlyDiagnostic(r, events) {
  const failures = ['trace-only diagnostic has no Rust phase hooks and cannot qualify a speed claim'];
  if (r.profiler?.chromeTraceEnabled !== true || r.profiler?.phaseHooksEnabled !== false || events.length)
    failures.push('trace-only mode or event population disagrees with receipt');
  if (!Number.isFinite(r.markers?.begin) || !Number.isFinite(r.markers?.end) ||
      r.markers.end <= r.markers.begin)
    failures.push('direct trace marker identity unavailable');
  if (r.losses?.trace !== 0) failures.push('Chrome trace loss unavailable or nonzero');
  if (Object.values(r.hashes ?? {}).some(row => !row?.before || row.before !== row.after))
    failures.push('source, artifact, input, reference, or resource hash mismatch');
  if (r.workload?.valid !== true) failures.push('workload delivery unverified');
  if (r.output?.valid !== true) failures.push('pinned image, frame, or hits unverified');
  if (r.presentations?.count == null) failures.push('actual content presentations unavailable');
  return failures;
}
export function validateVisualOnlyDiagnostic(r, events) {
  const failures = ['visual-only diagnostic has no direct trace markers and cannot qualify a speed claim'];
  if (r.effective?.config?.captureMode !== 'visual' ||
      r.profiler?.chromeTraceEnabled !== false || r.profiler?.phaseHooksEnabled !== false || events.length)
    failures.push('visual-only mode or event population disagrees with receipt');
  if (Object.values(r.hashes ?? {}).some(row => !row?.before || row.before !== row.after))
    failures.push('source, artifact, input, reference, or resource hash mismatch');
  if (r.workload?.valid !== true) failures.push('workload delivery unverified');
  if (r.output?.valid !== true) failures.push('pinned image, frame, or hits unverified');
  if (r.presentations?.count == null) failures.push('actual content presentations unavailable');
  return failures;
}
function cpuAttribution(samples, threads) {
  const allThreads = [...threads];
  for (const sample of samples) if (!allThreads.some(t => t.tid === sample.tid))
    allThreads.push({ tid: sample.tid, role: 'unidentified thread' });
  const byThread = allThreads.map(t => {
    const named = samples.filter(s => s.tid === t.tid && s.symbol && s.symbol !== '[unknown]');
    const total = samples.filter(s => s.tid === t.tid);
    return { tid: t.tid, role: t.role, samples: total.length, namedLeafSamples: named.length,
      unresolvedSamples: total.length - named.length, denominator: total.length };
  });
  return { unit: 'unweighted samples', byThread, total: byThread.reduce((n,t) => n+t.samples,0),
    unresolved: byThread.reduce((n,t) => n+t.unresolvedSamples,0) };
}
function validateV8Deltas(profile) {
  const health = profileTimingHealth(profile);
  return { ...health, timedAttribution: health.timingShapeValid &&
    Array.isArray(profile?.timeDeltas) && profile.timeDeltas.every(x => Number.isFinite(x) && x > 0) };
}
export function qualifiedSamples(receiptValue, runDir) {
  const path = join(runDir,'samples.json');
  if (!existsSync(path)) return {samples:[],failures:[]};
  const artifact = receiptValue.artifacts?.find(a => a.path === 'samples.json');
  if (!artifact || fileHash(path) !== artifact.sha256)
    return {samples:[],failures:['symbol sample artifact missing or hash drift']};
  const value = json(path), samples = value.samples;
  if (value.schema !== 'canvas-profile-samples/1' || value.runId !== receiptValue.runId ||
      !Array.isArray(samples) || samples.some(sample =>
        !receiptValue.processes.some(p => p.pid === sample.pid && p.tid === sample.tid &&
          p.startIdentity === sample.processStartIdentity) ||
        !Number.isFinite(sample.timestampUs) || sample.timestampUs < receiptValue.markers.begin ||
        sample.timestampUs > receiptValue.markers.end ||
        !['js','wasm','native','unknown'].includes(sample.category)))
    return {samples:[],failures:['symbol samples lack raw PID/TID/marker identity']};
  return {samples,failures:[]};
}
function bindEvidence(receiptValue, evidence, benchmarkSha256, runDir) {
  if (evidence.schema !== 'canvas-profile-evidence/1' || evidence.runId !== receiptValue.runId ||
      evidence.benchmarkSha256 !== benchmarkSha256)
    throw new Error('evidence sidecar is not bound to this capture');
  if (evidence.markers && (evidence.markers.begin !== receiptValue.markers.begin ||
      evidence.markers.end !== receiptValue.markers.end))
    throw new Error('evidence marker identity differs from raw trace');
  if (evidence.processes || evidence.clocks || evidence.losses || evidence.symbols || evidence.gpu || evidence.markers?.rust)
    throw new Error('raw process, clock, loss, GPU and Rust-mark facts cannot be replaced by sidecar');
  for (const artifact of evidence.artifacts ?? []) {
    const path = resolve(runDir, artifact.path);
    if (!path.startsWith(resolve(runDir)+'/') || fileHash(path) !== artifact.sha256)
      throw new Error('evidence artifact missing or hash mismatch');
  }
  const boundArtifactPath = (name, path) => {
    if (!path || !(evidence.artifacts ?? []).some(a => resolve(runDir,a.path) === resolve(runDir,path)))
      throw new Error(`${name} requires its own hashed artifact`);
    return resolve(runDir,path);
  };
  const readBoundArtifact = (name, path) => json(boundArtifactPath(name,path));
  if (evidence.workload?.valid === true) {
    const delivery = readBoundArtifact('workload', evidence.workload.artifact);
    if (delivery.schema !== 'canvas-replay-delivery/1' || delivery.runId !== receiptValue.runId ||
        delivery.inputSha256 !== receiptValue.hashes.input.before ||
        delivery.inputSha256 !== receiptValue.workload.recordingSha256 ||
        delivery.markerBegin !== receiptValue.markers.begin || delivery.markerEnd !== receiptValue.markers.end ||
        !Number.isInteger(delivery.expectedCount) || delivery.expectedCount < 1 ||
        delivery.deliveredCount !== delivery.expectedCount || delivery.failedCount !== 0 ||
        !receiptValue.workload.observed?.every(row => row.replayDelivery?.final?.done === true &&
          row.replayDelivery.final.index === row.replayDelivery.count &&
          row.replayDelivery.count === delivery.expectedCount &&
          row.replayDelivery.final.prefixSha256 === receiptValue.workload.replayMessageSha256 &&
          row.replayDelivery.final.delivered === delivery.deliveredCount) ||
        receiptValue.workload.observed?.some(row => !row.ready || row.pending !== 0 || row.failed !== 0))
      throw new Error('workload delivery proof disagrees with captured replay');
  }
  if (evidence.output?.valid === true) {
    const hit = readBoundArtifact('output hit fidelity',evidence.output.hitArtifact);
    boundArtifactPath('output image',evidence.output.imageArtifact);
    if (!/\.png$/.test(evidence.output.imageArtifact) ||
        hit.schema !== 'canvas-hit-oracle/1' || hit.runId !== receiptValue.runId ||
        hit.inputSha256 !== receiptValue.hashes.input.before || hit.equal !== true ||
        !receiptValue.output.observed?.length ||
        receiptValue.output.observed.some(row => !row.witness ||
          row.witness.sampleHits !== row.witness.sampleCount || row.witness.sampleCount < 1 ||
          !row.witness.screenshot ||
          fileHash(resolve(REPO_ROOT,row.witness.screenshot)) !== fileHash(boundArtifactPath('output image',evidence.output.imageArtifact)) ||
          hit.sampleHits !== row.witness.sampleHits || hit.sampleCount !== row.witness.sampleCount))
      throw new Error('output fidelity proof disagrees with captured witness');
    if (!receiptValue.output.valid || hit.gridSha256 !== receiptValue.output.hit?.sha256)
      throw new Error('output hit sidecar does not match first-party hit grid');
  }
  let physicalClock = null;
  if (evidence.presentations?.count != null) {
    const display = readBoundArtifact('actual presentations',evidence.presentations.artifact);
    const allowed = new Set(['Android SurfaceFlinger','Android FrameTimeline','DRM pageflip']);
    const ids = display.frames?.map(row => String(row.contentId)) ?? [];
    if (display.schema !== 'canvas-physical-presentations/1' || display.runId !== receiptValue.runId ||
        display.markerBegin !== receiptValue.markers.begin || display.markerEnd !== receiptValue.markers.end ||
        !allowed.has(display.source) || evidence.presentations.source !== display.source ||
        evidence.presentations.count !== ids.length || ids.length === 0 ||
        new Set(ids).size !== ids.length || !display.layerId ||
        display.frames.some(frame => String(frame.layerId) !== String(display.layerId)))
      throw new Error('display-layer proof lacks distinct bound content presentations');
    const physical = readBoundArtifact('physical trace',display.rawArtifact);
    if (physical.schema !== 'canvas-physical-trace/1' || physical.runId !== receiptValue.runId ||
        !['Perfetto FrameTimeline','DRM pageflip'].includes(physical.producer) ||
        !Array.isArray(physical.traceEvents) || physical.dataLossOccurred !== false ||
        physical.lostEvents !== 0)
      throw new Error('physical presentation proof requires a separately captured raw trace');
    const compositor = physical.processes?.find(p => p.pid === display.pid && p.role === 'compositor');
    if (!compositor || !display.processStartIdentity ||
        compositor.startBefore !== display.processStartIdentity ||
        compositor.startAfter !== display.processStartIdentity)
      throw new Error('external compositor PID/start identity is absent or stale in physical trace');
    const trace = physical.traceEvents;
    const sync = trace.filter(event => event.name === 'ProfileClockSync' && event.args?.runId === receiptValue.runId);
    const beginSync = sync.find(event => event.args?.edge === 'begin');
    const endSync = sync.find(event => event.args?.edge === 'end');
    const beginOffset = beginSync && receiptValue.markers.begin - beginSync.ts;
    const endOffset = endSync && receiptValue.markers.end - endSync.ts;
    if (!beginSync || !endSync || !physical.clockDomain ||
        !Number.isFinite(beginOffset) || !Number.isFinite(endOffset) ||
        Math.abs(beginOffset-endOffset) > 2000 ||
        beginSync.pid !== display.pid || endSync.pid !== display.pid ||
        !Number.isInteger(beginSync.tid) || !Number.isInteger(endSync.tid) ||
        !Number.isFinite(beginSync.args?.uncertaintyUs) || beginSync.args.uncertaintyUs < 0 ||
        !Number.isFinite(endSync.args?.uncertaintyUs) || endSync.args.uncertaintyUs < 0)
      throw new Error('physical trace clock or process identity cannot be joined to direct markers');
    const offset = (beginOffset+endOffset)/2;
    const uncertaintyUs = Math.max(1000,Math.max(beginSync.args.uncertaintyUs,
      endSync.args.uncertaintyUs)+Math.abs(beginOffset-endOffset)/2);
    if (uncertaintyUs > 2000)
      throw new Error('physical trace clock uncertainty exceeds 2000 microseconds');
    physicalClock = {from:physical.clockDomain,to:'performance.timeOrigin+now',offsetUs:offset,
      uncertaintyUs,method:'paired raw ProfileClockSync events with source uncertainty'};
    const actual = (trace ?? []).filter(event =>
      event.name === 'ActualContentPresentation' &&
      ['surfaceflinger.frame_timeline','drm.pageflip'].includes(event.cat) &&
      event.ts+offset-uncertaintyUs >= receiptValue.markers.begin &&
      event.ts+offset+uncertaintyUs <= receiptValue.markers.end &&
      event.pid === display.pid && Number.isInteger(event.tid) &&
      event.args?.contentId != null && event.args?.displayId != null &&
      String(event.args?.layerId) === String(display.layerId));
    const tokens = actual.map(event => String(event.args.contentId));
    if (actual.length !== ids.length || tokens.some(token => !ids.includes(token)) ||
        new Set(tokens).size !== tokens.length ||
        display.frames.some(frame => !actual.some(event => String(event.args.contentId) === String(frame.contentId) &&
          event.ts === frame.timestampUs && String(event.args.displayId) === String(frame.displayId) &&
          String(event.args.layerId) === String(frame.layerId))))
      throw new Error('physical presentation sidecar is not independently present in physical trace');
  }
  if (evidence.benchmarkContract?.path && !(evidence.artifacts ?? []).some(a =>
    resolve(runDir,a.path) === resolve(evidence.benchmarkContract.path)))
    throw new Error('benchmark contract must be a hashed evidence artifact');
  return { ...receiptValue,
    clocks:[...(receiptValue.clocks ?? []),...(physicalClock ? [physicalClock] : [])],
    workload: { ...receiptValue.workload, ...(evidence.workload ?? {}) },
    output: receiptValue.output,
    presentations: evidence.presentations ?? receiptValue.presentations,
    metrics: { ...receiptValue.metrics,
      actualPresentations: evidence.presentations?.count != null
        ? {value:evidence.presentations.count,unit:'count',method:'raw trace ActualContentPresentation matched to display sidecar',coverage:1}
        : receiptValue.metrics.actualPresentations },
    benchmarkContract: evidence.benchmarkContract ?? receiptValue.benchmarkContract,
    artifacts: [...receiptValue.artifacts, ...(evidence.artifacts ?? [])] };
}
export { receipt, validate, cpuAttribution, capabilities, validateV8Deltas, bindEvidence };
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    if (command === 'probe') {
      const config = json(resolve(opt('config'))), out = opt('out');
      const result = capabilities(config); if (out) { mkdirSync(resolve(out), { recursive: false }); save(join(resolve(out),'capabilities.json'), result); }
      console.log(JSON.stringify(result));
    } else if (command === 'capture') {
      const config = json(resolve(opt('config'))), out = resolve(opt('out'));
      if (config.browserExecutable &&
          (!/^[0-9a-f]{64}$/.test(config.browserExecutableSha256 ?? '') ||
           fileHash(resolve(config.browserExecutable)) !== config.browserExecutableSha256))
        throw new Error('pinned browser executable hash missing or differs before capture');
      if (!['speed','production-diagnostic'].includes(config.captureMode) &&
          (!Number.isFinite(config.shotClockMs) || config.shotClockMs < 0))
        throw new Error('diagnostic capture requires shotClockMs for a pinned final-frame image');
      if (['speed','production-diagnostic'].includes(config.captureMode) && config.shotClockMs != null)
        throw new Error('production capture must keep the ordinary clock throughout replay and final witness');
      if (!['speed','diagnostic','visual','visual-diagnostic','visual-phase-diagnostic','display','production-diagnostic'].includes(config.captureMode))
        throw new Error('unknown captureMode');
      if (!['diagnostic','visual-phase-diagnostic','production-diagnostic'].includes(config.captureMode) && config.phases)
        throw new Error('only diagnostic captures may enable phase hooks');
      if (['visual-phase-diagnostic','production-diagnostic'].includes(config.captureMode) && config.phases !== true)
        throw new Error('phase diagnostic requires phase hooks');
      if (existsSync(out)) throw new Error('capture output directory already exists');
      const requiredLeaseResources = config.requiredLeaseResources ?? [];
      const activeLease = requiredLeaseResources.length ? assertLiveLease({
        owner: process.env.COUCHCOOP_LIVEQA_OWNER,
        pid: Number(process.env.COUCHCOOP_LIVEQA_PID),
        resources: requiredLeaseResources
      }) : null;
      mkdirSync(dirname(out), { recursive: true });
      mkdirSync(out, { recursive: false });
      if (activeLease) save(join(out, 'lease-active.json'), {
        schema: 'canvas-profile-active-lease/1',
        capturedAt: new Date().toISOString(),
        requiredResources: requiredLeaseResources,
        lease: activeLease
      });
      const runId = randomUUID(), before = hashes(config);
      config.captureOut = out;
      const url = new URL(config.url); if (config.phases) url.searchParams.set('canvasProfileRun', runId);
      if (config.captureMode === 'display') url.searchParams.set('contentTrace','1');
      if (['visual','visual-diagnostic','visual-phase-diagnostic','display'].includes(config.captureMode)) url.searchParams.set('paintDump', '1');
      if ((config.benchArgs ?? []).includes('--connect-cdp') ||
          ((config.benchArgs ?? []).includes('--headed') && config.captureMode !== 'display'))
        throw new Error('only display captures may open a visible browser; attached browsers are unsupported');
      const traceCapture = ['diagnostic','visual-diagnostic','visual-phase-diagnostic','display','production-diagnostic']
        .includes(config.captureMode);
      const ordinaryCapture = ['speed','production-diagnostic'].includes(config.captureMode);
      const benchArgs = ['scripts/bench-mirror-replay.mjs', '--url', url.toString(), '--recording', resolve(config.recording),
        '--repeats', String(config.repeats ?? 1), '--quality', config.quality ?? 'auto', '--effects', config.effects ? 'on' : 'off',
        '--report', join(out,'bench-report.json'),
        ...(traceCapture ? ['--trace',join(out,'trace.json')] : ['--untraced-report']),
        '--result-json',join(out,'benchmark.json'),'--served-manifest',join(out,'bench-served-resources.ndjson'),
        '--hit-grid', join(out,'hit-grid.txt'),
        '--shot', join(out,'final.png'), '--shot-force',
        ...(config.browserExecutable ? ['--browser-executable',resolve(config.browserExecutable),
          '--browser-executable-sha256',config.browserExecutableSha256] : []),
        ...(ordinaryCapture ? [] : ['--shot-clock-ms', String(config.shotClockMs)]),
        ...(['visual','visual-diagnostic','visual-phase-diagnostic','display'].includes(config.captureMode) ? ['--parity-capture',join(out,'parity.json'),
          '--parity-clock-ms',String(config.shotClockMs),'--parity-after-drain'] : []),
        ...(config.resRoot ? ['--res-root', resolve(config.resRoot)] : []), ...(config.benchArgs ?? [])];
      benchArgs.push('--asset-cache-root', resolve(config.assetCacheRoot));
      let proc;
      const running = await startScratchServer(config,out);
      try { proc = spawnSync(process.execPath, benchArgs, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64*1024*1024 });
        const postProof = await postCaptureServerProof(running.proof,config);
        postProof.serverExitCodeAfterBench = running.server.exitCode;
        postProof.assetServerExitCodeAfterBench = running.assets.exitCode;
        try { process.kill(running.server.pid,0); postProof.serverAliveAfterBench = true; }
        catch { postProof.serverAliveAfterBench = false; }
        save(join(out,'server-proof.json'),postProof);
      }
      finally { try { process.kill(-running.server.pid,'SIGTERM'); } catch {}
        try { process.kill(-running.assets.pid,'SIGTERM'); } catch {}
        writeFileSync(join(out,'vite.log'),running.log.join(''));
        writeFileSync(join(out,'assets.log'),running.assetLog.join('')); }
      writeFileSync(join(out,'bench.stdout.txt'), proc.stdout ?? ''); writeFileSync(join(out,'bench.stderr.txt'), proc.stderr ?? '');
      let benchmark = {}, benchmarkParseFailure = null;
      try { benchmark = json(join(out,'benchmark.json')); }
      catch (error) { benchmarkParseFailure = `synchronous BENCH_RESULT artifact unavailable or malformed: ${error.message}`;
        if (!existsSync(join(out,'benchmark.json'))) save(join(out,'benchmark.json'),{}); }
      const traceMetaPath = join(out,'trace.json.meta.json');
      benchmark.traceLoss = existsSync(traceMetaPath)
        ? (json(traceMetaPath).dataLossOccurred === true ? 1
          : json(traceMetaPath).dataLossOccurred === false ? 0 : null) : null;
      for (const [index, row] of (benchmark.perRepeat ?? []).entries()) {
        const shot = row.outputWitness?.screenshot;
        if (shot && fileHash(resolve(REPO_ROOT,shot))) copyFileSync(resolve(REPO_ROOT,shot),join(out,`witness-r${index}.png`));
      }
      const servedResources = servedResourceHashes(join(out,'bench-served-resources.ndjson'),before.resources,hashes(config).resources,config);
      before.resources = servedResources.before;
      const after = hashes(config), artifacts = ['lease-active.json','bench.stdout.txt','bench.stderr.txt','benchmark.json','resource-warm-pass.json','resource-request-timing.ndjson','server-proof.json','vite.log','assets.log','hit-grid.txt','parity.json',
        'served-resources.ndjson','bench-served-resources.ndjson','bench-report.json','trace.json','trace.json.meta.json','final.png'].filter(path => existsSync(join(out,path)))
        .map(path => ({ path, sha256: fileHash(join(out,path)) }));
      after.resources = servedResources.after;
      for (const [index] of (benchmark.perRepeat ?? []).entries()) {
        const path = `witness-r${index}.png`;
        if (existsSync(join(out,path))) artifacts.push({path,sha256:fileHash(join(out,path))});
      }
      const serverProof = json(join(out,'server-proof.json'));
      const result = receipt(config, runId, before, after, benchmark, [process.execPath,...benchArgs], artifacts,serverProof);
      result.receipt.serverProof = serverProof;
      result.receipt.resourceDelivery = {manifest:'bench-served-resources.ndjson',count:servedResources.count,
        phases:servedResources.phases,
        sha256:(config.benchArgs ?? []).includes('--resource-warm-pass')
          ? servedResources.canonicalSha256 : fileHash(join(out,'bench-served-resources.ndjson')),
        rawSha256:fileHash(join(out,'bench-served-resources.ndjson')),reason:servedResources.reason};
      result.receipt.benchmarkRaw = {path:'benchmark.json',sha256:fileHash(join(out,'benchmark.json')),
        schema:benchmark.schema ?? null,
        reason:benchmarkParseFailure ?? 'raw BENCH_RESULT; renderer-benchmark-result/1 conversion unavailable'};
      result.receipt.benchmarkStatus = {exitCode:proc.status,parseFailure:benchmarkParseFailure,
        rejectedRepeats:benchmark.rejectedRepeats?.length ?? null,
        crashedRepeats:benchmark.crashedRepeats?.length ?? null};
      writeFileSync(join(out,'events.jsonl'), result.events.map(e => JSON.stringify(e)).join('\n') + '\n');
      save(join(out,'receipt.json'), result.receipt);
      save(join(out,'capture-status.json'), { exitCode: proc.status, error: proc.error?.message ?? null,
        benchmarkParseFailure,runId,
        serverProofFailures:Object.entries(result.receipt.serverProof.servedAfter ?? {})
          .filter(([,row]) => !row.matches && !row.servedSha256).map(([name,row]) => ({name,reason:row.reason})) });
      console.log(JSON.stringify({ out, exitCode: proc.status, runId, events: result.events.length }));
      if (proc.status !== 0) process.exitCode = 1;
    } else if (command === 'analyze') {
      const dir = resolve(opt('run'));
      let r = json(join(dir,'receipt.json'));
      if (opt('evidence')) {
        r = bindEvidence(r, json(resolve(opt('evidence'))), fileHash(join(dir,'benchmark.json')),dir);
        save(join(dir,'receipt.json'),r);
      }
      const events = readFileSync(join(dir,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
      const gsw = opt('gsw-root') ?? r.effective?.config?.gswRoot;
      if (!gsw) throw new Error('GSW source path needed for canonical schema validator');
      const tracePath = join(dir,'trace.json');
      const traceArtifact = r.artifacts.find(a => a.path === 'trace.json');
      const traceFailures = [];
      for (const artifact of r.artifacts ?? []) {
        const path = resolve(dir,artifact.path);
        if (!path.startsWith(dir+'/') || fileHash(path) !== artifact.sha256)
          traceFailures.push(`raw artifact missing or hash drift: ${artifact.path}`);
      }
      if (fileHash(join(dir,'server-proof.json')) !== r.artifacts.find(a => a.path === 'server-proof.json')?.sha256 ||
          JSON.stringify(json(join(dir,'server-proof.json'))) !== JSON.stringify(r.serverProof))
        traceFailures.push('scratch server proof differs from raw artifact');
      if (r.profiler?.chromeTraceEnabled === false) {
        if (traceArtifact || existsSync(tracePath)) traceFailures.push('untraced speed cell has a Chrome trace');
      } else if (!traceArtifact || fileHash(tracePath) !== traceArtifact.sha256) traceFailures.push('raw Chrome trace missing or hash drift');
      else {
        try {
          const raw = json(tracePath);
          const trace = Array.isArray(raw) ? raw : raw.traceEvents;
          if (!Array.isArray(trace)) throw new Error('trace event array absent');
          if (!r.profiler?.phaseHooksEnabled) {
            const direct = name => trace.filter(e => e.name === 'TimeStamp' && e.args?.data?.message === name);
            const begin = direct('cc-report-start'), end = direct('cc-report-end');
            if (begin.length !== 1 || end.length !== 1 || begin[0].ts !== r.markers.begin ||
                end[0].ts !== r.markers.end || begin[0].pid !== end[0].pid ||
                begin[0].tid !== end[0].tid || begin[0].ts >= end[0].ts)
              throw new Error('trace-only direct marker join failed');
          }
          if (r.profiler?.phaseHooksEnabled) {
            r.markers.rust = await verifyRustMarks(trace,events,gsw);
            save(join(dir,'receipt.json'),r);
          } else if (r.markers.rust != null) {
            r.markers.rust = null;
            save(join(dir,'receipt.json'),r);
          }
        } catch (error) { traceFailures.push(`Rust mark verification failed: ${error.message}`); }
      }
      const failures = [...(r.effective?.config?.captureMode === 'visual'
        ? validateVisualOnlyDiagnostic(r,events) : r.profiler?.chromeTraceEnabled === false
        ? validateSpeedReceipt(r,events) : r.profiler?.phaseHooksEnabled
          ? await validate(r, events, gsw) : validateTraceOnlyDiagnostic(r,events)), ...traceFailures];
      if (['speed','production-diagnostic'].includes(r.effective?.config?.captureMode)) {
        const raw = json(join(dir,'benchmark.json'));
        const args = r.effective.config.benchArgs ?? [];
        const i = args.indexOf('--window');
        const match = i >= 0 ? /^(\d+):(\d+)$/.exec(args[i+1] ?? '') : null;
        const expected = match ? {startMs:Number(match[1]),endMs:Number(match[2])} : null;
        if (JSON.stringify(productionWindowProof(raw.perRepeat?.[0],expected)) !==
            JSON.stringify(r.output?.production)) failures.push('production window proof differs from raw benchmark');
      }
      const profilePath = join(dir,'v8-profile.json');
      const profileTiming = existsSync(profilePath) ? validateV8Deltas(json(profilePath)) : null;
      if (profileTiming && !profileTiming.timedAttribution)
        failures.push('nonpositive V8 time delta; timed attribution refused');
      const sampleResult = qualifiedSamples(r,dir);
      failures.push(...sampleResult.failures);
      const samples = sampleResult.samples;
      if (samples.length) {
        const byThread = cpuAttribution(samples,r.processes).byThread.map(row => ({tid:row.tid,
          leafCoverage:row.denominator ? row.namedLeafSamples/row.denominator : null,
          callerCoverage:null,js:samples.filter(s => s.tid === row.tid && s.category === 'js').length,
          wasm:samples.filter(s => s.tid === row.tid && s.category === 'wasm').length,
          native:samples.filter(s => s.tid === row.tid && s.category === 'native').length,
          unresolved:row.unresolvedSamples,reason:'caller coverage unavailable'}));
        r.symbols = {byThread,invalidSampleDeltas:profileTiming?.timedAttribution === false ? 1 : 0};
        save(join(dir,'receipt.json'),r);
      }
      const analysis = { schema: 'canvas-profile-analysis/1', qualified: failures.length === 0, failures,
        receiptSha256: fileHash(join(dir,'receipt.json')), eventsSha256: fileHash(join(dir,'events.jsonl')),
        eventCount: events.length, outcomes: events.filter(e => e.eventType === 'outcome').reduce((o,e) => (o[e.outcome] = (o[e.outcome] ?? 0)+1, o), {}),
        profileTiming, attribution: cpuAttribution(samples, r.processes),
        phaseLeads:exclusivePhaseLeads(events) };
      save(join(dir,'analysis.json'), analysis); console.log(JSON.stringify(analysis));
      if (failures.length) process.exitCode = 1;
    } else if (command === 'compare-cpu-output') {
      const sequencePath = opt('sequence');
      if (!sequencePath) throw new Error('compare-cpu-output requires --sequence');
      const sequence = json(resolve(sequencePath));
      if (!Array.isArray(sequence.cells) || !sequence.cells.length)
        throw new Error('CPU/output sequence has no cells');
      const cells = sequence.cells.map(entry => {
        const dir = resolve(entry.run);
        const receiptPath = join(dir,'receipt.json');
        const benchmarkPath = join(dir,'benchmark.json');
        const eventPath = join(dir,'events.jsonl');
        const receipt = json(receiptPath), benchmark = json(benchmarkPath);
        const events = readFileSync(eventPath,'utf8').split('\n').filter(Boolean).map(JSON.parse);
        for (const artifact of receipt.artifacts ?? []) {
          const path = resolve(dir,artifact.path);
          if (!path.startsWith(dir+'/') || fileHash(path) !== artifact.sha256)
            throw new Error(`raw artifact missing or drifted: ${path}`);
        }
        if (entry.receiptSha256 !== fileHash(receiptPath) ||
            entry.benchmarkSha256 !== fileHash(benchmarkPath) ||
            entry.eventsSha256 !== fileHash(eventPath))
          throw new Error(`sequence hash mismatch: ${dir}`);
        return {label:entry.label,receipt,benchmark,events};
      });
      const labels = cells.map(cell => cell.label).join(',');
      const expected = cells.some(cell => cell.label === 'candidate')
        ? 'control,candidate,control,candidate,control'
        : 'control,control,control';
      const result = compareCpuOutputCells(cells);
      if (labels !== expected) {
        result.failures.push(`predeclared cell order mismatch: ${labels}`);
        result.comparable = false;
        result.saving = null;
      }
      console.log(JSON.stringify(result,null,2));
      if (!result.comparable) process.exitCode = 1;
    } else if (command === 'compare') {
      const control = resolve(opt('control')), candidate = resolve(opt('candidate'));
      const a = json(join(control,'analysis.json')), b = json(join(candidate,'analysis.json'));
      const ar = json(join(control,'receipt.json')), br = json(join(candidate,'receipt.json'));
      const offOffDir = opt('off-off'), offOff = offOffDir ? json(join(resolve(offOffDir),'receipt.json')) : null;
      const offOffAnalysis = offOffDir ? json(join(resolve(offOffDir),'analysis.json')) : null;
      const sequence = opt('sequence') ? json(resolve(opt('sequence'))) : null;
      const cells = [ar,br,...(offOff ? [offOff] : [])];
      const failures = [...(!a.qualified || !b.qualified || !offOffAnalysis?.qualified ? ['unqualified cell'] : []),
        ...cells.flatMap(r => comparableEnvironment(ar,r)),
        ...(![control,candidate,...(offOffDir ? [resolve(offOffDir)] : [])].every((dir,i) => {
          const analysis = i === 0 ? a : i === 1 ? b : offOffAnalysis;
          return analysis?.receiptSha256 === fileHash(join(dir,'receipt.json')) &&
            analysis?.eventsSha256 === fileHash(join(dir,'events.jsonl'));
        }) ? ['analysis no longer matches raw cell artifacts'] : []),
        ...(ar.hashes.input.before !== br.hashes.input.before ? ['different recording'] : []),
        ...(ar.hashes.resources.before !== br.hashes.resources.before ? ['different resources'] : []),
        ...(ar.effective.config.phases || br.effective.config.phases ? ['instrumented cell'] : []),
        ...(!cells.every(r => r.profiler?.chromeTraceEnabled === false && r.profiler?.phaseHooksEnabled === false)
          ? ['speed cells contain Chrome tracing or phase hooks'] : []),
        ...(ar.presentations.count === null || br.presentations.count === null ? ['actual presentations unavailable'] : []),
        ...(!offOff || !sequence ? ['contemporary off/off variation and interleaved sequence unavailable'] : []),
        ...(!cells.every(r => r.benchmarkContract?.path) ? ['renderer benchmark result contract unavailable'] : []),
        ...(!cells.every(r => !r.effective?.config?.phases &&
          r.hashes.input.before === ar.hashes.input.before && r.hashes.resources.before === ar.hashes.resources.before &&
          JSON.stringify(r.effective.config?.quality) === JSON.stringify(ar.effective.config?.quality) &&
          JSON.stringify(r.effective.config?.effects) === JSON.stringify(ar.effective.config?.effects) &&
          JSON.stringify(r.effective.benchmark) === JSON.stringify(ar.effective.benchmark) &&
          JSON.stringify(r.gpu) === JSON.stringify(ar.gpu) &&
          comparableProductionOutput(ar,r) &&
          r.hashes.imageReference?.before === ar.hashes.imageReference?.before &&
          Object.values(r.hashes).every(h => h.before && h.before === h.after))
          ? ['source/artifact/input/settings mismatch across cells'] : [])];
      const labels = sequence?.cells?.map(c => c.label) ?? [];
      const sequenceReceipts = sequence?.cells?.map(c => {
        try { return json(join(resolve(c.run),'receipt.json')); } catch { return null; }
      }) ?? [];
      const timestamps = sequence?.cells?.map(c => {
        try { return Date.parse(json(join(resolve(c.run),'receipt.json')).capturedAt); } catch { return NaN; }
      }) ?? [];
      if (!Array.isArray(sequence?.cells) || labels.filter(x => x === 'control').length < 2 ||
          labels.filter(x => x === 'candidate').length < 2 ||
          !labels.includes('off-off') || timestamps.some(x => !Number.isFinite(x)) ||
          !sequenceReceipts.some((r,i) => labels[i] === 'control' && r?.runId === ar.runId) ||
          !sequenceReceipts.some((r,i) => labels[i] === 'candidate' && r?.runId === br.runId) ||
          !sequenceReceipts.some((r,i) => labels[i] === 'off-off' && r?.runId === offOff?.runId) ||
          !sequenceReceipts.every((r,i) => {
            if (!r || r.hashes.input.before !== ar.hashes.input.before || r.hashes.resources.before !== ar.hashes.resources.before ||
                comparableEnvironment(ar,r).length > 0 ||
                r.effective?.config?.phases || r.profiler?.chromeTraceEnabled !== false ||
                r.profiler?.phaseHooksEnabled !== false || !r.output?.valid || !r.presentations?.count ||
                !comparableProductionOutput(ar,r) ||
                r.hashes.imageReference?.before !== ar.hashes.imageReference?.before) return false;
            if (labels[i] === 'control' || labels[i] === 'off-off') return r.hashes.source.before === ar.hashes.source.before &&
              r.hashes.wasm.before === ar.hashes.wasm.before && r.hashes.glue.before === ar.hashes.glue.before;
            return labels[i] === 'candidate' && r.hashes.source.before === br.hashes.source.before &&
              r.hashes.wasm.before === br.hashes.wasm.before && r.hashes.glue.before === br.hashes.glue.before;
          }) ||
          timestamps.some((x,i) => i > 0 && x <= timestamps[i-1]) ||
          !labels.some((x,i) => x === 'candidate' && labels.slice(0,i).includes('control') && labels.slice(i+1).includes('control')))
        failures.push('interleaved sequence invalid or unverified');
      for (const [i, cell] of cells.entries()) if (cell.benchmarkContract?.path) {
        const path = resolve(cell.benchmarkContract.path);
        const sourceDir = i === 0 ? control : i === 1 ? candidate : resolve(offOffDir);
        if (!cell.artifacts?.some(a => resolve(sourceDir,a.path) === path && a.sha256 === fileHash(path)))
          { failures.push(`renderer benchmark contract cell ${i} artifact hash mismatch`); continue; }
        const result = spawnSync('python3', ['scripts/validate-renderer-benchmark-result.py',path], {cwd:REPO_ROOT,encoding:'utf8'});
        if (result.status !== 0) failures.push(`renderer benchmark contract cell ${i} invalid: ${(result.stderr||result.stdout).trim()}`);
      }
      if (cells.length === 3 && cells.every(r => r.benchmarkContract?.path)) {
        for (const other of [br,offOff]) {
          const result = spawnSync('python3', ['scripts/validate-renderer-benchmark-result.py',
            resolve(ar.benchmarkContract.path),'--compare',resolve(other.benchmarkContract.path)], {cwd:REPO_ROOT,encoding:'utf8'});
          if (result.status !== 0) failures.push(`renderer benchmark comparison invalid: ${(result.stderr||result.stdout).trim()}`);
        }
      }
      for (const entry of sequence?.cells ?? []) {
        const dir = resolve(entry.run);
        try {
          const cell = json(join(dir,'receipt.json')), analysis = json(join(dir,'analysis.json'));
          const contract = cell.benchmarkContract?.path && resolve(cell.benchmarkContract.path);
          if (!analysis.qualified || analysis.receiptSha256 !== fileHash(join(dir,'receipt.json')) ||
              analysis.eventsSha256 !== fileHash(join(dir,'events.jsonl')) ||
              !contract || !cell.artifacts?.some(a => resolve(dir,a.path) === contract && a.sha256 === fileHash(contract)))
            throw new Error('unqualified or stale sequence cell');
          const result = spawnSync('python3', ['scripts/validate-renderer-benchmark-result.py',
            resolve(ar.benchmarkContract.path),'--compare',contract], {cwd:REPO_ROOT,encoding:'utf8'});
          if (result.status !== 0) throw new Error((result.stderr||result.stdout).trim());
        } catch (error) { failures.push(`invalid sequence cell: ${error.message}`); }
      }
      const metric = name => {
        const c = ar.metrics[name], b = br.metrics[name], oo = offOff?.metrics?.[name];
        if (![c?.value,b?.value,oo?.value].every(v => typeof v === 'number') || c.value <= 0)
          return { value: null, reason: 'metric unavailable or control denominator nonpositive' };
        const deltaPct = 100*(b.value-c.value)/c.value;
        const offOffPct = 100*Math.abs(oo.value-c.value)/c.value;
        const bound = row => (row.jiffyUncertaintyMs ?? 0) +
          (row.overhangTotalMs ?? 0)*(ar.hostIdentity?.logicalCpus ?? 1);
        const uncertainty = 2*bound(c)+bound(b)+bound(oo);
        const variationAbs = Math.abs(oo.value-c.value);
        return { control:c.value,candidate:b.value,offOff:oo.value,unit:c.unit,deltaPct,offOffPct,
          variationAbs,counterAndOverhangBound:uncertainty,
          exceedsVariationAndBound:Math.abs(b.value-c.value)>variationAbs+uncertainty };
      };
      console.log(JSON.stringify({ schema: 'canvas-profile-comparison/1', comparable: failures.length === 0, failures,
        sequence, metrics: { rendererCpuMs:metric('rendererCpuMs'),gpuProcessCpuMs:metric('gpuProcessCpuMs'),
          gpuExecutionMs:metric('gpuExecutionMs'),actualPresentations:metric('actualPresentations') },
        claim: failures.length ? null : 'review metric-specific variation and output before claiming a saving' }));
      if (failures.length) process.exitCode = 1;
    } else throw new Error('usage: profile-mirror-rust.mjs probe|capture|analyze|compare|compare-cpu-output --config/--out/--run/--control/--candidate/--sequence');
  } catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 2; }
}
