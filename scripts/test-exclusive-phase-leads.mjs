import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exclusivePhaseLeads } from './lib/exclusive-phase-leads.mjs';

const edge = (phase,edge,us) => ({runId:'r',rendererInstanceId:'i',operationId:1,
  eventType:'phase-edge',clockDomain:'performance.timeOrigin+now',phase,edge,timestampUs:String(us)});
test('exclusive synchronous wall accounting subtracts direct children and rejects open spans', () => {
  const result = exclusivePhaseLeads([edge('couch.build-draw-list','start',1000),
    edge('couch.draw-paint-order','start',2000),edge('couch.draw-paint-order','end',5000),
    edge('couch.draw-root-walk','start',6000),edge('couch.draw-root-walk','end',10000),
    edge('couch.build-draw-list','end',12000)]);
  assert.deepEqual(result.failures,[]);
  assert.equal(result.unit,'ms wall, not CPU');
  const parent = result.phases.find(row => row.phase === 'couch.build-draw-list');
  assert.equal(parent.inclusiveWallMs,11);
  assert.equal(parent.exclusiveWallMs,4);
  assert.match(exclusivePhaseLeads([edge('x','start',1)]).failures.join(),/open phase/);
});
