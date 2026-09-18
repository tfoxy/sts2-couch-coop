/**
 * Shared, browser-driver-neutral survival verdict for the synthetic iPhone burst.
 * Inputs intentionally contain only runner counters/booleans, never browser console or page data.
 */
export function validateIphoneSurvival(result) {
  const failures = [];
  if (!Number.isInteger(result?.presentations) || result.presentations < 2) failures.push("second-presentation-missing");
  if (!Number.isInteger(result?.acks) || result.acks < 2) failures.push("second-ack-missing");
  if (result?.hostSocketOpen !== true) failures.push("host-socket-not-open");
  if (result?.seatSocketOpen !== true) failures.push("seat-socket-not-open");
  if (result?.viewError === true) failures.push("client-view-error");
  if (result?.crash === true) failures.push("browser-crash");
  if (!(Number.isInteger(result?.animationFrames) && result.animationFrames >= 30) && result?.responsive !== true) {
    failures.push("post-delta-responsiveness-missing");
  }
  return { ok: failures.length === 0, failures };
}
