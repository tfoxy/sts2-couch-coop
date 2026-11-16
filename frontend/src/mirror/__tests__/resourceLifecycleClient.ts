import type { RenderStreamClient, RenderStreamClientOptions } from "@godot-scene-web/render-stream-client";
import { StreamLoop } from "@render-stream-test/loop";
import { FakeClock, FakeCore, FakeTransport, session, tx } from "@render-stream-test/fakes";

// Keep resource scheduling, failure classification and status delivery real. Only the WASM
// boundary, carrier and clock are scripted; no status is fabricated by the consumer test.
export function resourceLifecycleClient(options: RenderStreamClientOptions) {
  const core = new FakeCore();
  const clock = new FakeClock();
  let transport!: FakeTransport;
  const loop = new StreamLoop({
    core, clock, endpoint: options.endpoint, creditWindow: 2,
    onStatus: (status) => options.onStatus?.(status),
    transport: (_endpoint, protocol, events) => (transport = new FakeTransport(protocol, events)),
    canvas: () => ({ backing: [1920, 1080], css: [1920, 1080], dprMilli: 1000, gpuFormats: "none" })
  });
  const client: RenderStreamClient = {
    connect: () => loop.connect(),
    setEndpoint: () => {},
    stats: () => loop.stats(),
    dispose: () => loop.dispose(),
    recording: () => null,
    cssToPresentation: (x, y) => ({ x, y }),
    presentationToCss: (rect) => rect,
    toGame: (x, y) => ({ point: { x, y }, drawn: { x, y }, item: null }),
    clientToGame: (x, y) => ({ point: { x, y }, drawn: { x, y }, item: null })
  };
  return {
    client,
    calls: core.calls,
    get transport() { return transport; },
    open() { transport.on.open(); transport.on.message(session()); },
    transaction(seq: number, hashes: string[]) { transport.on.message(tx(seq, hashes)); },
    frame() { clock.frame(); },
    complete(hash: string, status: number) {
      const request = transport.gets.find((get) => get.path.endsWith(hash));
      if (!request) throw new Error(`No resource GET for ${hash}`);
      request.resolve(status);
    }
  };
}
