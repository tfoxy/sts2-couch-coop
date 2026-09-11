function effectiveHttpPort(url) {
  if (url.protocol === "http:") return url.port || "80";
  if (url.protocol === "https:") return url.port || "443";
  return null;
}

export function httpPagePort(rawUrl) {
  try {
    return effectiveHttpPort(new URL(rawUrl));
  } catch {
    return null;
  }
}

// Connect mode may only drive the intent-opened benchmark tab. Android Chrome can rewrite 127.0.0.1 to
// worky.local, but retains the port, which is the stable ownership boundary. Zero or multiple matches are unsafe:
// never guess a Chrome internal target or an unrelated user tab and then navigate it.
export function selectConnectBenchPageIndex(pageUrls, requestedUrl) {
  const expectedPort = httpPagePort(requestedUrl);
  if (!expectedPort) throw new Error(`--url must be an HTTP(S) URL with a port (got '${requestedUrl}')`);
  const matches = pageUrls
    .map((url, index) => ({ url, index }))
    .filter(({ url }) => httpPagePort(url) === expectedPort);
  if (matches.length === 1) return matches[0].index;
  const listed = pageUrls.map((url) => String(url)).join(", ") || "(none)";
  if (matches.length === 0) {
    throw new Error(`no HTTP(S) page on benchmark port ${expectedPort}; attached tabs: ${listed}`);
  }
  throw new Error(`${matches.length} HTTP(S) pages on benchmark port ${expectedPort}; refusing ambiguous attached tabs: ${listed}`);
}

// Preserve the requested candidate path/query while using the selected phone tab's canonical HTTP(S) origin.
// Chrome's 127.0.0.1 -> worky.local rewrite otherwise creates a second navigation during warmup and tears down the
// freshly installed replay instrumentation. The selection check already proves same-port ownership; repeat it here
// so this helper cannot silently be reused to cross an origin boundary.
export function effectiveConnectPageUrl(requestedPageUrl, selectedPageUrl) {
  const requested = new URL(requestedPageUrl);
  const selected = new URL(selectedPageUrl);
  const requestedPort = effectiveHttpPort(requested);
  const selectedPort = effectiveHttpPort(selected);
  if (!requestedPort || !selectedPort || requestedPort !== selectedPort) {
    throw new Error(`selected page origin does not match requested benchmark port (${requestedPageUrl} vs ${selectedPageUrl})`);
  }
  return new URL(`${requested.pathname}${requested.search}${requested.hash}`, selected.origin).toString();
}
