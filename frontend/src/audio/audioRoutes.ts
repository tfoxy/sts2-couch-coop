import { hostUrl } from "@/join/hostBase";

export function tmpSfxUrl(resourcePath: string, token: string | null): string | null {
  const prefix = "res://";
  if (!resourcePath.startsWith(prefix)) return null;
  const relative = resourcePath.slice(prefix.length);
  if (!/^debug_audio\/[^/\\?#]+\.mp3$/i.test(relative)) return null;
  const query = token ? `?b=${encodeURIComponent(token)}` : "";
  return hostUrl(`/audio/tmpsfx/${encodeURIComponent(relative)}${query}`);
}
