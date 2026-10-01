import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function emitBenchResult(result, outputPath, log = console.log) {
  const serialized = JSON.stringify(result);
  if (outputPath) {
    mkdirSync(dirname(outputPath),{recursive:true});
    writeFileSync(outputPath,serialized+'\n');
    log(`BENCH_RESULT_FILE ${outputPath}`);
  } else log(`BENCH_RESULT ${serialized}`);
}
