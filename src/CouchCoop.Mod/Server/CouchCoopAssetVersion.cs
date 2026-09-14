using System.Reflection;
using CouchCoop.MirrorProtocol.Assets;

namespace CouchCoop.Mod.Server;

/// <summary>
/// THE ONE STRING THAT SAYS "THESE ASSET BYTES CAME FROM THIS BUILD" — published to clients on the
/// <c>session</c> envelope as <c>assetCacheToken</c>, and folded into the asset URLs this host mints.
/// </summary>
/// <remarks>
/// <para>
/// Everything the host serves under <c>/res/</c>, <c>/models/</c>, <c>/spines/</c> and <c>/bg/</c> is derived
/// from the game's own content, and two builds of Slay the Spire 2 render different pixels from identical
/// <c>res://</c> paths. Those answers carry <c>Cache-Control: public, max-age=31536000, immutable</c>, which is
/// true of the BYTES and not of the URL: without a build qualifier a client's HTTP cache pins one build's atlas
/// under a URL the other build also asks for, for a year.
/// </para>
/// <para>
/// So the token rides the URL. It is composed from <see cref="CouchCoopCacheRoot.Identity"/> — the same identity
/// the host keys its OWN on-disk cache on — so "the host's bytes can have changed" and "a client's cached bytes
/// are stale" stay one fact rather than two that drift apart. It deliberately does NOT come from
/// <c>Capabilities.GameVersion</c>, which the embedded runtime facade reports as the empty string.
/// </para>
/// <para>
/// RESOLVED ONCE. Every input is fixed for the life of the process (the install on disk, this assembly's own
/// version, the server asset schema), so the token cannot change while the host runs — which is also what lets a
/// client latch it and mint every subsequent URL from it.
/// </para>
/// </remarks>
public static class CouchCoopAssetVersion
{
    /// <summary>The query parameter asset URLs carry it under. <c>b</c> for build.</summary>
    /// <remarks>
    /// Not <c>v</c>: <see cref="CouchCoopStaticBackgroundProvider"/> already spends that on the <c>/bg/</c> URL
    /// grammar's own version, and <c>/spines/</c> reserves it as a clip discriminator. The browser twin of this
    /// constant is <c>PARAM</c> in <c>frontend/src/join/assetVersion.ts</c>.
    /// </remarks>
    public const string QueryParameter = "b";

    private static readonly Lazy<string> Value = new(Compose, LazyThreadSafetyMode.ExecutionAndPublication);

    /// <summary>The token, e.g. <c>cc-1a2b3c4d5e6f7890</c>. Never null, never empty.</summary>
    public static string Token => Value.Value;

    /// <summary><c>&amp;b=&lt;token&gt;</c> / <c>?b=&lt;token&gt;</c>, for appending to a route this host mints.</summary>
    public static string QuerySuffix(bool hasQuery) =>
        $"{(hasQuery ? '&' : '?')}{QueryParameter}={Uri.EscapeDataString(Token)}";

    private static string Compose() => AssetCacheToken.Compose(
        DescribeGameBuild(CouchCoopCacheRoot.Identity),
        ModAssemblyVersion,
        SpirectlAssetBinaryCache.SchemaVersion);

    /// <summary>
    /// The game build, as one token component: version, content hash, Steam build id and branch.
    /// </summary>
    /// <remarks>
    /// All four, because each covers a gap the others leave. The version alone repeats across a rebuild that
    /// keeps its string; the hash alone is 0 when <c>release_info.json</c> is unreadable; the build id alone is 0
    /// off Steam; and the branch alone is what two branches sharing a version would differ by. Any one of them
    /// moving must move the token, so they are concatenated rather than chosen between.
    /// </remarks>
    internal static string DescribeGameBuild(CouchCoopCacheIdentity identity) =>
        $"{identity.GameVersion}/{identity.MainAssemblyHash}/{identity.SteamBuildId}/{identity.Branch}";

    /// <summary>
    /// The mod assembly's version. The mod csproj sets no explicit version, so this resolves to the SDK default
    /// (e.g. "1.0.0") — stable per build, changing only across releases.
    /// </summary>
    internal static readonly string ModAssemblyVersion =
        typeof(CouchCoopAssetVersion).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(CouchCoopAssetVersion).Assembly.GetName().Version?.ToString()
        ?? "0";
}
