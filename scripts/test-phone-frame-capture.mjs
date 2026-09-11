#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { captureConfig, chooseChromeLayer } from './phone-frame-capture.mjs';
import { parseCsvRows, bootOffsetNs, actualFrameTimelineSamples } from './lib/perfetto-frame-timeline.mjs';
import { presentationStats } from './lib/perfetto-presentation.mjs';
import { acquireLease } from './live-qa-lock.mjs';

const directory = mkdtempSync(join(tmpdir(), 'phone-frame-capture-'));
try {
  assert.doesNotMatch(captureConfig(false), /linux\.ftrace/, 'default FrameTimeline capture stays lightweight');
  assert.match(captureConfig(true), /compact_sched[\s\S]*sched\/sched_switch/);
  assert.match(captureConfig(true), /sched\/sched_process_exit[\s\S]*sched\/sched_process_free[\s\S]*task\/task_newtask[\s\S]*task\/task_rename/);
  const lockConfig = { leaseRoot: join(directory, 'leases'), guardDir: join(directory, 'guard') };
  acquireLease({ owner: 'test', pid: process.pid, resources: ['shared:install', 'exclusive:android:device1'], config: lockConfig });
  const fakeAdb = join(directory, 'adb');
  writeFileSync(fakeAdb, `#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),d=process.env.MOCK_DIR;
fs.appendFileSync(p.join(d,'calls'),JSON.stringify(a)+'\\n');
if(a[0]!=='-s'||a[1]!=='device1')process.exit(2);
const c=a.slice(2),state=p.join(d,'device-state');
if(c[0]==='shell'&&c[1]==='perfetto'){
 if(!c.includes('--txt')||!c.includes('--background-wait')||!fs.readFileSync(0,'utf8').includes('frametimeline'))process.exit(3);
 fs.writeFileSync(state,JSON.stringify({remote:c.at(-1),stopped:false}));console.log('424242');
}else if(c[0]==='shell'&&c[1]==='cat'){
 const s=JSON.parse(fs.readFileSync(state));
 if(c[2].endsWith('cmdline'))process.stdout.write('perfetto\\0'+s.remote);
 else if(s.stopped){console.error('No such file or directory');process.exit(1);}else console.log('424242 (perfetto) S 1');
}else if(c[0]==='shell'&&c[1]==='kill'){
 const s=JSON.parse(fs.readFileSync(state));s.stopped=true;fs.writeFileSync(state,JSON.stringify(s));
}else if(c[0]==='pull'){
 if(!JSON.parse(fs.readFileSync(state)).stopped)process.exit(4);fs.writeFileSync(c[2],'trace');
}else if(c[0]!=='shell'||c[1]!=='rm')process.exit(5);
`, { mode: 0o755 });
  const processor = join(directory, 'processor');
  writeFileSync(processor, `#!/usr/bin/env node
if(process.argv.at(-1).includes('clock_snapshot')) { console.log('ts,monotonic\\n1000000500,1000000000'); process.exit(0); }
if(!process.argv.at(-1).includes('sf.ts + sf.dur >= 1000500') || !process.argv.at(-1).includes('sf.ts + sf.dur <= 2000500')) process.exit(6);
console.log('"upid","layer_name","pid","process_name"\\n2,"TX - com.android.chrome/ChromeChildSurface#7",99,"com.android.chrome:privileged_process0"');
`, { mode: 0o755 });
  const env = { ...process.env, MOCK_DIR: directory, ADB_BIN: fakeAdb,
    COUCHCOOP_LIVEQA_OWNER: 'test', COUCHCOOP_LIVEQA_PID: String(process.pid),
    COUCHCOOP_LIVEQA_LEASE_ROOT: lockConfig.leaseRoot, COUCHCOOP_LIVEQA_REGISTRY_GUARD: lockConfig.guardDir };
  const prefix = join(directory, 'cell'), meta = join(directory, 'cell.json');
  const chromeTrace = join(directory, 'chrome.json');
  writeFileSync(chromeTrace, JSON.stringify([{ts:1000,args:{data:{message:'cc-report-start'}}},{ts:2000,args:{data:{message:'cc-report-end'}}}]));
  writeFileSync(meta, JSON.stringify({workload:{phase:'active'},artifacts:{trace:chromeTrace}}));
  const run = (command, args = [], override = {}) => spawnSync(process.execPath,
    [resolve('scripts/phone-frame-capture.mjs'), command, '--serial', 'device1', '--out-prefix', prefix, ...args],
    { env: { ...env, ...override }, encoding: 'utf8' });
  let r = run('start', ['--package', 'com.android.chrome'], { COUCHCOOP_LIVEQA_OWNER: 'foreign' });
  assert.notEqual(r.status, 0); assert.equal(existsSync(join(directory, 'calls')), false, 'wrong lock must not touch adb');
  r = run('start', ['--package', 'com.android.chrome']); assert.equal(r.status, 0, r.stderr);
  assert.notEqual(run('start', ['--package', 'com.android.chrome']).status, 0, 'reject concurrent capture');
  r = run('stop', ['--meta', meta, '--trace-processor', processor]); assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(`${prefix}.perfetto-state.json`), false);
  const result = JSON.parse(readFileSync(meta)); assert.equal(result.presentation.pid, 99);
  assert.equal(result.presentation.surface, 'TX - com.android.chrome/ChromeChildSurface#7');
  const calls = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every((call) => call[0] === '-s' && call[1] === 'device1'));
  assert.ok(calls.findIndex((call) => call.includes('-TERM')) < calls.findIndex((call) => call[2] === 'pull'));
  const rows = [{ upid: '2', pid: '99', process_name: 'com.android.chrome:privileged_process0', layer_name: result.presentation.surface }];
  assert.equal(chooseChromeLayer([...rows, { ...rows[0], layer_name: 'TX - com.android.chrome/ChromeChildSurface#8' }], 'com.android.chrome'), null);
  assert.equal(chooseChromeLayer([{ ...rows[0], process_name: 'foreign' }], 'com.android.chrome'), null);
  assert.deepEqual(parseCsvRows('"id","text"\n1,"a,""b""\nline"\n'), [{ id: '1', text: 'a,"b"\nline' }]);
  assert.equal(bootOffsetNs([{ ts: '1000000500', monotonic: '1000000000' }]), 500);
  assert.equal(bootOffsetNs([{ ts: 1000000, monotonic: 100 }, { ts: 3000000, monotonic: 101 }]), null);
  const samples = actualFrameTimelineSamples([0, 16, 32, 48].map((ms, index) => ({
    layer_name: 'content', ts: 1, dur: 1, display_ts: 1_000_000_000 + ms * 1_000_000,
    display_dur: 1_000_000, present_type: 'On-time Present', display_present_type: 'On-time Present',
    display_frame_token: index + 1, surface_frame_token: index + 5
  })), { surface: 'content', fromBootNs: 1_000_000_000, toBootNs: 1_060_000_000 });
  assert.equal(presentationStats(samples, 60).gapP95Ms, 16, 'nanoseconds must convert exactly once');
  console.log('Phone FrameTimeline ownership, flush, attribution and units tests passed');
} finally { rmSync(directory, { recursive: true, force: true }); }
