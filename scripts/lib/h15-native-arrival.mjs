/** Raw scene-event barrier for H15 setup; never reads the renderer's predicted or cosmetic pose. */
export function createH15NativeArrivalProbe() {
  const scenes = new Map();
  let pending = null;
  let result = Promise.resolve(null);
  const finish = (ready, reason = null) => {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.resolve({ ready, reason, holderId: current.holderId, target: current.target, samples: current.samples });
  };
  const originOf = (nodes, holder) => {
    let point = { x: 0, y: 0 };
    const visited = new Set();
    for (let node = holder; node;) {
      if (visited.has(node.id)) return null;
      visited.add(node.id);
      const t = node.transform;
      if (t) {
        const values = [t.xAxis?.x, t.xAxis?.y, t.yAxis?.x, t.yAxis?.y, t.origin?.x, t.origin?.y];
        if (!values.every(Number.isFinite)) return null;
        const [a, b, c, d, x, y] = values;
        point = { x: a * point.x + c * point.y + x, y: b * point.x + d * point.y + y };
      }
      if (node.parentId == null) return point;
      node = nodes.get(String(node.parentId));
      if (!node) return null;
    }
    return null;
  };
  return {
    arm(holderId, name, timeoutMs = 12000) {
      finish(false, "superseded");
      result = new Promise((resolve) => {
        pending = { holderId, name, target: null, socket: null, samples: [], resolve,
          timer: setTimeout(() => finish(false, "no native board arrival before deadline"), timeoutMs) };
      });
    },
    wait() { return result; },
    cancel() { finish(false, "gesture cancelled"); },
    sent(socket, input) {
      if (!pending || pending.target || input.type !== "input" || input.kind !== "hover") return;
      if (![input.coordX, input.coordY].every(Number.isFinite)) return;
      pending.socket = socket;
      pending.target = { x: input.coordX, y: input.coordY, requestId: input.requestId };
    },
    receive(socket, delta) {
      if (delta.type !== "scene-delta") return;
      let nodes = scenes.get(socket);
      if (!nodes || delta.full) scenes.set(socket, nodes = new Map());
      for (const id of delta.removedIds ?? []) nodes.delete(String(id));
      for (const update of delta.upserts ?? []) {
        const id = String(update.id);
        const previous = nodes.get(id);
        nodes.set(id, { id, parentId: update.parentId ?? null,
          name: update.name || previous?.name, nodeType: update.nodeType || previous?.nodeType,
          transform: update.transform ?? null });
      }
      const current = pending;
      if (!current?.target || current.socket !== socket) return;
      // Only a fresh producer transform can prove arrival. Hints and unrelated scene ticks cannot.
      if (!(delta.upserts ?? []).some((node) => String(node.id) === current.holderId && node.transform)) return;
      const holder = nodes.get(current.holderId);
      if (holder?.name !== current.name || !holder.nodeType?.endsWith("NHandCardHolder")) {
        finish(false, "native holder identity changed");
        return;
      }
      const origin = originOf(nodes, holder);
      const distance = origin ? Math.hypot(origin.x - current.target.x, origin.y - current.target.y) : null;
      if (current.samples.length < 300) current.samples.push({ atMs: performance.now(), origin, distance });
      if (distance !== null && distance <= 2) finish(true);
    }
  };
}
