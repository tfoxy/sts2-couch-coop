#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CONTEXT_LOSS_SIGNAL, createCampaignPageAbort, installCampaignContextLossHook,
  selectBenchInitScriptTarget } from "./lib/bench-campaign-abort.mjs";

const context = { calls: [], addInitScript(value) { this.calls.push(value); } };
const ownedPage = new EventEmitter();
ownedPage.calls = [];
ownedPage.addInitScript = value => ownedPage.calls.push(value);
const launch = selectBenchInitScriptTarget({ connectMode: false, context, connectPage: ownedPage });
const connected = selectBenchInitScriptTarget({ connectMode: true, context, connectPage: ownedPage });
launch.addInitScript("launch"); connected.addInitScript("owned");
assert.deepEqual(context.calls, ["launch"]);
assert.deepEqual(ownedPage.calls, ["owned"]);
assert.throws(() => selectBenchInitScriptTarget({ connectMode: true, context }), /no owned page/);

let listener, removed = false, logged = "";
const savedWindow = globalThis.window, savedConsole = globalThis.console;
try {
  globalThis.window = { addEventListener(_name, callback, capture) { listener = callback; assert.equal(capture, true); },
    removeEventListener(_name, callback, capture) { removed = callback === listener && capture === true; } };
  globalThis.console = { ...savedConsole, error(value) { logged = value; } };
  installCampaignContextLossHook(); listener();
  assert.equal(logged, CONTEXT_LOSS_SIGNAL);
  window.__benchCampaignContextLossOff(); assert.equal(removed, true);
} finally {
  if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
  globalThis.console = savedConsole;
}

const message = value => ({ text: () => value });
const gate = createCampaignPageAbort(ownedPage);
const waiting = gate.wait(new Promise(() => {}));
ownedPage.emit("console", message("normal console"));
assert.equal(gate.reason, null);
ownedPage.emit("console", message(CONTEXT_LOSS_SIGNAL));
await assert.rejects(waiting, /WebGL context lost/);
let unhandled = 0;
const onUnhandled = () => { unhandled++; };
process.on("unhandledRejection", onUnhandled);
await assert.rejects(gate.wait(Promise.reject(Error("underlying page rejected after loss"))), /WebGL context lost/);
await new Promise(resolve => setImmediate(resolve));
process.off("unhandledRejection", onUnhandled);
assert.equal(unhandled, 0);
gate.close();
assert.equal(ownedPage.listenerCount("console"), 0);
assert.equal(ownedPage.listenerCount("crash"), 0);

const crashPage = new EventEmitter(), crashGate = createCampaignPageAbort(crashPage);
const crashWait = crashGate.wait(new Promise(() => {}));
crashPage.emit("crash");
await assert.rejects(crashWait, /renderer process crashed/);
crashGate.close();
console.log("CPU campaign event abort and owned-page init tests passed");
