/** Asset families faithfully served by the recovered-project/cache resolver. */
export const BENCH_ASSET_FAMILIES = Object.freeze(["res", "models", "spines"]);

export function isBenchAssetRoute(pathname) {
  return BENCH_ASSET_FAMILIES.some((family) => pathname.startsWith(`/${family}/`));
}
