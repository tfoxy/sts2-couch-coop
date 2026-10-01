import assert from 'node:assert/strict';
import { validatePinnedReplayShot } from './lib/pinned-replay-shot.mjs';

const frame = { revision: 178, presentEpoch: 402, clock: 20000 };
const proof = { before: { revision: 178, presentEpoch: 401, clock: 19949.793 },
  returned: frame, after: frame,
  renderer: { ready: true, resources: { pending: 0, failed: 0 }, frameIdentity: frame },
  replay: { done: true, index: 717, count: 717 } };
assert.deepEqual(validatePinnedReplayShot(proof, 20000), { valid: true, reason: null });
assert.match(validatePinnedReplayShot({ ...proof, replay: { done: true, index: 716, count: 717 } }, 20000).reason, /fully delivered/);
assert.match(validatePinnedReplayShot({ ...proof, after: { ...frame, clock: 19949.793 } }, 20000).reason, /completed frame/);
assert.match(validatePinnedReplayShot({ ...proof, after: { ...frame, presentEpoch: 401 } }, 20000).reason, /new frame/);
assert.match(validatePinnedReplayShot({ ...proof, renderer: { ...proof.renderer, resources: { pending: 1, failed: 0 } } }, 20000).reason, /not ready/);
