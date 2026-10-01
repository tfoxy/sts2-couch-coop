import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, assertLiveLease, releaseLease } from './live-qa-lock.mjs';

test('capture lease rejects an unreaped zombie with its original PID and start identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'couch-zombie-lock-'));
  const config = { leaseRoot: join(root, 'leases'), guardDir: join(root, 'guard') };
  const script = `import os,signal,sys,time
pid=os.fork()
if pid==0: os._exit(0)
print(pid,flush=True)
signal.signal(signal.SIGTERM,lambda *_: sys.exit(0))
try: time.sleep(20)
finally: os.waitpid(pid,0)
`;
  const parent = spawn('python3', ['-u', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let pid = null, acquired = false;
  try {
    const [chunk] = await once(parent.stdout, 'data');
    pid = Number(String(chunk).trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    let state = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      state = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0];
      if (state === 'Z') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(state, 'Z', 'child remains unreaped during assertion');
    const lease = acquireLease({ owner: 'zombie-capture', pid,
      resources: ['exclusive:bench:desktop'], config });
    acquired = true;
    assert.match(lease.processStartIdentity, /^\d+$/);
    assert.throws(() => assertLiveLease({ owner: 'zombie-capture', pid,
      resources: ['exclusive:bench:desktop'], config }), /non-running process identity/);
  } finally {
    if (acquired) releaseLease({ owner: 'zombie-capture', pid, config });
    parent.kill('SIGTERM');
    if (parent.exitCode === null && parent.signalCode === null) await once(parent, 'exit');
    rmSync(root, { recursive: true, force: true });
  }
});
