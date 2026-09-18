import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("iPhone hermetic launcher", () => {
  it("builds the pinned stable reference SDK and passes only its temporary assembly directory to the harness", async () => {
    const source = await readFile(resolve(process.cwd(), "iphone-webkit/start-hermetic.mjs"), "utf8");
    expect(source).toContain("../eng/Sts2.ReferenceSdk/stable/Sts2.ReferenceSdk.stable.csproj");
    expect(source).toContain("-p:RestoreLockedMode=true");
    expect(source).toContain("STS2_ASSEMBLIES_DIR: referenceSdkDir");
    expect(source).toContain("CouchCoopLocalConfigPath: join(root, \"no-local-game-config.yaml\")");
    expect(source).toContain('"-p:Sts2GameApi=v107"');
    expect(source).toContain('"-p:CouchCoopBuildToLocalMods=false"');
  });
});
