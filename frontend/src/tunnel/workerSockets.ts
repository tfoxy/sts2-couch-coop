/** Worker sockets use the window's tunnel; RTC peers remain owned by the window. */
export function serveWorkerSockets(port: MessagePort, Socket: typeof WebSocket): () => void {
  const sockets = new Map<number, WebSocket>();
  port.onmessage = ({ data }) => {
    const { id, type } = data;
    try {
      if (type === "open") {
        const socket = new Socket(data.url, data.protocols);
        sockets.set(id, socket);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => port.postMessage({ id, type: "open", protocol: socket.protocol });
        socket.onmessage = event => {
          const payload = event.data as string | ArrayBuffer;
          port.postMessage({ id, type: "message", data: payload }, payload instanceof ArrayBuffer ? [payload] : []);
        };
        socket.onerror = () => port.postMessage({ id, type: "error" });
        socket.onclose = event => {
          sockets.delete(id);
          port.postMessage({ id, type: "close", code: event.code, reason: event.reason, wasClean: event.wasClean });
        };
      } else if (type === "send") sockets.get(id)?.send(data.data);
      else if (type === "close") sockets.get(id)?.close(data.code, data.reason);
    } catch {
      const socket = sockets.get(id);
      if (socket) { socket.onclose = null; socket.close(); sockets.delete(id); }
      port.postMessage({ id, type: "error" });
      port.postMessage({ id, type: "close", code: 1006, reason: "", wasClean: false });
    }
  };
  port.start();
  return () => {
    port.onmessage = null;
    for (const socket of sockets.values()) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    sockets.clear();
    port.close();
  };
}

export function createWorkerSocketCtor(port: MessagePort): { WebSocket: typeof WebSocket; dispose(): void } {
  let nextId = 0;
  const sockets = new Map<number, WorkerSocket>();
  class WorkerSocket extends EventTarget {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
    readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
    readonly id = ++nextId;
    readonly extensions = "";
    readonly bufferedAmount = 0;
    binaryType: BinaryType = "blob";
    protocol = "";
    readyState = WorkerSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    constructor(readonly url: string, protocols?: string | string[]) {
      super();
      sockets.set(this.id, this);
      for (const type of ["open", "message", "error", "close"] as const) {
        this.addEventListener(type, event => (this[`on${type}`] as ((event: Event) => void) | null)?.call(this, event));
      }
      port.postMessage({ id: this.id, type: "open", url, protocols });
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState === WorkerSocket.CONNECTING) throw new DOMException("Socket connecting", "InvalidStateError");
      if (this.readyState === WorkerSocket.OPEN) port.postMessage({ id: this.id, type: "send", data });
    }
    close(code?: number, reason = "") {
      if (this.readyState >= WorkerSocket.CLOSING) return;
      this.readyState = WorkerSocket.CLOSING;
      port.postMessage({ id: this.id, type: "close", code, reason });
    }
  }
  port.onmessage = ({ data }) => {
    const socket = sockets.get(data.id);
    if (!socket) return;
    switch (data.type) {
      case "open":
        if (socket.readyState !== WorkerSocket.CONNECTING) return;
        socket.readyState = WorkerSocket.OPEN;
        socket.protocol = data.protocol;
        socket.dispatchEvent(new Event("open"));
        break;
      case "message":
        if (socket.readyState !== WorkerSocket.OPEN) return;
        socket.dispatchEvent(new MessageEvent("message", { data: data.data instanceof ArrayBuffer && socket.binaryType === "blob"
          ? new Blob([data.data]) : data.data }));
        break;
      case "error": socket.dispatchEvent(new Event("error")); break;
      case "close":
        socket.readyState = WorkerSocket.CLOSED;
        sockets.delete(data.id);
        socket.dispatchEvent(new CloseEvent("close", { code: data.code, reason: data.reason, wasClean: data.wasClean }));
    }
  };
  port.start();
  return {
    WebSocket: WorkerSocket as unknown as typeof WebSocket,
    dispose() {
      for (const socket of sockets.values()) socket.close();
      sockets.clear();
      port.onmessage = null;
      port.close();
    }
  };
}
