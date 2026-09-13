using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Collections.Concurrent;

namespace CouchCoop.Mod.Server;

/// <summary>
/// The MANAGED on-disk cache of baked geoclips — the second <c>/geoclips/</c> root, behind the operator-seeded
/// <see cref="CouchCoopGeoclipDirectory.RootEnvVar"/> one. Where <see cref="SpirectlAssetBinaryCache"/> stores one
/// opaque blob per asset key, a geoclip is a small DIRECTORY (a manifest, packed vertex blob, and packed sheets),
/// so the layout is a directory tree rather than a hashed file pair.
/// </summary>
/// <remarks>
/// <para>
/// LAYOUT, under <see cref="CouchCoopCacheRoot.GeoclipRoot"/> (or <c>&lt;explicit root&gt;/geoclips/</c>):
/// </para>
/// <code>
///   pages/sheet-&lt;hash&gt;.png|.webp   content-addressed packed sheets, SHARED by every pose of every rig
///   &lt;sha256(geoclipKey)&gt;/manifest.json
///   &lt;sha256(geoclipKey)&gt;/verts.bin
///   &lt;sha256(geoclipKey)&gt;/.complete  written LAST; a directory without it never resolves
///   refusals/&lt;sha256(geoclipKey)&gt;.json   the NEGATIVE twin of .complete — see below
///   staging/&lt;guid&gt;/                 where a bake writes before it is adopted
/// </code>
/// <para>
/// PAGES ARE THE POINT. A rig's atlas pages are identical across its poses, so they are named by the hash of
/// their own bytes and adopted into ONE shared folder: the rig pays for its atlas once on disk and once in the
/// browser cache, and a creature's second pose transfers geometry only. Without that sharing a second pose costs
/// about what the webp still it replaces costs and the round's transfer payoff evaporates. The manifest's
/// <c>pages[].file</c> is rewritten to the hashed name as part of adoption, so the client follows the manifest
/// and never needs to know the rule.
/// </para>
/// <para>
/// THE MARKER IS THE GATE. Every file is written temp-then-move (the discipline
/// <see cref="SpirectlAssetBinaryCache"/> uses, for the same reason: a concurrent reader must never see a
/// half-written file), and <see cref="CompleteMarkerName"/> is written LAST. Resolution requires the marker, so a
/// bake that died halfway through leaves a directory that is simply invisible — it is re-baked and overwritten,
/// never served. There is no eviction, matching <see cref="SpirectlAssetBinaryCache"/>, which has none either.
/// </para>
/// <para>
/// TWO LEVERS. <see cref="GeoclipSelector"/>'s <c>gv</c> is the fine one: it versions the geoclip POLICY inside an
/// unchanged layout, moving cached deltas and leaving every raster clip and still valid, because those are
/// addressed by keys that do not carry it. <see cref="CouchCoopCacheRoot.CacheVersion"/> is the coarse one — reach
/// for it when the on-disk LAYOUT changes (what files a pose directory holds, or how they are named), which is the
/// one thing a <c>gv</c> bump cannot express. It empties this store's whole branch directory, and every other
/// cache in it, which is the honest cost of saying "nothing written before this is readable".
/// </para>
/// <para>
/// A REFUSAL IS ALSO A RESULT, and it has to be durable or the sweep never converges. Roughly half of a real
/// catalog's identities come back from the baker incomplete; without a receipt every relaunch re-bakes every one
/// of them, at seconds each, on a host measured to die about every four hundred bakes — so the store fills
/// asymptotically never. <see cref="RecordRefusalAsync"/> writes the negative twin of the <c>.complete</c> marker
/// into <see cref="RefusalsFolderName"/> and <see cref="TryReadRefusal"/> reads it back.
/// </para>
/// <para>
/// A REFUSAL IS A VERDICT OF THIS BAKER AT THIS REFUSAL-POLICY REVISION, never a permanent property of the rig — a
/// better baker must get to retry it. The receipt records that revision separately from the geoclip key's
/// <c>gv</c>, so changing the rules for refusing a bake retries old refusals WITHOUT moving an already-complete
/// artifact. It fails OPEN in every direction — an unreadable, malformed or foreign-policy receipt means "bake it",
/// never "suppress it forever", because the cost of a wrong retry is one bake and the cost of a wrong suppression is a creature that
/// can never be produced again.
/// </para>
/// <para>
/// A REFUSAL RECEIPT IS NOT CONTENT. It lives outside every pose directory and its name is outside
/// <see cref="CouchCoopGeoclipDirectory.IsAllowedFileName"/>'s whitelist, so neither of the route's two
/// addressing forms can reach it: resolution needs a pose directory holding <see cref="CompleteMarkerName"/>, and
/// a refused identity has no pose directory at all.
/// </para>
/// </remarks>
public sealed class CouchCoopGeoclipStore
{
    /// <summary>
    /// The tail appended to a canonical <c>spine://</c> key to address the GEOCLIP for that identity.
    /// </summary>
    /// <remarks>
    /// Exactly the trick <see cref="CouchCoopSpineClipProvider.StillSelector"/>'s <c>sf</c> plays. <c>geo=1</c>
    /// says "the geometry bake of this identity, not the raster clip"; <c>gv</c> is an OPAQUE
    /// geoclip-POLICY-version discriminator that no producer parses — bumping it invalidates every cached DELTA
    /// and leaves every cached raster clip and still valid, because they are addressed by keys that do not carry
    /// it. It rides at the END, after <see cref="CouchCoopSpineClipProvider.BuildSpineKey"/>'s fixed selector
    /// order, so the shared prefix of a clip key and its geoclip key stays byte-identical.
    /// </remarks>
    public const string GeoclipSelector = "&geo=1&gv=1";

    /// <summary>The compatibility revision for durable refusal receipts, independent of <see cref="GeoclipSelector"/>.</summary>
    /// <remarks>
    /// <para>A refusal is a verdict about the baker's admission rules, while <c>gv</c> addresses a successful
    /// artifact. Bump this value when those admission rules change: old or field-less receipts then fail open and
    /// retry, but complete artifacts retain their existing <c>gv</c>-based addresses.</para>
    /// <para>AND BUMP IT WHEN THE PRODUCER'S ANSWER CHANGES FOR A WHOLE CLASS OF HOSTS, which is the wider reading
    /// the <c>/5</c> → <c>/6</c> entry below rests on. The invariant a receipt actually carries is "a bake of this
    /// identity RAN, under these rules, on this kind of host, and was refused" — not "the admission rule said no".
    /// An acquisition-only fix normally leaves the revision alone, because it changes what a FUTURE bake finds
    /// without saying anything about the hosts that already answered; the exception is a fix that turns a
    /// deterministic refusal into a deterministic admission for every host of some shape, where every receipt
    /// those hosts hold is now known-wrong and is answered without baking.</para>
    /// <para><c>/3</c> → <c>/4</c>: the third arm of the completeness rule stopped refusing on unclaimed geometry
    /// alone and now grades per-claim ownership proof
    /// (<see cref="CouchCoopGeoclipProvider.IncompletenessReason(bool,int,int,int,int,int,bool?)"/>, in lockstep
    /// with spirectl <c>71c92bc7</c>). THIS BUMP RIDES IN THE SAME COMMIT AS THAT RULE CHANGE, and it has to:
    /// every receipt on every host was written by the old rule, and a receipt is answered without baking. Leave
    /// the revision alone and each of those identities keeps returning the old verdict for ever — the new rule
    /// would be live, correct, and unreachable for exactly the bakes it was written to admit. The cost is one
    /// re-bake per remembered refusal, paid lazily; artifact addresses do not move.</para>
    /// <para><c>/4</c> → <c>/5</c>: a refusal whose sweep came up short WITHOUT truncating is no longer written
    /// down at all (<see cref="CouchCoopGeoclipProvider.IsRetryableAcquisitionShortfall(int,int,bool)"/>, in
    /// lockstep with spirectl <c>7cb0e6b5</c>) — its plan missed geometry a creature death had moved out of the
    /// inferred index hull, which is a property of the RID allocator at that instant and not of the rig. THE BUMP
    /// IS THE OTHER HALF OF THAT CHANGE. Every host's disk already holds receipts minted under the sticky rule
    /// for exactly those bakes, and a receipt is answered without baking; leave the revision alone and the new
    /// rule is live and correct for future bakes while the identities it was written to rescue stay poisoned for
    /// ever. Bumping fails them open at one re-bake each, and successful <c>gv</c> addresses do not move.</para>
    /// <para><c>/5</c> → <c>/6</c>: a bake under a HEADLESS renderer used to read every slot mesh back at its
    /// creation-time contents, because the dummy backend's in-place mesh-region updates are no-ops, so the pose the
    /// skeleton was posed to never reached the geometry. Such a bake refuses — deterministically, on every rig, on
    /// every headless host — and each refusal writes a receipt. The producer now re-mints the slot mesh pool at the
    /// sampled pose and arms that from the renderer it actually got (spirectl <c>e124decc</c>, <c>ed45162f</c>,
    /// <c>5e8d04c3</c>), and the four measured knight rigs go from 404 on all four to <c>complete=true</c> and
    /// byte-identical to a real-renderer bake through this very route. THE BUMP IS THE OTHER HALF OF THAT CHANGE
    /// and there is no couch-side rule change to ride with, which is the whole trap: the fix is entirely upstream,
    /// this store's rules are untouched, and a receipt is answered WITHOUT baking — so on any host that has already
    /// run headless the fix is invisible and the route keeps answering <c>geoclip-bake-refused-cached</c> in
    /// milliseconds, for ever, having never re-attempted the bake the fix repaired. Measured, not argued: seeding
    /// one such receipt into an otherwise-fixed headless host kept that rig at 404 while its three siblings served
    /// 200. Cost, as before, is one re-bake per remembered refusal, paid lazily; <c>gv</c> addresses do not
    /// move.</para>
    /// <para>WHAT THIS BUMP CANNOT REACH, stated because it is the reason it is not the whole deployment story: a
    /// receipt is the only durable thing a REFUSED bake leaves. A pre-fix headless bake that the completeness rule
    /// happened to ADMIT was adopted with <see cref="CompleteMarkerName"/> under its unchanged <c>gv</c> address,
    /// and this store has no eviction and re-decides nothing that resolves — so that pose keeps serving its
    /// creation-time geometry until <see cref="GeoclipSelector"/> moves or the tree is deleted by hand. Nothing
    /// here can distinguish it from a good bake, so nothing here tries.</para>
    /// </remarks>
    public const string RefusalPolicyRevision = "geoclip-refusal/1";

    /// <summary>The shared, content-addressed atlas-page folder at the store root.</summary>
    public const string PagesFolderName = "pages";

    /// <summary>Where a bake writes before adoption. Never served; swept after each adopt.</summary>
    public const string StagingFolderName = "staging";

    /// <summary>
    /// Refusal receipts, one JSON file per refused identity, named <c>&lt;sha256(geoclipKey)&gt;.json</c>.
    /// </summary>
    /// <remarks>
    /// Its OWN folder rather than a <c>.refused</c> file inside the pose directory, for two reasons that both
    /// matter. A refused identity has no pose directory — it never got one, and creating one would put a
    /// resolvable-looking shell next to every real pose for a reader (and for anything that ever enumerates the
    /// root) to mistake for a half-written bake. And keeping the receipt out of the served tree entirely means
    /// the "never serve a refusal" property does not depend on the file-name whitelist alone.
    /// </remarks>
    public const string RefusalsFolderName = "refusals";

    /// <summary>
    /// Written LAST, and required by every resolution. Not in
    /// <see cref="CouchCoopGeoclipDirectory.IsAllowedFileName"/>, so it is never itself servable.
    /// </summary>
    public const string CompleteMarkerName = ".complete";

    public const string ManifestFileName = "manifest.json";
    public const string VertsFileName = "verts.bin";

    /// <summary>
    /// Hex characters of SHA-256 kept in a page's content-addressed name — 64 bits.
    /// </summary>
    /// <remarks>
    /// Deliberately wider than the 32 bits an 8-character name would give. The failure mode of a page-hash
    /// collision is not a cache miss, it is a creature silently drawn with another creature's atlas, cached
    /// forever; at a few hundred distinct pages the birthday probability of that is ~1e-5 at 32 bits and ~1e-13
    /// at 64. The extra eight characters cost nothing (the name is never typed by a human, and the client reads
    /// it out of the manifest), so this buys the difference for free.
    /// </remarks>
    private const int PageHashHexLength = 16;

    /// <summary>
    /// camelCase and case-insensitive, so a refusal receipt reads like every other JSON this host emits and
    /// survives being hand-edited by whoever is deciding whether to bump <c>gv</c>.
    /// </summary>
    private static readonly JsonSerializerOptions RefusalJsonOptions = new(JsonSerializerDefaults.Web);

    private readonly string? _root;
    private readonly ManagedCacheQuota? _quota;
    private readonly ConcurrentDictionary<string, ManagedCacheQuota.Reservation> _stagingReservations = new(StringComparer.Ordinal);

    /// <param name="cacheRoot">
    /// A directory to hang this store's <c>geoclips/</c> leaf under, NOT branch scoped (tests and benches, which
    /// own a scratch directory and wipe it themselves). Null takes the branch-scoped root the shipped host uses;
    /// the leaf name is the same either way, so there is one on-disk shape.
    /// </param>
    public CouchCoopGeoclipStore(string? cacheRoot = null) : this(cacheRoot, null) { }

    internal CouchCoopGeoclipStore(string? cacheRoot, ManagedCacheQuota? quota)
    {
        if (!string.IsNullOrWhiteSpace(cacheRoot))
        {
            _root = Path.Combine(cacheRoot, CouchCoopCacheRoot.GeoclipFolderName);
            _quota = quota ?? SpirectlAssetBinaryCache.CreateQuota(cacheRoot);
            return;
        }

        _root = CouchCoopCacheRoot.GeoclipRoot;
        _quota = _root is null ? null : quota ?? CouchCoopCacheRoot.Quota;
    }

    /// <summary>Whether a root could be resolved at all. Says NOTHING about the root existing on disk.</summary>
    public bool IsEnabled => _root is not null;

    /// <summary>The store root, or null when no cache root could be resolved.</summary>
    public string? RootPath => _root;

    /// <summary>
    /// The shared content-addressed page folder, or null when disabled. Only ever CREATED by an adoption — asking
    /// for the path touches nothing.
    /// </summary>
    public string? PagesPath => _root is null ? null : Path.Combine(_root, PagesFolderName);

    /// <summary>
    /// The refusal-receipt folder, or null when disabled. Only ever CREATED by a recorded refusal.
    /// </summary>
    public string? RefusalsPath => _root is null ? null : Path.Combine(_root, RefusalsFolderName);

    /// <summary>
    /// Whether this store has anything on disk. The route consults it to decide whether the managed root exists
    /// at all; on a host that has never baked, this is the single <c>Directory.Exists</c> that keeps the unarmed
    /// path from creating a thing.
    /// </summary>
    public bool RootExists => _root is not null && Directory.Exists(_root);

    /// <summary>
    /// The geoclip key for a canonical spine key: the clip identity plus <see cref="GeoclipSelector"/>.
    /// </summary>
    public static string BuildGeoclipKey(string spineKey)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(spineKey);
        return spineKey.Trim() + GeoclipSelector;
    }

    /// <summary>The pose directory NAME for a geoclip key (lowercase sha256 hex).</summary>
    public static string DirectoryNameFor(string geoclipKey)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(geoclipKey);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(geoclipKey))).ToLowerInvariant();
    }

    /// <summary>The content-addressed file name for a page's bytes, in the container those bytes are.</summary>
    /// <remarks>
    /// Routed through <see cref="PageFileNameForContentId"/> rather than restating the truncation, so a page
    /// named from its bytes and a page named from a producer's declared <c>sha256</c> cannot drift apart. A full
    /// SHA-256 hex string always satisfies that method's guard, hence the assertion rather than a fallback — but
    /// the EXTENSION can still be refused, because it comes from a manifest another assembly wrote.
    /// </remarks>
    public static string PageFileNameFor(ReadOnlySpan<byte> bytes, string extension)
        => PageFileNameForContentId(Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), extension)
            ?? throw new InvalidOperationException(
                $"A SHA-256 hex digest and '{extension}' do not name a usable page file.");

    /// <summary>
    /// The same name, from a content id the PRODUCER computed (<c>pages[].sha256</c>) instead of from bytes.
    /// </summary>
    /// <remarks>
    /// <para>The two must agree exactly, and a test pins that they do: a page adopted by name and the same page
    /// adopted by hashing its bytes have to land on one file, or the store would hold two copies of one atlas and
    /// the sharing this whole design rests on would be silently off. Answers null for anything that is not at
    /// least <see cref="PageHashHexLength"/> hex characters — a short or malformed id must miss, never alias.</para>
    /// <para>THE EXTENSION IS CHECKED, NOT TRUSTED. It reaches here from a bake's manifest, and a store that
    /// minted <c>sheet-&lt;hex&gt;.anything</c> would be writing files its own route then refuses to serve — so
    /// only <see cref="CouchCoopGeoclipDirectory.PageExtensions"/> name a page, and a name this method returns is
    /// always one <see cref="CouchCoopGeoclipDirectory.IsPageFileName"/> accepts.</para>
    /// </remarks>
    public static string? PageFileNameForContentId(string? contentId, string extension)
    {
        var id = contentId?.Trim().ToLowerInvariant();
        if (id is null || id.Length < PageHashHexLength || !id.All(char.IsAsciiHexDigit))
        {
            return null;
        }

        if (!CouchCoopGeoclipDirectory.PageExtensions.Contains(extension, StringComparer.Ordinal))
        {
            return null;
        }

        return "sheet-" + id[..PageHashHexLength] + extension;
    }

    /// <summary>
    /// The content ids of every shared page already on disk, in the truncated form this store NAMES them by.
    /// </summary>
    /// <remarks>
    /// <para>Handed to a bake so it can describe a page it does not have to produce. The producer treats these as
    /// PREFIXES of its own full SHA-256, which is what lets the two sides disagree about how many characters to
    /// keep without either one knowing the other's policy.</para>
    /// <para>SAFE ONLY BECAUSE THIS STORE HAS NO EVICTION. A page named here is a page that will still be here
    /// when the bake finishes, so "the caller already holds it" cannot go stale between the probe and the adopt.
    /// If eviction is ever added, this has to become a pin.</para>
    /// <para>AN ID IS EXTENSION-FREE, and that is the whole reason this enumerates every page extension rather
    /// than one. A content id identifies BYTES; the extension only says what container those bytes are, and the
    /// producer matches an id against the sha256 of the bytes it is holding, which knows nothing about file
    /// names. Listing one extension while <see cref="PageFileNameForContentId"/> can mint two is the exact way
    /// this silently stops working: the adopt writes <c>sheet-&lt;id&gt;.webp</c>, the next sweep lists only
    /// <c>*.png</c>, the id is never announced, and every pose of the rig re-encodes and re-transfers a page the
    /// store already holds — with nothing failing and no error anywhere.</para>
    /// </remarks>
    public IReadOnlySet<string> KnownPageContentIds()
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        if (PagesPath is not { } pages || !Directory.Exists(pages))
        {
            return ids;
        }

        try
        {
            // Glob the published sheet family, not the extension, and let the whitelist decide. A half-written
            // sheet is refused, so a concurrent adopt can never announce it as content a bake may skip.
            foreach (var file in Directory.EnumerateFiles(pages, "sheet-*"))
            {
                var name = Path.GetFileName(file);
                if (CouchCoopGeoclipDirectory.PageExtensionOf(name) is not { } extension)
                {
                    continue;
                }

                var stem = name["sheet-".Length..^extension.Length];
                if (stem.Length == PageHashHexLength)
                {
                    ids.Add(stem);
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // A store that cannot be listed just means nothing is known, which costs a re-encode and nothing else.
            return ids;
        }

        return ids;
    }

    /// <summary>
    /// The refusal-receipt file NAME for a geoclip key. The same hash the pose directory uses, so the two
    /// addresses move together, in a different folder and with a suffix the route's whitelist does not admit.
    /// </summary>
    public static string RefusalFileNameFor(string geoclipKey) => DirectoryNameFor(geoclipKey) + ".json";

    /// <summary>
    /// The COMPLETE pose directory for <paramref name="spineKey"/>, or null — no store, no directory, or no
    /// <see cref="CompleteMarkerName"/>. A directory missing the marker is a half-written bake and must never be
    /// served, so it is treated as absent.
    /// </summary>
    public string? TryResolveDirectory(string spineKey)
    {
        if (_root is null || string.IsNullOrWhiteSpace(spineKey))
        {
            return null;
        }

        var directory = Path.Combine(_root, DirectoryNameFor(BuildGeoclipKey(spineKey)));
        return File.Exists(Path.Combine(directory, CompleteMarkerName)) ? Path.GetFullPath(directory) : null;
    }

    /// <summary>
    /// The full path of one artifact for <paramref name="spineKey"/>, or null. Pose-local files
    /// (<c>manifest.json</c>, <c>verts.bin</c>) live in the pose directory; PAGES live in the shared
    /// <see cref="PagesFolderName"/> folder, so the lookup falls back there — see
    /// <see cref="CouchCoopGeoclipDirectory.TryResolveFileUnder"/>, which owns the traversal policy for both.
    /// </summary>
    public string? TryResolveFile(string spineKey, string fileName)
    {
        if (_root is null)
        {
            return null;
        }

        var directory = TryResolveDirectory(spineKey);
        return directory is null
            ? null
            : CouchCoopGeoclipDirectory.TryResolveFileUnder(_root, directory, fileName, sharedPagesFallback: true);
    }

    /// <summary>
    /// Whether <paramref name="path"/> is one of the shared, content-addressed page files — the ONE thing this
    /// store serves that may carry an immutable far-future <c>Cache-Control</c>, because its URL names its own
    /// bytes.
    /// </summary>
    public bool IsSharedPagePath(string? path)
    {
        if (_root is null || string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

        var pages = Path.GetFullPath(Path.Combine(_root, PagesFolderName));
        var parent = Path.GetDirectoryName(Path.GetFullPath(path));
        return parent is not null && string.Equals(parent, pages, StringComparison.Ordinal);
    }

    /// <summary>
    /// Whether a refusal receipt EXISTS for this identity — a presence probe with no read and no parse, for a
    /// caller that only wants to know whether this item is about to do any work (the sweep's per-item
    /// announcement). <see cref="TryReadRefusal"/> is the one that decides whether it is BINDING.
    /// </summary>
    public bool HasRefusal(string spineKey)
        => TryRefusalPath(spineKey) is { } path && File.Exists(path);

    /// <summary>
    /// The refusal recorded for this identity UNDER THE RUNNING REFUSAL POLICY, or null — no store, no receipt, an
    /// unreadable or malformed receipt, or one minted under another artifact selector or refusal-policy revision.
    /// </summary>
    /// <remarks>
    /// EVERY failure answers null, which means "bake it". That direction is chosen, not incidental: a negative
    /// cache that fails closed turns one bad byte into a creature that can never be produced again, while one
    /// that fails open costs a single re-bake. The artifact-selector comparison rejects copied or renamed receipts;
    /// the separate refusal-policy revision rejects legacy receipts and admission-rule changes without renaming
    /// complete poses.
    /// </remarks>
    public CouchCoopGeoclipRefusalRecord? TryReadRefusal(string spineKey)
    {
        if (TryRefusalPath(spineKey) is not { } path || !File.Exists(path))
        {
            return null;
        }

        try
        {
            var record = JsonSerializer.Deserialize<CouchCoopGeoclipRefusalRecord>(File.ReadAllBytes(path), RefusalJsonOptions);
            if (record is null
                || !string.Equals(record.Policy, GeoclipSelector, StringComparison.Ordinal)
                || !string.Equals(record.RefusalPolicyRevision, RefusalPolicyRevision, StringComparison.Ordinal))
            {
                return null;
            }

            return string.IsNullOrWhiteSpace(record.Reason) ? null : record;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Record that a bake of this identity RAN and was kept out of the store, so a later sweep skips it instead
    /// of paying for it again. Answers whether the receipt reached disk; a refusal that could not be written is
    /// still a refusal, it just costs the next sweep another bake.
    /// </summary>
    /// <param name="reason">
    /// The stable arm token — <c>incomplete</c> / <c>unassociated</c> / <c>ownership</c> / <c>foreign</c>.
    /// </param>
    /// <param name="detail">
    /// The guard's full text, counts and all. The reason buckets a sweep's table; the detail is what makes one
    /// row diagnosable months later without re-running the bake.
    /// </param>
    /// <param name="claimsProven">
    /// The ownership evidence the refused bake carried, kept so the receipt can answer the second and every later
    /// ask as fully as the first did. A cached refusal is served without baking, so anything not written here is
    /// gone — and "did the claims grade, or was there nothing to grade" is the difference between an old bridge
    /// and a weak rig. Zero for both is legal and means "no provenance recorded".
    /// </param>
    /// <param name="claimsUnproven">The other half of the same pair.</param>
    public async Task<bool> RecordRefusalAsync(
        string spineKey,
        string reason,
        string detail,
        int claimsProven = 0,
        int claimsUnproven = 0,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(spineKey);
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        if (TryRefusalPath(spineKey) is not { } path)
        {
            return false;
        }

        var payload = JsonSerializer.SerializeToUtf8Bytes(
            new CouchCoopGeoclipRefusalRecord(
                BuildGeoclipKey(spineKey), GeoclipSelector, RefusalPolicyRevision,
                reason, detail ?? string.Empty, DateTimeOffset.UtcNow,
                claimsProven, claimsUnproven), RefusalJsonOptions);
        using var reservation = _quota?.TryReserve(payload.LongLength);
        if (reservation is null) return false;
        try
        {
            await WriteAtomicAsync(
                path,
                payload,
                cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private string? TryRefusalPath(string spineKey)
        => _root is null || string.IsNullOrWhiteSpace(spineKey)
            ? null
            : Path.Combine(_root, RefusalsFolderName, RefusalFileNameFor(BuildGeoclipKey(spineKey)));

    /// <summary>
    /// A fresh, empty directory for a bake to write into, or null when the store is disabled or the filesystem
    /// refuses. Staging is under the store root (not the system temp dir) so the adopt below is a same-volume
    /// rename rather than a copy for the files that stay.
    /// </summary>
    public string? TryCreateStagingDirectory(int entryCount = 1)
    {
        if (_root is null)
        {
            return null;
        }

        // The baker's completed staging tree and adoption's atomic temp copies coexist until publish finishes.
        // Reserve both copies up front; the producer separately caps each generated entry at EntryLimitBytes.
        var reserveBytes = checked(_quota!.EntryLimitBytes * 2 * Math.Max(1, entryCount));
        var reservation = _quota.TryReserve(reserveBytes, enforceEntryLimit: false);
        if (reservation is null) return null;
        try
        {
            var staging = Path.Combine(_root, StagingFolderName, Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(staging);
            _stagingReservations[Path.GetFullPath(staging)] = reservation;
            return staging;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            reservation.Dispose();
            return null;
        }
    }

    public void ReleaseStagingDirectory(string? staging)
    {
        TryDeleteStagingDirectory(staging);
        if (!string.IsNullOrWhiteSpace(staging)
            && _stagingReservations.TryRemove(Path.GetFullPath(staging), out var reservation))
        {
            reservation.Dispose();
        }
    }

    /// <summary>Best-effort removal of a staging directory. A leftover is inert — it is never served.</summary>
    public static void TryDeleteStagingDirectory(string? staging)
    {
        if (string.IsNullOrWhiteSpace(staging))
        {
            return;
        }

        try
        {
            Directory.Delete(staging, recursive: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Inert: nothing under staging/ is resolvable, so a leftover costs disk and nothing else.
        }
    }

    /// <summary>
    /// Take a directory a bake just wrote and publish it into the store: every page adopted into the shared
    /// content-addressed folder, the manifest's <c>pages[].file</c> rewritten to the hashed names, then
    /// <see cref="CompleteMarkerName"/> written LAST. Idempotent — re-adopting the same bake overwrites the same
    /// bytes and re-writes the marker.
    /// </summary>
    public async Task<CouchCoopGeoclipAdoptResult> AdoptAsync(
        string spineKey,
        string bakedDirectory,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(spineKey);
        ArgumentException.ThrowIfNullOrWhiteSpace(bakedDirectory);
        if (_root is null)
        {
            return CouchCoopGeoclipAdoptResult.Failure("geoclip-store-disabled", "No geoclip cache root is available.");
        }

        var generatedBytes = MeasureDirectoryBytes(bakedDirectory);
        if (generatedBytes > _quota!.EntryLimitBytes)
        {
            return CouchCoopGeoclipAdoptResult.Failure("geoclip-entry-too-large", "The generated geoclip exceeds the managed-cache entry limit.");
        }
        ManagedCacheQuota.Reservation? adoptionReservation = null;
        var bakedFull = Path.GetFullPath(bakedDirectory);
        var coveredByStaging = _stagingReservations.Keys.Any(staging =>
            bakedFull.Equals(staging, StringComparison.Ordinal)
            || bakedFull.StartsWith(staging + Path.DirectorySeparatorChar, StringComparison.Ordinal));
        if (!coveredByStaging && (adoptionReservation = _quota.TryReserve(generatedBytes)) is null)
        {
            return CouchCoopGeoclipAdoptResult.Failure("geoclip-storage-unavailable", "Managed-cache storage is unavailable.");
        }
        try
        {
            return await AdoptCoreAsync(spineKey, bakedDirectory, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return CouchCoopGeoclipAdoptResult.Failure(
                "geoclip-adopt-failed",
                $"{exception.GetType().Name}: {exception.Message}");
        }
        finally
        {
            adoptionReservation?.Dispose();
        }
    }

    private static long MeasureDirectoryBytes(string directory)
    {
        long total = 0;
        foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
            total = checked(total + new FileInfo(file).Length);
        return total;
    }

    private async Task<CouchCoopGeoclipAdoptResult> AdoptCoreAsync(
        string spineKey,
        string bakedDirectory,
        CancellationToken cancellationToken)
    {
        var manifestSource = Path.Combine(bakedDirectory, ManifestFileName);
        if (!File.Exists(manifestSource))
        {
            return CouchCoopGeoclipAdoptResult.Failure(
                "geoclip-manifest-missing",
                $"The bake produced no {ManifestFileName} in '{bakedDirectory}'.");
        }

        var document = JsonNode.Parse(await File.ReadAllBytesAsync(manifestSource, cancellationToken).ConfigureAwait(false));
        if (document is not JsonObject manifest)
        {
            return CouchCoopGeoclipAdoptResult.Failure("geoclip-manifest-invalid", "The manifest is not a JSON object.");
        }

        // PAGES FIRST, and into the SHARED folder — a page is valid on its own (its name is its hash), so
        // publishing it before the pose directory can only ever leave an unreferenced page behind, never a
        // manifest pointing at a file that is not there yet.
        var adoptedPages = new List<string>();
        if (manifest["pages"] is JsonArray pages)
        {
            foreach (var entry in pages)
            {
                if (entry is not JsonObject page || page["file"]?.GetValue<string>() is not { } sourceName)
                {
                    continue;
                }

                var adopted = await AdoptPageAsync(
                        bakedDirectory,
                        sourceName,
                        page["sha256"]?.GetValue<string>(),
                        cancellationToken)
                    .ConfigureAwait(false);
                if (adopted is null)
                {
                    return CouchCoopGeoclipAdoptResult.Failure(
                        "geoclip-page-missing",
                        $"The manifest references page '{sourceName}'"
                        + (page["sha256"]?.GetValue<string>() is { } sha
                            ? $" (sha256 {sha}), which the bake did not write and which is not in {PagesFolderName}/."
                            : ", which the bake did not write."));
                }

                page["file"] = adopted;
                adoptedPages.Add(adopted);
            }
        }

        var vertsSource = Path.Combine(bakedDirectory, VertsFileName);
        if (!File.Exists(vertsSource))
        {
            return CouchCoopGeoclipAdoptResult.Failure(
                "geoclip-verts-missing",
                $"The bake produced no packed {VertsFileName} in '{bakedDirectory}'.");
        }

        var directory = Path.Combine(_root!, DirectoryNameFor(BuildGeoclipKey(spineKey)));
        Directory.CreateDirectory(directory);

        // Clear any marker from an earlier adopt BEFORE rewriting the files it describes, so a crash midway
        // through leaves the directory unresolvable rather than resolvable-and-inconsistent.
        TryDeleteFile(Path.Combine(directory, CompleteMarkerName));

        await WriteAtomicAsync(
            Path.Combine(directory, ManifestFileName),
            JsonSerializer.SerializeToUtf8Bytes(manifest),
            cancellationToken).ConfigureAwait(false);

        await WriteAtomicAsync(
            Path.Combine(directory, VertsFileName),
            await File.ReadAllBytesAsync(vertsSource, cancellationToken).ConfigureAwait(false),
            cancellationToken).ConfigureAwait(false);

        // LAST. Everything above is invisible until this lands.
        await WriteAtomicAsync(
            Path.Combine(directory, CompleteMarkerName),
            JsonSerializer.SerializeToUtf8Bytes(new CouchCoopGeoclipCompleteMarker(
                BuildGeoclipKey(spineKey),
                adoptedPages,
                DateTimeOffset.UtcNow)),
            cancellationToken).ConfigureAwait(false);

        // The two markers are contradictory verdicts on one identity, so the positive one retires the negative:
        // whatever an earlier bake decided, this identity is now IN the store. Nothing reads a refusal for a key
        // that resolves (the store probe comes first), so this is hygiene rather than correctness — but a cache a
        // human can read and believe is worth one delete.
        TryDeleteFile(Path.Combine(_root!, RefusalsFolderName, RefusalFileNameFor(BuildGeoclipKey(spineKey))));

        return CouchCoopGeoclipAdoptResult.Ok(Path.GetFullPath(directory), adoptedPages);
    }

    /// <summary>
    /// Copy one baked page into the shared folder under its content hash, or answer null when the bake did not
    /// write it. A page whose hash is already present is NOT rewritten — that skip is the dedupe, and it is what
    /// makes a rig's second pose geometry-only.
    /// </summary>
    /// <param name="contentId">
    /// The producer's own <c>pages[].sha256</c>, when it emitted one. A bake that was TOLD this store already
    /// holds a page (see <see cref="KnownPageContentIds"/>) describes it without writing the image, so the only
    /// way to adopt it is by name — and the name is only accepted when the file it points at is genuinely
    /// present, so a stale or invented id fails the adopt rather than publishing a manifest that references
    /// nothing. See <see cref="TryResolveHeldPage"/>: the declared container must match.
    /// </param>
    private async Task<string?> AdoptPageAsync(
        string bakedDirectory,
        string sourceName,
        string? contentId,
        CancellationToken cancellationToken)
    {
        // The manifest is machine-written, but it is still an input: constrain the name to one safe segment
        // before combining it with a directory, using the route's own page whitelist (which is narrower than
        // IsAllowedFileName — a `pages[].file` naming manifest.json is a malformed bake, not a page). The same
        // lookup hands back the CONTAINER the bake says this page is, which is what the adopted name keeps: the
        // store renames a page (positional → content-addressed) but never re-containers it.
        if (StagingImageExtensionOf(sourceName) is not { } extension)
        {
            return null;
        }

        var source = Path.GetFullPath(Path.Combine(bakedDirectory, sourceName));
        if (!File.Exists(source))
        {
            // NOT WRITTEN, and that can be correct: the bake was handed this store's page ids and skipped the
            // ones it already had. Resolve by the declared content id, and only when the bytes are actually
            // there — the id names a file, it does not conjure one.
            return TryResolveHeldPage(contentId, extension);
        }

        var bytes = await File.ReadAllBytesAsync(source, cancellationToken).ConfigureAwait(false);
        var name = PageFileNameFor(bytes, extension);
        var pages = Path.Combine(_root!, PagesFolderName);
        Directory.CreateDirectory(pages);

        var target = Path.Combine(pages, name);
        if (!File.Exists(target))
        {
            await WriteAtomicAsync(target, bytes, cancellationToken).ConfigureAwait(false);
        }

        return name;
    }

    // Raw `page-*` names are an upstream bake input only. The store repacks their bytes under a `sheet-*`
    // content address before publishing, so no CouchCoop route or cache lookup can ever expose the raw shape.
    private static string? StagingImageExtensionOf(string? fileName)
    {
        if (CouchCoopGeoclipDirectory.PageExtensionOf(fileName) is { } packed)
        {
            return packed;
        }

        if (string.IsNullOrEmpty(fileName) || !fileName.StartsWith("page-", StringComparison.Ordinal))
        {
            return null;
        }

        foreach (var extension in CouchCoopGeoclipDirectory.PageExtensions)
        {
            if (!fileName.EndsWith(extension, StringComparison.Ordinal))
            {
                continue;
            }

            var stem = fileName["page-".Length..^extension.Length];
            return stem.Length is > 0 and <= 64 && stem.All(char.IsAsciiHexDigit) ? extension : null;
        }

        return null;
    }

    /// <summary>
    /// The shared page this store already holds for a producer-declared content id, or null when it holds none.
    /// </summary>
    /// <remarks>The declared container is part of the current packed-page contract.</remarks>
    private string? TryResolveHeldPage(string? contentId, string declaredExtension)
    {
        if (_root is null)
        {
            return null;
        }

        var pages = Path.Combine(_root, PagesFolderName);
        if (PageFileNameForContentId(contentId, declaredExtension) is { } name
            && File.Exists(Path.Combine(pages, name)))
        {
            return name;
        }
        return null;
    }

    /// <summary>
    /// Temp-then-move, per file: a reader either sees the previous bytes or the new ones, never a prefix. The
    /// temp name is per-write so two concurrent adopts of the same page cannot truncate each other's staging
    /// file (the move itself is the atomic step, and both moves carry identical bytes).
    /// </summary>
    private static async Task WriteAtomicAsync(string path, byte[] bytes, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
        try
        {
            await File.WriteAllBytesAsync(temp, bytes, cancellationToken).ConfigureAwait(false);
            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            TryDeleteFile(temp);
            throw;
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Best effort.
        }
    }
}

/// <param name="Directory">The published pose directory, or null on failure.</param>
/// <param name="PageFiles">The content-addressed page names the manifest now references.</param>
public sealed record CouchCoopGeoclipAdoptResult(
    bool Success,
    string? Directory,
    IReadOnlyList<string> PageFiles,
    string? ErrorCode,
    string? ErrorMessage)
{
    public static CouchCoopGeoclipAdoptResult Ok(string directory, IReadOnlyList<string> pageFiles)
        => new(true, directory, pageFiles, null, null);

    public static CouchCoopGeoclipAdoptResult Failure(string code, string message)
        => new(false, null, [], code, message);
}

/// <summary>
/// The body of the <c>.complete</c> marker. Its PRESENCE is the whole contract; the contents are a receipt for a
/// human reading the cache (which key this hashed directory holds, which shared pages it depends on, when).
/// </summary>
internal sealed record CouchCoopGeoclipCompleteMarker(
    string Key,
    IReadOnlyList<string> Pages,
    DateTimeOffset CompletedUtc);

/// <summary>
/// The body of a refusal receipt: a bake of <paramref name="Key"/> RAN and was kept out of the store.
/// </summary>
/// <param name="Key">
/// The full geoclip key, <c>gv</c> tail included — so the identity a hashed file name stands for is legible
/// without reversing a hash.
/// </param>
/// <param name="Policy">
/// The geoclip selector this verdict's artifact identity belongs to (<see cref="CouchCoopGeoclipStore.GeoclipSelector"/>
/// as it was when the bake was refused). A receipt from another selector is IGNORED, not obeyed — see
/// <see cref="CouchCoopGeoclipStore.TryReadRefusal"/>.
/// </param>
/// <param name="RefusalPolicyRevision">
/// The separate admission-rule revision (<see cref="CouchCoopGeoclipStore.RefusalPolicyRevision"/>). Missing or
/// stale revisions are ignored so a newer baker retries them without changing the address of completed artifacts.
/// </param>
/// <param name="Reason">
/// The stable arm token a sweep buckets by: <c>incomplete</c>/<c>unassociated</c>/<c>ownership</c>/<c>foreign</c>.
/// </param>
/// <param name="Detail">The guard's full text with its counts, which is what makes the row diagnosable later.</param>
/// <param name="ClaimsProven">
/// How many of the refused bake's slot→mesh claims carried a positive ownership proof. OPTIONAL with a zero
/// default, which is what lets a receipt written before this field existed still deserialize — though in practice
/// none does, because the revision above moved in the same commit that added the field.
/// </param>
/// <param name="ClaimsUnproven">The other half of the same pair; both zero means no provenance was recorded.</param>
public sealed record CouchCoopGeoclipRefusalRecord(
    string Key,
    string Policy,
    string RefusalPolicyRevision,
    string Reason,
    string Detail,
    DateTimeOffset RefusedUtc,
    int ClaimsProven = 0,
    int ClaimsUnproven = 0);
