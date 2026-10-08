import { hostUrl } from "@/join/hostBase";

/**
 * The root-relative TmpSfx route (no host base applied), or null for a path the host does not serve. Split
 * out of `tmpSfxUrl` so the audio Worker — where the page's host-base state is not available — can apply
 * the host base it was handed in `init` itself.
 */
export function tmpSfxRoute(resourcePath: string, token: string | null): string | null {
  const prefix = "res://";
  if (!resourcePath.startsWith(prefix)) return null;
  const relative = resourcePath.slice(prefix.length);
  if (!/^debug_audio\/[^/\\?#]+\.mp3$/i.test(relative)) return null;
  const query = token ? `?b=${encodeURIComponent(token)}` : "";
  return `/audio/tmpsfx/${encodeURIComponent(relative)}${query}`;
}

export function tmpSfxUrl(resourcePath: string, token: string | null): string | null {
  const route = tmpSfxRoute(resourcePath, token);
  return route === null ? null : hostUrl(route);
}
