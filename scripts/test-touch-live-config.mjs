#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { localFixturePlayerId, installLocalFixtureJoin } from "./lib/touch-live-identity.mjs";
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
    const result = run(["--plan", "--sts2-config", config, "--sts2-cwd", scratch,
      "--asset-origin", "http://127.0.0.1:13437/"], {
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
    assert.equal(plan.vite.assetOrigin, "http://127.0.0.1:13437");
    assert.equal(plan.gameLaunchIdentity.COUCHCOOP_HEADLESS_CLIENT, "1");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("asset origin refuses external hosts and non-origin URLs", () => {
  for (const origin of ["http://192.168.1.2:13437", "https://example.com", "ftp://127.0.0.1",
    "http://user:pass@127.0.0.1", "http://127.0.0.1/res", "http://127.0.0.1/?seat=other"]) {
    const result = run(["--plan", "--asset-origin", origin]);
    assert.notEqual(result.status, 0, origin);
    assert.match(result.stderr, /--asset-origin must be an http\(s\) loopback origin/);
  }
});

test("Vite routes assets to the rendered host while WebSocket input stays on the player", () => {
  const frontend = resolve(dirname(harness), "../frontend");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { loadConfigFromFile } from "vite";
    const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, "vite.config.ts");
    console.log(JSON.stringify(Object.fromEntries(Object.entries(loaded.config.server.proxy)
      .map(([path, value]) => [path, { target: value.target, ws: value.ws }]))));
  `], {
    cwd: frontend, encoding: "utf8", env: { ...process.env,
      COUCHCOOP_DEV_PROXY_TARGET: "http://127.0.0.1:13457",
      COUCHCOOP_DEV_ASSET_TARGET: "http://127.0.0.1:13437",
      COUCHCOOP_DEV_BG_FIXTURE: "" }
  });
  assert.equal(result.status, 0, result.stderr);
  const routes = JSON.parse(result.stdout.trim().split("\n").at(-1));
  for (const path of ["/res", "/models", "/spines", "/geoclips", "/bg", "/favicon.ico"]) {
    assert.equal(routes[path].target, "http://127.0.0.1:13437/", path);
  }
  assert.deepEqual(routes["/ws"], { target: "http://127.0.0.1:13457/", ws: true });
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


test("fixture join uses the CLI identity when every advertised browser local/host flag is false", () => {
  const id = "p:18446744073709551615";
  const localPlayerId = localFixturePlayerId({ run: { players: [{ id, isLocal: true }] } });
  class Socket {
    listeners = [];
    sent = [];
    addEventListener(type, listener) { if (type === "message") this.listeners.push(listener); }
    send(data) { this.sent.push(JSON.parse(data)); }
    receive(data) { for (const listener of this.listeners) listener({ data: JSON.stringify(data) }); }
  }
  const context = vm.createContext({ WebSocket: Socket });
  vm.runInContext(`(${installLocalFixtureJoin.toString()})(${JSON.stringify({ localPlayerId })})`, context);
  const socket = new Socket();
  socket.addEventListener("message", () => {});
  const session = { type: "session", hostAccess: { allowed: true }, players: [
    { playerId: id, name: "Fixture player", isLocal: false, isHost: false }
  ] };
  socket.receive({ ...session, players: [] });
  socket.receive({ ...session, players: [{ playerId: "p:2", name: "Wrong player", isLocal: true, isHost: true }] });
  socket.receive({ ...session, hostAccess: { allowed: false } });
  assert.deepEqual(socket.sent, []);
  socket.receive(session);
  socket.receive(session);
  assert.deepEqual(socket.sent, [{ type: "join", name: "Fixture player", playerId: id, requestId: "touch-qa-local-player" }]);
});

test("fixture identity rejects absent, ambiguous, or missing local ids", () => {
  for (const state of [{}, { run: { players: [] } }, { run: { players: [{ id: "p:1", isLocal: false }] } },
    { run: { players: [{ isLocal: true }] } }, { run: { players: [{ id: "p:1", isLocal: true }, { id: "p:2", isLocal: true }] } }]) {
    assert.throws(() => localFixturePlayerId(state), /exactly one local fixture player/);
  }
});
