import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as groups from "@/stream-ext/groups";

// TWO-SIDED LOCKSTEP (vitest side). The group names the seat's C# RenderStreamItemTagger assigns and the names the
// stream-ext modules ask for are two copies of one table, tests/fixtures/render-stream/item-groups.json. The C# runner
// (RenderStreamPairingTests) asserts its `<Role>Group` consts equal it; THIS spec asserts the `RS_GROUP_<ROLE>`
// exports do. A name changed on one side only would grant nothing (the seat matches groups by exact name), so it
// fails here instead of silently disabling a module.

const fixture: Record<string, string> = Object.fromEntries(
  Object.entries(
    JSON.parse(readFileSync(resolve(process.cwd(), "../tests/fixtures/render-stream/item-groups.json"), "utf8")) as
      Record<string, string>
  ).filter(([role]) => !role.startsWith("_"))
);

const PREFIX = "RS_GROUP_";

describe("stream-ext group names", () => {
  it("export exactly the shared table (RS_GROUP_<ROLE> ↔ role)", () => {
    const exported = Object.fromEntries(
      Object.entries(groups)
        .filter(([name]) => name.startsWith(PREFIX))
        .map(([name, value]) => [name.slice(PREFIX.length).toLowerCase(), value])
    );
    expect(Object.keys(fixture)).toHaveLength(14);
    expect(exported).toEqual(fixture);
  });

  it("every module's group list names only table groups", () => {
    const names = new Set(Object.values(fixture));
    for (const list of [groups.RAISE_GROUPS, groups.VIEW_SCALE_GROUPS, groups.HELD_CARD_GROUPS, groups.CONFIRM_TAP_GROUPS]) {
      for (const g of list) expect(names.has(g)).toBe(true);
    }
  });
});
