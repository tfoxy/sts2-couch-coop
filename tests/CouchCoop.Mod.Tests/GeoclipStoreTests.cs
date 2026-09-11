using System.Text.Json;
using System.Text.Json.Nodes;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.Artifacts;

/// <summary>
/// The MANAGED geoclip cache (<see cref="CouchCoopGeoclipStore"/>) and its producer
/// (<see cref="CouchCoopGeoclipProvider"/>): the on-disk layout, the <c>.complete</c> gate, page sharing by
/// content hash, the key's <c>gv</c> discriminator, single-flight, and the load-bearing UNARMED case.
/// </summary>
/// <remarks>
/// Production always serves the current geoclip representation; the load-bearing cases cover its cache and
/// corruption-recovery contracts.
/// </remarks>
internal static class GeoclipStoreTests
{
    public static async Task RunAsync()
    {
        TheKeyIsTheSpineKeyPlusAnOpaquePolicyTail();
        await TheStoreLayoutIsPagesPlusHashedPoseDirectoriesAsync();
        await AHalfWrittenDirectoryIsNeverServedAsync();
        await TwoPosesSharingAPageStoreOneCopyAsync();
        await AFailedAdoptLeavesNothingResolvableAsync();
        await ArmedTheProviderBakesOnceForConcurrentAskersAsync();
        await ASecondRequestIsAStoreHitWithNoBakeAsync();
        await AnIncompleteBakeIsRefusedEntryToTheStoreAsync();
        await AProvenBakeWithLeftoversIsAdmittedAndCarriesItsEvidenceAsync();
        await ANestedBakeIsAdoptedAndAnEscapingManifestIsRefusedAsync();
        await ARefusalIsRememberedAndIsNeverServedAsync();
        await ARetryableAcquisitionShortfallIsNeverWrittenDownAsync();
        await ANonRetryableRefusalIsStillWrittenDownAsync();
        await TheRigLaneDerivesRetryabilityPerPoseAsync();
        await AStickyRuleReceiptFailsOpenAfterTheRevisionBumpAsync();
        await APreFixHeadlessReceiptFailsOpenAfterTheRevisionBumpAsync();
        await AMatchingRefusalPolicyRevisionSuppressesRebakeAsync();
        await AForeignRefusalPolicyReceiptRetriesAsync();
        await ARefusalPolicyRevisionLeavesCompleteArtifactsAddressableAsync();
        await AForeignArtifactSelectorReceiptRetriesAsync();
        await AGoodBakeRetiresAnEarlierRefusalAsync();
        PageNamesAgreeWhicheverSideComputedThem();
        await KnownPageContentIdsAreWhatTheStoreActuallyHoldsAsync();
        await APageTheBakeWasToldWeHoldIsAdoptedByNameAsync();
        await AWebpPageIsSharedAcrossPosesOnlyInItsDeclaredContainerAsync();
        await APageThatIsNeitherWrittenNorHeldFailsTheAdoptAsync();

        Console.WriteLine("geoclip store: ok");
    }

    // ── Page identity: naming a page WITHOUT its bytes ────────────────────────────────────────────────────

    // The two must land on ONE name. The producer declares `pages[].sha256` so a page it was told this host holds
    // can be adopted without ever being written; if that name differed by a character from the one hashing the
    // bytes produces, the store would quietly hold two copies of one atlas and the page sharing this whole design
    // rests on would be off — with nothing failing.
    private static void PageNamesAgreeWhicheverSideComputedThem()
    {
        var bytes = PagePixels(77);
        var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();

        Expect(CouchCoopGeoclipStore.PageFileNameFor(bytes, ".png") == CouchCoopGeoclipStore.PageFileNameForContentId(digest, ".png"),
            "a page named from its BYTES and the same page named from the producer's declared sha256 are one file");
        Expect(CouchCoopGeoclipStore.PageFileNameForContentId(digest.ToUpperInvariant(), ".png")
            == CouchCoopGeoclipStore.PageFileNameFor(bytes, ".png"),
            "…and the id is case-normalised, so a producer's spelling cannot fork the name");

        // A short or malformed id must MISS, never alias: it is an input from another assembly, and a truncated
        // one would name a prefix of somebody else's page.
        Expect(CouchCoopGeoclipStore.PageFileNameForContentId(null, ".png") is null, "a missing id names nothing");
        Expect(CouchCoopGeoclipStore.PageFileNameForContentId("abc", ".png") is null, "…and neither does a short one");
        Expect(CouchCoopGeoclipStore.PageFileNameForContentId("zzzzzzzzzzzzzzzz", ".png") is null, "…nor a non-hex one");
        Expect(CouchCoopGeoclipStore.PageFileNameForContentId(digest[..16], ".png") == CouchCoopGeoclipStore.PageFileNameFor(bytes, ".png"),
            "an id exactly as long as the name keeps is enough — that is the length this store publishes");

        // THE CONTAINER RIDES ALONGSIDE THE ID, and only a container the route will actually serve names a file.
        // A store that minted `sheet-<hex>.anything` would be writing artifacts its own whitelist then refuses.
        Expect(CouchCoopGeoclipStore.PageFileNameFor(bytes, ".webp") == CouchCoopGeoclipStore.PageFileNameForContentId(digest, ".webp"),
            "the two sides agree for a webp page too");
        Expect(CouchCoopGeoclipStore.PageFileNameFor(bytes, ".webp") != CouchCoopGeoclipStore.PageFileNameFor(bytes, ".png"),
            "…and the two containers are two distinct names — a page is never re-containered in place");
        Expect(CouchCoopGeoclipDirectory.IsPageFileName(CouchCoopGeoclipStore.PageFileNameFor(bytes, ".webp")),
            "every name this store mints is one the route serves");
        Expect(CouchCoopGeoclipStore.PageFileNameForContentId(digest, ".jpg") is null,
            "an undeclared container names nothing — the extension is checked, not pasted on");
        Expect(CouchCoopGeoclipStore.PageFileNameForContentId(digest, "png") is null, "…and the dot is part of it");
        Expect(CouchCoopGeoclipStore.PageFileNameForContentId(digest, ".PNG") is null, "…spelled exactly as the whitelist spells it");
    }

    // What a bake is TOLD this host holds. It has to be what is on disk and nothing else: an id here that is not
    // a real file makes the bake skip a page the adopt then cannot resolve, and the whole bake is thrown away.
    private static async Task KnownPageContentIdsAreWhatTheStoreActuallyHoldsAsync()
    {
        using var scope = new StoreScope();
        Expect(scope.Store.KnownPageContentIds().Count == 0, "a store with no pages folder holds nothing");

        var adopted = await scope.Store.AdoptAsync(Key("known.tscn", "idle_loop"), scope.WriteBake("page-0.png", PagePixels(21)));
        Expect(adopted.Success, "the bake adopts");

        var ids = scope.Store.KnownPageContentIds();
        var name = CouchCoopGeoclipStore.PageFileNameFor(PagePixels(21), ".png");
        Expect(ids.Count == 1, $"one adopted page ⇒ one known id (got {ids.Count})");
        Expect(ids.Single() == name["sheet-".Length..^".png".Length],
            "…and it is the stem of the file's own name, which is what the producer matches its sha256 against");
        Expect(CouchCoopGeoclipStore.PageFileNameForContentId(ids.Single(), ".png") == name,
            "…so it round-trips back to the file it came from");

        // Anything that is not one of this store's own page names is not an id. A stray file must not be
        // announced as a page the bake may skip.
        await File.WriteAllTextAsync(Path.Combine(scope.Store.PagesPath!, "sheet-nothex.png"), "junk");
        await File.WriteAllTextAsync(Path.Combine(scope.Store.PagesPath!, "notes.txt"), "junk");
        Expect(scope.Store.KnownPageContentIds().Count == 1, "a stray file in pages/ is not a known page id");

        // THE ENUMERATOR AND THE MINTER MUST AGREE ON EVERY CONTAINER, which is the exact thing that breaks
        // silently once a sheet can be a webp: adopt writes `sheet-<id>.webp`, an enumerator spelled `sheet-*.png`
        // never sees it, the id is never announced, and every later pose of that rig re-reads, re-writes and
        // re-transfers a page this store is already holding — with nothing failing anywhere. It is a pure
        // performance regression, so only a test can catch it.
        var webpAdopt = await scope.Store.AdoptAsync(Key("known.tscn", "attack"), scope.WriteBake("page-0.webp", PagePixels(22)));
        Expect(webpAdopt.Success, "a webp page adopts");
        var webpName = CouchCoopGeoclipStore.PageFileNameFor(PagePixels(22), ".webp");
        Expect(webpAdopt.PageFiles.Single() == webpName, "…under its content hash, keeping the container");

        var mixed = scope.Store.KnownPageContentIds();
        Expect(mixed.Count == 2, $"a MIXED store announces both containers' ids (got {mixed.Count})");
        Expect(mixed.Contains(webpName["sheet-".Length..^".webp".Length]),
            "…including the webp page's, or the bake re-encodes a page we are already holding, for ever");
        Expect(mixed.Contains(ids.Single()), "…and the png page's is not lost to the widening");

        // An id is EXTENSION-FREE by construction: it is the prefix of a sha256, and the producer matches it
        // against the hash of bytes it holds, which knows nothing about file names.
        Expect(mixed.All(id => id.Length == 16 && id.All(char.IsAsciiHexDigit)),
            "an announced id is bare hex — no extension leaks into the contract the producer matches against");

        // A half-written sheet (`sheet-<id>.png.<8hex>.tmp`, the temp-then-move staging name) is caught by the
        // family glob but must never be announced: a bake told to skip it would reference bytes that vanish.
        await File.WriteAllTextAsync(Path.Combine(scope.Store.PagesPath!, "sheet-0123456789abcdef.png.a1b2c3d4.tmp"), "half");
        Expect(scope.Store.KnownPageContentIds().Count == 2, "a temp-then-move staging file is not a known page id");
    }

    // THE SKIP ITSELF. A bake handed this store's page ids describes those pages and does not write the PNG —
    // which is the whole saving — so the adopt has to resolve them by name.
    private static async Task APageTheBakeWasToldWeHoldIsAdoptedByNameAsync()
    {
        using var scope = new StoreScope();
        var page = PagePixels(33);
        var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(page)).ToLowerInvariant();

        var first = await scope.Store.AdoptAsync(Key("rig.tscn", "idle_loop"), scope.WriteBake("page-0.png", page));
        Expect(first.Success, "the first pose adopts and publishes the page");

        // The second pose: manifest describes the page, no PNG beside it.
        var second = await scope.Store.AdoptAsync(
            Key("rig.tscn", "attack"),
            scope.WriteBake("page-0.png", page, pageSha256: digest, writePage: false));

        Expect(second.Success, "a pose whose page was skipped still adopts");
        Expect(second.PageFiles.Single() == first.PageFiles.Single(),
            "…referencing the SAME shared file the first pose published");
        Expect(Directory.GetFiles(scope.Store.PagesPath!, "*.png").Length == 1,
            "…and no second copy appears on disk");

        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(second.Directory!, "manifest.json")))!;
        Expect(manifest["pages"]![0]!["file"]!.GetValue<string>() == first.PageFiles.Single(),
            "…and the manifest the CLIENT reads points at it, so the route resolves without knowing any of this");
    }

    // THE SKIP, FOR A WEBP PAGE — and then for a store that holds the id under the OTHER container.
    private static async Task AWebpPageIsSharedAcrossPosesOnlyInItsDeclaredContainerAsync()
    {
        using var scope = new StoreScope();
        var page = PagePixels(55);
        var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(page)).ToLowerInvariant();

        var first = await scope.Store.AdoptAsync(Key("webprig.tscn", "idle_loop"), scope.WriteBake("page-0.webp", page));
        Expect(first.Success && first.PageFiles.Single().EndsWith(".webp", StringComparison.Ordinal),
            $"a webp page publishes as a webp file (got {first.PageFiles.SingleOrDefault() ?? "nothing"})");
        Expect(File.Exists(Path.Combine(scope.Store.PagesPath!, first.PageFiles.Single())),
            "…and the bytes are actually there under that name");

        var second = await scope.Store.AdoptAsync(
            Key("webprig.tscn", "attack"),
            scope.WriteBake("page-0.webp", page, pageSha256: digest, writePage: false));
        Expect(second.Success && second.PageFiles.Single() == first.PageFiles.Single(),
            "a second pose that was told we hold the page resolves it by id, in the container it declared");
        Expect(Directory.GetFiles(scope.Store.PagesPath!, "sheet-*").Length == 1, "…with no second copy on disk");

        // The packed-page container is part of the current contract. A same-id page held under another extension
        // is not silently reused: the producer must declare and publish the same container for every pose.
        using var crossed = new StoreScope();
        var underPng = await crossed.Store.AdoptAsync(Key("crossed.tscn", "idle_loop"), crossed.WriteBake("page-0.png", page));
        Expect(underPng.Success && underPng.PageFiles.Single().EndsWith(".png", StringComparison.Ordinal),
            "the store holds the bytes under the declared PNG container");

        var declaredWebp = await crossed.Store.AdoptAsync(
            Key("crossed.tscn", "attack"),
            crossed.WriteBake("page-0.webp", page, pageSha256: digest, writePage: false));
        Expect(!declaredWebp.Success,
            "a page declared as WebP is not resolved through an old PNG container");
        Expect(Directory.GetFiles(crossed.Store.PagesPath!, "sheet-*").Length == 1,
            "…and it is still ONE copy of one atlas, which is the whole point of content addressing");
    }

    // The other direction, which is the one that must not be lenient: a page that was not written and is not here
    // is a bake that cannot be published. Resolving it on the strength of the id alone would publish a manifest
    // referencing a file that does not exist, and the route would 404 every request for a pose the store says is
    // complete.
    private static async Task APageThatIsNeitherWrittenNorHeldFailsTheAdoptAsync()
    {
        using var scope = new StoreScope();
        var absent = PagePixels(44);
        var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(absent)).ToLowerInvariant();

        var declared = await scope.Store.AdoptAsync(
            Key("rig.tscn", "idle_loop"),
            scope.WriteBake("page-0.png", absent, pageSha256: digest, writePage: false));
        Expect(!declared.Success && declared.ErrorCode == "geoclip-page-missing",
            $"a declared page that is nowhere on disk fails the adopt (got {declared.ErrorCode ?? "success"})");
        Expect(declared.ErrorMessage!.Contains(digest, StringComparison.Ordinal),
            "…and the failure names the id, so the mismatch is diagnosable without re-running the bake");

        var undeclared = await scope.Store.AdoptAsync(
            Key("rig.tscn", "attack"),
            scope.WriteBake("page-0.png", absent, writePage: false));
        Expect(!undeclared.Success && undeclared.ErrorCode == "geoclip-page-missing",
            "…and so does a missing page with no id at all, exactly as before");

        Expect(scope.Store.TryResolveDirectory(Key("rig.tscn", "idle_loop")) is null,
            "neither leaves anything resolvable behind");

        // AND A CONTAINER THE ROUTE WOULD NOT SERVE. The bytes are right there beside the manifest, so only the
        // name refuses it — which it must, or the store publishes a pose whose page is a permanent 404.
        var wrongContainer = await scope.Store.AdoptAsync(Key("rig.tscn", "flee"), scope.WriteBake("page-0.jpg", PagePixels(45)));
        Expect(!wrongContainer.Success && wrongContainer.ErrorCode == "geoclip-page-missing",
            $"a page in an undeclared container fails the adopt (got {wrongContainer.ErrorCode ?? "success"})");
        Expect(!Directory.Exists(scope.Store.PagesPath!)
                || Directory.GetFiles(scope.Store.PagesPath!).All(f => !Path.GetFileName(f).Contains(".jpg", StringComparison.Ordinal)),
            "…and nothing of it reaches the shared pages folder");
    }

    // ── The key ────────────────────────────────────────────────────────────────────────────────────────────

    // `gv` is an OPAQUE policy-version discriminator, exactly like the still lane's `sf`: bumping it must
    // invalidate DELTAS ALONE. That property is structural — the tail rides AFTER BuildSpineKey's fixed selector
    // order, so the raster clip key for the same identity is a byte-identical PREFIX and cannot move.
    private static void TheKeyIsTheSpineKeyPlusAnOpaquePolicyTail()
    {
        var spineKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/creature.tscn", "Visuals/Spine", "idle_loop");
        var geoclipKey = CouchCoopGeoclipStore.BuildGeoclipKey(spineKey);

        Expect(geoclipKey.StartsWith(spineKey, StringComparison.Ordinal),
            "the geoclip key is the canonical spine key plus a tail — the raster clip's key is an untouched prefix, "
            + "so a gv bump cannot invalidate a single cached clip or still");
        Expect(geoclipKey == spineKey + "&geo=1&gv=1", "the geoclip tail is exactly &geo=1&gv=1");
        Expect(geoclipKey.EndsWith(CouchCoopGeoclipStore.GeoclipSelector, StringComparison.Ordinal),
            "the selector constant is what the builder appends (one spelling, not two)");

        // The discriminator has to actually discriminate: a different gv addresses a different directory.
        var atGv1 = CouchCoopGeoclipStore.DirectoryNameFor(geoclipKey);
        var atGv2 = CouchCoopGeoclipStore.DirectoryNameFor(spineKey + "&geo=1&gv=2");
        Expect(atGv1 != atGv2, "bumping gv addresses a different pose directory (that is what makes it a cache version)");
        Expect(atGv1 != CouchCoopGeoclipStore.DirectoryNameFor(spineKey),
            "a geoclip never shares a directory name with the bare clip identity");
        Expect(atGv1.Length == 64 && atGv1.All(char.IsAsciiHexDigit) && atGv1 == atGv1.ToLowerInvariant(),
            "a pose directory is named by the full lowercase sha256 of its geoclip key");
        Expect(CouchCoopGeoclipStore.DirectoryNameFor(geoclipKey) == atGv1, "the directory name is a pure function of the key");

        // The identity the key folds in is (scene, node, anim) — two anims of one rig are two geoclips.
        var otherAnim = CouchCoopGeoclipStore.BuildGeoclipKey(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/creature.tscn", "Visuals/Spine", "attack"));
        Expect(CouchCoopGeoclipStore.DirectoryNameFor(otherAnim) != atGv1, "a second animation is a second pose directory");
    }

    // ── Layout ─────────────────────────────────────────────────────────────────────────────────────────────

    private static async Task TheStoreLayoutIsPagesPlusHashedPoseDirectoriesAsync()
    {
        using var scope = new StoreScope();
        var spineKey = Key("layout.tscn", "idle_loop");
        var baked = scope.WriteBake("page-0.png", PagePixels(1), verts: [7, 7, 7]);

        var adopted = await scope.Store.AdoptAsync(spineKey, baked);
        Expect(adopted.Success, "a well-formed bake adopts");

        var root = scope.Store.RootPath!;
        Expect(Path.GetFileName(root) == CouchCoopGeoclipStore.SchemaVersion,
            "the store hangs its own schema-version folder off the asset cache root, like the asset cache does");

        var directory = scope.Store.TryResolveDirectory(spineKey);
        Expect(directory == adopted.Directory, "the adopted directory is the one the store resolves");
        Expect(
            Path.GetFileName(directory!) == CouchCoopGeoclipStore.DirectoryNameFor(CouchCoopGeoclipStore.BuildGeoclipKey(spineKey)),
            "the pose directory is named by sha256(geoclipKey)");

        // Pose-local artifacts stay in the pose directory; PAGES do not.
        Expect(File.Exists(Path.Combine(directory!, "manifest.json")), "the manifest lands in the pose directory");
        Expect(File.Exists(Path.Combine(directory!, "verts.bin")), "verts.bin lands beside it when the bake wrote one");
        Expect(File.Exists(Path.Combine(directory!, CouchCoopGeoclipStore.CompleteMarkerName)), "the .complete marker is written");
        Expect(!File.Exists(Path.Combine(directory!, "page-0.png")), "the baker's positional page name does not survive adoption");

        var pageName = adopted.PageFiles.Single();
        Expect(pageName.StartsWith("sheet-", StringComparison.Ordinal) && pageName.EndsWith(".png", StringComparison.Ordinal),
            $"an adopted page is published in the packed sheet family ({pageName})");
        Expect(CouchCoopGeoclipDirectory.IsAllowedFileName(pageName),
            "an adopted page name is servable by the route's whitelist — the hex widening exists for exactly this");
        Expect(File.Exists(Path.Combine(scope.Store.PagesPath!, pageName)), "the page lands in the SHARED pages folder");
        Expect(pageName == CouchCoopGeoclipStore.PageFileNameFor(PagePixels(1), ".png"),
            "the page's name is the hash of its own bytes (content-addressed, not positional)");

        // The manifest is rewritten to point at the hashed name, which is how the client finds it without
        // knowing the rule.
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(directory!, "manifest.json")))!;
        Expect(manifest["pages"]![0]!["file"]!.GetValue<string>() == pageName,
            "the manifest's pages[].file is rewritten to the content-addressed name");
        Expect(manifest["pages"]![0]!["width"]!.GetValue<int>() == 4, "the rest of the page entry survives the rewrite");
        Expect(manifest["meta"]!["schema"]!.GetValue<string>() == "geoclip/1", "the rest of the manifest survives the rewrite");

        // Temp-then-move leaves nothing behind.
        Expect(
            !Directory.EnumerateFiles(root, "*.tmp", SearchOption.AllDirectories).Any(),
            "no temp file survives an adopt (every write is temp-then-move)");

        // Resolution, both artifact families, through the route's own traversal policy.
        Expect(scope.Store.TryResolveFile(spineKey, "manifest.json") == Path.Combine(directory!, "manifest.json"),
            "the manifest resolves from the pose directory");
        Expect(scope.Store.TryResolveFile(spineKey, "verts.bin") == Path.Combine(directory!, "verts.bin"),
            "verts.bin resolves from the pose directory");
        Expect(scope.Store.TryResolveFile(spineKey, pageName) == Path.Combine(scope.Store.PagesPath!, pageName),
            "a page resolves through the SHARED pages fallback, since it is not in the pose directory");
        Expect(scope.Store.IsSharedPagePath(scope.Store.TryResolveFile(spineKey, pageName)),
            "a shared page is recognised as content-addressed (this is what earns it an immutable Cache-Control)");
        Expect(!scope.Store.IsSharedPagePath(scope.Store.TryResolveFile(spineKey, "manifest.json")),
            "a pose manifest is NOT content-addressed and must not be cached immutably");
        Expect(scope.Store.TryResolveFile(spineKey, "sheet-ffffffffffffffff.png") is null,
            "a sheet nothing baked resolves nothing, even though the name is well-formed");
        Expect(scope.Store.TryResolveFile(spineKey, "../manifest.json") is null, "a traversing name is refused");
        Expect(scope.Store.TryResolveFile(spineKey, CouchCoopGeoclipStore.CompleteMarkerName) is null,
            "the completion marker is not itself servable");
        Expect(scope.Store.TryResolveFile(Key("layout.tscn", "never_baked"), "manifest.json") is null,
            "an unbaked identity resolves nothing");
    }

    // ── The marker is the gate ─────────────────────────────────────────────────────────────────────────────

    private static async Task AHalfWrittenDirectoryIsNeverServedAsync()
    {
        using var scope = new StoreScope();
        var spineKey = Key("halfwritten.tscn", "idle_loop");
        var adopted = await scope.Store.AdoptAsync(spineKey, scope.WriteBake("page-0.png", PagePixels(2)));
        Expect(adopted.Success && scope.Store.TryResolveDirectory(spineKey) is not null, "the bake adopted");

        var pageName = adopted.PageFiles.Single();
        File.Delete(Path.Combine(adopted.Directory!, CouchCoopGeoclipStore.CompleteMarkerName));

        Expect(scope.Store.TryResolveDirectory(spineKey) is null,
            "a pose directory WITHOUT the .complete marker does not resolve, even with every artifact present");
        Expect(scope.Store.TryResolveFile(spineKey, "manifest.json") is null, "…and neither does its manifest");
        Expect(scope.Store.TryResolveFile(spineKey, pageName) is null,
            "…nor its page: the marker gates the whole address, not just the pose-local files");
        Expect(File.Exists(Path.Combine(scope.Store.PagesPath!, pageName)),
            "the page is still ON DISK — it is unreachable through an incomplete pose, not deleted "
            + "(it is content-addressed and may be shared with a pose that IS complete)");
    }

    private static async Task AFailedAdoptLeavesNothingResolvableAsync()
    {
        using var scope = new StoreScope();
        var spineKey = Key("failedadopt.tscn", "idle_loop");
        var first = await scope.Store.AdoptAsync(spineKey, scope.WriteBake("page-0.png", PagePixels(3)));
        Expect(first.Success, "first adopt succeeds");
        var goodManifest = await File.ReadAllTextAsync(Path.Combine(first.Directory!, "manifest.json"));

        // A bake whose manifest references a page it never wrote. Pages are adopted BEFORE the pose directory is
        // touched (a page is valid on its own — its name is its hash), so this fails before anything the served
        // pose depends on has moved: the previous, complete entry keeps serving.
        var broken = scope.WriteBake("page-0.png", PagePixels(3));
        File.Delete(Path.Combine(broken, "page-0.png"));
        var second = await scope.Store.AdoptAsync(spineKey, broken);

        Expect(!second.Success, "an adopt whose manifest references a missing page fails");
        Expect(second.ErrorCode == "geoclip-page-missing", $"…with a structured code (got {second.ErrorCode})");
        Expect(scope.Store.TryResolveDirectory(spineKey) == first.Directory,
            "a failed re-adopt never degrades a good cache entry — the previous COMPLETE pose still resolves");

        var missingVerts = scope.WriteBake("page-0.png", PagePixels(4));
        File.Delete(Path.Combine(missingVerts, "verts.bin"));
        var noPackedGeometry = await scope.Store.AdoptAsync(Key("noverts.tscn", "idle_loop"), missingVerts);
        Expect(!noPackedGeometry.Success && noPackedGeometry.ErrorCode == "geoclip-verts-missing",
            "a raw bake without packed vertices is never published as a Couch geoclip/1 artifact");
        Expect(scope.Store.TryResolveDirectory(Key("noverts.tscn", "idle_loop")) is null,
            "a missing verts.bin leaves no route-visible partial artifact");
        Expect(
            await File.ReadAllTextAsync(Path.Combine(first.Directory!, "manifest.json")) == goodManifest,
            "…and still serves the manifest it served before the failed bake");
        Expect(
            !Directory.EnumerateFiles(scope.Store.RootPath!, "*.tmp", SearchOption.AllDirectories).Any(),
            "a failed adopt leaves no temp file behind either");

        var missingManifest = Path.Combine(Path.GetTempPath(), "couchcoop-geoclip-empty-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(missingManifest);
        try
        {
            var third = await scope.Store.AdoptAsync(Key("nomanifest.tscn", "idle_loop"), missingManifest);
            Expect(!third.Success && third.ErrorCode == "geoclip-manifest-missing", "a bake that wrote no manifest fails by name");
        }
        finally
        {
            Directory.Delete(missingManifest, recursive: true);
        }
    }

    // ── Page sharing — the round's transfer payoff ─────────────────────────────────────────────────────────

    private static async Task TwoPosesSharingAPageStoreOneCopyAsync()
    {
        using var scope = new StoreScope();
        var idle = Key("shared.tscn", "idle_loop");
        var attack = Key("shared.tscn", "attack");

        // Two poses of ONE rig: same atlas bytes, different geometry. The baker names the page positionally in
        // both bakes, and the two bakes are different directories — only the CONTENT can dedupe them.
        var first = await scope.Store.AdoptAsync(idle, scope.WriteBake("page-0.png", PagePixels(9)));
        var second = await scope.Store.AdoptAsync(attack, scope.WriteBake("page-0.png", PagePixels(9)));
        Expect(first.Success && second.Success, "both poses adopt");

        Expect(first.PageFiles.Single() == second.PageFiles.Single(),
            "two poses that sample the same atlas page reference the SAME content-addressed file");
        Expect(
            Directory.GetFiles(scope.Store.PagesPath!, "*.png").Length == 1,
            "…and that page exists ONCE on disk. This is the round's payoff: a rig pays for its atlas once, so a "
            + "second pose transfers geometry only");
        Expect(first.Directory != second.Directory, "…while the two poses are still separate directories");

        // A DIFFERENT rig's page is a different file — the sharing is by content, not by wishful thinking.
        var other = await scope.Store.AdoptAsync(Key("otherrig.tscn", "idle_loop"), scope.WriteBake("page-0.png", PagePixels(11)));
        Expect(other.Success && other.PageFiles.Single() != first.PageFiles.Single(), "different page bytes get a different name");
        Expect(Directory.GetFiles(scope.Store.PagesPath!, "*.png").Length == 2, "…and a second file on disk");
    }

    // ── The provider ───────────────────────────────────────────────────────────────────────────────────────

    private static async Task ArmedTheProviderBakesOnceForConcurrentAskersAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        // A LATCH, not a one-permit semaphore: once opened it stays open, so a build that lost the single-flight
        // fails on the call count below instead of deadlocking eight bakes behind one permit (and taking the
        // whole suite with it). A test whose mutant HANGS has not really been mutation-tested.
        using var latch = new ManualResetEventSlim(false);
        var baker = new RecordingBaker(hold: latch);
        var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });
        var request = Request("singleflight.tscn", "idle_loop");

        var askers = Enumerable.Range(0, 8).Select(_ => provider.GetAsync(request)).ToArray();
        await WaitUntilAsync(() => baker.Calls > 0, "the first asker reaches the baker");
        latch.Set();
        var results = await Task.WhenAll(askers);

        Expect(baker.Calls == 1, $"eight concurrent asks for one key bake ONCE (baked {baker.Calls} times)");
        Expect(results.All(r => r.Directory is not null), "every asker gets the directory the one bake produced");
        Expect(results.Select(r => r.Directory).Distinct().Count() == 1, "…the same directory");
        Expect(scope.Store.TryResolveDirectory(request.SpineKey) is not null, "the bake is written through to the store");
        Expect(
            Directory.GetFiles(scope.Store.PagesPath!, "*.png").Select(Path.GetFileName).SequenceEqual(
                [CouchCoopGeoclipStore.PageFileNameFor(PagePixels(42), ".png")]),
            "the one page the bake emitted was adopted into the shared folder under its content hash");
        Expect(
            !Directory.Exists(Path.Combine(scope.Store.RootPath!, CouchCoopGeoclipStore.StagingFolderName, baker.LastOutputDirectory!)),
            "the staging directory is swept after adoption");
        Expect(baker.LastCommand!.MaxFrames == CouchCoopGeoclipProvider.SinglePoseFrames,
            "the on-demand lane asks for a SINGLE-POSE bake");
        Expect(baker.LastCommand!.SampleTimeSeconds is null,
            "…and pins no sample time, so the producer's own pose rule (ChooseSampleTime) decides");
        Expect(baker.LastCommand!.SceneResPath == "res://singleflight.tscn" && baker.LastCommand!.AnimationName == "idle_loop",
            "the identity reaches the baker intact");
    }

    private static async Task ASecondRequestIsAStoreHitWithNoBakeAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        var baker = new RecordingBaker();
        var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });
        var request = Request("hit.tscn", "idle_loop");

        var cold = await provider.GetAsync(request);
        Expect(cold.CacheStatus == "MISS" && cold.Directory is not null, "the cold request bakes");
        Expect(baker.Calls == 1, "…once");

        var warm = await provider.GetAsync(request);
        Expect(warm.CacheStatus == "HIT" && warm.Directory == cold.Directory, "the second request is a store HIT");
        Expect(baker.Calls == 1, "…with NO second bake");

        // A store HIT is served by a provider whose baker would fail: the disk is the source of truth.
        var refusing = new CouchCoopGeoclipProvider(new RefusingBaker(), scope.Store, _ => { });
        var served = await refusing.GetAsync(request);
        Expect(served.CacheStatus == "HIT" && served.Directory == cold.Directory,
            "an already-baked geoclip is served without the producer being consulted at all");
    }

    // A bake that comes back INCOMPLETE has still written a well-formed directory holding wrong data — a measured
    // case dropped 2 of 28 parts, associated 0 of 44 slots and fell through to a fallback that mis-assigned the
    // rest. Nothing downstream can tell that from a good bake, and this store is content-addressed with SHARED
    // pages, so committing one poisons poses that were themselves fine. It must be refused.
    private static async Task AnIncompleteBakeIsRefusedEntryToTheStoreAsync()
    {
        // The arms fail independently, so each gets its own refusal.
        var arms = new (string Label, RecordingBaker Baker, string Scene)[]
        {
            ("complete=false", new RecordingBaker(complete: false), "incomplete_flag.tscn"),
            ("associated < slotsEverVisible", new RecordingBaker(slots: 28, associated: 26), "incomplete_assoc.tscn"),
            // Missing provenance is rejected rather than treated as clean evidence.
            ("claim provenance missing", new RecordingBaker(foreignMeshes: 3), "incomplete_foreign.tscn"),
            // Leftovers WITH provenance, and one claim that could not be proven: the ownership arm.
            ("ownership", new RecordingBaker(foreignMeshes: 3, claimsProven: 27, claimsUnproven: 1), "incomplete_ownership.tscn"),
        };

        foreach (var (label, baker, scene) in arms)
        {
            using var scope = new StoreScope(armOnDemand: true);
            var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });
            var request = Request(scene, "idle_loop");

            var result = await provider.GetAsync(request);

            Expect(baker.Calls == 1, $"[{label}] the bake ran");
            Expect(result.Directory is null, $"[{label}] an incomplete bake produces nothing servable");
            Expect(result.Error?.Code == "geoclip-bake-incomplete", $"[{label}] …and says so by name (got {result.Error?.Code})");

            // The route serves exactly what this call resolves, so a null here IS the 404.
            Expect(scope.Store.TryResolveFile(request.SpineKey, "manifest.json") is null,
                $"[{label}] the route still 404s: the store resolves no manifest for a refused bake");
            var directory = Path.Combine(
                scope.Store.RootPath!,
                CouchCoopGeoclipStore.DirectoryNameFor(CouchCoopGeoclipStore.BuildGeoclipKey(request.SpineKey)));
            Expect(!File.Exists(Path.Combine(directory, CouchCoopGeoclipStore.CompleteMarkerName)),
                $"[{label}] no .complete marker is written");
            Expect(!Directory.Exists(directory), $"[{label}] the pose directory is not created at all");
            Expect(
                !Directory.Exists(scope.Store.PagesPath!) || Directory.GetFiles(scope.Store.PagesPath!).Length == 0,
                $"[{label}] and NOTHING reaches the shared pages folder — the pages are shared, so a bad page "
                + "would taint poses that were themselves fine");
            Expect(
                !Directory.EnumerateDirectories(Path.Combine(scope.Store.RootPath!, CouchCoopGeoclipStore.StagingFolderName)).Any(),
                $"[{label}] the staging directory is swept, so the bad bytes are gone from disk entirely");
        }

        // The decision itself, at the seam, so the rules are pinned independently of the plumbing.
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(Outcome(complete: true, slots: 28, associated: 28)) is null,
            "a complete, fully-associated, foreign-free bake is admitted");
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(Outcome(complete: false, slots: 28, associated: 28)) == "complete=false",
            "the baker's own verdict is decisive on its own");
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(Outcome(complete: true, slots: 44, associated: 40)) is not null,
            "an under-associated bake is refused even when the baker calls itself complete");
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(Outcome(complete: true, slots: 28, associated: 28, foreign: 1)) is not null,
            "an unattributable surface with NO claim provenance to grade still refuses — missing evidence is not "
            + "clean evidence, so the rule falls back to the arm it had");

        TheThirdArmGradesClaimsNotLeftovers();
    }

    // ── The third arm: ownership proof, not a leftover count ──────────────────────────────────────────────
    //
    // Couch keeps its OWN copy of spirectl's admission rule (the local backstop for a producer that reports no
    // verdict of its own), so spirectl 71c92bc7's change has to be made here too or this route goes on refusing on
    // its own arm and the upstream change is invisible. The arm is exercised through the RAW-COUNTER overload with
    // the lever passed explicitly: the rule must be a pure function of its arguments, and a suite that read the
    // process-global env var here would be one parallel test away from grading the other rule's verdict.
    private static void TheThirdArmGradesClaimsNotLeftovers()
    {
        static string? Rule(int foreign, int proven, int unproven)
            => CouchCoopGeoclipProvider.IncompletenessReason(
                complete: true, associated: 28, slotsEverVisible: 28,
                foreignMeshes: foreign, claimsProven: proven, claimsUnproven: unproven);

        // THE COUNTER-EXAMPLE THAT RETIRED THE PROXY, in the shape spirectl measured it: an Ironclad that baked
        // complete, associated every drawable slot, and was thrown away over 8 leftovers that were its own
        // geometry for attachments not drawable at the sampled pose.
        Expect(Rule(foreign: 8, proven: 44, unproven: 0) is null,
            "leftovers alone no longer sink a bake whose every claim is positively proven");

        Expect(Rule(foreign: 8, proven: 40, unproven: 4) == "ownership=4 of claimed=44",
            "…but leftovers BESIDE an unproven claim do, naming how many claims and out of how many");
        Expect(CouchCoopGeoclipProvider.ClassifyRefusal("ownership=4 of claimed=44") == "ownership",
            "…and that reason buckets onto its own stable arm token, which the receipt and the header carry");

        // FAIL CLOSED. Missing current provenance is rejected explicitly rather than treated as clean evidence.
        Expect(Rule(foreign: 8, proven: 0, unproven: 0) == "claim-provenance-missing",
            "missing claim provenance refuses the bake");

        // NOT the strict form. With no leftovers the claims exhaust the validated pool, so an unproven claim has
        // nothing it could have taken instead; spirectl reports that case as a shadow line and does not enforce
        // it, and a couch copy that DID enforce it would refuse bakes the producer had just admitted.
        Expect(Rule(foreign: 0, proven: 40, unproven: 4) is null,
            "an unproven claim with an empty bracket is admitted — the strict form is reported upstream, not enforced");

        // Arm order is unchanged: the earlier arms still win, because an incomplete bake's association numbers
        // are not evidence about anything.
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(
                complete: false, associated: 28, slotsEverVisible: 28,
                foreignMeshes: 8, claimsProven: 40, claimsUnproven: 4) == "complete=false",
            "the baker's own verdict still fires before any of this");
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(
                complete: true, associated: 40, slotsEverVisible: 44,
                foreignMeshes: 8, claimsProven: 40, claimsUnproven: 0)
                == "associated=40 of slotsEverVisible=44",
            "…and so does an under-associated bake, whose leftover count is unreadable anyway");
    }

    // THE BEHAVIOUR CHANGE, end to end through the real provider and the real store rather than at the rule:
    // a bake that the previous arm threw away is now published and servable, and one whose claims did not all
    // prove is still refused — with the evidence for the verdict written into the receipt, because a receipt is
    // answered without baking and anything not written there is gone by the second ask.
    private static async Task AProvenBakeWithLeftoversIsAdmittedAndCarriesItsEvidenceAsync()
    {
        // The Ironclad shape: complete, every drawable slot associated, 8 leftovers, every claim proven.
        using (var scope = new StoreScope(armOnDemand: true))
        {
            var baker = new RecordingBaker(slots: 44, foreignMeshes: 8, claimsProven: 44, claimsUnproven: 0);
            var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });
            var request = Request("proven_with_leftovers.tscn", "attack");

            var result = await provider.GetAsync(request);
            Expect(baker.Calls == 1 && result.Error is null && result.Directory is not null,
                $"a fully proven bake is ADMITTED despite 8 leftovers (got {result.Error?.Code ?? "<no error>"})");
            Expect(scope.Store.TryResolveFile(request.SpineKey, "manifest.json") is not null,
                "…and the route can actually serve it, which is the whole point of the change");
            Expect(scope.Store.TryReadRefusal(request.SpineKey) is null,
                "…and nothing was remembered as refused");
        }

        // The same bake with one claim it could not prove: still refused, on the arm that says so.
        using (var scope = new StoreScope(armOnDemand: true))
        {
            var baker = new RecordingBaker(slots: 44, foreignMeshes: 8, claimsProven: 43, claimsUnproven: 1);
            var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });
            var request = Request("unproven_with_leftovers.tscn", "attack");

            var result = await provider.GetAsync(request);
            Expect(result.Error?.Code == CouchCoopGeoclipProvider.RefusedCode,
                $"one unproven claim beside leftovers still refuses (got {result.Error?.Code})");
            Expect(result.Refusal is { Reason: "ownership" },
                $"…on the ownership arm, not the leftover one (got {result.Refusal?.Reason})");
            Expect(result.Refusal!.Detail == "ownership=1 of claimed=44",
                $"…naming how many claims failed and out of how many (got '{result.Refusal.Detail}')");
            Expect(result.Refusal is { ClaimsProven: 43, ClaimsUnproven: 1 },
                "…and the verdict carries the evidence it rested on as structure");

            // THE RECEIPT. A cached refusal is served without baking, so evidence that is not durable is evidence
            // that only the first asker ever sees.
            var record = scope.Store.TryReadRefusal(request.SpineKey);
            Expect(record is { Reason: "ownership", ClaimsProven: 43, ClaimsUnproven: 1 },
                "the durable receipt keeps the arm AND the counts that produced it");

            var header = CouchCoopGeoclipProvider.DescribeCachedRefusal(record!);
            Expect(header.Contains("claimsProven=43", StringComparison.Ordinal)
                && header.Contains("claimsUnproven=1", StringComparison.Ordinal),
                $"…so the second ask's diagnostics header explains itself too (got '{header}')");
        }
    }

    private static CouchCoopGeoclipBakeOutcome Outcome(
        bool complete,
        int slots,
        int associated,
        int foreign = 0,
        int claimsProven = 0,
        int claimsUnproven = 0)
        => new(true, null, [], 0, 1, 0d, "mid", 0L, null, null, complete, slots, associated, foreign,
            ClaimsProven: claimsProven, ClaimsUnproven: claimsUnproven);

    // ── A refusal is durable ───────────────────────────────────────────────────────────────────────────────

    // Measured on the real catalog: 695 of 857 attempted identities were REFUSED, at a median 1.45 s and a p90
    // 4.15 s each, and every one of them was re-baked from scratch on the next launch because a refusal wrote
    // nothing down. On a host that dies roughly every four hundred bakes that store never converges. So the
    // verdict is written to disk — and, because it is a verdict rather than an artifact, it must be impossible to
    // SERVE it: a receipt that ever satisfied a /geoclips/ read would be a creature drawn from a JSON error note.
    private static async Task ARefusalIsRememberedAndIsNeverServedAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        var baker = new RecordingBaker(slots: 44, associated: 40);
        var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });
        var request = Request("remembered.tscn", "idle_loop");

        var fresh = await provider.GetAsync(request);
        Expect(baker.Calls == 1, "the first ask bakes");
        Expect(fresh.Error?.Code == CouchCoopGeoclipProvider.RefusedCode, $"…and is refused (got {fresh.Error?.Code})");
        Expect(fresh.Refusal is { Cached: false, Reason: "unassociated" },
            $"…carrying the verdict as STRUCTURE, bucketed by the guard arm that fired (got {fresh.Refusal?.Reason})");
        Expect(fresh.Refusal!.Detail.Contains("associated=40", StringComparison.Ordinal),
            $"…with the counts kept for whoever reads this months later (got '{fresh.Refusal.Detail}')");

        // The receipt on disk.
        var geoclipKey = CouchCoopGeoclipStore.BuildGeoclipKey(request.SpineKey);
        var receiptName = CouchCoopGeoclipStore.RefusalFileNameFor(geoclipKey);
        var receipt = Path.Combine(scope.Store.RefusalsPath!, receiptName);
        Expect(File.Exists(receipt), "a refusal writes a receipt");
        var record = scope.Store.TryReadRefusal(request.SpineKey);
        Expect(record is not null, "…which reads back");
        Expect(record!.Key == geoclipKey, "…naming the identity it refused, gv tail included, so a hashed file name is legible");
        Expect(record.Policy == CouchCoopGeoclipStore.GeoclipSelector,
            $"…and the POLICY VERSION the verdict belongs to (got '{record.Policy}')");
        Expect(record.Reason == "unassociated" && record.Detail == fresh.Refusal.Detail, "…plus the reason and its detail");
        Expect(record.RefusedUtc > DateTimeOffset.UtcNow.AddMinutes(-5), "…and when");

        // The second ask is answered from it, WITHOUT a bake. This is the whole point.
        var remembered = await provider.GetAsync(request);
        Expect(baker.Calls == 1, $"a second ask does NOT re-bake a refused identity (baker calls {baker.Calls})");
        Expect(remembered.Error?.Code == CouchCoopGeoclipProvider.RefusedCachedCode,
            $"…and says it was remembered rather than re-decided (got {remembered.Error?.Code})");
        Expect(remembered.Refusal is { Cached: true, Reason: "unassociated" }, "…with the same bucketed verdict, marked cached");
        Expect(remembered.Refusal!.Detail == fresh.Refusal.Detail && remembered.Refusal.RefusedUtc == record.RefusedUtc,
            "…and the ORIGINAL detail and timestamp, not this request's");
        Expect(remembered.Error!.Message.Contains(fresh.Refusal.Detail, StringComparison.Ordinal),
            "the message a client gets carries the original reason too — a 404 in a millisecond that explains itself");

        // NEVER SERVED, by four independent routes.
        Expect(scope.Store.TryResolveDirectory(request.SpineKey) is null,
            "a refused identity resolves NO pose directory: the receipt is not a .complete marker");
        Expect(scope.Store.TryResolveFile(request.SpineKey, "manifest.json") is null, "…so the route still 404s its manifest");
        Expect(scope.Store.TryResolveFile(request.SpineKey, receiptName) is null,
            "…and the receipt cannot be fetched by naming it either");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName(receiptName),
            "…because a receipt's name is outside the served whitelist to begin with");
        Expect(!scope.Store.IsSharedPagePath(receipt), "…and it is not a content-addressed page, so it earns no immutable caching");

        var poseDirectory = Path.Combine(scope.Store.RootPath!, CouchCoopGeoclipStore.DirectoryNameFor(geoclipKey));
        Expect(!Directory.Exists(poseDirectory),
            "the refused identity still has NO pose directory — the receipt lives in its own folder, so nothing that "
            + "walks the store can mistake it for a half-written bake");
        Expect(
            !Directory.Exists(scope.Store.PagesPath!) || Directory.GetFiles(scope.Store.PagesPath!).Length == 0,
            "…and nothing from the refused bake reached the shared pages folder");
        Expect(Path.GetDirectoryName(receipt) == Path.Combine(scope.Store.RootPath!, CouchCoopGeoclipStore.RefusalsFolderName),
            "the receipt lives under refusals/, outside every served tree");
        Expect(
            !Directory.EnumerateFiles(scope.Store.RootPath!, "*.tmp", SearchOption.AllDirectories).Any(),
            "…and it is written temp-then-move like everything else here");

    }

    // ── The one refusal that must NOT become durable ───────────────────────────────────────────────────────

    // A creature death frees RIDs, Godot's allocator leaves bump-allocation, and the sweep's inferred index hull
    // stops covering the rig's own meshes: they land at recycled indices outside it and are never probed.
    // `meshesValidated` falls below the slots there are to fill, `unassociated` is DEFINED as that difference, and
    // the bake refuses — over an accident of allocator state at that instant, not over anything about the rig.
    // Measured in .sts2/research/data/geoclip-driven-combat-20260909T002811Z: two kills alone refuse 3 of 4 rigs
    // that bake clean in a virgin process.
    //
    // spirectl declines to pin one in its own memo, but that memo dies with the game. THIS store's receipt does
    // not — so a couch that wrote one anyway would poison that identity on every later launch for ever, on the
    // strength of one unlucky moment. The receipt is the durable half, so the fix has to be here.
    private static async Task ARetryableAcquisitionShortfallIsNeverWrittenDownAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        var request = Request("freed_rids.tscn", "idle_loop");
        var baker = new SweepBaker([new SweepScript("idle_loop", SlotsVisible: 44, Associated: 40, MeshesValidated: 40)]);
        var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });

        var first = await provider.GetAsync(request);
        Expect(baker.Calls == 1, "the first ask bakes");
        Expect(first.Error?.Code == CouchCoopGeoclipProvider.RefusedCode,
            $"a short sweep is still REFUSED — nothing may be adopted, the bytes on disk are wrong (got {first.Error?.Code})");
        Expect(first.Refusal is { Cached: false }, "…and says so as a fresh verdict, not a remembered one");

        // The whole point: no receipt.
        Expect(!scope.Store.HasRefusal(request.SpineKey),
            "a retryable acquisition shortfall writes NO refusal receipt");
        var receipt = Path.Combine(
            scope.Store.RefusalsPath!,
            CouchCoopGeoclipStore.RefusalFileNameFor(CouchCoopGeoclipStore.BuildGeoclipKey(request.SpineKey)));
        Expect(!File.Exists(receipt), $"…and nothing lands at its receipt path ({receipt})");
        Expect(scope.Store.TryReadRefusal(request.SpineKey) is null, "…so there is nothing to read back");

        // And therefore the next ask RE-BAKES rather than being answered from disk. This is the behaviour the
        // whole change exists for: the identity gets another chance in a process whose allocator has moved on.
        var second = await provider.GetAsync(request);
        Expect(baker.Calls == 2, $"a second ask re-bakes a retryable refusal (baker calls {baker.Calls})");
        Expect(second.Error?.Code == CouchCoopGeoclipProvider.RefusedCode,
            $"…and re-decides it rather than answering `refused-cached` (got {second.Error?.Code})");

        // A LATER BAKE THAT ACQUIRES THE RIG IS ADOPTED. Nothing on disk is left to stop it.
        var recovered = await new CouchCoopGeoclipProvider(new RecordingBaker(), scope.Store, _ => { }).GetAsync(request);
        Expect(recovered.CacheStatus == "MISS" && recovered.Refusal is null,
            "…and once the sweep does cover the rig, the artifact is adopted");
    }

    // THE OTHER DIRECTION, which is the one that costs real money if it goes wrong: everything that is NOT an
    // untruncated measured shortfall still writes its receipt and is still answered from it. A change that made
    // every refusal retryable would pass the test above and re-bake half the catalog on every single request.
    private static async Task ANonRetryableRefusalIsStillWrittenDownAsync()
    {
        // (1) A shortfall the sweep TRUNCATED. It hit its own candidate cap, so it never finished its plan and
        // re-running it under the same cap reproduces this exactly. A configuration verdict: it sticks.
        await StickyAsync(
            "truncated_sweep.tscn",
            new SweepScript("idle_loop", SlotsVisible: 44, Associated: 40, MeshesValidated: 40, SweepTruncated: true),
            "a TRUNCATED shortfall is a verdict about the sweep's configuration, not about its plan");

        // (2) A bake that acquired every mesh and then failed on OWNERSHIP. Nothing about the allocator; the rig's
        // own claims did not prove out.
        await StickyAsync(
            "unproven_claims.tscn",
            new SweepScript(
                "idle_loop", SlotsVisible: 44, Associated: 44, MeshesValidated: 44,
                ForeignMeshes: 6, ClaimsProven: 43, ClaimsUnproven: 1),
            "an ownership refusal is a verdict about the rig");

        // (3) Same, on the bare FOREIGN arm — leftovers with no provenance recorded to grade.
        await StickyAsync(
            "foreign_leftovers.tscn",
            new SweepScript("idle_loop", SlotsVisible: 44, Associated: 44, MeshesValidated: 44, ForeignMeshes: 6),
            "a foreign-leftover refusal is a verdict about the rig");

        // (4) INCOMPLETE for some other reason, with the sweep having covered every slot it could see.
        await StickyAsync(
            "otherwise_incomplete.tscn",
            new SweepScript("idle_loop", SlotsVisible: 44, Associated: 44, MeshesValidated: 44, Complete: false),
            "an incomplete bake whose sweep was not short is a verdict about the rig");

        // (5) A producer too old to report the sweep counters at all. `meshesValidated == 0` is MISSING evidence,
        // not a measured shortfall — the same fail-closed asymmetry the ownership arm takes on 0 claims. Drop the
        // `> 0` clause and every refusal from every older bridge silently becomes a re-bake on every request.
        await StickyAsync(
            "counterless_bridge.tscn",
            new SweepScript("idle_loop", SlotsVisible: 44, Associated: 40, MeshesValidated: 0),
            "a bake carrying no sweep counters is missing evidence, and missing evidence sticks");

        // (6) THE PRODUCER DID NOT JUDGE THIS BAKE. Couch's local backstop is what refused it, so the producer's
        // flag says nothing about it and a defaulted-true must not be read as consent to forget the refusal.
        await StickyAsync(
            "unjudged_by_producer.tscn",
            new SweepScript("idle_loop", SlotsVisible: 44, Associated: 40, MeshesValidated: 40),
            "a refusal the producer never judged is not the producer's to call retryable",
            producerJudges: false,
            producerClaimsRetryable: true);

        static async Task StickyAsync(
            string scene,
            SweepScript script,
            string because,
            bool producerJudges = true,
            bool? producerClaimsRetryable = null)
        {
            using var scope = new StoreScope(armOnDemand: true);
            var request = Request(scene, script.Animation);
            var baker = new SweepBaker([script], producerJudges, producerClaimsRetryable);
            var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });

            var first = await provider.GetAsync(request);
            Expect(first.Error?.Code == CouchCoopGeoclipProvider.RefusedCode,
                $"{scene}: the bake is refused (got {first.Error?.Code})");
            Expect(scope.Store.HasRefusal(request.SpineKey), $"{because} — so it IS written down ({scene})");
            Expect(scope.Store.TryReadRefusal(request.SpineKey)?.Detail == first.Refusal?.Detail,
                $"{scene}: …with the detail this bake reached");

            var second = await provider.GetAsync(request);
            Expect(baker.Calls == 1, $"{scene}: a second ask does NOT re-bake it (baker calls {baker.Calls})");
            Expect(second.Error?.Code == CouchCoopGeoclipProvider.RefusedCachedCode,
                $"{scene}: …and is answered from the receipt (got {second.Error?.Code})");
            Expect(second.Refusal is { Cached: true }, $"{scene}: …marked as remembered");
        }
    }

    // The rig lane reaches the same verdict on its OWN evidence, and it has to: a rig result's top-level
    // retryability flag describes the FIRST refused pose and is absent entirely once some other pose is adoptable,
    // while this lane judges, refuses and records each pose ALONE. The two lanes have drifted independently
    // before, so both directions are proved here too — in ONE bake, where the flag cannot be a rig-wide accident.
    private static async Task TheRigLaneDerivesRetryabilityPerPoseAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        var shortfall = Request("mixed_rig.tscn", "idle_loop");
        var truncated = Request("mixed_rig.tscn", "attack");
        var baker = new SweepBaker([
            new SweepScript("idle_loop", SlotsVisible: 44, Associated: 40, MeshesValidated: 40),
            new SweepScript("attack", SlotsVisible: 44, Associated: 40, MeshesValidated: 40, SweepTruncated: true),
        ]);
        var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });

        var results = await provider.GetRigAsync([shortfall, truncated]);
        Expect(baker.Calls == 1, $"the rig lane bakes ONCE for both poses (baker calls {baker.Calls})");
        Expect(results.Count == 2 && results.All(result => result.Error?.Code == CouchCoopGeoclipProvider.RefusedCode),
            "both poses are refused — neither may be adopted");

        Expect(!scope.Store.HasRefusal(shortfall.SpineKey),
            "the untruncated shortfall pose writes NO receipt, judged on ITS OWN sweep counters");
        Expect(scope.Store.HasRefusal(truncated.SpineKey),
            "…while its sibling in the SAME bake, whose sweep truncated, still writes one");

        // And the disk state is what the next sweep acts on: one pose retries, the other is answered without a bake.
        var again = await provider.GetRigAsync([shortfall, truncated]);
        Expect(baker.Calls == 2, $"the retryable pose sends the rig lane back to the baker (baker calls {baker.Calls})");
        Expect(again[1].Error?.Code == CouchCoopGeoclipProvider.RefusedCachedCode && again[1].Refusal is { Cached: true },
            $"…while the sticky pose is answered from its receipt (got {again[1].Error?.Code})");

        // The derivation reads counters the SEAM has to carry. A MapPose that dropped them leaves every pose at
        // 0/false, which reads as missing evidence and refuses stickily — silently, with everything above green.
        var mapped = CouchCoopRuntimeGeoclipBaker.MapPose(new SpineGeoClipBakePoseSnapshot(
            AnimationName: "idle_loop",
            Success: true,
            ManifestPath: "/store/staging/idle_loop/manifest.json",
            PageFileNames: ["page-0.png"],
            PartCount: 40,
            FrameCount: 1,
            SampleTimeSeconds: 0.5d,
            SampleTimeSource: "mid",
            Slots: 52,
            SlotsVisible: 44,
            Associated: 40,
            Unassociated: 4,
            ForeignMeshes: 0,
            StaleMeshFrames: 0,
            AttachmentDriftSlots: 0,
            Complete: false,
            Batched: true,
            FailureReason: null,
            MeshesValidated: 40,
            SweepTruncated: false));
        Expect(mapped.MeshesValidated == 40 && !mapped.SweepTruncated,
            "the pose mapper carries the sweep counters the rig lane's verdict is derived from");
        Expect(CouchCoopGeoclipProvider.IsRetryableAcquisitionShortfall(mapped),
            "…and the rule reads them as a retryable acquisition shortfall");
        Expect(!CouchCoopGeoclipProvider.IsRetryableAcquisitionShortfall(mapped with { SweepTruncated = true }),
            "…which truncation alone turns back into a sticky verdict");
        Expect(!CouchCoopGeoclipProvider.IsRetryableAcquisitionShortfall(mapped with { MeshesValidated = 0 }),
            "…and which absent counters do not qualify for");
        Expect(!CouchCoopGeoclipProvider.IsRetryableAcquisitionShortfall(mapped with { MeshesValidated = 44 }),
            "…nor does a sweep that covered every visible slot");
    }

    // The bump is the other half of the rule change, and it is what rescues the identities already poisoned. Every
    // host's disk holds receipts minted while an untruncated shortfall still stuck, and a receipt is answered
    // WITHOUT baking — so without this the new rule would be live, correct, and unreachable for exactly the bakes
    // it was written to rescue.
    private static async Task AStickyRuleReceiptFailsOpenAfterTheRevisionBumpAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        var request = Request("poisoned_under_revision_4.tscn", "idle_loop");
        Expect(await scope.Store.RecordRefusalAsync(request.SpineKey, "incomplete", "complete=false"),
            "a receipt exists before it is rewritten as a revision-4 one");

        var receipt = Path.Combine(
            scope.Store.RefusalsPath!,
            CouchCoopGeoclipStore.RefusalFileNameFor(CouchCoopGeoclipStore.BuildGeoclipKey(request.SpineKey)));
        var sticky = JsonNode.Parse(await File.ReadAllTextAsync(receipt))!;
        sticky["refusalPolicyRevision"] = "geoclip-refusal/4";
        await File.WriteAllTextAsync(receipt, sticky.ToJsonString());

        Expect(scope.Store.TryReadRefusal(request.SpineKey) is null,
            "a receipt written under the sticky rule (revision 4) fails open after the bump");
        var baker = new RecordingBaker();
        var retried = await new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }).GetAsync(request);
        Expect(retried.CacheStatus == "MISS" && baker.Calls == 1 && retried.Refusal is null,
            "…and the identity it poisoned is re-baked and adopted");
    }

    // THE HEADLESS RECEIPT, which is the one case where the bump is the ENTIRE change on this side.
    //
    // A pre-fix host running under Godot's dummy renderer read every slot mesh back at its creation-time contents,
    // so every rig refused, deterministically, and every refusal wrote a receipt at revision 5. The repair is
    // wholly in the producer: no rule in this assembly moved, `gv` did not move, and a receipt is answered WITHOUT
    // baking — so a host that has already run headless answers `geoclip-bake-refused-cached` in milliseconds for
    // ever and never re-attempts the bake that now succeeds. Measured, arm RC of
    // `geoclip-headless-route-20260909T190000Z`: one seeded receipt held one rig at 404 while its three siblings,
    // which had none, served 200 through the same fixed route.
    //
    // The pair below is what makes this test refuse to be vacuous. ONE receipt file, ONE identity, ONE byte of
    // difference — the revision it carries. At the pre-fix revision it must fail open and the identity must really
    // be baked again; at the CURRENT revision the same file must bind and suppress the bake. If the constant is
    // ever reverted the two halves collide and the first half fails, which is the point of writing them together.
    private const string PreFixHeadlessRefusalPolicyRevision = "geoclip-refusal/5";

    private static async Task APreFixHeadlessReceiptFailsOpenAfterTheRevisionBumpAsync()
    {
        // NO "the constant moved" PIN AHEAD OF THE BEHAVIOUR, on purpose. A guard here would be the first thing to
        // fire if the bump were ever reverted, and it would report a string comparison — while the fact worth
        // reporting is that a real host silently stops re-baking. So the behaviour is asserted first and the pin
        // closes the test.

        // The receipt a headless host wrote before the fix, in the shape RecordRefusalAsync mints — a real
        // `incomplete`/`complete=false` verdict carrying the ownership split the refused bake had reached.
        static string ReceiptJson(string geoclipKey, string revision) => JsonSerializer.Serialize(new
        {
            key = geoclipKey,
            policy = CouchCoopGeoclipStore.GeoclipSelector,
            refusalPolicyRevision = revision,
            reason = "incomplete",
            detail = "complete=false",
            refusedUtc = "2026-09-09T15:56:25.6476702+00:00",
            claimsProven = 38,
            claimsUnproven = 2,
        });

        // ── (1) THE PRE-FIX RECEIPT MUST NOT BIND ──────────────────────────────────────────────────────────
        using var scope = new StoreScope(armOnDemand: true);
        var request = Request("headless_refused_under_revision_5.tscn", "idle_loop");
        var geoclipKey = CouchCoopGeoclipStore.BuildGeoclipKey(request.SpineKey);
        var receipt = Path.Combine(scope.Store.RefusalsPath!, CouchCoopGeoclipStore.RefusalFileNameFor(geoclipKey));
        Directory.CreateDirectory(scope.Store.RefusalsPath!);
        await File.WriteAllTextAsync(receipt, ReceiptJson(geoclipKey, PreFixHeadlessRefusalPolicyRevision));

        Expect(scope.Store.HasRefusal(request.SpineKey),
            "the pre-fix receipt really is on disk, so the retry below cannot pass by the file being absent");
        Expect(scope.Store.TryReadRefusal(request.SpineKey) is null,
            $"a receipt stamped {PreFixHeadlessRefusalPolicyRevision} by a broken headless bake fails open after the bump");

        var baker = new RecordingBaker();
        var retried = await new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }).GetAsync(request);
        Expect(baker.Calls == 1, $"…so the single lane BAKES the identity again (baker calls {baker.Calls})");
        Expect(retried.CacheStatus == "MISS" && retried.Refusal is null
                && retried.Error?.Code != CouchCoopGeoclipProvider.RefusedCachedCode,
            "…and adopts it rather than replaying the remembered 404");

        // The rig lane reads the receipt at its own call site, and it is the PRERENDER sweep's lane — the one that
        // walks a whole catalog on a headless host and would otherwise skip every identity it poisoned.
        using var rigScope = new StoreScope(armOnDemand: true);
        var rigRequest = Request("headless_refused_rig_lane.tscn", "idle_loop");
        var rigKey = CouchCoopGeoclipStore.BuildGeoclipKey(rigRequest.SpineKey);
        Directory.CreateDirectory(rigScope.Store.RefusalsPath!);
        await File.WriteAllTextAsync(
            Path.Combine(rigScope.Store.RefusalsPath!, CouchCoopGeoclipStore.RefusalFileNameFor(rigKey)),
            ReceiptJson(rigKey, PreFixHeadlessRefusalPolicyRevision));

        var rigBaker = new RecordingBaker();
        var rigResult = (await new CouchCoopGeoclipProvider(rigBaker, rigScope.Store, _ => { }).GetRigAsync([rigRequest]))[0];
        Expect(rigBaker.Calls == 1, $"…and so does the rig lane the sweep uses (baker calls {rigBaker.Calls})");
        Expect(rigResult.Refusal is null && rigResult.Error?.Code != CouchCoopGeoclipProvider.RefusedCachedCode,
            "…rather than reporting the pre-fix verdict a second time");

        // ── (2) THE CONTROL: the SAME file at the CURRENT revision still binds ──────────────────────────────
        // Without this half, "fails open" could be an accident of the receipt shape rather than of its revision.
        using var boundScope = new StoreScope(armOnDemand: true);
        var boundRequest = Request("headless_refused_at_current_revision.tscn", "idle_loop");
        var boundKey = CouchCoopGeoclipStore.BuildGeoclipKey(boundRequest.SpineKey);
        Directory.CreateDirectory(boundScope.Store.RefusalsPath!);
        await File.WriteAllTextAsync(
            Path.Combine(boundScope.Store.RefusalsPath!, CouchCoopGeoclipStore.RefusalFileNameFor(boundKey)),
            ReceiptJson(boundKey, CouchCoopGeoclipStore.RefusalPolicyRevision));

        var bound = boundScope.Store.TryReadRefusal(boundRequest.SpineKey);
        Expect(bound is { Reason: "incomplete", ClaimsProven: 38, ClaimsUnproven: 2 },
            "byte-for-byte the same receipt at the RUNNING revision parses and binds, counters and all");
        var boundBaker = new RecordingBaker();
        var suppressed = await new CouchCoopGeoclipProvider(boundBaker, boundScope.Store, _ => { }).GetAsync(boundRequest);
        Expect(boundBaker.Calls == 0 && suppressed.Error?.Code == CouchCoopGeoclipProvider.RefusedCachedCode,
            "…and suppresses the bake — so the half above is discriminating on the revision and nothing else");

        Expect(CouchCoopGeoclipStore.RefusalPolicyRevision != PreFixHeadlessRefusalPolicyRevision,
            "…which is only true because the revision moved off the one pre-fix headless hosts stamped");
    }

    private static async Task AMatchingRefusalPolicyRevisionSuppressesRebakeAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        var request = Request("matching_refusal_revision.tscn", "idle_loop");
        // PINNED ON PURPOSE, and it has to move in the same commit as the admission rule. A refusal receipt is
        // answered WITHOUT baking, so every remembered verdict on every host was reached by the previous rule;
        // leave the revision alone while the rule changes and each of those identities keeps returning the old
        // answer for ever — the new rule live, correct, and unreachable for exactly the bakes it was written to
        // admit. Bumping it fails them open. Successful `geo=1&gv=1` artifact addresses do not move.
        Expect(CouchCoopGeoclipStore.RefusalPolicyRevision == "geoclip-refusal/1",
            "repairing the headless bake — which flips every headless host's verdict on every rig — minted "
            + "refusal-policy revision 1");
        Expect(await scope.Store.RecordRefusalAsync(request.SpineKey, "foreign", "foreignMeshes=1"),
            "a current refusal receipt is recorded");

        var record = scope.Store.TryReadRefusal(request.SpineKey);
        Expect(record?.RefusalPolicyRevision == CouchCoopGeoclipStore.RefusalPolicyRevision,
            "a receipt carries the distinct refusal-policy revision");

        var baker = new RecordingBaker();
        var result = (await new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }).GetRigAsync([request]))[0];
        Expect(result.Refusal is { Cached: true } && result.Error?.Code == CouchCoopGeoclipProvider.RefusedCachedCode,
            "a receipt at the current refusal-policy revision suppresses a rig-lane rebake");
        Expect(baker.Calls == 0, "the matching durable receipt performs no rig bake");
    }

    private static async Task AForeignRefusalPolicyReceiptRetriesAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        var request = Request("obsolete_refusal_revision.tscn", "idle_loop");
        Expect(await scope.Store.RecordRefusalAsync(request.SpineKey, "foreign", "foreignMeshes=1"),
            "a receipt exists before it is made obsolete");

        var receipt = Path.Combine(
            scope.Store.RefusalsPath!,
            CouchCoopGeoclipStore.RefusalFileNameFor(CouchCoopGeoclipStore.BuildGeoclipKey(request.SpineKey)));
        var obsolete = JsonNode.Parse(await File.ReadAllTextAsync(receipt))!;
        obsolete["refusalPolicyRevision"] = "geoclip-refusal/2";
        await File.WriteAllTextAsync(receipt, obsolete.ToJsonString());

        Expect(scope.Store.TryReadRefusal(request.SpineKey) is null,
            "the obsolete attachment-category refusal receipt fails open rather than binding forever");
        var baker = new RecordingBaker();
        var retried = await new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }).GetAsync(request);
        Expect(retried.CacheStatus == "MISS" && baker.Calls == 1 && retried.Refusal is null,
            "the obsolete refusal is re-baked and a successful artifact is adopted");

        using var missingScope = new StoreScope(armOnDemand: true);
        var missingRequest = Request("missing_refusal_revision.tscn", "idle_loop");
        Expect(await missingScope.Store.RecordRefusalAsync(missingRequest.SpineKey, "foreign", "foreignMeshes=1"),
            "a receipt exists before its policy revision is removed");
        var missingReceipt = Path.Combine(
            missingScope.Store.RefusalsPath!,
            CouchCoopGeoclipStore.RefusalFileNameFor(CouchCoopGeoclipStore.BuildGeoclipKey(missingRequest.SpineKey)));
        var fieldless = JsonNode.Parse(await File.ReadAllTextAsync(missingReceipt))!;
        fieldless.AsObject().Remove("refusalPolicyRevision", out _);
        await File.WriteAllTextAsync(missingReceipt, fieldless.ToJsonString());

        Expect(missingScope.Store.TryReadRefusal(missingRequest.SpineKey) is null,
            "a field-less receipt also fails open rather than binding forever");
        var missingBaker = new RecordingBaker();
        var missingRetried = await new CouchCoopGeoclipProvider(missingBaker, missingScope.Store, _ => { }).GetAsync(missingRequest);
        Expect(missingRetried.CacheStatus == "MISS" && missingBaker.Calls == 1 && missingRetried.Refusal is null,
            "the field-less refusal is re-baked and a successful artifact is adopted");
    }

    private static async Task ARefusalPolicyRevisionLeavesCompleteArtifactsAddressableAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        var request = Request("complete_artifact_refusal_revision.tscn", "idle_loop");
        var adopted = await scope.Store.AdoptAsync(request.SpineKey, scope.WriteBake("page-0.png", PagePixels(91)));
        Expect(adopted.Success && adopted.Directory is not null, "a complete artifact is stored at the existing gv address");
        Expect(CouchCoopGeoclipStore.GeoclipSelector == "&geo=1&gv=1",
            "the refusal-policy correction does not change successful geoclip artifact addressing");
        Expect(CouchCoopGeoclipStore.BuildGeoclipKey(request.SpineKey).EndsWith(CouchCoopGeoclipStore.GeoclipSelector, StringComparison.Ordinal),
            "the refusal revision does not alter the geoclip artifact selector");

        // A receipt is never allowed to obscure a completed artifact: the positive probe stays first, so a
        // refusal-policy revision can invalidate refusals without moving or hiding already-good content.
        Expect(await scope.Store.RecordRefusalAsync(request.SpineKey, "foreign", "foreignMeshes=1"),
            "a contradictory receipt can be represented for the precedence check");
        var served = await new CouchCoopGeoclipProvider(new RefusingBaker(), scope.Store, _ => { }).GetAsync(request);
        Expect(served.CacheStatus == "HIT" && served.Directory == adopted.Directory && served.Refusal is null,
            "the existing complete artifact remains addressable before any refusal receipt is considered");
    }

    // The selector stays a guard on the artifact identity: a copied receipt from a different selector still cannot
    // bind this identity. Refusal-policy revisions are the separate lever that retries old admission verdicts.
    private static async Task AForeignArtifactSelectorReceiptRetriesAsync()
    {
        var spineKey = Key("policy.tscn", "idle_loop");

        // (1) THE ADDRESS. A receipt is named by the hash of the existing artifact key; this remains the gv=1
        // address while refusal-policy compatibility is carried by its separate persisted revision.
        var atGv1 = CouchCoopGeoclipStore.RefusalFileNameFor(CouchCoopGeoclipStore.BuildGeoclipKey(spineKey));
        Expect(
            Path.GetFileNameWithoutExtension(atGv1)
                == CouchCoopGeoclipStore.DirectoryNameFor(CouchCoopGeoclipStore.BuildGeoclipKey(spineKey)),
            "…and the positive and negative sides of the cache share one address, so they can never disagree about "
            + "which identity they mean");
        Expect(atGv1.EndsWith(".json", StringComparison.Ordinal), "a receipt is JSON, and its suffix is not servable");

        // (2) THE ARTIFACT SELECTOR remains a belt: a receipt minted under another selector is IGNORED rather
        // than obeyed, even when its separate refusal-policy revision is current.
        using var scope = new StoreScope(armOnDemand: true);
        var baker = new RecordingBaker(complete: false);
        var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });
        Expect((await provider.GetAsync(Request("policy.tscn", "idle_loop"))).Refusal is { Cached: false }, "the first ask is refused");
        Expect((await provider.GetAsync(Request("policy.tscn", "idle_loop"))).Refusal is { Cached: true }, "…and remembered");
        Expect(baker.Calls == 1, "…so far one bake");

        var receipt = Path.Combine(scope.Store.RefusalsPath!, atGv1);
        var stale = JsonNode.Parse(await File.ReadAllTextAsync(receipt))!;
        stale["policy"] = "&geo=1&gv=0";
        stale["refusalPolicyRevision"] = CouchCoopGeoclipStore.RefusalPolicyRevision;
        await File.WriteAllTextAsync(receipt, stale.ToJsonString());

        Expect(scope.Store.TryReadRefusal(spineKey) is null,
            "a receipt from another artifact selector fails open even with the current refusal-policy revision");
        var retried = await provider.GetAsync(Request("policy.tscn", "idle_loop"));
        Expect(baker.Calls == 2, $"…so the identity is BAKED AGAIN (baker calls {baker.Calls})");
        Expect(retried.Refusal is { Cached: false }, "…and re-decided from scratch rather than reported from the stale receipt");
        Expect(scope.Store.TryReadRefusal(spineKey)?.Policy == CouchCoopGeoclipStore.GeoclipSelector,
            "…and the receipt is rewritten under the running selector, so the retry is once, not once per request");

        // (3) IT FAILS OPEN. An unreadable receipt means "bake it", never "suppress it forever" — the cost of a
        // wrong retry is one bake, the cost of a wrong suppression is a creature that can never be produced.
        await File.WriteAllTextAsync(receipt, "{ this is not json");
        Expect(scope.Store.TryReadRefusal(spineKey) is null, "a corrupt receipt reads as no receipt");
        Expect((await provider.GetAsync(Request("policy.tscn", "idle_loop"))).Refusal is { Cached: false }, "…and the bake is retried");
        Expect(baker.Calls == 3, $"…for real (baker calls {baker.Calls})");

        await File.WriteAllTextAsync(receipt, "{\"key\":\"k\",\"policy\":\"&geo=1&gv=1\",\"reason\":\"\",\"detail\":\"d\"}");
        Expect(scope.Store.TryReadRefusal(spineKey) is null, "…as does a receipt with no reason in it");
        Expect(scope.Store.TryReadRefusal(Key("never_refused.tscn", "idle_loop")) is null, "an identity nobody refused has no receipt");
        Expect(!scope.Store.HasRefusal(Key("never_refused.tscn", "idle_loop")), "…and the cheap presence probe agrees");
    }

    // The two markers are contradictory verdicts about one identity. If a rig that was refused later bakes clean
    // — a better baker, a fixed freeze exemption, a game update — the pose is what the store holds, and a reader
    // listing the cache must not find a refusal note beside it saying otherwise.
    private static async Task AGoodBakeRetiresAnEarlierRefusalAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        var spineKey = Key("recovered.tscn", "idle_loop");
        Expect(await scope.Store.RecordRefusalAsync(spineKey, "foreign", "foreignMeshes=8"), "the refusal is recorded");
        Expect(scope.Store.HasRefusal(spineKey) && scope.Store.TryReadRefusal(spineKey) is not null, "…and is binding");

        var adopted = await scope.Store.AdoptAsync(spineKey, scope.WriteBake("page-0.png", PagePixels(13)));
        Expect(adopted.Success && scope.Store.TryResolveDirectory(spineKey) is not null, "a later bake adopts");
        Expect(scope.Store.TryReadRefusal(spineKey) is null, "…and the refusal receipt is gone");
        Expect(!scope.Store.HasRefusal(spineKey), "…from disk, not merely ignored");

        // And the provider serves the pose rather than the stale verdict, with a baker that would throw.
        var served = await new CouchCoopGeoclipProvider(new RefusingBaker(), scope.Store, _ => { })
            .GetAsync(Request("recovered.tscn", "idle_loop"));
        Expect(served.CacheStatus == "HIT" && served.Directory == adopted.Directory && served.Refusal is null,
            "the stored pose wins: the store probe runs before the refusal probe, so a recovered identity serves");
    }

    // ── Harness ────────────────────────────────────────────────────────────────────────────────────────────

    private static string Key(string scene, string anim)
        => CouchCoopSpineClipProvider.BuildSpineKey($"res://{scene}", "Visuals/Spine", anim);

    private static CouchCoopGeoclipRequest Request(string scene, string anim)
        => new(Key(scene, anim), $"res://{scene}", "Visuals/Spine", anim);

    // Deterministic per-seed "atlas" bytes. Only the byte identity matters — nothing here decodes a PNG.
    private static byte[] PagePixels(int seed)
        => [0x89, 0x50, 0x4E, 0x47, (byte)seed, (byte)(seed * 3), (byte)(seed * 7), 0x00];

    private static async Task WaitUntilAsync(Func<bool> condition, string what)
    {
        for (var attempt = 0; attempt < 500; attempt++)
        {
            if (condition())
            {
                return;
            }

            await Task.Delay(10);
        }

        throw new InvalidOperationException("geoclip store expectation failed: timed out waiting until " + what);
    }

    /// <summary>A store on a throwaway cache root.</summary>
    private sealed class StoreScope : IDisposable
    {
        private readonly string _cacheRoot = Path.Combine(Path.GetTempPath(), "couchcoop-geoclip-store-" + Guid.NewGuid().ToString("N"));
        public StoreScope(bool armOnDemand = false)
        {
            Store = new CouchCoopGeoclipStore(_cacheRoot);
        }

        public CouchCoopGeoclipStore Store { get; }

        /// <summary>A directory shaped like a geoclip/1 bake: a manifest, its page, optionally a verts blob.</summary>
        public string WriteBake(
            string pageFileName,
            byte[] pageBytes,
            byte[]? verts = null,
            string? pageSha256 = null,
            bool writePage = true)
        {
            var directory = Path.Combine(_cacheRoot, "bakes", Guid.NewGuid().ToString("N"));
            WriteBakeInto(directory, pageFileName, pageBytes, verts, pageSha256, writePage);
            return directory;
        }

        /// <param name="pageSha256">
        /// The producer's declared content id for the page, as a real bake now emits. Null omits the key, which
        /// is what a bake that never had the bytes in hand writes.
        /// </param>
        /// <param name="writePage">
        /// False reproduces the bake that was TOLD this store already holds the page: the manifest describes it
        /// and the PNG is not there. The adopt has to resolve it from <paramref name="pageSha256"/> or fail.
        /// </param>
        public static void WriteBakeInto(
            string directory,
            string pageFileName,
            byte[] pageBytes,
            byte[]? verts = null,
            string? pageSha256 = null,
            bool writePage = true)
        {
            Directory.CreateDirectory(directory);
            File.WriteAllText(
                Path.Combine(directory, "manifest.json"),
                JsonSerializer.Serialize(new
                {
                    meta = new { schema = "geoclip/1", frameCount = 1 },
                    pages = new[] { new { id = 0, file = pageFileName, width = 4, height = 4, sha256 = pageSha256 } },
                    parts = Array.Empty<object>(),
                    frames = Array.Empty<object>(),
                }));
            if (writePage)
            {
                File.WriteAllBytes(Path.Combine(directory, pageFileName), pageBytes);
            }
            File.WriteAllBytes(Path.Combine(directory, "verts.bin"), verts ?? [0, 0]);
        }

        public void Dispose()
        {
            try { Directory.Delete(_cacheRoot, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    // WHERE THE BAKE LANDED vs WHERE WE ASKED FOR IT. The real producer nests its artifacts one level below the
    // output directory, so the provider has to adopt the directory the outcome NAMES rather than the staging root
    // it handed over. This is the live defect W5 found: every on-demand request baked for seconds and then 404'd,
    // because the adopt looked for `staging/manifest.json` and the manifest was at
    // `staging/<rig>--<node>--<anim>/manifest.json`. Both legal shapes are covered, plus the containment guard —
    // the manifest path comes from another assembly and it SELECTS the directory the store publishes.
    private static async Task ANestedBakeIsAdoptedAndAnEscapingManifestIsRefusedAsync()
    {
        using var scope = new StoreScope(armOnDemand: true);
        var nesting = new CouchCoopGeoclipProvider(new RecordingBaker(), scope.Store, _ => { });
        var nested = await nesting.GetAsync(Request("nested.tscn", "idle_loop"));
        Expect(nested.Error is null && nested.Directory is not null,
            $"a bake nested under staging is adopted (got {nested.Error?.Code ?? "no error"})");
        Expect(File.Exists(Path.Combine(nested.Directory!, CouchCoopGeoclipStore.ManifestFileName)),
            "…manifest and all");

        var flat = new CouchCoopGeoclipProvider(new RecordingBaker(nest: false), scope.Store, _ => { });
        var written = await flat.GetAsync(Request("flat.tscn", "idle_loop"));
        Expect(written.Error is null && written.Directory is not null,
            $"a bake written straight into the staging root is adopted too (got {written.Error?.Code ?? "no error"})");

        var staging = Path.Combine("/tmp", "staging-root");
        Expect(CouchCoopGeoclipProvider.ResolveProducedDirectory(staging, Path.Combine(staging, "m.json")) is not null,
            "the staging root itself resolves");
        Expect(
            CouchCoopGeoclipProvider.ResolveProducedDirectory(staging, Path.Combine(staging, "rig--n--a", "m.json"))
                == Path.Combine(staging, "rig--n--a"),
            "a nested target directory resolves to itself");
        Expect(CouchCoopGeoclipProvider.ResolveProducedDirectory(staging, "/tmp/elsewhere/m.json") is null,
            "a manifest OUTSIDE staging is refused rather than adopted");
        Expect(CouchCoopGeoclipProvider.ResolveProducedDirectory(staging, Path.Combine(staging, "..", "m.json")) is null,
            "…including one that walks out of it");
        Expect(CouchCoopGeoclipProvider.ResolveProducedDirectory(staging, null) is null, "no manifest, no adopt");
    }

    /// <summary>
    /// A baker that writes a plausible bake into the output directory it is handed, counts its calls, and can be
    /// held open so the single-flight window is real rather than assumed.
    /// </summary>
    /// <param name="slots">Slots visible at the pose; <paramref name="associated"/> defaults to matching it.</param>
    /// <param name="nest">
    /// NESTS the artifacts in a per-target subdirectory of the output directory, and defaults to doing so because
    /// THAT IS WHAT THE REAL PRODUCER DOES (spirectl's baker writes
    /// <c>&lt;out&gt;/&lt;rig&gt;--&lt;node&gt;--&lt;anim&gt;/manifest.json</c>). A double that wrote flat passed
    /// this whole file while the live route 404'd every single request, because the provider adopted the staging
    /// root and found no manifest there. Set false only to cover the other legal shape.
    /// </param>
    private sealed class RecordingBaker(
        ManualResetEventSlim? hold = null,
        bool complete = true,
        int slots = 28,
        int? associated = null,
        int foreignMeshes = 0,
        bool nest = true,
        int claimsProven = 0,
        int claimsUnproven = 0) : ICouchCoopGeoclipBaker
    {
        private int _calls;

        public int Calls => Volatile.Read(ref _calls);

        public CouchCoopGeoclipBakeCommand? LastCommand { get; private set; }

        public string? LastOutputDirectory { get; private set; }

        public CouchCoopGeoclipBakeOutcome Bake(CouchCoopGeoclipBakeCommand command)
        {
            Interlocked.Increment(ref _calls);
            LastCommand = command;
            LastOutputDirectory = Path.GetFileName(command.OutputDirectory);
            hold?.Wait();

            // A partial bake still WRITES a well-formed directory — that is the whole hazard, so the fake must
            // reproduce it rather than conveniently writing nothing.
            var written = nest
                ? Path.Combine(command.OutputDirectory, TargetDirectoryName(command))
                : command.OutputDirectory;
            StoreScope.WriteBakeInto(written, "page-0.png", PagePixels(42));
            return new CouchCoopGeoclipBakeOutcome(
                true,
                Path.Combine(written, "manifest.json"),
                ["page-0.png"],
                PartCount: 3,
                FrameCount: 1,
                SampleTimeSeconds: 0.5d,
                SampleTimeSource: "mid",
                ElapsedMs: 1L,
                ErrorCode: null,
                ErrorMessage: null,
                Complete: complete,
                SlotsEverVisible: slots,
                Associated: associated ?? slots,
                ForeignMeshes: foreignMeshes,
                ClaimsProven: claimsProven,
                ClaimsUnproven: claimsUnproven);
        }

        private static string TargetDirectoryName(CouchCoopGeoclipBakeCommand command)
            => GeoclipStoreTests.TargetDirectoryName(command, command.AnimationName);
    }

    // The shape spirectl's Sts2SpineGeoClipSpec.DirectoryName mints: "<rig>--<node>--<anim>". Only the SHAPE
    // matters here (a subdirectory whose name the caller cannot predict), not the exact spelling. Taken per
    // ANIMATION rather than off the command, because a rig bake writes one of these per pose from a command that
    // names only the first.
    private static string TargetDirectoryName(CouchCoopGeoclipBakeCommand command, string animation)
    {
        var scene = command.SceneResPath;
        var slash = scene.LastIndexOf('/');
        if (slash >= 0)
        {
            scene = scene[(slash + 1)..];
        }

        var dot = scene.LastIndexOf('.');
        if (dot > 0)
        {
            scene = scene[..dot];
        }

        return $"{scene}--{command.NodePath ?? "root"}--{animation}";
    }

    /// <summary>
    /// How ONE pose's sweep came out. Drives the completeness counters AND the two sweep counters the
    /// retryability rule reads, so a test states one coherent story rather than a pair that could not co-occur.
    /// </summary>
    /// <param name="MeshesValidated">
    /// Meshes the RID sweep validated. Below <paramref name="SlotsVisible"/> is the shortfall this round is
    /// about; 0 is the older bridge that reports no counters at all.
    /// </param>
    /// <param name="SweepTruncated">A window hit its own candidate cap, so the sweep never finished its plan.</param>
    /// <param name="Complete">
    /// Null derives it the way the producer does — a sweep that validated a mesh for every visible slot and
    /// associated every one of them is complete. Set explicitly only to cover "incomplete for some other reason".
    /// </param>
    private sealed record SweepScript(
        string Animation,
        int SlotsVisible = 44,
        int Associated = 44,
        int ForeignMeshes = 0,
        int MeshesValidated = 44,
        bool SweepTruncated = false,
        int ClaimsProven = 0,
        int ClaimsUnproven = 0,
        bool? Complete = null)
    {
        public bool IsComplete => Complete ?? (Associated >= SlotsVisible && MeshesValidated >= SlotsVisible);
    }

    /// <summary>
    /// A producer whose SWEEP is scripted per pose, mapped through the real seam so the counters have to survive
    /// <see cref="CouchCoopRuntimeGeoclipBaker.Map"/> and <see cref="CouchCoopRuntimeGeoclipBaker.MapPose"/> to
    /// reach the rule. <see cref="RecordingBaker"/> answers in couch types directly and so cannot catch a mapper
    /// that drops a field.
    /// </summary>
    /// <param name="producerJudges">
    /// False leaves the producer's refusal fields unset, which is the older bridge (and the per-pose-only refusal)
    /// that couch's own backstop has to catch. The provider must then treat the refusal as STICKY however
    /// <paramref name="producerClaimsRetryable"/> is set, because the flag is not about this bake.
    /// </param>
    /// <param name="producerClaimsRetryable">Null derives it as spirectl does; set to force the boundary.</param>
    private sealed class SweepBaker(
        IReadOnlyList<SweepScript> scripts,
        bool producerJudges = true,
        bool? producerClaimsRetryable = null) : ICouchCoopGeoclipBaker
    {
        private int _calls;

        public int Calls => Volatile.Read(ref _calls);

        public CouchCoopGeoclipBakeOutcome Bake(CouchCoopGeoclipBakeCommand command)
        {
            Interlocked.Increment(ref _calls);
            var wanted = command.AnimationNames ?? [command.AnimationName];
            var poses = new List<SpineGeoClipBakePoseSnapshot>(wanted.Count);
            foreach (var animation in wanted)
            {
                var script = scripts.First(candidate => candidate.Animation == animation);
                // A partial bake still writes a WELL-FORMED directory — that is the whole hazard.
                var written = Path.Combine(command.OutputDirectory, TargetDirectoryName(command, animation));
                StoreScope.WriteBakeInto(written, "page-0.png", PagePixels(42));
                poses.Add(new SpineGeoClipBakePoseSnapshot(
                    AnimationName: animation,
                    Success: true,
                    ManifestPath: Path.Combine(written, "manifest.json"),
                    PageFileNames: ["page-0.png"],
                    PartCount: script.MeshesValidated,
                    FrameCount: 1,
                    SampleTimeSeconds: 0.5d,
                    SampleTimeSource: "mid",
                    Slots: script.SlotsVisible + 8,
                    SlotsVisible: script.SlotsVisible,
                    Associated: script.Associated,
                    Unassociated: script.SlotsVisible - script.Associated,
                    ForeignMeshes: script.ForeignMeshes,
                    StaleMeshFrames: 0,
                    AttachmentDriftSlots: 0,
                    Complete: script.IsComplete,
                    Batched: wanted.Count > 1,
                    FailureReason: null,
                    ClaimsProven: script.ClaimsProven,
                    ClaimsUnproven: script.ClaimsUnproven,
                    MeshesValidated: script.MeshesValidated,
                    SweepTruncated: script.SweepTruncated));
            }

            // The top-level fields are the PRIMARY pose's, as they are upstream. The refusal verdict follows
            // spirectl's own walk: one adoptable pose makes the whole result adoptable, otherwise the FIRST
            // refused pose's reason and ITS counters are what the top-level flag describes.
            var head = scripts.First(candidate => candidate.Animation == poses[0].AnimationName);
            var mappedPoses = poses.Select(CouchCoopRuntimeGeoclipBaker.MapPose).ToArray();
            var refused = Array.Find(mappedPoses, pose => CouchCoopGeoclipProvider.IncompletenessReason(pose) is not null);
            var verdict = mappedPoses.Any(pose => CouchCoopGeoclipProvider.IncompletenessReason(pose) is null)
                ? null
                : refused;
            var reason = verdict is null ? null : CouchCoopGeoclipProvider.IncompletenessReason(verdict);

            return CouchCoopRuntimeGeoclipBaker.Map(new SpineGeoClipBakeResultSnapshot(
                Success: true,
                ManifestPath: poses[0].ManifestPath,
                PageFileNames: ["page-0.png"],
                PartCount: head.MeshesValidated,
                FrameCount: 1,
                SampleTimeSeconds: 0.5d,
                SampleTimeSource: "mid",
                ElapsedMs: 1d,
                Slots: head.SlotsVisible + 8,
                SlotsVisible: head.SlotsVisible,
                Associated: head.Associated,
                Unassociated: head.SlotsVisible - head.Associated,
                ForeignMeshes: head.ForeignMeshes,
                Complete: head.IsComplete,
                Error: null,
                Poses: poses,
                ScenesLoaded: 1,
                BatchNote: wanted.Count > 1 ? "batched" : "single",
                RefusalArm: producerJudges && reason is not null ? CouchCoopGeoclipProvider.ClassifyRefusal(reason) : null,
                RefusalReason: producerJudges ? reason : null,
                ClaimsProven: head.ClaimsProven,
                ClaimsUnproven: head.ClaimsUnproven,
                MeshesValidated: head.MeshesValidated,
                SweepTruncated: head.SweepTruncated,
                RefusalRetryable: producerClaimsRetryable
                    ?? (verdict is not null && CouchCoopGeoclipProvider.IsRetryableAcquisitionShortfall(verdict))));
        }
    }

    private sealed class RefusingBaker : ICouchCoopGeoclipBaker
    {
        public CouchCoopGeoclipBakeOutcome Bake(CouchCoopGeoclipBakeCommand command)
            => throw new InvalidOperationException("this baker must never be called");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException("geoclip store expectation failed: " + because);
        }
    }
}
