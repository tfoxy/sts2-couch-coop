import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const ALLOWED = new Set(["browser-lifecycle.jsonl", "iphone-webkit-result.json", "iphone-webkit-timeline.json"]);

export default class IphoneArtifactReporter {
  constructor(options) {
    this.stageDir = options.stageDir;
    this.exportDir = options.exportDir;
    this.tempRoot = options.tempRoot;
  }

  async onEnd() {
    try {
      if (!this.exportDir) return;
      await assertNoSymlink(this.exportDir);
      await mkdir(this.exportDir, { recursive: true });
      for (const entry of await readdir(this.stageDir, { withFileTypes: true })) {
        if (!entry.isFile() || !ALLOWED.has(entry.name)) continue;
        const source = join(this.stageDir, entry.name);
        const stat = await lstat(source);
        if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked iPhone artifact ${entry.name}.`);
        await cp(source, join(this.exportDir, entry.name), { force: true, dereference: false });
      }
    } finally {
      await rm(this.tempRoot, { recursive: true, force: true });
    }
  }
}

async function assertNoSymlink(target) {
  const resolved = resolve(target);
  const root = resolve(process.cwd(), "..");
  const pathFromRoot = relative(root, resolved);
  if (basename(resolved) !== "iphone-webkit" || pathFromRoot !== ".ci-artifacts/iphone-webkit") {
    throw new Error("Refusing an iPhone artifact export outside .ci-artifacts/iphone-webkit.");
  }
  let current = root;
  for (const part of pathFromRoot.split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing symlinked artifact path ${current}.`);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
  }
}
