// Ordinary-clock output evidence uses counters already sampled at the active
// marker boundaries. It never asks the page to rebuild or advance its clock.
export function productionWindowProof(row, expectedWindow) {
  const before = row?.rendererWindow?.before;
  const after = row?.rendererWindow?.after;
  const a = before?.frameIdentity;
  const b = after?.frameIdentity;
  const delivery = row?.replayDelivery;
  const clock = row?.pageMarkerClock;
  const window = row?.window;
  const ledger = delivery?.final?.deliveryLedger;
  const deliveryRows = ledger?.rows;
  const inWindow = Array.isArray(deliveryRows) && expectedWindow
    ? deliveryRows.filter(item => item.recordedMs >= expectedWindow.startMs &&
      item.recordedMs <= expectedWindow.endMs) : [];
  const deliveredInWindow = Array.isArray(deliveryRows) &&
    Number.isFinite(clock?.beginReplayMs) && Number.isFinite(clock?.endReplayMs)
    ? deliveryRows.filter(item => item.deliveredAtMs >= clock.beginReplayMs &&
      item.deliveredAtMs <= clock.endReplayMs) : [];
  const sortedLateness = inWindow.map(item => item.latenessMs).sort((x,y) => x-y);
  const proof = {
    schema: 'production-window-proof/1',
    clockMode: a?.clock === null && b?.clock === null ? 'ordinary' : 'diagnostic-or-unavailable',
    frame: {before:a ?? null,after:b ?? null,
      completedBefore:before?.draw?.completedFrames ?? null,
      completedAfter:after?.draw?.completedFrames ?? null},
    delivery: {before:delivery?.before ?? null,after:delivery?.after ?? null,
      index:delivery?.index ?? null,count:delivery?.count ?? null},
    readiness: {before:before?.ready ?? null,after:after?.ready ?? null,
      pendingBefore:before?.resources?.pending ?? null,pendingAfter:after?.resources?.pending ?? null,
      failedBefore:before?.resources?.failed ?? null,failedAfter:after?.resources?.failed ?? null},
    window:window ?? null, pageClock:clock ?? null,
    deliveryTiming: {clock:ledger?.clock ?? null,method:ledger?.method ?? null,
      rows:Array.isArray(deliveryRows) ? deliveryRows.length : null,dropped:ledger?.dropped ?? null,
      inWindow:inWindow.length,firstIndex:inWindow[0]?.index ?? null,
      lastIndex:inWindow.at(-1)?.index ?? null,
      deliveredInWindow:deliveredInWindow.length,
      firstDeliveredIndex:deliveredInWindow[0]?.index ?? null,
      lastDeliveredIndex:deliveredInWindow.at(-1)?.index ?? null,
      maxLatenessMs:sortedLateness.at(-1) ?? null,
      p95LatenessMs:sortedLateness.length
        ? sortedLateness[Math.ceil(sortedLateness.length*0.95)-1] : null},
    frameGaps:row?.frameGaps ?? null,sceneAckLatency:row?.sceneAckLatency ?? null,
    ordinalWindow:delivery?.final?.ordinalWindow ?? null,
  };
  const failures = [];
  if (proof.clockMode !== 'ordinary') failures.push('diagnostic clock in production window');
  if (proof.readiness.before !== true || proof.readiness.after !== true ||
      [proof.readiness.pendingBefore,proof.readiness.pendingAfter,
        proof.readiness.failedBefore,proof.readiness.failedAfter].some(x => x !== 0))
    failures.push('renderer or resources not ready at both boundaries');
  if (!Number.isInteger(a?.revision) || !Number.isInteger(b?.revision) || b.revision <= a.revision ||
      !Number.isInteger(a?.presentEpoch) || !Number.isInteger(b?.presentEpoch) || b.presentEpoch <= a.presentEpoch ||
      !Number.isInteger(proof.frame.completedBefore) ||
      !Number.isInteger(proof.frame.completedAfter) || proof.frame.completedAfter <= proof.frame.completedBefore)
    failures.push('completed frame/revision progress unavailable');
  if (!Number.isInteger(proof.delivery.before) || !Number.isInteger(proof.delivery.after) ||
      proof.delivery.after <= proof.delivery.before || !Number.isInteger(proof.delivery.index) ||
      !Number.isInteger(proof.delivery.count) || proof.delivery.index > proof.delivery.count)
    failures.push('scene delivery progress unavailable');
  if (!Array.isArray(deliveryRows) || ledger?.dropped !== 0 ||
      inWindow.length === 0 || inWindow.length !== proof.delivery.after-proof.delivery.before ||
      inWindow.some((item,index) => index > 0 && item.index !== inWindow[index-1].index+1) ||
      deliveryRows.some((item,index) => !Number.isInteger(item.index) ||
        !Number.isFinite(item.recordedMs) || !Number.isFinite(item.deliveredAtMs) ||
        !Number.isFinite(item.latenessMs) || item.latenessMs < -1 ||
        Math.abs(item.latenessMs-(item.deliveredAtMs-item.recordedMs)) > 1e-6 ||
        (index > 0 && (item.index <= deliveryRows[index-1].index ||
          item.recordedMs < deliveryRows[index-1].recordedMs ||
          item.deliveredAtMs < deliveryRows[index-1].deliveredAtMs))))
    failures.push('recorded scene delivery timestamps incomplete or unordered');
  if (!window || window.startMs !== expectedWindow?.startMs || window.endMs !== expectedWindow?.endMs ||
      !Number.isFinite(window.spanMs) || window.spanMs <= 0)
    failures.push('recorded window boundary mismatch');
  if (!Number.isFinite(clock?.beginEpochUs) || !Number.isFinite(clock?.endEpochUs) ||
      clock.endEpochUs <= clock.beginEpochUs)
    failures.push('direct page marker clock unavailable');
  if (proof.ordinalWindow) {
    const ordinal = proof.ordinalWindow, contract = ordinal.contract;
    const committedGate = (gate, frame) =>
      Number.isInteger(gate?.expectedRevision) && gate.expectedRevision === frame?.revision &&
      gate.frameIdentity?.revision === frame.revision &&
      gate.frameIdentity?.presentEpoch === frame.presentEpoch &&
      gate.presentEpoch === frame.presentEpoch &&
      gate.presentEpoch > gate.minPresentEpoch &&
      Number.isInteger(gate.ackSerial) && Number.isInteger(gate.ackBaseline) &&
      gate.ackSerial > gate.ackBaseline && gate.pendingAckCount === 0 &&
      gate.asyncSubmissionRevision === null && gate.asyncAwaitingAckRevision === null &&
      gate.commit?.presented === true && gate.commit.sceneRevision === frame.revision &&
      gate.commit.frameIdentity?.revision === frame.revision &&
      gate.commit.frameIdentity?.presentEpoch === frame.presentEpoch;
    const inside = deliveryRows?.filter(item => item.deliveredAtMs >= clock?.beginReplayMs &&
      item.deliveredAtMs <= clock?.endReplayMs) ?? [];
    const prior = deliveryRows?.find(item => item.index === contract?.firstIndex - 1);
    const next = deliveryRows?.find(item => item.index === contract?.lastIndex + 1);
    if (ordinal.stage !== 'closed' || ordinal.failure !== null || ordinal.requests !== 2 ||
        !contract || !Number.isInteger(contract.firstIndex) ||
        !Number.isInteger(contract.lastIndex) ||
        contract.sceneCount !== contract.lastIndex - contract.firstIndex + 1 ||
        !/^[0-9a-f]{64}$/.test(contract.recordingSha256 ?? '') ||
        !/^[0-9a-f]{64}$/.test(contract.selectedDataJsonSha256 ?? '') ||
        !Array.isArray(contract.boundaryRows) || contract.boundaryRows.length !== 4 ||
        contract.boundaryRows.some((row, index) =>
          row.messageIndex !== [contract.firstIndex - 1, contract.firstIndex,
            contract.lastIndex, contract.lastIndex + 1][index] ||
          !Number.isFinite(row.recordedMs) ||
          !/^[0-9a-f]{64}$/.test(row.dataUtf8Sha256 ?? '')) ||
        !Array.isArray(contract.nonSceneIndices) || contract.nonSceneIndices.length !== 0 ||
        !Number.isFinite(ordinal.startPauseMs) || ordinal.startPauseMs < 0 ||
        !Number.isFinite(ordinal.endPauseMs) || ordinal.endPauseMs < 0 ||
        ordinal.open?.stage !== 'open' || ordinal.close?.stage !== 'close' ||
        ordinal.open.messageIndex !== contract.firstIndex ||
        ordinal.close.messageIndex !== contract.lastIndex ||
        ordinal.open.gate?.expectedRevision !== a?.revision ||
        ordinal.close.gate?.expectedRevision !== b?.revision ||
        ordinal.close.gate?.ackSerial <= ordinal.open.gate?.ackSerial ||
        b?.revision - a?.revision !== contract.sceneCount ||
        proof.delivery.after - proof.delivery.before !== contract.sceneCount ||
        inside.length !== contract.sceneCount ||
        inside[0]?.index !== contract.firstIndex ||
        inside.at(-1)?.index !== contract.lastIndex ||
        inside.some((item,index) => item.index !== contract.firstIndex + index) ||
        !(prior?.deliveredAtMs < clock?.beginReplayMs) ||
        !(next?.deliveredAtMs > clock?.endReplayMs) ||
        !committedGate(ordinal.open.gate, a) || !committedGate(ordinal.close.gate, b))
      failures.push('ordinal boundary, exact committed work, or pause evidence unavailable');
  }
  // sceneAckLatency is read after the direct marker closes and can include
  // drained post-window deliveries. Keep it as a diagnostic, not a gate.
  proof.valid = failures.length === 0;
  proof.failures = failures;
  return proof;
}
