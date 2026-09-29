import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createPerfCollector} from './lib/perf-tool-collector.mjs';

const fakeCollector = `
import {writeFileSync} from 'node:fs';
const bytes=Buffer.alloc(72+64);
bytes.write('PERFILE2',0,'ascii');
bytes.writeBigUInt64LE(72n,40);
bytes.writeBigUInt64LE(64n,48);
bytes.writeUInt32LE(9,72);
bytes.writeUInt16LE(64,78);
writeFileSync(process.argv[2],bytes);
process.stdout.write('ready\\n');
if(process.argv[3]==='early') process.exit(0);
setInterval(()=>{},1000);
`;

test('maintained session stops a spawned collector and writes a truthful SIGINT receipt', async () => {
  const dir=mkdtempSync(join(tmpdir(),'perf-session-'));
  try {
    const script=join(dir,'collector.mjs'),outputPath=join(dir,'perf.data'),receiptPath=join(dir,'receipt.json');
    writeFileSync(script,fakeCollector);
    const session=createPerfCollector({binary:process.execPath,args:[script,outputPath],
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
    writeFileSync(script,fakeCollector);
    const session=createPerfCollector({binary:process.execPath,args:[script,outputPath,'early'],
      cwd:dir,outputPath,receiptPath,timeoutMs:1000});
    await once(session.child,'exit');
    const receipt=await session.stop();
    assert.equal(receipt.success,false);
    assert.equal(receipt.perfStop.exitedBeforeStop,true);
    assert.match(receipt.perfStop.reason,/before deliberate stop/);
    assert.equal(receipt.perfStop.output.valid,true);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('existing output bytes are preserved and the collector never starts', async () => {
  const dir=mkdtempSync(join(tmpdir(),'perf-session-'));
  try {
    const script=join(dir,'collector.mjs'),outputPath=join(dir,'perf.data');
    const receiptPath=join(dir,'receipt.json'),marker=join(dir,'started');
    writeFileSync(script,"import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],'started');");
    writeFileSync(outputPath,'preserved capture');
    assert.throws(() => createPerfCollector({binary:process.execPath,args:[script,marker],
      cwd:dir,outputPath,receiptPath}),/output already exists/);
    await new Promise(resolve => setTimeout(resolve,50));
    assert.equal(readFileSync(outputPath,'utf8'),'preserved capture');
    assert.throws(() => readFileSync(marker),{code:'ENOENT'});
    assert.throws(() => readFileSync(receiptPath),{code:'ENOENT'});
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
