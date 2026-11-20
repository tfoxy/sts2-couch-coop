import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectPeer } from "@godot-scene-web/direct-peer";
import { bootWebsite } from "../websiteBoot";
import { connectMirrorClient, type MirrorClient } from "@/mirror/mirrorClient";
import { hostUrl } from "@/join/hostBase";
import { decodeFrame, frame } from "@/tunnel/framing";
import { fakePair } from "@/tunnel/__tests__/fakeChannel";
import { startServiceWorkerBridge, type ServiceWorkerBridge } from "@/tunnel/serviceWorkerBridge";

afterEach(() => {
  delete globalThis.__couchCoopTunnel;
  delete globalThis.__couchCoopHostBase;
  vi.unstubAllGlobals();
});

describe("Website tunnel integration", () => {
  it("boots, sends the first control message and serves a worker resource over framed channels", async () => {
    const manifest = { entry: "/assets/app.js", css: [], buildId: "test", bootProtocol: 1,
      originAllowed: true, webOrigin: null, tunnel: "couch-tunnel/1" };
    const heads: Array<{ t: string; m: string; p: string }> = [];
    const messages: unknown[] = [];
    const channels: ReturnType<typeof fakePair>[] = [];
    let firstMessage!: () => void;
    const controlMessage = new Promise<void>(resolve => { firstMessage = resolve; });
    const peer: DirectPeer = {
      connection: {} as RTCPeerConnection,
      closed: new Promise(() => {}),
      close() { for (const pair of channels) pair.client.close(); },
      async openChannel(label) {
        const pair = fakePair(server => {
          let head: (typeof heads)[number] | undefined;
          server.addEventListener("message", event => {
            const data = (event as MessageEvent).data;
            if (typeof data === "string") {
              head = JSON.parse(data); heads.push(head!);
              if (head!.t === "ws") server.send(JSON.stringify({ s: 101, h: [] }));
              return;
            }
            const part = decodeFrame(data);
            if (head?.t === "ws") {
              if (part.opcode === 8) { server.send(data); server.close(); return; }
              messages.push(JSON.parse(new TextDecoder().decode(part.payload)));
              firstMessage();
            } else if (part.fin) {
              const body = head?.p === "/app-boot.json" ? JSON.stringify(manifest) : "resource bytes";
              server.send(JSON.stringify({ s: 200, h: [] }));
              server.send(frame(2, new TextEncoder().encode(body)));
              server.close();
            }
          });
        });
        channels.push(pair);
        return pair.open(label as "couch-tunnel/1");
      }
    };
    let workerPort: MessagePort | undefined;
    let finishResource!: (body: string) => void;
    const resource = new Promise<string>(resolve => { finishResource = resolve; });
    const worker = {
      postMessage(_message: unknown, ports: MessagePort[]) {
        workerPort = ports[0]!;
        const chunks: Uint8Array[] = [];
        workerPort.onmessage = ({ data }) => {
          if (data.type === "chunk") chunks.push(new Uint8Array(data.chunk));
          if (data.type === "end") finishResource(chunks.map(chunk => new TextDecoder().decode(chunk)).join(""));
        };
        workerPort.start();
        workerPort.postMessage({ type: "registered" });
      }
    };
    const sw = Object.assign(new EventTarget(), { controller: worker, ready: Promise.resolve({ active: worker }),
      register: vi.fn(async () => ({})) }) as unknown as ServiceWorkerContainer;
    vi.stubGlobal("navigator", { serviceWorker: sw });
    vi.stubGlobal("MessageChannel", NodeMessageChannel);
    const directFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected direct HTTP"));
    const openDirectPeer = vi.fn(async () => peer);
    let client: MirrorClient | undefined;
    let bridge: ServiceWorkerBridge | undefined;
    let base = "";
    try {
      const outcome = await bootWebsite(["http://192.168.1.5:13337"],
        "https://pages.example/?h=192.168.1.5:13337&f=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&tunnel=first", {
          serviceWorker: sw, RTCPeerConnection: class {} as typeof RTCPeerConnection,
          openDirectPeer, fetch: directFetch, hardReload: false, storage: sessionStorage,
          startServiceWorkerBridge: fetch => (bridge = startServiceWorkerBridge(fetch)),
          async injectApp(injectedBase) {
            base = injectedBase;
            globalThis.__couchCoopHostBase = base;
            client = connectMirrorClient();
            client.sendWatch(false);
            await controlMessage;
            expect(hostUrl("/res/test")).toBe(`${base}/res/test`);
            workerPort!.postMessage({ type: "request", id: 1, method: "GET", url: "/res/test", headers: [] });
            expect(await resource).toBe("resource bytes");
          }
        });
      expect(outcome?.ok).toBe(true);
      expect(base).toMatch(/^https:\/\/pages\.example\/~h\/[A-Za-z0-9_-]{22}$/);
      expect(heads.map(head => [head.t, head.m, head.p.split("?")[0]])).toEqual([
        ["fetch", "GET", "/app-boot.json"], ["ws", "GET", "/ws"], ["fetch", "GET", "/res/test"]
      ]);
      expect(messages[0]).toEqual({ type: "watch", on: false });
      expect(openDirectPeer).toHaveBeenCalledOnce();
      expect(directFetch).not.toHaveBeenCalled();
    } finally {
      client?.close();
      peer.close();
      bridge?.stop();
      workerPort?.close();
    }
  });
});
