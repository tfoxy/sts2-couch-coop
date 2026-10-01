import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productionWindowProof } from './lib/production-window-proof.mjs';

const row = () => ({
  rendererWindow:{before:{ready:true,resources:{pending:0,failed:0},
    frameIdentity:{revision:386,presentEpoch:441,clock:null},draw:{completedFrames:441}},
    after:{ready:true,resources:{pending:0,failed:0},
      frameIdentity:{revision:677,presentEpoch:865,clock:null},draw:{completedFrames:865}}},
  replayDelivery:{before:0,after:2,index:678,count:717,final:{delivered:2,
    deliveryLedger:{dropped:0,clock:'performance.now relative to recorded replay start',
      method:'scene delta timestamp immediately before fake transport delivery',rows:[
        {index:386,recordedMs:12000,deliveredAtMs:12002,latenessMs:2},
        {index:387,recordedMs:19000,deliveredAtMs:19003,latenessMs:3}
      ]}}},
  window:{startMs:12000,endMs:19000,spanMs:6990.5},
  pageMarkerClock:{beginEpochUs:100,endEpochUs:200},
  frameGaps:{frames:424},sceneAckLatency:{count:291},
});
const bounds = {startMs:12000,endMs:19000};
test('ordinary production window requires completed content and delivery progress', () => {
  assert.equal(productionWindowProof(row(),bounds).valid,true);
  const frozen = row(); frozen.rendererWindow.after.draw.completedFrames = 441;
  assert.match(productionWindowProof(frozen,bounds).failures.join(),/completed frame/);
  const clocked = row(); clocked.rendererWindow.after.frameIdentity.clock = 20000;
  assert.match(productionWindowProof(clocked,bounds).failures.join(),/diagnostic clock/);
  const missing = row(); missing.sceneAckLatency.count = 0;
  assert.equal(productionWindowProof(missing,bounds).valid,true);
  const dropped = row(); dropped.replayDelivery.final.deliveryLedger.dropped = 1;
  assert.match(productionWindowProof(dropped,bounds).failures.join(),/timestamps/);
  assert.match(productionWindowProof(row(),{startMs:12000,endMs:20500}).failures.join(),/boundary/);
});
test('production proof separates recorded schedule from actual marker deliveries', () => {
  const value = row();
  value.pageMarkerClock.beginReplayMs = 12001;
  value.pageMarkerClock.endReplayMs = 19002;
  const proof = productionWindowProof(value,bounds);
  assert.equal(proof.deliveryTiming.inWindow,2);
  assert.equal(proof.deliveryTiming.deliveredInWindow,1);
  assert.equal(proof.deliveryTiming.firstDeliveredIndex,386);
  assert.equal(proof.deliveryTiming.lastDeliveredIndex,386);
});
