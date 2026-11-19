import {
  ChannelInbox, CHUNK_BYTES, decodeFrame, FETCH_BODY_LIMIT, frame, openChannel,
  requestPath, responseHead, send, type OpenChannel
} from "./framing";

export type TunnelFetch = (request: Request) => Promise<Response>;
class BodyTooLarge extends Error {}

export function createTunnelFetch(open: OpenChannel): TunnelFetch {
  return async function tunnelFetch(request) {
    request.signal.throwIfAborted();
    if (Number(request.headers.get("content-length")) > FETCH_BODY_LIMIT) return new Response(null, { status: 413 });
    const channel = await openChannel(open, request.signal);
    const inbox = new ChannelInbox(channel);
    const reader = request.body?.getReader();
    let finished = false;
    let uploadError: unknown;
    const cleanup = () => {
      request.signal.removeEventListener("abort", abort);
      inbox.dispose();
      channel.close();
      void reader?.cancel().catch(() => {});
    };
    const abort = () => { inbox.fail(request.signal.reason); cleanup(); };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const upload = async () => {
      await send(channel, JSON.stringify({ v: 1, t: "fetch", m: request.method, p: requestPath(request.url), h: [...request.headers], sp: [] }));
      let total = 0;
      let initial = true;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > FETCH_BODY_LIMIT) throw new BodyTooLarge();
          for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
            await send(channel, frame(initial ? 2 : 0, value.subarray(offset, offset + CHUNK_BYTES), false));
            initial = false;
          }
        }
      }
      await send(channel, frame(0));
    };
    void upload().catch(error => { uploadError = error; inbox.fail(error); channel.close(); });
    try {
      const head = responseHead(await inbox.read());
      if (head.s < 200) throw new Error("Invalid fetch status");
      let initial = true;
      const next = async () => {
        request.signal.throwIfAborted();
        const part = decodeFrame(await inbox.read());
        if (part.opcode !== (initial ? 2 : 0) && !(initial && part.fin && !part.payload.length && part.opcode === 0)) {
          throw new Error("Invalid fetch continuation");
        }
        initial = false;
        return part;
      };
      const noBody = request.method === "HEAD" || head.s === 204 || head.s === 205 || head.s === 304;
      if (noBody) {
        const part = await next();
        if (!part.fin || part.payload.length) throw new Error("Unexpected fetch body");
        finished = true;
        cleanup();
        return new Response(null, { status: head.s, headers: head.h });
      }
      const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          try {
            const part = await next();
            if (part.payload.length) controller.enqueue(part.payload);
            if (part.fin) { finished = true; controller.close(); cleanup(); }
          } catch (error) { controller.error(error); cleanup(); }
        },
        cancel() { finished = true; cleanup(); }
      }, { highWaterMark: 0 });
      return new Response(body, { status: head.s, headers: head.h });
    } catch (error) {
      if (!finished) cleanup();
      if (uploadError instanceof BodyTooLarge) return new Response(null, { status: 413 });
      throw error;
    }
  };
}
