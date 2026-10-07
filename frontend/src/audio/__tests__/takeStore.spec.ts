import { describe, expect, it, vi } from "vitest";
import { __resetAssetVersionForTest, publishAssetVersion } from "@/join/assetVersion";
import { TakeStore } from "../takeStore";
import type { AudioContextLike } from "../audioUnlock";

describe("seat audio take index", () => {
  it("maps ready key IDs to immutable WAV routes and awaits index warmup before cache lookup", async () => {
    const keyId = "0123456789abcdef0123456789abcdef";
    const calls: string[] = [];
    publishAssetVersion("game-build-8");
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (String(url) === "/audio/takes") return new Response(JSON.stringify({ schema: 1, bankset: "bank-set", keys: [keyId] }));
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const context = { decodeAudioData: async () => ({ decoded: true }) } as unknown as AudioContextLike;
    const store = new TakeStore(context, fetcher);
    const buffer = await store.get(keyId);
    expect(buffer).toEqual({ decoded: true });
    expect(calls).toEqual([
      "/audio/takes",
      `/audio/take/1/bank-set/${keyId}.wav?b=game-build-8`
    ]);
    __resetAssetVersionForTest();
  });

  it("fills newly ready WAV URLs serially without refetching queued URLs", async () => {
    const firstKey = "0123456789abcdef0123456789abcdef";
    const secondKey = "fedcba9876543210fedcba9876543210";
    const firstUrl = `/audio/take/1/b/${firstKey}.wav`;
    const secondUrl = `/audio/take/1/b/${secondKey}.wav`;
    let releaseFirst!: () => void;
    const calls: Array<{ url: string; cache?: RequestCache }> = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), cache: init?.cache });
      if (String(url) === "/audio/takes") return new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [] }));
      if (String(url) === firstUrl) await new Promise<void>(resolve => { releaseFirst = resolve; });
      return new Response(new Uint8Array([1]));
    });
    const store = new TakeStore({} as AudioContextLike, fetcher);
    await store.warm();
    expect(store.setUrl(firstKey, firstUrl)).toBe(true);
    expect(store.setUrl(firstKey, firstUrl)).toBe(false);
    const firstFill = store.fillHttpCache();
    const duplicateFill = store.fillHttpCache();
    await Promise.resolve();
    expect(calls).toEqual([{ url: "/audio/takes", cache: undefined }, { url: firstUrl, cache: "force-cache" }]);
    expect(store.setUrl(secondKey, secondUrl)).toBe(true);
    const secondFill = store.fillHttpCache();
    expect(calls).toHaveLength(2);
    releaseFirst();
    await Promise.all([firstFill, duplicateFill, secondFill]);
    expect(calls).toEqual([
      { url: "/audio/takes", cache: undefined },
      { url: firstUrl, cache: "force-cache" },
      { url: secondUrl, cache: "force-cache" }
    ]);
  });

  it("uses a take-ready URL while the startup index is still unresolved", async () => {
    const keyId = "0123456789abcdef0123456789abcdef";
    const url = `/audio/take/1/b/${keyId}.wav`;
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input) === "/audio/takes") return await new Promise<Response>(() => {});
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const buffer = { decoded: true } as unknown as AudioBuffer;
    const store = new TakeStore({ decodeAudioData: async () => buffer } as unknown as AudioContextLike, fetcher);
    void store.warm();
    store.setUrl(keyId, url);
    expect(await store.get(keyId)).toBe(buffer);
    expect(calls).toEqual(["/audio/takes", url]);
  });
});
