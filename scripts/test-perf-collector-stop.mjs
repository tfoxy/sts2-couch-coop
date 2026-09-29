import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {classifyPerfStop, stopPerfCollector, validatePerfData} from './lib/perf-collector-stop.mjs';

function perfBytes() {
  const data = Buffer.alloc(72 + 64);
  data.write('PERFILE2',0,'ascii');
  data.writeBigUInt64LE(72n,40);
  data.writeBigUInt64LE(64n,48);
  data.writeUInt32LE(9,72);
  data.writeUInt16LE(64,78);
  return data;
}

test('intentional SIGINT with readable perf output is a valid collector stop', async () => {
  const dir=mkdtempSync(join(tmpdir(),'perf-stop-'));
  try {
    const output=join(dir,'perf.data'); writeFileSync(output,perfBytes());
    const child=new EventEmitter(); child.exitCode=null; child.signalCode=null;
    child.kill=signal => {child.signalCode=signal; queueMicrotask(()=>child.emit('exit',null,signal));return true;};
    const result=await stopPerfCollector(child,output,{timeoutMs:100});
    assert.equal(result.valid,true);
    assert.equal(result.signalCode,'SIGINT');
    assert.equal(result.exitCode,null);
    assert.equal(result.output.sampleCount,1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('early exit, crash, timeout, and missing output remain failures', () => {
  const output={valid:true,sampleCount:1};
  const base={stopRequested:true,exitedBeforeStop:false,exitCode:null,signalCode:'SIGINT',output};
  assert.equal(classifyPerfStop(base).valid,true);
  assert.match(classifyPerfStop({...base,exitedBeforeStop:true}).reason,/before/);
  assert.match(classifyPerfStop({...base,signalCode:'SIGSEGV'}).reason,/failed/);
  assert.match(classifyPerfStop({...base,exitCode:0,signalCode:'SIGSEGV'}).reason,/failed/);
  assert.match(classifyPerfStop({...base,timedOut:true}).reason,/timed out/);
  assert.match(classifyPerfStop({...base,output:{valid:false,reason:'missing'}}).reason,/missing/);
  assert.match(classifyPerfStop({...base,stopRequested:false}).reason,/did not receive/);
});

test('structural perf validation rejects absent, truncated, and empty output', () => {
  const dir=mkdtempSync(join(tmpdir(),'perf-stop-'));
  try {
    const path=join(dir,'perf.data');
    assert.equal(validatePerfData(path).valid,false);
    writeFileSync(path,Buffer.from('bad'));
    assert.match(validatePerfData(path).reason,/header/);
    const truncated=perfBytes(); truncated.writeBigUInt64LE(9n,48);
    writeFileSync(path,truncated);
    assert.match(validatePerfData(path).reason,/extent/);
    const empty=perfBytes(); empty.writeUInt32LE(1,72);
    writeFileSync(path,empty);
    assert.match(validatePerfData(path).reason,/no samples/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
