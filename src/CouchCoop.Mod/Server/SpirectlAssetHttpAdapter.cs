using CouchCoop.Mod.Runtime;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Server;

// Godot-native-first `/res` serving keeps resource bytes raw by default. The only alternate representation is
// `Png`, the explicit raster request for resources a client needs to decode as an image.
//
// WS-PARTICLE: `Png` (`?format=png`) asks spirectl to RASTERIZE the resource. For an AtlasTexture `.tres` (the
// particle-texture case: intent_attack_3.tres etc.) spirectl's extraction falls through its structure-family
// branch to ExtractTextureAsync → ExtractAtlasTextureAsync, returning the CROPPED REGION as PNG bytes — the same
// resolver raster requests already use. Raw would return the `.tres` TEXT, which no image decoder can load (the
// native client then drew default untextured white quads).
public enum CouchCoopResourceFormat
{
    Raw,
    Png,
}

/// <param name="RenderWidth">
/// Requested output size in px, or <c>0</c> for "whatever the resource is". Forwarded verbatim to
/// <see cref="EmbeddableAssetRequest.RenderWidth"/>, which spirectl honours by RESAMPLING a texture
/// extract (and by re-framing a combat-background scene render). Both dimensions must be positive to
/// take effect, so the default is byte-identical to a request that never mentions a size.
/// </param>
public readonly record struct CouchCoopAssetRenderSize(int RenderWidth, int RenderHeight)
{
    public static readonly CouchCoopAssetRenderSize Source = new(0, 0);

    public bool IsRequested => RenderWidth > 0 && RenderHeight > 0;

    /// <summary>Cache-key fragment; empty for the default so existing keys are unchanged.</summary>
    public string KeySuffix => IsRequested ? $"|size={RenderWidth}x{RenderHeight}" : string.Empty;
}

public interface ICouchCoopAssetHttpAdapter
{
    Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
        string opaqueKey,
        CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
        CouchCoopAssetRenderSize renderSize = default,
        CancellationToken cancellationToken = default);
}

public sealed class SpirectlAssetHttpAdapter(ISpirectlAssetProvider assets, ICouchCoopCapabilityPolicy capabilities) : ICouchCoopAssetHttpAdapter
{
    public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
        string opaqueKey,
        CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
        CouchCoopAssetRenderSize renderSize = default,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(assets);
        ArgumentNullException.ThrowIfNull(capabilities);
        cancellationToken.ThrowIfCancellationRequested();

        EmbeddableAssetResult result;
        try
        {
            capabilities.RequireCapability(CouchCoopRuntimeHost.AssetExtractionCapability);
            result = assets.GetAsset(new EmbeddableAssetRequest(
                opaqueKey,
                ResolveAssetFormat(opaqueKey, format),
                "http-asset",
                RenderWidth: renderSize.IsRequested ? renderSize.RenderWidth : null,
                RenderHeight: renderSize.IsRequested ? renderSize.RenderHeight : null));
        }
        catch (NotSupportedException exception)
        {
            return Task.FromResult(CouchCoopAssetHttpResponse.Missing(new CouchCoopAssetHttpError(
                CouchCoopRuntimeHost.AssetExtractionCapability,
                exception.Message,
                "capabilityId",
                CouchCoopRuntimeHost.AssetExtractionCapability,
                capabilities.Notices)));
        }

        if (!result.Success || result.Payload is null)
        {
            return Task.FromResult(CouchCoopAssetHttpResponse.Missing(result.Error is null
                ? new CouchCoopAssetHttpError("missing-asset", "Asset was not found.")
                : CouchCoopAssetHttpError.FromEmbeddable(result.Error)));
        }

        return Task.FromResult(CouchCoopAssetHttpResponse.Found(
            result.Payload.Contents,
            string.IsNullOrWhiteSpace(result.Payload.ContentType)
                ? "application/octet-stream"
                : result.Payload.ContentType,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Cache-Control"] = "public, max-age=31536000, immutable"
            }));
    }

    // `model://` keys are always texture ART (the renderer only routes `texture`-kind bindings
    // through `resourcePathToUrl`). Some resolve to a PackedScene (e.g. a character's
    // `characterSelectBgSpineStill` background); the seam returns a GodotSceneState JSON document under the
    // structure formats, which the renderer can't paint as an image → black. Requesting an explicit raster
    // format makes the seam RENDER scene-backed art to PNG — exactly what the spirectl presentation dev server
    // does (`--format png` for model:// queries). The res:// format selection is Godot-native-first: `raw`
    // (default) serves the game's own resource bytes — spirectl's "raw" keeps scenes as GodotSceneState JSON
    // and shaders as raw `.gdshader` text, and diverts only the AtlasTexture/Font/Material `.tres` DOCUMENTS to
    // their raw bytes. `png` (WS-PARTICLE,
    // `?format=png`) is the explicit raster ask: spirectl's extraction treats any non-structure format as a raster
    // encode, so an AtlasTexture `.tres` routes to the cropped-region PNG path (ExtractAtlasTextureAsync) instead
    // of its raw `[gd_resource]` text — the native client requests this for particle/sampler textures whose path
    // is not a decodable image (see RasterTextureUrl).
    internal static string ResolveAssetFormat(string key, CouchCoopResourceFormat format)
    {
        if (key.StartsWith("model://", StringComparison.Ordinal))
        {
            return "png";
        }

        return format switch
        {
            CouchCoopResourceFormat.Png => "png",
            _ => "raw",
        };
    }
}

public sealed record CouchCoopAssetHttpResponse(
    byte[]? Bytes,
    string? ContentType,
    IReadOnlyDictionary<string, string> Headers,
    CouchCoopAssetHttpError? Error)
{
    public static CouchCoopAssetHttpResponse Found(
        byte[] bytes,
        string contentType,
        IReadOnlyDictionary<string, string> headers)
        => new(bytes, contentType, headers, Error: null);

    public static CouchCoopAssetHttpResponse Missing(CouchCoopAssetHttpError error)
        => new(Bytes: null, ContentType: null, Headers: new Dictionary<string, string>(), error);
}

public sealed record CouchCoopAssetHttpError(
    string Code,
    string Message,
    string? Field = null,
    string? Value = null,
    IReadOnlyList<object>? Notices = null)
{
    public static CouchCoopAssetHttpError FromEmbeddable(EmbeddableAssetError error)
        => new(error.Code, error.Message, error.Field, error.Value, error.Notices?.Cast<object>().ToList());
}
