using System.Runtime.CompilerServices;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.Tests;

// Distinct mod-owned throw sites exercise the server's fault-based diagnostic throttle.
internal sealed class ThrowingAssetAdapter : ICouchCoopAssetHttpAdapter
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(string opaqueKey,
        CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
        CouchCoopAssetRenderSize renderSize = default,
        CancellationToken cancellationToken = default)
    {
        if (opaqueKey.EndsWith("/other-boom.png", StringComparison.Ordinal)) return ThrowOther();
        throw new ApplicationException("asset test failure");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static Task<CouchCoopAssetHttpResponse> ThrowOther()
        => throw new ApplicationException("asset test failure at another site");
}
