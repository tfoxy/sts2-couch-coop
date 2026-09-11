import { describe, expect, it } from "vitest";

import { requireReproHeader } from "./reproRecording";

describe("bench repro recording guard", () => {
  it("accepts only a first-line repro/1 header", () => {
    expect(requireReproHeader('{"meta":{"format":"repro/1"}}\n{"t":0}', "fixture").format).toBe("repro/1");
    expect(() => requireReproHeader('{"t":0,"data":"x"}\n', "headerless")).toThrow(/repro\/1/);
    expect(() => requireReproHeader('{"meta":{"format":"recording/1"}}\n', "wrong-schema")).toThrow(/repro\/1/);
  });
});
