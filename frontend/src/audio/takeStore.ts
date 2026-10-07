import type { AudioContextLike } from "./audioUnlock";
import { isKeyId } from "./audioWire";
import { assetVersionSuffix } from "@/join/assetVersion";
import { hostUrl } from "@/join/hostBase";

export interface TakeIndex { schema: number; bankset: string; keys?: string[]; takes?: Record<string, string>; }
type TakeDiagnostic = (type: string, fields: Record<string, unknown>) => void;
export class TakeStore {
  private readonly urls = new Map<string, string>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private warming: Promise<void> | null = null;
  private cacheFillTail: Promise<void> = Promise.resolve();
  private readonly queuedCacheUrls = new Set<string>();
  private readonly fetcher: typeof fetch;
  constructor(private readonly context: AudioContextLike, fetcher: typeof fetch = fetch,
    private readonly diagnostic?: TakeDiagnostic) {
    this.fetcher = (input, init) => fetcher.call(globalThis, input, init);
  }
  async warm(indexUrl = "/audio/takes"): Promise<void> {
    if (!this.warming) this.warming = this.fetcher(indexUrl).then(async r => {
      if (!r.ok) throw new Error(`audio index ${r.status}`);
      const index = await r.json() as TakeIndex;
      if (Number.isInteger(index.schema) && typeof index.bankset === "string" && Array.isArray(index.keys)) {
        for (const keyId of index.keys) if (typeof keyId === "string" && isKeyId(keyId)) {
          const route = `/audio/take/${index.schema}/${encodeURIComponent(index.bankset)}/${keyId}.wav${assetVersionSuffix(false)}`;
          this.urls.set(keyId, hostUrl(route));
        }
      }
      for (const [keyId, url] of Object.entries(index.takes ?? {})) if (isKeyId(keyId) && typeof url === "string") this.urls.set(keyId, hostUrl(url));
    }).catch(() => {});
    return this.warming;
  }
  setUrl(keyId: string, url: string): boolean {
    if (!isKeyId(keyId)) return false;
    const isNew = this.urls.get(keyId) !== url;
    this.urls.set(keyId, url);
    return isNew;
  }
  setBuffer(keyId: string, buffer: AudioBuffer): void { if (isKeyId(keyId)) this.buffers.set(keyId, buffer); }
  hasDecoded(keyId: string): boolean { return this.buffers.has(keyId); }
  async get(keyId: string, signal?: AbortSignal, reason = "seat-event"): Promise<AudioBuffer | null> {
    if (!this.buffers.has(keyId) && !this.urls.has(keyId)) await this.warm();
    const cached = this.buffers.get(keyId);
    const url = this.urls.get(keyId);
    this.diagnostic?.("take-lookup", { keyId, reason, decoded: !!cached, url: url ?? null, aborted: !!signal?.aborted });
    if (cached) return cached;
    if (!url) return null;
    let stage = "fetch";
    try {
      this.diagnostic?.("take-fetch-start", { keyId, reason, url });
      const response = await this.fetcher(url, { cache: "force-cache", signal });
      this.diagnostic?.("take-fetch-response", { keyId, reason, url, status: response.status, ok: response.ok });
      if (!response.ok) return null;
      stage = "body";
      const bytes = await response.arrayBuffer();
      stage = "decode";
      const buffer = await this.context.decodeAudioData(bytes);
      this.buffers.set(keyId, buffer); return buffer;
    } catch (error) {
      this.diagnostic?.("take-get-failed", { keyId, reason, url, stage,
        error: error instanceof Error ? error.message : String(error), aborted: !!signal?.aborted });
      return null;
    }
  }
  /** Consume each take serially so its complete body can enter the HTTP cache. */
  fillHttpCache(signal?: AbortSignal): Promise<void> {
    for (const url of this.urls.values()) {
      if (signal?.aborted || this.queuedCacheUrls.has(url)) continue;
      this.queuedCacheUrls.add(url);
      this.cacheFillTail = this.cacheFillTail.then(async () => {
        if (signal?.aborted) return;
        try {
          const response = await this.fetcher(url, { cache: "force-cache", signal });
          if (response.ok) await response.arrayBuffer();
        } catch { /* retry on demand */ }
      });
    }
    return this.cacheFillTail;
  }
  clearDecoded(): void { this.buffers.clear(); }
}
