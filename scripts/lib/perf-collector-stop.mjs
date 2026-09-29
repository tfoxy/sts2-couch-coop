import { readFileSync } from 'node:fs';

// Validate the collector's artifact independently of its process exit status.
// This is a structural check; sample ownership, loss, clocks and symbols have
// separate qualification gates.
export function validatePerfData(path) {
  let data;
  try { data = readFileSync(path); }
  catch (error) { return { valid:false, reason:`perf output unreadable: ${error.code ?? error.message}` }; }
  if (data.length < 72 || data.toString('ascii',0,8) !== 'PERFILE2')
    return { valid:false, reason:'invalid perf.data header' };
  const offset = Number(data.readBigUInt64LE(40));
  const length = Number(data.readBigUInt64LE(48));
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 72 ||
      length < 8 || offset + length > data.length)
    return { valid:false, reason:'invalid perf.data section extent' };
  let cursor = offset, sampleCount = 0;
  while (cursor < offset + length) {
    if (cursor + 8 > offset + length)
      return { valid:false, reason:'truncated perf record header' };
    const type = data.readUInt32LE(cursor);
    const size = data.readUInt16LE(cursor+6);
    if (size < 8 || cursor + size > offset + length)
      return { valid:false, reason:'invalid perf record extent' };
    if (type === 9) {
      if (size < 64) return {valid:false, reason:'short perf sample record'};
      const depth = Number(data.readBigUInt64LE(cursor+56));
      if (!Number.isSafeInteger(depth) || depth > (size-64)/8)
        return {valid:false, reason:'invalid perf sample callchain extent'};
      sampleCount++;
    }
    cursor += size;
  }
  return sampleCount > 0 ? { valid:true, sampleCount } :
    { valid:false, reason:'perf output has no samples' };
}

export function classifyPerfStop({stopRequested, exitedBeforeStop, timedOut=false,
                                  exitCode, signalCode, output}) {
  if (exitedBeforeStop) return {valid:false, reason:'collector exited before deliberate stop'};
  if (!stopRequested) return {valid:false, reason:'collector did not receive deliberate stop'};
  if (timedOut) return {valid:false, reason:'collector stop timed out'};
  if (!((exitCode === 0 && signalCode === null) ||
        (exitCode === null && signalCode === 'SIGINT')))
    return {valid:false, reason:`collector failed: exit=${exitCode} signal=${signalCode}`};
  if (!output?.valid) return {valid:false, reason:output?.reason ?? 'perf output unvalidated'};
  return {valid:true, reason:'deliberate stop with structurally valid perf output',
    sampleCount:output.sampleCount};
}

export async function stopPerfCollector(child, outputPath, {timeoutMs=10_000}={}) {
  const exitedBeforeStop = child.exitCode !== null || child.signalCode !== null;
  let stopRequested = false, timedOut = false;
  if (!exitedBeforeStop) {
    let onExit;
    const exitPromise = new Promise(resolve => {
      onExit = () => resolve(true);
      child.once('exit', onExit);
    });
    stopRequested = child.kill('SIGINT');
    if (stopRequested) {
      let timer;
      const exited = await Promise.race([exitPromise,
        new Promise(resolve => {timer = setTimeout(() => resolve(false), timeoutMs);})]);
      clearTimeout(timer);
      timedOut = !exited;
      if (timedOut) child.kill('SIGKILL');
    }
    child.removeListener('exit', onExit);
  }
  const output = validatePerfData(outputPath);
  return { ...classifyPerfStop({stopRequested, exitedBeforeStop, timedOut,
    exitCode:child.exitCode, signalCode:child.signalCode, output}),
    stopRequested, exitedBeforeStop, timedOut, exitCode:child.exitCode,
    signalCode:child.signalCode, output };
}
