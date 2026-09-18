const StandardErrors = new Map([
  ["invalid argument", "webdriver-invalid-argument"],
  ["no such element", "webdriver-no-such-element"],
  ["session not created", "webdriver-session-not-created"],
  ["unknown error", "webdriver-unknown-error"],
  ["unsupported operation", "webdriver-unsupported-operation"],
]);

/** Keep only standardized WebDriver error names; driver-provided messages and stacks are never persisted. */
export function sanitizedWebDriverReason(value, message) {
  if (value === "session not created" && typeof message === "string") {
    if (/remote automation is turned off/i.test(message)) return "webdriver-remote-automation-disabled";
    if (/no (?:matching |usable )?(?:simulator|device|host)/i.test(message)) return "webdriver-device-unavailable";
    if (/(?:could not|failed to) launch safari/i.test(message)) return "webdriver-safari-launch-failed";
  }
  return typeof value === "string"
    ? StandardErrors.get(value) ?? "webdriver-command-failed"
    : "webdriver-command-failed";
}

/** Cold iOS Simulator services can reject an otherwise valid first session while they finish becoming ready. */
export function retryableSessionReason(reason) {
  return reason === "webdriver-session-not-created"
    || reason === "webdriver-unknown-error"
    || reason === "webdriver-safari-launch-failed"
    || reason === "webdriver-command-failed";
}
