import assert from "node:assert/strict";
import { selectIphone13Simulator } from "./iphone-simulator-selection.mjs";

const runtimes = { runtimes: [
  { name: "iOS 18.5", version: "18.5", identifier: "ios-18-5", isAvailable: true },
  { name: "iOS 19.0 Beta", version: "19.0", identifier: "ios-19-beta", isAvailable: true },
  { name: "iOS 18.10", version: "18.10", identifier: "ios-18-10", isAvailable: true },
  { name: "iOS 20.0", version: "20.0", identifier: "ios-20", isAvailable: false },
] };
const deviceTypes = { devicetypes: [
  { name: "iPhone 13 mini", identifier: "mini" },
  { name: "iPhone 13", identifier: "exact-iphone-13" },
] };

const reuse = selectIphone13Simulator(runtimes, deviceTypes, { devices: {
  "ios-18-10": [
    { name: "iPhone 13", deviceTypeIdentifier: "nearby-renamed", udid: "wrong", state: "Booted", isAvailable: true },
    { name: "QA phone", deviceTypeIdentifier: "exact-iphone-13", udid: "exact", state: "Booted", isAvailable: true },
  ],
} });
assert.deepEqual(reuse, {
  ok: true,
  action: "reuse",
  runtime: "ios-18-10",
  runtimeVersion: "18.10",
  deviceType: "exact-iphone-13",
  udid: "exact",
  wasBooted: true,
  cleanup: "none",
}, "the newest numerically sorted stable runtime and exact model are reused");

const create = selectIphone13Simulator(runtimes, deviceTypes, { devices: { "ios-18-10": [] } });
assert.equal(create.action, "create", "an exact iPhone 13 is created when none exists");
assert.equal(create.deviceType, "exact-iphone-13", "creation uses the exact device-type identifier");
assert.equal(create.cleanup, "delete", "only a simulator created by the run is deleted");

const restore = selectIphone13Simulator(runtimes, deviceTypes, { devices: {
  "ios-18-10": [{ name: "iPhone 13", deviceTypeIdentifier: "exact-iphone-13", udid: "shutdown", state: "Shutdown", isAvailable: true }],
} });
assert.equal(restore.cleanup, "shutdown", "an existing simulator's shutdown state is restored");

const renamedNearby = selectIphone13Simulator(runtimes, deviceTypes, { devices: {
  "ios-18-10": [{ name: "iPhone 13", deviceTypeIdentifier: "mini", udid: "renamed", state: "Booted", isAvailable: true }],
} });
assert.equal(renamedNearby.action, "create", "a nearby model renamed to iPhone 13 is never reused");

assert.deepEqual(
  selectIphone13Simulator({ runtimes: [{ name: "iOS 19.0 Beta", version: "19.0", identifier: "beta", isAvailable: true }] }, deviceTypes, { devices: {} }),
  { ok: false, reason: "stable-ios-runtime-unavailable" },
  "beta-only installations are refused",
);
assert.deepEqual(
  selectIphone13Simulator(runtimes, { devicetypes: [{ name: "iPhone 13 mini", identifier: "mini" }] }, { devices: {} }),
  { ok: false, reason: "iphone-13-device-type-unavailable", runtime: "ios-18-10" },
  "a nearby model is never substituted",
);

console.log("iphone-simulator-selection: ok");
