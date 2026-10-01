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
test('ordinal proof admits exactly the pinned committed scenes and rejects the next scene', () => {
  const value = row();
  value.rendererWindow.before.frameIdentity.revision = 10;
  value.rendererWindow.after.frameIdentity.revision = 12;
  value.pageMarkerClock.beginReplayMs = 12000;
  value.pageMarkerClock.endReplayMs = 19010;
  value.replayDelivery.final.deliveryLedger.rows = [
    {index:0,recordedMs:11999,deliveredAtMs:11999,latenessMs:0},
    {index:1,recordedMs:12001,deliveredAtMs:12002,latenessMs:1},
    {index:2,recordedMs:18999,deliveredAtMs:19000,latenessMs:1},
    {index:3,recordedMs:19001,deliveredAtMs:19020,latenessMs:19},
  ];
  value.replayDelivery.final.ordinalWindow = {
    stage:'closed',failure:null,requests:2,startPauseMs:15,endPauseMs:25,
    contract:{firstIndex:1,lastIndex:2,sceneCount:2,recordingSha256:'a'.repeat(64),
      selectedDataJsonSha256:'d'.repeat(64),
      boundaryRows:[0,1,2,3].map(messageIndex => ({messageIndex,
        recordedMs:messageIndex,dataUtf8Sha256:'b'.repeat(64)})),nonSceneIndices:[]},
    open:{stage:'open',messageIndex:1,gate:{expectedRevision:10,ackSerial:5,ackBaseline:4,
      minPresentEpoch:440,presentEpoch:441,pendingAckCount:0,
      asyncSubmissionRevision:null,asyncAwaitingAckRevision:null,
      frameIdentity:{revision:10,presentEpoch:441},
      commit:{presented:true,sceneRevision:10,frameIdentity:{revision:10,presentEpoch:441}}}},
    close:{stage:'close',messageIndex:2,gate:{expectedRevision:12,ackSerial:7,ackBaseline:6,
      minPresentEpoch:864,presentEpoch:865,pendingAckCount:0,
      asyncSubmissionRevision:null,asyncAwaitingAckRevision:null,
      frameIdentity:{revision:12,presentEpoch:865},
      commit:{presented:true,sceneRevision:12,frameIdentity:{revision:12,presentEpoch:865}}}},
  };
  assert.equal(productionWindowProof(value,bounds).valid,true);
  const extra = structuredClone(value);
  extra.pageMarkerClock.endReplayMs = 19021;
  extra.replayDelivery.after = 3;
  extra.rendererWindow.after.frameIdentity.revision = 13;
  assert.match(productionWindowProof(extra,bounds).failures.join(),/ordinal boundary|timestamps/);
  const missing = structuredClone(value);
  missing.replayDelivery.final.ordinalWindow.close.gate.commit.presented = false;
  assert.match(productionWindowProof(missing,bounds).failures.join(),/ordinal boundary/);
  missing.replayDelivery.final.ordinalWindow.close.gate.commit.presented = true;
  missing.replayDelivery.final.ordinalWindow.close.gate.pendingAckCount = 1;
  assert.match(productionWindowProof(missing,bounds).failures.join(),/ordinal boundary/);
  missing.replayDelivery.final.ordinalWindow.close.gate.pendingAckCount = 0;
  missing.replayDelivery.final.deliveryLedger.rows.splice(2,1);
  assert.match(productionWindowProof(missing,bounds).failures.join(),/ordinal boundary|timestamps/);
});
