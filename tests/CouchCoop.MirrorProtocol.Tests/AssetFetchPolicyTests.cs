using CouchCoop.MirrorProtocol.Assets;

namespace CouchCoop.MirrorProtocol.Tests;

// Missing-textures fix (2026-07-19): the asset stores' bounded transient-retry policy. Transport hiccups
// (timeout / connection errors) and HTTP 429/5xx retry up to MaxAttempts; other 4xx and non-transient transport
// results are permanent; attempts are 1-based and exhaust at MaxAttempts.
internal static class AssetFetchPolicyTests
{
    private const long Success = 0;
    private const long CantConnect = 2;
    private const long ConnectionError = 4;
    private const long TlsHandshakeError = 5;
    private const long BodySizeLimitExceeded = 7;
    private const long Timeout = 13;

    public static void Run()
    {
        TransientTransportRetries();
        TimeoutRetries();
        ServerBusyStatusesRetry();
        HardHttpFailuresArePermanent();
        NonTransientTransportIsPermanent();
        SuccessStatusNeverRetries();
        AttemptsExhaust();
    }

    private static void TransientTransportRetries()
    {
        Check.That(AssetFetchPolicy.ShouldRetry(CantConnect, 0, 1), "cant-connect attempt 1 retries");
        Check.That(AssetFetchPolicy.ShouldRetry(ConnectionError, 0, 2), "connection-error attempt 2 retries");
    }

    private static void TimeoutRetries()
    {
        Check.That(AssetFetchPolicy.ShouldRetry(Timeout, 0, 1), "timeout retries (the busy-host wedge case)");
    }

    private static void ServerBusyStatusesRetry()
    {
        Check.That(AssetFetchPolicy.ShouldRetry(Success, 503, 1), "503 asset-busy retries");
        Check.That(AssetFetchPolicy.ShouldRetry(Success, 429, 1), "429 throttle retries");
        Check.That(AssetFetchPolicy.ShouldRetry(Success, 500, 2), "500 retries");
    }

    private static void HardHttpFailuresArePermanent()
    {
        Check.That(!AssetFetchPolicy.ShouldRetry(Success, 404, 1), "404 is permanent");
        Check.That(!AssetFetchPolicy.ShouldRetry(Success, 426, 1), "426 (the WS-only-server case) is permanent");
        Check.That(!AssetFetchPolicy.ShouldRetry(Success, 400, 1), "400 is permanent");
    }

    private static void NonTransientTransportIsPermanent()
    {
        Check.That(!AssetFetchPolicy.ShouldRetry(TlsHandshakeError, 0, 1), "TLS failure re-fails identically — permanent");
        Check.That(!AssetFetchPolicy.ShouldRetry(BodySizeLimitExceeded, 0, 1), "body-size-limit is permanent");
    }

    private static void SuccessStatusNeverRetries()
    {
        Check.That(!AssetFetchPolicy.ShouldRetry(Success, 200, 1), "2xx never retries (decode failures are permanent)");
    }

    private static void AttemptsExhaust()
    {
        Check.That(AssetFetchPolicy.ShouldRetry(Timeout, 0, AssetFetchPolicy.MaxAttempts - 1), "attempt MaxAttempts-1 still retries");
        Check.That(!AssetFetchPolicy.ShouldRetry(Timeout, 0, AssetFetchPolicy.MaxAttempts), "attempt MaxAttempts exhausts");
        Check.That(!AssetFetchPolicy.ShouldRetry(Success, 503, AssetFetchPolicy.MaxAttempts), "exhaustion beats retryable status");
    }
}
