import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeStill } from "@/mirror/stillDecode";

describe("decodeStill failure seam", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports a completed decode failure", async () => {
    class DecodeFailureImage {
      complete = true;
      naturalWidth = 0;
      decoding = "";
      src = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decode(): Promise<void> { return Promise.reject(new Error("decode")); }
    }
    vi.stubGlobal("Image", DecodeFailureImage);
    const result = new Promise<boolean>((resolve) => decodeStill("/decode-failure", resolve));
    await expect(result).resolves.toBe(false);
  });

  it("reports a fetch failure that arrives after decode rejects", async () => {
    let image: FetchFailureImage | null = null;
    class FetchFailureImage {
      complete = false;
      naturalWidth = 0;
      decoding = "";
      src = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { image = this; }
      decode(): Promise<void> { return Promise.reject(new Error("fetch")); }
    }
    vi.stubGlobal("Image", FetchFailureImage);
    const result = new Promise<boolean>((resolve) => decodeStill("/fetch-failure", resolve));
    await Promise.resolve();
    await Promise.resolve();
    image!.onerror!();
    await expect(result).resolves.toBe(false);
  });
});
