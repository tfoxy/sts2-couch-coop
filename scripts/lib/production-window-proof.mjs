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
  // sceneAckLatency is read after the direct marker closes and can include
  // drained post-window deliveries. Keep it as a diagnostic, not a gate.
  proof.valid = failures.length === 0;
  proof.failures = failures;
  return proof;
}
