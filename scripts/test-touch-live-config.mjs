#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const harness = fileURLToPath(new URL("./validate-touch-live.mjs", import.meta.url));
const run = (args, env = process.env) => spawnSync(process.execPath, [harness, ...args], {
  cwd: resolve(fileURLToPath(new URL("..", import.meta.url))), encoding: "utf8", env
});

test("scratch config routes every game command and retains absolute fixture paths", () => {
  const scratch = mkdtempSync(join(tmpdir(), "cc-touch-config-"));
  try {
    const config = join(scratch, "sts2.yaml");
    writeFileSync(config, "game: {}\n");
    const result = run(["--plan", "--sts2-config", config, "--sts2-cwd", scratch], {
      ...process.env, COUCHCOOP_GSW_ROOT: "/tmp/isolated-gsw"
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.instanceRecordRoot, scratch);
    for (const command of [plan.gameLaunch, plan.fixtureLoad, plan.gameState, plan.gameClose]) {
      assert.equal(command.command, "sts2");
      assert.equal(command.cwd, scratch);
      assert.deepEqual(command.args.slice(0, 4), ["--config", config, "--instance", "touchqa"]);
    }
    assert.equal(plan.gameLaunch.args.at(-1), "--headless");
    assert.equal(plan.fixtureLoad.args.at(-1), resolve(dirname(harness), "fixtures/touch-live-combat.sts2.fixture.yaml"));
    assert.equal(plan.vite.gswRoot, "/tmp/isolated-gsw");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("scratch config and cwd must be an existing absolute pair", () => {
  const absentCwd = run(["--plan", "--sts2-config", "/tmp/missing-sts2.yaml"]);
  assert.notEqual(absentCwd.status, 0);
  assert.match(absentCwd.stderr, /must be supplied together/);

  const relative = run(["--plan", "--sts2-config", "sts2.yaml", "--sts2-cwd", "/tmp"]);
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /must be absolute paths/);
});

test("a live port record from a different user directory is rejected", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "cc-touch-port-"));
  const server = createServer(() => {});
  try {
    const config = join(scratch, "sts2.yaml");
    const userDir = join(scratch, "private-user");
    const instanceDir = join(scratch, ".sts2/instances/touchqa");
    mkdirSync(join(userDir, "SlayTheSpire2/couch-coop"), { recursive: true });
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(config, "game: {}\n");
    writeFileSync(join(instanceDir, "instance.json"), JSON.stringify({ userDir }));
    server.listen(0, "127.0.0.1");
    await new Promise(resolveReady => server.once("listening", resolveReady));
    writeFileSync(join(userDir, "SlayTheSpire2/couch-coop/browser-port"),
      JSON.stringify({ port: server.address().port, pid: process.pid }));
    const result = run(["--check-port", "--sts2-config", config, "--sts2-cwd", scratch]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { instance: "touchqa", ownedPort: null });
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
