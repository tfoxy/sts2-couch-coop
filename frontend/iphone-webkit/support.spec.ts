import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertInternalArtifactPath,
  assertSurvival,
  boundedQueryKeyNames,
  resolveHermeticArtifactExport,
  resolveIphoneRunPlan,
  socketLifecycle
} from "./support";

describe("iPhone WebKit run policy", () => {
  it("keeps hermetic artifacts inside the invocation's temporary root", () => {
    expect(assertInternalArtifactPath("/tmp/iphone-run", "/tmp/iphone-run/stage")).toBe("/tmp/iphone-run/stage");
    expect(() => assertInternalArtifactPath("/tmp/iphone-run", "/tmp/elsewhere")).toThrow(/temporary directory/);
    expect(() => assertInternalArtifactPath("/tmp/iphone-run", "/tmp/iphone-run")).toThrow(/temporary directory/);
  });

  it("allows only the repo-local CI export stage and rejects escapes and symlinks", () => {
    const repo = mkdtempSync(join(tmpdir(), "iphone-artifact-policy-"));
    const allowed = join(repo, ".ci-artifacts", "iphone-webkit", "baseline");
    expect(resolveHermeticArtifactExport(repo, allowed)).toBe(allowed);
    expect(resolveHermeticArtifactExport(repo, join(repo, ".ci-artifacts", "iphone-webkit", "field-repro"), "field-repro")).toContain("field-repro");
    expect(() => resolveHermeticArtifactExport(repo, join(repo, ".ci-artifacts"))).toThrow(/may only be/);
    expect(() => resolveHermeticArtifactExport(repo, join(repo, "..", "outside"))).toThrow(/may only be/);

    mkdirSync(join(repo, "outside"));
    symlinkSync(join(repo, "outside"), join(repo, ".ci-artifacts"));
    expect(() => resolveHermeticArtifactExport(repo, allowed)).toThrow(/symlinked/);
  });

  it("requires both real-mode acknowledgements and refuses GitHub Actions", () => {
    expect(() => resolveIphoneRunPlan({ COUCHCOOP_E2E_REAL_URL: "http://127.0.0.1:13337" })).toThrow(/both required/);
    expect(() => resolveIphoneRunPlan({ COUCHCOOP_ALLOW_REAL_GAME: "1" })).toThrow(/both required/);
    expect(() => resolveIphoneRunPlan({
      COUCHCOOP_E2E_REAL_URL: "http://127.0.0.1:13337",
      COUCHCOOP_ALLOW_REAL_GAME: "1",
      GITHUB_ACTIONS: "true"
    })).toThrow(/GitHub Actions/);
  });

  it("reports bounded, value-free URL query names", () => {
    const query = new URLSearchParams();
    for (let index = 0; index < 20; index++) query.append(`key${index}`, `secret-${index}`);
    query.append("bad/key", "secret");
    expect(boundedQueryKeyNames(`ws://host/ws?${query}`, 3)).toEqual(["key0", "key1", "key2"]);
  });

  it("classifies HTTP-hosted ws sockets by authority rather than scheme", () => {
    expect(socketLifecycle("ws://127.0.0.1:23339/ws?watch=1", "http://127.0.0.1:23339").role).toBe("host");
    expect(socketLifecycle("ws://127.0.0.1:24440/ws?watch=1", "http://127.0.0.1:23339").role).toBe("seat");
  });

  it("fails survival on a crash or a host WebSocket close", () => {
    const stable = {
      presented: true,
      responsiveSeconds: 10,
      pageCrashed: false,
      pageErrorCategories: [],
      sockets: [
        { role: "host" as const, queryKeys: [], closed: false },
        { role: "seat" as const, queryKeys: [], closed: false }
      ]
    };
    expect(() => assertSurvival({ ...stable, pageCrashed: true })).toThrow(/crashed/);
    expect(() => assertSurvival({ ...stable, sockets: [{ role: "host" as const, queryKeys: [], closed: true }] })).toThrow(/WebSocket closed/);
    expect(() => assertSurvival({ ...stable, sockets: [{ role: "seat" as const, queryKeys: [], closed: true }] })).toThrow(/WebSocket closed/);
    expect(() => assertSurvival({ ...stable, sockets: [{ role: "host" as const, queryKeys: [], closed: false }] })).toThrow(/seat WebSocket/);
  });
});
