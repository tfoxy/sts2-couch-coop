import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('bench requires a paired executable path and hash before browser launch', () => {
  const bench = new URL('./bench-mirror-replay.mjs',import.meta.url).pathname;
  const result = spawnSync(process.execPath,[bench,'--help','--browser-executable','/bin/true'],
    {encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/--browser-executable and --browser-executable-sha256 require each other/);
});

test('profile capture rejects a stale browser hash before making an output directory', () => {
  const dir = mkdtempSync(join(tmpdir(),'pinned-browser-'));
  try {
    const config = join(dir,'config.json'), output = join(dir,'capture');
    writeFileSync(config,JSON.stringify({captureMode:'visual',shotClockMs:20000,
      browserExecutable:'/bin/true',browserExecutableSha256:'0'.repeat(64)}));
    const result = spawnSync(process.execPath,[new URL('./profile-mirror-rust.mjs',import.meta.url).pathname,
      'capture','--config',config,'--out',output],{encoding:'utf8'});
    assert.equal(result.status,2);
    assert.match(result.stderr,/pinned browser executable hash missing or differs before capture/);
    assert.equal(existsSync(output),false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('profile capture requires all declared live leases before making output', () => {
  const dir = mkdtempSync(join(tmpdir(),'pinned-capture-lease-'));
  try {
    const config = join(dir,'config.json'), output = join(dir,'capture');
    writeFileSync(config,JSON.stringify({captureMode:'visual',shotClockMs:20000,
      requiredLeaseResources:['exclusive:bench:desktop','exclusive:browser:desktop-rust-replay',
        'exclusive:port:5351','exclusive:port:8351']}));
    const result = spawnSync(process.execPath,[new URL('./profile-mirror-rust.mjs',import.meta.url).pathname,
      'capture','--config',config,'--out',output],{encoding:'utf8',env:{...process.env,
        COUCHCOOP_LIVEQA_OWNER:'missing-capture-lease',COUCHCOOP_LIVEQA_PID:'99999999'}});
    assert.equal(result.status,2);
    assert.match(result.stderr,/no live-QA lease/);
    assert.equal(existsSync(output),false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
