import { cp, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const ALLOWED = new Set(["browser-lifecycle.jsonl", "iphone-webkit-result.json", "iphone-webkit-timeline.json", "iphone-webkit-failure.png"]);

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
      await assertPrivateStage(this.tempRoot, this.stageDir);
      await mkdir(this.exportDir, { recursive: true });
      for (const entry of await readdir(this.exportDir, { withFileTypes: true })) {
        if (!entry.isFile() || !ALLOWED.has(entry.name)) {
          throw new Error(`Refusing unreviewed existing iPhone artifact ${entry.name}.`);
        }
        const existing = join(this.exportDir, entry.name);
        if ((await lstat(existing)).isSymbolicLink()) {
          throw new Error(`Refusing symlinked existing iPhone artifact ${entry.name}.`);
        }
        await rm(existing, { force: true });
      }
      for (const entry of await readdir(this.stageDir, { withFileTypes: true })) {
        if (!entry.isFile() || !ALLOWED.has(entry.name)) {
          throw new Error(`Refusing unreviewed iPhone artifact ${entry.name}.`);
        }
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

async function assertPrivateStage(tempRoot, stageDir) {
  const root = await realpath(tempRoot);
  const stage = await realpath(stageDir);
  const fromRoot = relative(root, stage);
  if (!fromRoot || fromRoot.startsWith("..") || fromRoot.includes("../")) {
    throw new Error("Refusing an iPhone artifact stage outside the private temporary root.");
  }
}

async function assertNoSymlink(target) {
  const resolved = resolve(target);
  const root = resolve(process.cwd(), "..");
  const pathFromRoot = relative(root, resolved);
  if (!/\.ci-artifacts\/iphone-webkit\/(baseline|field-repro)$/.test(pathFromRoot)) {
    throw new Error("Refusing an iPhone artifact export outside a reviewed iPhone WebKit profile root.");
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
