namespace CouchCoop.MirrorProtocol.Assets;

// Retry policy for the godot-client asset stores (Texture/Font/Shader/SpineClip HTTP fetches). Pure and Godot-free
// (Exe-testable): the stores pass Godot's HttpRequest.Result and the HTTP status as plain longs.
//
// WHY (2026-07-19 missing-textures incident): the stores had NO HttpRequest.Timeout (Godot default 0 = wait
// forever) and marked any failure PERMANENTLY `_failed` for the session. A phone that connected while the host was
// loading a run had its /res responses stall (asset extraction runs on the game's main thread), silently wedging
// the few in-flight slots forever — many textures missing, zero logs. With timeouts in place, a busy host surfaces
// as a TRANSIENT failure that must be retried, not a permanent blank.
//
// Retryable = the host was busy / the network hiccuped and a later attempt can succeed:
//   * transport-level: can't-connect / can't-resolve / connection-error / no-response / request-failed / timeout
//   * HTTP 429 (throttled) and 5xx (server-side transient, incl. the mod's asset-busy 503)
// Permanent = other 4xx (the asset genuinely isn't served), other transport results (TLS/body-size/redirect — a
// retry re-fails identically), decode failures (handled by the stores directly), or attempts exhausted.
public static class AssetFetchPolicy
{
    // Total tries per asset (1 initial + 2 retries). Bounded so the settle gate always resolves
    // (worst case MaxAttempts × the store's HttpRequest.Timeout).
    public const int MaxAttempts = 3;

    // The per-request timeout the stores apply (seconds). `COUCHCOOP_ASSET_TIMEOUT_SEC` overrides BOTH tiers —
    // a test/dev knob (the stall e2e leg forces fast timeouts); production uses the defaults (30s standard,
    // 60s spine — multi-MB clips on the single-slot store).
    public static double TimeoutSeconds(double defaultSeconds)
    {
        var raw = Environment.GetEnvironmentVariable("COUCHCOOP_ASSET_TIMEOUT_SEC");
        return raw is not null && double.TryParse(raw, out double sec) && sec > 0 ? sec : defaultSeconds;
    }

    // Godot HttpRequest.Result values that indicate a transient transport failure (numeric mirrors of the Godot
    // enum, kept here so this stays Godot-free): CantConnect=2, CantResolve=3, ConnectionError=4, NoResponse=6,
    // RequestFailed=9, Timeout=13. Success=0 is never retryable at the transport level.
    private static readonly long[] RetryableResults = { 2, 3, 4, 6, 9, 13 };

    // True when the store should re-enqueue the url for another attempt instead of marking it failed.
    // `attempt` is 1-based (the attempt that just failed).
    public static bool ShouldRetry(long result, long httpCode, int attempt)
    {
        if (attempt >= MaxAttempts)
        {
            return false;
        }

        if (result == 0)
        {
            // Transport success: retry only throttle/server-side-transient statuses.
            return httpCode == 429 || (httpCode >= 500 && httpCode <= 599);
        }

        foreach (long r in RetryableResults)
        {
            if (result == r)
            {
                return true;
            }
        }

        return false;
    }
}
