export function isHttpPageOnPort(rawUrl, port) {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && url.port === String(port);
  } catch {
    return false;
  }
}

/** Match the requested URL literally, or Chrome's canonicalized hostname on the same explicit bench port. */
export function isHttpPageAtPrefixOrPort(rawUrl, urlPrefix) {
  if (typeof rawUrl === "string" && rawUrl.startsWith(urlPrefix)) return true;
  try {
    const port = new URL(urlPrefix).port;
    return port !== "" && isHttpPageOnPort(rawUrl, port);
  } catch {
    return false;
  }
}

/**
 * Wait for Android Chrome's plain DevTools endpoint to list an intent-created page.
 * This deliberately happens before Playwright attaches: a context attached before the
 * intent can retain a stale target list on this device.
 */
export async function waitForPageTarget({
  endpoint,
  urlPrefix,
  urlPort = null,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  pollMs = 250,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const remaining = deadline - now();
    if (remaining < 0) break;
    try {
      const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, remaining))) });
      const targets = await response.json();
      const target = Array.isArray(targets) && targets.find((entry) =>
        entry?.type === "page" && typeof entry.url === "string"
        && (urlPort === null ? entry.url.startsWith(urlPrefix) : isHttpPageOnPort(entry.url, urlPort)));
      if (target) return target;
    } catch { /* the target may not have registered yet */ }
    await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
  }
  throw new Error(`no tab appeared on ${urlPrefix} after ${timeoutMs}ms`);
}
