using CouchCoop.Mod.Server;

// Exercise the real caching adapter with an extraction barrier and disposable disk cache. No Godot or game.
internal static class AssetSingleFlightTests
{
    private const string Key = "res://single-flight-test.png";
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(5);

    public static async Task RunAsync()
    {
        await ConcurrentMissesShareOneExtractionAsync();
        await CallerCancellationDoesNotRemoveTheFlightAsync(cancelFirst: true);
        await CallerCancellationDoesNotRemoveTheFlightAsync(cancelFirst: false);
        await AlreadyCancelledCallerDoesNotExtractAsync();
        await FailedExtractionCanRetryAsync(throws: false);
        await FailedExtractionCanRetryAsync(throws: true);
        await CancelledExtractionCanRetryAsync();
        await FormatAndSizeRemainSeparateAsync();
        await RefusedCacheWriteDoesNotRetainTheResultAsync();
        await SeparateAdaptersDoNotShareFlightsAsync();
    }

    private static async Task ConcurrentMissesShareOneExtractionAsync()
    {
        using var scope = new CacheScope();
        var inner = new BarrierAdapter();
        var adapter = Create(inner, scope.Cache);
        var requests = Enumerable.Range(0, 8).Select(_ => adapter.TryGetAssetAsync(Key)).ToArray();
        await inner.Entered.Task.WaitAsync(Deadline);
        var callsBeforeRelease = inner.Calls;
        inner.Release.TrySetResult();
        var results = await Task.WhenAll(requests).WaitAsync(Deadline);

        Expect(callsBeforeRelease == 1 && inner.Calls == 1,
            $"concurrent cold requests must extract once; got {inner.Calls}");
        Expect(results.All(result => result.Error is null && result.Bytes!.SequenceEqual(new byte[] { 1, 2, 3 })),
            "all callers receive the extracted bytes");
        Expect(results.All(result => result.Headers["X-Cache"] == "MISS"), "joined callers share the MISS result");
        var hit = await adapter.TryGetAssetAsync(Key);
        Expect(hit.Headers["X-Cache"] == "HIT" && inner.Calls == 1, "the result is written through before completing");
        Expect(hit.ContentType == "image/png", "write-through preserves content type");
    }

    private static async Task CallerCancellationDoesNotRemoveTheFlightAsync(bool cancelFirst)
    {
        using var scope = new CacheScope();
        using var cancelled = new CancellationTokenSource();
        var inner = new BarrierAdapter();
        var adapter = Create(inner, scope.Cache);
        var first = adapter.TryGetAssetAsync(Key, cancellationToken: cancelFirst ? cancelled.Token : default);
        await inner.Entered.Task.WaitAsync(Deadline);
        var second = adapter.TryGetAssetAsync(Key, cancellationToken: cancelFirst ? default : cancelled.Token);
        cancelled.Cancel();
        await ExpectCancellationAsync(cancelFirst ? first : second);
        var third = adapter.TryGetAssetAsync(Key);
        inner.Release.TrySetResult();
        var survivors = await Task.WhenAll(cancelFirst ? second : first, third).WaitAsync(Deadline);

        Expect(inner.Calls == 1, "a cancelled caller must not remove the shared operation before a late joiner arrives");
        Expect(!inner.SawCancelableToken, "an individual caller token must not own the shared extraction");
        Expect(survivors.All(result => result.Error is null), "other callers survive cancellation");
        Expect((await adapter.TryGetAssetAsync(Key)).Headers["X-Cache"] == "HIT", "cancellation does not prevent write-through");
    }

    private static async Task AlreadyCancelledCallerDoesNotExtractAsync()
    {
        using var scope = new CacheScope();
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var inner = new BarrierAdapter();
        var adapter = Create(inner, scope.Cache);
        try
        {
            await ExpectCancellationAsync(adapter.TryGetAssetAsync(Key, cancellationToken: cancelled.Token));
            Expect(inner.Calls == 0, "an already cancelled request does not start extraction");
        }
        finally
        {
            inner.Release.TrySetResult();
        }
    }

    private static async Task FailedExtractionCanRetryAsync(bool throws)
    {
        using var scope = new CacheScope();
        var calls = 0;
        var inner = new DelegateAdapter((_, _, _, _) =>
        {
            if (Interlocked.Increment(ref calls) == 1)
            {
                if (throws) throw new InvalidOperationException("expected extraction failure");
                return Task.FromResult(CouchCoopAssetHttpResponse.Missing(new CouchCoopAssetHttpError("retry-me", "expected")));
            }
            return Task.FromResult(Success());
        });
        var adapter = Create(inner, scope.Cache);
        if (throws)
        {
            try
            {
                await adapter.TryGetAssetAsync(Key).WaitAsync(Deadline);
                throw new Exception("expected extraction exception");
            }
            catch (InvalidOperationException exception) when (exception.Message == "expected extraction failure") { }
        }
        else
        {
            Expect((await adapter.TryGetAssetAsync(Key)).Error?.Code == "retry-me", "structured errors pass through");
        }
        Expect((await adapter.TryGetAssetAsync(Key).WaitAsync(Deadline)).Error is null && calls == 2,
            "a settled failure is removed before callers retry");
        Expect((await adapter.TryGetAssetAsync(Key)).Headers["X-Cache"] == "HIT", "a successful retry is cached");
    }

    private static async Task CancelledExtractionCanRetryAsync()
    {
        using var scope = new CacheScope();
        var calls = 0;
        var inner = new DelegateAdapter((_, _, _, _) => Interlocked.Increment(ref calls) == 1
            ? Task.FromCanceled<CouchCoopAssetHttpResponse>(new CancellationToken(canceled: true))
            : Task.FromResult(Success()));
        var adapter = Create(inner, scope.Cache);
        await ExpectCancellationAsync(adapter.TryGetAssetAsync(Key));
        Expect((await adapter.TryGetAssetAsync(Key).WaitAsync(Deadline)).Error is null && calls == 2,
            "an extraction cancelled by the inner adapter is removed and can retry");
    }

    private static async Task FormatAndSizeRemainSeparateAsync()
    {
        using var scope = new CacheScope();
        var inner = new BarrierAdapter();
        var adapter = Create(inner, scope.Cache);
        var variants = new[]
        {
            (CouchCoopResourceFormat.Raw, CouchCoopAssetRenderSize.Source),
            (CouchCoopResourceFormat.Png, CouchCoopAssetRenderSize.Source),
            (CouchCoopResourceFormat.Png, new CouchCoopAssetRenderSize(192, 192)),
            (CouchCoopResourceFormat.Png, new CouchCoopAssetRenderSize(512, 512)),
        };
        var requests = variants.SelectMany(variant => Enumerable.Range(0, 2)
            .Select(_ => adapter.TryGetAssetAsync(Key, variant.Item1, variant.Item2))).ToArray();
        inner.Release.TrySetResult();
        await Task.WhenAll(requests).WaitAsync(Deadline);
        Expect(inner.Calls == variants.Length, "raw, png, and requested render sizes are independent identities");
        foreach (var (format, size) in variants)
            Expect((await adapter.TryGetAssetAsync(Key, format, size)).Headers["X-Cache"] == "HIT", "every variant has its own cache entry");
        Expect(inner.Calls == variants.Length, "variant cache hits never extract again");
    }

    private static async Task RefusedCacheWriteDoesNotRetainTheResultAsync()
    {
        using var scope = new CacheScope(refuseWrites: true);
        var inner = new BarrierAdapter();
        var adapter = Create(inner, scope.Cache);
        var first = adapter.TryGetAssetAsync(Key);
        var second = adapter.TryGetAssetAsync(Key);
        await inner.Entered.Task.WaitAsync(Deadline);
        inner.Release.TrySetResult();
        await Task.WhenAll(first, second).WaitAsync(Deadline);
        Expect(inner.Calls == 1, "concurrent callers still share work when disk writes are refused");
        Expect(await scope.Cache.TryReadAsync(Key) is null, "the fixture actually refuses the disk write");
        Expect((await adapter.TryGetAssetAsync(Key)).Headers["X-Cache"] == "MISS" && inner.Calls == 2,
            "single-flight is not a memory cache and preserves uncached requests after completion");
    }

    private static async Task SeparateAdaptersDoNotShareFlightsAsync()
    {
        using var firstScope = new CacheScope();
        using var secondScope = new CacheScope();
        var firstInner = new BarrierAdapter();
        var secondInner = new BarrierAdapter();
        var first = Create(firstInner, firstScope.Cache).TryGetAssetAsync(Key);
        var second = Create(secondInner, secondScope.Cache).TryGetAssetAsync(Key);
        await Task.WhenAll(firstInner.Entered.Task, secondInner.Entered.Task).WaitAsync(Deadline);
        firstInner.Release.TrySetResult();
        secondInner.Release.TrySetResult();
        await Task.WhenAll(first, second).WaitAsync(Deadline);
        Expect(firstInner.Calls == 1 && secondInner.Calls == 1, "adapter instances never share flights across cache roots/providers");
    }

    private static CachedSpirectlAssetHttpAdapter Create(ICouchCoopAssetHttpAdapter inner, SpirectlAssetBinaryCache cache)
        => new(inner, cache, isHeadlessClient: false);

    private static CouchCoopAssetHttpResponse Success()
        => CouchCoopAssetHttpResponse.Found([1, 2, 3], "image/png", new Dictionary<string, string>());

    private static async Task ExpectCancellationAsync(Task<CouchCoopAssetHttpResponse> task)
    {
        try
        {
            await task.WaitAsync(Deadline);
            throw new Exception("expected caller cancellation");
        }
        catch (OperationCanceledException) { }
    }

    private sealed class BarrierAdapter : ICouchCoopAssetHttpAdapter
    {
        private int _calls;
        public int Calls => Volatile.Read(ref _calls);
        public bool SawCancelableToken { get; private set; }
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(string opaqueKey,
            CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _calls);
            SawCancelableToken |= cancellationToken.CanBeCanceled;
            Entered.TrySetResult();
            await Release.Task.WaitAsync(cancellationToken);
            return Success();
        }
    }

    private sealed class DelegateAdapter(
        Func<string, CouchCoopResourceFormat, CouchCoopAssetRenderSize, CancellationToken, Task<CouchCoopAssetHttpResponse>> get)
        : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(string opaqueKey,
            CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
            => get(opaqueKey, format, renderSize, cancellationToken);
    }

    private sealed class CacheScope : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), "couchcoop-single-flight-" + Guid.NewGuid().ToString("N"));
        public SpirectlAssetBinaryCache Cache { get; }

        public CacheScope(bool refuseWrites = false)
        {
            Directory.CreateDirectory(_root);
            // Pin quota inputs so the test never depends on the user's available disk space or global cache.
            var quota = new ManagedCacheQuota(_root, [_root], ceilingBytes: 1_000_000,
                freeSpaceReserveBytes: 0, entryLimitBytes: refuseWrites ? 1 : 100_000,
                freeSpace: _ => 10_000_000, allocationUnitBytes: 1, reconcileInterval: TimeSpan.FromHours(1));
            Cache = new SpirectlAssetBinaryCache(_root, quota);
        }

        public void Dispose() => Directory.Delete(_root, recursive: true);
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new Exception("AssetSingleFlightTests: " + message);
    }
}
