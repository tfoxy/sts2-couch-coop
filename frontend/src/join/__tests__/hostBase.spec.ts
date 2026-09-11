import { afterEach, describe, expect, it } from "vitest";

import { hostBase, hostUrl, hostWsUrl, isRemoteHosted, normalizeHostBase } from "@/join/hostBase";
import {
  HOST_STORE_KEY,
  MAX_REMEMBERED_HOSTS,
  hostCandidates,
  hostFromUrl,
  readHosts,
  rememberHost
} from "@/join/hostStore";

function setHostBase(value: string | undefined): void {
  if (value === undefined) {
    delete (globalThis as { __couchCoopHostBase?: string }).__couchCoopHostBase;
  } else {
    (globalThis as { __couchCoopHostBase?: string }).__couchCoopHostBase = value;
  }
}

afterEach(() => setHostBase(undefined));

describe("normalizeHostBase", () => {
  it("accepts a bare authority and assumes http — what the QR actually carries", () => {
    expect(normalizeHostBase("192.168.1.5:13337")).toBe("http://192.168.1.5:13337");
  });

  it("accepts a full origin and drops any path/query/trailing slash", () => {
    expect(normalizeHostBase("http://192.168.1.5:13337/join?name=x")).toBe("http://192.168.1.5:13337");
    expect(normalizeHostBase("https://host.example/")).toBe("https://host.example");
  });

  it("refuses anything that is not http(s), and anything empty or unparseable", () => {
    expect(normalizeHostBase("ws://192.168.1.5:13337")).toBeNull();
    expect(normalizeHostBase("javascript:alert(1)")).toBeNull();
    expect(normalizeHostBase("   ")).toBeNull();
    expect(normalizeHostBase(null)).toBeNull();
    expect(normalizeHostBase(undefined)).toBeNull();
  });
});

describe("host-served mode (no injected base)", () => {
  it("reports the page origin and is not remote-hosted", () => {
    expect(hostBase()).toBe(location.origin);
    expect(isRemoteHosted()).toBe(false);
  });

  it("leaves routes EXACTLY as they were — they are cache keys, not just fetch targets", () => {
    expect(hostUrl("/res/images/card.png")).toBe("/res/images/card.png");
    expect(hostUrl("/spines/a.tscn?anim=idle")).toBe("/spines/a.tscn?anim=idle");
  });

  it("derives the socket scheme from the page when the page is the host", () => {
    expect(hostWsUrl("/ws", "http://192.168.1.5:13337/?name=x")).toBe("ws://192.168.1.5:13337/ws");
    expect(hostWsUrl("/ws", "https://192-168-1-5.my.local-ip.co:8443/")).toBe(
      "wss://192-168-1-5.my.local-ip.co:8443/ws"
    );
  });
});

describe("remote-hosted mode (public origin bootstrap)", () => {
  it("prefixes routes with the host origin", () => {
    setHostBase("http://192.168.1.5:13337");
    expect(isRemoteHosted()).toBe(true);
    expect(hostUrl("/res/images/card.png")).toBe("http://192.168.1.5:13337/res/images/card.png");
  });

  it("never re-bases a URL that already carries a scheme", () => {
    setHostBase("http://192.168.1.5:13337");
    expect(hostUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(hostUrl("blob:https://example/abc")).toBe("blob:https://example/abc");
    expect(hostUrl("http://other.example/res/x.png")).toBe("http://other.example/res/x.png");
  });

  // THE REGRESSION THIS FILE EXISTS FOR. The page is https (Cloudflare Pages) while the host is plain
  // http, so a socket scheme derived from `location` would come out `wss:` and reach nothing at all.
  it("keeps the socket on ws: even though the PAGE is https", () => {
    setHostBase("http://192.168.1.5:13337");
    expect(hostWsUrl("/ws", "https://sts2-couch.pages.dev/?h=192.168.1.5:13337")).toBe(
      "ws://192.168.1.5:13337/ws"
    );
  });

  it("still uses wss: when the HOST itself is https", () => {
    setHostBase("https://192-168-1-5.my.local-ip.co:8443");
    expect(hostWsUrl("/ws", "https://sts2-couch.pages.dev/")).toBe(
      "wss://192-168-1-5.my.local-ip.co:8443/ws"
    );
  });

  it("ignores an injected base that is not a usable origin", () => {
    setHostBase("not a url");
    expect(hostBase()).toBe(location.origin);
    expect(isRemoteHosted()).toBe(false);
  });
});

describe("hostStore", () => {
  function memoryStorage(seed?: string) {
    const map = new Map<string, string>();
    if (seed !== undefined) map.set(HOST_STORE_KEY, seed);
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      raw: () => map.get(HOST_STORE_KEY) ?? null
    };
  }

  it("round-trips a remembered host, most-recent first", () => {
    const storage = memoryStorage();
    rememberHost("192.168.1.5:13337", 1000, storage);
    rememberHost("192.168.1.9:13337", 2000, storage);
    expect(readHosts(storage).map((h) => h.origin)).toEqual([
      "http://192.168.1.9:13337",
      "http://192.168.1.5:13337"
    ]);
  });

  it("re-seeing a host moves it to the front instead of duplicating it", () => {
    const storage = memoryStorage();
    rememberHost("192.168.1.5:13337", 1000, storage);
    rememberHost("192.168.1.9:13337", 2000, storage);
    rememberHost("192.168.1.5:13337", 3000, storage);
    expect(readHosts(storage).map((h) => h.origin)).toEqual([
      "http://192.168.1.5:13337",
      "http://192.168.1.9:13337"
    ]);
  });

  it("caps the list so it cannot grow into a record of every network the phone has been on", () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_REMEMBERED_HOSTS + 3; i += 1) {
      rememberHost(`192.168.1.${i}:13337`, i, storage);
    }
    expect(readHosts(storage)).toHaveLength(MAX_REMEMBERED_HOSTS);
  });

  // A corrupt store must cost a re-scan, never a boot failure.
  it.each([
    ["not json at all", "{{{"],
    ["a non-array", '{"origin":"x"}'],
    ["entries that are not objects", '["nope", 7, null]'],
    ["entries whose origin is unusable", '[{"origin":"javascript:x"},{"origin":""}]']
  ])("reads %s as an empty list rather than throwing", (_label, seed) => {
    expect(readHosts(memoryStorage(seed))).toEqual([]);
  });

  // Private-mode Safari and some embedded webviews throw on mere ACCESS, not only on write. Reads answer
  // empty; a write still returns the correct list for THIS session (it just will not survive a reload),
  // because degrading to "you must scan again right now" would be worse than degrading to "…next time".
  it("survives a storage that throws on access (private mode)", () => {
    const hostile = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); }
    };
    expect(readHosts(hostile)).toEqual([]);
    expect(rememberHost("192.168.1.5:13337", 1, hostile)).toEqual([
      { origin: "http://192.168.1.5:13337", lastSeenMs: 1 }
    ]);
  });

  it("parses ?h= as an authority, and tolerates a full origin", () => {
    expect(hostFromUrl("https://sts2-couch.pages.dev/?h=192.168.1.5:13337"))
      .toBe("http://192.168.1.5:13337");
    expect(hostFromUrl("https://sts2-couch.pages.dev/?h=http://192.168.1.5:13337"))
      .toBe("http://192.168.1.5:13337");
    expect(hostFromUrl("https://sts2-couch.pages.dev/")).toBeNull();
    expect(hostFromUrl("nonsense")).toBeNull();
  });

  it("orders candidates scanned-first, then remembered, then the .local name, without duplicates", () => {
    expect(hostCandidates({
      fromUrl: "192.168.1.9:13337",
      remembered: [
        { origin: "http://192.168.1.5:13337", lastSeenMs: 2 },
        { origin: "http://192.168.1.9:13337", lastSeenMs: 1 }
      ],
      mdnsHost: "worky.local:13337"
    })).toEqual([
      "http://192.168.1.9:13337",
      "http://192.168.1.5:13337",
      "http://worky.local:13337"
    ]);
  });
});
