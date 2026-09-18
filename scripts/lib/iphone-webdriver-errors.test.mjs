import assert from "node:assert/strict";
import { retryableSessionReason, sanitizedWebDriverReason } from "./iphone-webdriver-errors.mjs";

assert.equal(sanitizedWebDriverReason("session not created"), "webdriver-session-not-created");
assert.equal(sanitizedWebDriverReason("session not created", "Remote Automation is turned off; private device details"), "webdriver-remote-automation-disabled");
assert.equal(sanitizedWebDriverReason("session not created", "No matching simulator host; private inventory"), "webdriver-device-unavailable");
assert.equal(sanitizedWebDriverReason("session not created", "Failed to launch Safari: private path"), "webdriver-safari-launch-failed");
assert.equal(sanitizedWebDriverReason("invalid argument"), "webdriver-invalid-argument");
assert.equal(sanitizedWebDriverReason("no such element", "private selector detail"), "webdriver-no-such-element");
assert.equal(sanitizedWebDriverReason("vendor-private-detail"), "webdriver-command-failed");
assert.equal(sanitizedWebDriverReason({ message: "private" }), "webdriver-command-failed");
assert.equal(retryableSessionReason("webdriver-session-not-created"), true);
assert.equal(retryableSessionReason("webdriver-unknown-error"), true);
assert.equal(retryableSessionReason("webdriver-safari-launch-failed"), true);
assert.equal(retryableSessionReason("webdriver-command-failed"), true);
assert.equal(retryableSessionReason("webdriver-invalid-argument"), false);
assert.equal(retryableSessionReason("webdriver-remote-automation-disabled"), false);
assert.equal(retryableSessionReason("webdriver-command-timeout"), false);
assert.equal(retryableSessionReason("webdriver-unreachable"), false);

console.log("iphone-webdriver-errors: ok");
