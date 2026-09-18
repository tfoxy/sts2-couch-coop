/**
 * Shared, browser-driver-neutral survival verdict for the synthetic iPhone burst.
 * Inputs intentionally contain only runner counters/booleans, never browser console or page data.
 */
export function validateIphoneSurvival(result) {
  const failures = [];
  const required = result?.requiredMessages === 6 ? 6 : 2;
  if (!Number.isInteger(result?.presentations) || result.presentations < required) failures.push("final-presentation-missing");
  if (!Number.isInteger(result?.acks) || result.acks < required) failures.push("final-ack-missing");
  if (result?.hostSocketOpen !== true) failures.push("host-socket-not-open");
  if (result?.seatSocketOpen !== true) failures.push("seat-socket-not-open");
  if (result?.viewError === true) failures.push("client-view-error");
  if (result?.crash === true) failures.push("browser-crash");
  if (!(Number.isInteger(result?.animationFrames) && result.animationFrames >= 30) || result?.responsive !== true) {
    failures.push("post-delta-responsiveness-missing");
  }
  return { ok: failures.length === 0, failures };
}

/**
 * A deliberately small, runner-neutral failure taxonomy. The first matching condition wins so an EOF after a
 * renderer crash is reported as the crash, not as a derivative socket symptom.
 */
export function classifyIphoneFailure(input = {}) {
  const required = input.requiredMessages === 6 ? 6 : 2;
  const phase = !input.presentations ? "pre-first-frame"
    : input.presentations < required || input.acks < required ? "post-first-frame"
      : "post-final-delta";
  const disappeared = input.presentations > 0
    && Boolean(input.rendererPageCrash || input.navigation || input.seatSocketClosed || input.hostSocketClosed);
  const checks = [
    ["renderer-page-crash", input.rendererPageCrash],
    ["unexpected-reload-navigation", input.navigation],
    ["seat-socket-close", input.seatSocketClosed],
    ["host-socket-close", input.hostSocketClosed],
    ["client-view-error", input.clientViewError],
    ["missing-acknowledgement", input.missingAcknowledgement || (input.presentations >= required && input.acks < required)],
    ["render-stall", input.renderStall],
    ["script-unresponsive", input.scriptUnresponsive],
    ["simulator-safaridriver-failure", input.simulatorSafariDriverFailure],
  ];
  const category = checks.find(([, value]) => value)?.[0] ?? "success";
  return { category, phase, postFirstFrameBrowserDisappearance: disappeared };
}
