import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createPerfCollector} from './lib/perf-tool-collector.mjs';

const fakeCollector = `#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
const bytes=Buffer.alloc(72+64);
bytes.write('PERFILE2',0,'ascii');
bytes.writeBigUInt64LE(72n,40);
bytes.writeBigUInt64LE(64n,48);
bytes.writeUInt32LE(9,72);
bytes.writeUInt16LE(64,78);
writeFileSync(process.argv[4],bytes);
process.stdout.write('ready\\n');
if(process.argv[5]==='early') process.exit(0);
setInterval(()=>{},1000);
`;

test('maintained session stops a spawned collector and writes a truthful SIGINT receipt', async () => {
  const dir=mkdtempSync(join(tmpdir(),'perf-session-'));
  try {
    const script=join(dir,'collector.mjs'),outputPath=join(dir,'perf.data'),receiptPath=join(dir,'receipt.json');
    writeFileSync(script,fakeCollector);chmodSync(script,0o755);
    const session=createPerfCollector({binary:script,args:['record','-o',outputPath],
      cwd:dir,outputPath,receiptPath,timeoutMs:1000});
    await once(session.child.stdout,'data');
    const receipt=await session.stop();
    assert.equal(receipt.success,true);
    assert.equal(receipt.perfExit,null);
    assert.equal(receipt.perfSignal,'SIGINT');
    assert.equal(receipt.perfStop.output.sampleCount,1);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath,'utf8')),receipt);
    assert.strictEqual(await session.stop(),receipt);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('collector exit before deliberate stop stays failed even with readable output', async () => {
  const dir=mkdtempSync(join(tmpdir(),'perf-session-'));
  try {
    const script=join(dir,'collector.mjs'),outputPath=join(dir,'perf.data'),receiptPath=join(dir,'receipt.json');
    writeFileSync(script,fakeCollector);chmodSync(script,0o755);
    const session=createPerfCollector({binary:script,args:['record','-o',outputPath,'early'],
      cwd:dir,outputPath,receiptPath,timeoutMs:1000});
    await once(session.child,'exit');
    const receipt=await session.stop();
    assert.equal(receipt.success,false);
    assert.equal(receipt.perfStop.exitedBeforeStop,true);
    assert.match(receipt.perfStop.reason,/before deliberate stop/);
    assert.equal(receipt.perfStop.output.valid,true);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('relative -o perf.data binds to absolute outputPath in child cwd', async () => {
  const dir=mkdtempSync(join(tmpdir(),'perf-session-'));
  try {
    const script=join(dir,'collector.mjs'),outputPath=join(dir,'perf.data'),receiptPath=join(dir,'receipt.json');
    writeFileSync(script,fakeCollector);chmodSync(script,0o755);
    const session=createPerfCollector({binary:script,args:['record','-o','perf.data'],
      cwd:dir,outputPath,receiptPath,timeoutMs:1000});
    await once(session.child.stdout,'data');
    const receipt=await session.stop();
    assert.equal(receipt.success,true);
    assert.equal(receipt.outputPath,outputPath);
    assert.equal(receipt.perfStop.output.sampleCount,1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('existing output bytes are preserved and the collector never starts', async () => {
  const dir=mkdtempSync(join(tmpdir(),'perf-session-'));
  try {
    const script=join(dir,'collector.mjs'),outputPath=join(dir,'perf.data');
    const receiptPath=join(dir,'receipt.json'),marker=join(dir,'started');
    writeFileSync(script,`#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'started');`);
    chmodSync(script,0o755);
    writeFileSync(outputPath,'preserved capture');
    assert.throws(() => createPerfCollector({binary:script,args:['record','-o',outputPath],
      cwd:dir,outputPath,receiptPath}),/output already exists/);
    await new Promise(resolve => setTimeout(resolve,50));
    assert.equal(readFileSync(outputPath,'utf8'),'preserved capture');
    assert.throws(() => readFileSync(marker),{code:'ENOENT'});
    assert.throws(() => readFileSync(receiptPath),{code:'ENOENT'});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('missing, mismatched and duplicate perf output targets fail before spawn', async () => {
  const dir=mkdtempSync(join(tmpdir(),'perf-session-'));
  try {
    const script=join(dir,'collector.mjs'),outputPath=join(dir,'new-perf.data');
    const oldOutput=join(dir,'old-perf.data'),receiptPath=join(dir,'receipt.json');
    const marker=join(dir,'started');
    writeFileSync(script,`#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'started');`);
    chmodSync(script,0o755);
    writeFileSync(oldOutput,'old capture bytes');
    for (const args of [
      ['record','-p','7'],
      ['record','-o',oldOutput],
      ['record','-o',outputPath,'--output',oldOutput],
      ['record',`--output=${oldOutput}`],
      ['record','--','-o',outputPath],
    ]) {
      assert.throws(() => createPerfCollector({binary:script,args,cwd:dir,outputPath,receiptPath}),
        /explicit -o\/--output target|differs from declared outputPath/);
    }
    await new Promise(resolve => setTimeout(resolve,50));
    assert.equal(readFileSync(oldOutput,'utf8'),'old capture bytes');
    for (const absent of [outputPath,receiptPath,marker])
      assert.throws(() => readFileSync(absent),{code:'ENOENT'});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('relative output and receipt paths are rejected before spawn', () => {
  const dir=mkdtempSync(join(tmpdir(),'perf-session-'));
  try {
    const base={binary:process.execPath,args:['-e','process.exit(1)'],cwd:dir,
      outputPath:join(dir,'perf.data'),receiptPath:join(dir,'receipt.json')};
    assert.throws(() => createPerfCollector({...base,outputPath:'perf.data'}),/must be absolute/);
    assert.throws(() => createPerfCollector({...base,receiptPath:'receipt.json'}),/must be absolute/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
