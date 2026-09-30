import {spawn} from 'node:child_process';
import {lstatSync, writeFileSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {stopPerfCollector} from './perf-collector-stop.mjs';

function perfRecordOutput(args, cwd) {
  if (args[0] !== 'record') throw new Error('collector command must be perf record');
  const targets=[];
  for (let i=1;i<args.length;i++) {
    const arg=args[i];
    if (arg === '--') break;
    if (arg === '-o' || arg === '--output') {
      targets.push(args[++i]);
    } else if (arg.startsWith('--output=')) {
      targets.push(arg.slice('--output='.length));
    } else if (arg.startsWith('-o') && arg.length>2) {
      targets.push(arg.slice(2));
    }
  }
  if (targets.length !== 1 || !targets[0] || targets[0].startsWith('-'))
    throw new Error('perf record requires exactly one explicit -o/--output target');
  return resolve(cwd,targets[0]);
}

// A future tool-only harness owns its phases and calls session.stop() once
// they finish. This session owns perf's process and stop receipt; it does not
// qualify clocks, loss, sample ownership or symbol coverage.
export function createPerfCollector({binary, args, cwd, outputPath, receiptPath,
                                     timeoutMs=10_000}) {
  if (!binary || !Array.isArray(args) || !cwd || !outputPath || !receiptPath)
    throw new Error('binary, args, cwd, outputPath and receiptPath are required');
  if (!isAbsolute(outputPath) || !isAbsolute(receiptPath))
    throw new Error('collector outputPath and receiptPath must be absolute');
  if (perfRecordOutput(args,cwd) !== resolve(outputPath))
    throw new Error('perf record output target differs from declared outputPath');
  const pathExists=path => {
    try {lstatSync(path);return true;}
    catch (error) {if (error.code === 'ENOENT') return false;throw error;}
  };
  if (pathExists(receiptPath)) throw new Error(`collector receipt already exists: ${receiptPath}`);
  if (pathExists(outputPath)) throw new Error(`collector output already exists: ${outputPath}`);
  const child=spawn(binary,args,{cwd,stdio:['ignore','pipe','pipe']});
  const startedAt=new Date().toISOString();
  let stderr='', spawnError=null, stopped=null;
  child.stderr?.on('data', chunk => {stderr=(stderr+String(chunk)).slice(-200_000);});
  child.on('error', error => {spawnError=String(error);});
  function stop() {
    if (stopped) return stopped;
    stopped=(async () => {
      const perfStop=await stopPerfCollector(child,outputPath,{timeoutMs});
      const receipt={schema:'tool-only-perf-collector/1',
        success:perfStop.valid && !spawnError,
        startedAt,finishedAt:new Date().toISOString(),
        command:[binary,...args],cwd:resolve(cwd),outputPath:resolve(outputPath),
        perfPid:child.pid ?? null,perfExit:perfStop.exitCode,perfSignal:perfStop.signalCode,
        perfStop,spawnError,perfStderr:stderr};
      writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
      return receipt;
    })();
    return stopped;
  }
  return {child,stop};
}
