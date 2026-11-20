import type { DirectPeer } from "@godot-scene-web/direct-peer";
import type { OpenChannel } from "./framing";

type Peer = Pick<DirectPeer, "openChannel" | "closed" | "close">;

/** Peer loss retires its channels; the next request shares one new connection attempt. */
export function createPeerSession(initial: Peer, reconnect: () => Promise<Peer>): {
  open: OpenChannel;
  readonly closed: Promise<void>;
  close(): void;
} {
  interface State { peer: Peer; ended: boolean; channels: Set<RTCDataChannel> }
  let current: State | undefined;
  let pending: Promise<State> | undefined;
  let stopped = false;
  let closed = initial.closed;

  function retire(state: State) {
    if (state.ended) return;
    state.ended = true;
    if (current === state) current = undefined;
    for (const channel of state.channels) channel.close();
    state.channels.clear();
  }
  function adopt(peer: Peer): State {
    if (stopped) { peer.close(); throw new Error("Host tunnel stopped"); }
    const state: State = { peer, ended: false, channels: new Set() };
    current = state;
    closed = peer.closed;
    void peer.closed.then(() => retire(state), () => retire(state));
    return state;
  }
  adopt(initial);

  return {
    get closed() { return closed; },
    async open(label) {
      if (stopped) throw new Error("Host tunnel stopped");
      if (!current && !pending) {
        pending = Promise.resolve().then(reconnect).then(adopt).finally(() => { pending = undefined; });
      }
      const state = current ?? await pending!;
      if (state.ended) throw new Error("Host peer closed");
      const channel = await state.peer.openChannel(label);
      if (stopped || state.ended) {
        channel.close();
        throw new Error("Host peer closed");
      }
      state.channels.add(channel);
      channel.addEventListener("close", () => state.channels.delete(channel), { once: true });
      return channel;
    },
    close() {
      stopped = true;
      if (current) {
        const state = current;
        retire(state);
        state.peer.close();
      }
    }
  };
}
