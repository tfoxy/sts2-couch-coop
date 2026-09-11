using System.Net;
using System.Net.Sockets;
using System.Text;
using CouchCoop.Mod.Server;

/// <summary>
/// The DEV-ONLY <c>/geoclips/</c> artifact route: its filesystem policy (<see cref="CouchCoopGeoclipDirectory"/>)
/// and the live route over a real loopback socket.
/// </summary>
/// <remarks>
/// The load-bearing assertion is the FIRST one: with <c>COUCHCOOP_GEOCLIPS_DIR</c> unset the route 404s and the
/// host is otherwise untouched. Everything after it only matters once an operator has opted in.
/// </remarks>
internal static class GeoclipRouteTests
{
    public static async Task RunAsync()
    {
        AssertFileWhitelist();
        AssertKeySanitization();
        await AssertManagedStoreRootAsync();
        await AssertRefusalHeaderAsync();

        var root = Path.Combine(Path.GetTempPath(), "couchcoop-geoclips-" + Guid.NewGuid().ToString("N"));
        var staticRoot = Path.Combine(Path.GetTempPath(), "couchcoop-geoclip-static-" + Guid.NewGuid().ToString("N"));
        var previous = Environment.GetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar);
        try
        {
            Directory.CreateDirectory(staticRoot);
            File.WriteAllText(Path.Combine(staticRoot, "index.html"), "<!doctype html><div>spa-index</div>");
            Directory.CreateDirectory(root);

            // The canonical key for one animated clip identity, computed by the SERVER's own builder — the test
            // must never spell a spine:// key by hand, or it would stop testing the route's agreement with /spines/.
            var key = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/creature.tscn", "Visuals/Spine", "idle_loop");
            var sanitized = CouchCoopGeoclipDirectory.SanitizeKey(key);
            var clipDir = Path.Combine(root, sanitized);
            Directory.CreateDirectory(clipDir);
            File.WriteAllText(Path.Combine(clipDir, "manifest.json"), "{\"meta\":{\"schema\":\"geoclip/1\"}}");
            File.WriteAllBytes(Path.Combine(clipDir, "verts.bin"), [1, 0, 2, 0]);
            File.WriteAllBytes(Path.Combine(clipDir, "sheet-0.png"), [0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]);

            // A SECOND identity whose bake directory the baker named itself — reachable only through map.json.
            var mappedKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/boss.tscn", null, "fly");
            var mappedDir = Path.Combine(root, "byrdonis-fly");
            Directory.CreateDirectory(mappedDir);
            File.WriteAllText(Path.Combine(mappedDir, "manifest.json"), "{\"meta\":{\"schema\":\"geoclip/1\"}}");
            File.WriteAllBytes(Path.Combine(mappedDir, "verts.bin"), [1, 0, 2, 0]);
            File.WriteAllBytes(Path.Combine(mappedDir, "sheet-0.png"), [0x89, 0x50, 0x4E, 0x47, 9]);
            File.WriteAllText(
                Path.Combine(root, CouchCoopGeoclipDirectory.MapFileName),
                $"{{{System.Text.Json.JsonSerializer.Serialize(mappedKey)}:\"byrdonis-fly\"}}");

            // --- NO OPERATOR ROOT ------------------------------------------------------------------------------
            Environment.SetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar, null);
            Expect(CouchCoopGeoclipDirectory.TryResolveRoot() is null, "an unset COUCHCOOP_GEOCLIPS_DIR resolves no root");

            await using (var offServer = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new NullAssetAdapter(),
                preferredPort: 13590))
            {
                var offUri = await offServer.StartAsync();
                var off = await GetAsync(offUri, "/geoclips/" + Uri.EscapeDataString(key) + "/manifest.json");
                Expect(off.StatusLine.Contains("404", StringComparison.Ordinal), "the geoclip route 404s without a root or runtime host");
                Expect(off.Body.Contains("geoclip-not-found", StringComparison.Ordinal), "the missing artifact has the current not-found code");
                Expect(!off.Body.Contains("spa-index", StringComparison.Ordinal), "the geoclip route is reserved from the SPA fallback");
            }

            // --- OPERATOR ROOT -------------------------------------------------------------------------------
            Environment.SetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar, root);
            Expect(CouchCoopGeoclipDirectory.TryResolveRoot() is not null, "a configured, existing directory resolves as the root");
            Expect(
                CouchCoopGeoclipDirectory.TryResolveDirectory(root, key) == Path.GetFullPath(clipDir),
                "the sanitized key names the artifact directory directly");
            Expect(
                CouchCoopGeoclipDirectory.TryResolveDirectory(root, mappedKey) == Path.GetFullPath(mappedDir),
                "map.json redirects a key onto a differently-named bake directory");
            var rootAlias = Path.Combine(Path.GetDirectoryName(root)!, Path.GetFileName(root) + "-alias");
            Directory.CreateSymbolicLink(rootAlias, root);
            Expect(
                CouchCoopGeoclipDirectory.TryResolveDirectory(rootAlias, key) == Path.GetFullPath(clipDir),
                "a configured geoclip root symlink resolves legitimate artifacts");
            Expect(
                CouchCoopGeoclipDirectory.TryResolveDirectory(root, "no-such-key") is null,
                "an unknown key resolves nothing (no directory, no map entry)");
            Expect(
                CouchCoopGeoclipDirectory.TryResolveFile(root, key, "../map.json") is null,
                "a traversing file name is refused by the whitelist before any path is combined");
            var outsideArtifact = Path.Combine(staticRoot, "outside.png");
            File.WriteAllBytes(outsideArtifact, [1, 2, 3]);
            File.CreateSymbolicLink(Path.Combine(clipDir, "sheet-1.png"), outsideArtifact);
            Expect(
                CouchCoopGeoclipDirectory.TryResolveFile(root, key, "sheet-1.png") is null,
                "an artifact symlink escaping the geoclip root is refused");
            var outsideArtifactDirectory = Path.Combine(staticRoot, "outside-geoclip");
            Directory.CreateDirectory(outsideArtifactDirectory);
            File.WriteAllText(Path.Combine(outsideArtifactDirectory, "manifest.json"), "{\"secret\":true}");
            Directory.CreateSymbolicLink(Path.Combine(root, "escaped-pose"), outsideArtifactDirectory);
            Expect(
                CouchCoopGeoclipDirectory.TryResolveFile(root, "escaped-pose", "manifest.json") is null,
                "a geoclip pose directory symlink cannot escape the configured root");

            var mapSymlinkRoot = Path.Combine(root, "map-symlink-root");
            Directory.CreateDirectory(mapSymlinkRoot);
            var outsideMap = Path.Combine(staticRoot, CouchCoopGeoclipDirectory.MapFileName);
            File.WriteAllText(outsideMap, $"{{{System.Text.Json.JsonSerializer.Serialize(mappedKey)}:\"byrdonis-fly\"}}");
            File.CreateSymbolicLink(Path.Combine(mapSymlinkRoot, CouchCoopGeoclipDirectory.MapFileName), outsideMap);
            Expect(
                CouchCoopGeoclipDirectory.TryResolveDirectory(mapSymlinkRoot, mappedKey) is null,
                "map.json is not read through a symlink that escapes the geoclip root");

            await using var server = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new NullAssetAdapter(),
                preferredPort: 13591);
            var baseUri = await server.StartAsync();

            var manifest = await GetAsync(baseUri, "/geoclips/" + Uri.EscapeDataString(key) + "/manifest.json");
            Expect(manifest.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the operator form serves a manifest by percent-encoded spine key");
            Expect(manifest.Body.Contains("geoclip/1", StringComparison.Ordinal), "the manifest body is the file on disk");
            Expect(
                manifest.Headers.TryGetValue("Content-Type", out var manifestType) && manifestType.StartsWith("application/json", StringComparison.Ordinal),
                "a manifest is served as JSON");
            Expect(
                manifest.Headers.TryGetValue("Cache-Control", out var manifestCache) && manifestCache == "no-store",
                "geoclip artifacts are no-store so a re-bake is picked up on reload");

            var byDirName = await GetAsync(baseUri, "/geoclips/" + sanitized + "/manifest.json");
            Expect(byDirName.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the operator form also accepts the bare directory name (the curl path)");

            var mapped = await GetAsync(baseUri, "/geoclips/byrdonis-fly/verts.bin");
            Expect(mapped.StatusLine.Contains("200 OK", StringComparison.Ordinal), "verts.bin is served for the mapped directory");
            Expect(
                mapped.Headers.TryGetValue("Content-Type", out var vertsType) && vertsType == "application/octet-stream",
                "verts.bin is served as an opaque binary");

            var sheet = await GetAsync(baseUri, "/geoclips/byrdonis-fly/sheet-0.png");
            Expect(sheet.StatusLine.Contains("200 OK", StringComparison.Ordinal), "a packed geoclip/1 sheet is served");
            Expect(
                sheet.Headers.TryGetValue("Content-Type", out var sheetType) && sheetType == "image/png",
                "a sheet is served as a PNG");

            // The CLIENT form: the browser sends the same readable selectors it sends /spines/, and the server
            // mints the key. Landing on the SAME bytes as the operator form is the whole contract.
            var viaScene = await GetAsync(baseUri, "/geoclips/scenes/creature.tscn?node=Visuals%2FSpine&anim=idle_loop&file=manifest.json");
            Expect(viaScene.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the client form resolves the same artifact from scene+node+anim");
            Expect(viaScene.Body == manifest.Body, "both addressing forms serve byte-identical bodies (one key computation)");

            var viaSceneMapped = await GetAsync(baseUri, "/geoclips/scenes/boss.tscn?anim=fly&file=manifest.json");
            Expect(viaSceneMapped.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the client form works for a node-less identity through map.json");

            var missingAnim = await GetAsync(baseUri, "/geoclips/scenes/creature.tscn?node=Visuals%2FSpine&file=manifest.json");
            Expect(missingAnim.StatusLine.Contains("400", StringComparison.Ordinal), "the client form requires an anim (a geoclip has no still form)");
            Expect(missingAnim.Body.Contains("invalid-geoclip-route", StringComparison.Ordinal), "the 400 is the structured route error");

            var unknownFile = await GetAsync(baseUri, "/geoclips/" + sanitized + "/secrets.txt");
            Expect(unknownFile.StatusLine.Contains("404", StringComparison.Ordinal), "a file outside the artifact whitelist is not served");
            Expect(unknownFile.Body.Contains("geoclip-not-found", StringComparison.Ordinal), "an unserved file answers the not-found code");

            var traversal = await GetAsync(baseUri, "/geoclips/" + Uri.EscapeDataString("../..") + "/manifest.json");
            Expect(traversal.StatusLine.Contains("404", StringComparison.Ordinal), "a traversing key resolves nothing");

            var absolute = await GetAsync(baseUri, "/geoclips/" + Uri.EscapeDataString("/etc") + "/manifest.json");
            Expect(absolute.StatusLine.Contains("404", StringComparison.Ordinal), "an absolute key resolves nothing");

            var noFile = await GetAsync(baseUri, "/geoclips/" + sanitized);
            Expect(noFile.StatusLine.Contains("400", StringComparison.Ordinal), "a key with no artifact segment is a route error");
        }
        finally
        {
            Environment.SetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar, previous);
            try { Directory.Delete(root, recursive: true); } catch (IOException) { }
            try { Directory.Delete(Path.Combine(Path.GetDirectoryName(root)!, Path.GetFileName(root) + "-alias")); } catch (IOException) { }
            try { Directory.Delete(staticRoot, recursive: true); } catch (IOException) { }
        }

        Console.WriteLine("geoclip route: ok");
    }

    /// <summary>
    /// The route's SECOND root: the managed <see cref="CouchCoopGeoclipStore"/>. Three properties, over real
    /// loopback sockets — the operator root still WINS, the store serves what the operator root does not have,
    /// and only a content-addressed page gets an immutable Cache-Control. Plus the load-bearing negative: with
    /// neither root present and production disarmed, the route 404s and creates nothing.
    /// </summary>
    private static async Task AssertManagedStoreRootAsync()
    {
        var cacheRoot = Path.Combine(Path.GetTempPath(), "couchcoop-geoclip-managed-" + Guid.NewGuid().ToString("N"));
        var operatorRoot = Path.Combine(Path.GetTempPath(), "couchcoop-geoclip-operator-" + Guid.NewGuid().ToString("N"));
        var staticRoot = Path.Combine(Path.GetTempPath(), "couchcoop-geoclip-static2-" + Guid.NewGuid().ToString("N"));
        var previous = Environment.GetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar);
        var store = new CouchCoopGeoclipStore(cacheRoot);
        try
        {
            Directory.CreateDirectory(staticRoot);
            File.WriteAllText(Path.Combine(staticRoot, "index.html"), "<!doctype html><div>spa-index</div>");

            // --- NO STORE -----------------------------------------------------------------------------------
            Environment.SetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar, null);
            var storeOnlyKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/store_only.tscn", "Visuals/Spine", "idle_loop");
            await using (var bare = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new NullAssetAdapter(),
                preferredPort: 13592,
                resourceCacheRoot: cacheRoot))
            {
                var bareUri = await bare.StartAsync();
                var off = await GetAsync(bareUri, "/geoclips/scenes/store_only.tscn?node=Visuals%2FSpine&anim=idle_loop&file=manifest.json");
                Expect(off.StatusLine.Contains("404", StringComparison.Ordinal), "with no operator root and an empty store the route 404s exactly as before");
                Expect(off.Body.Contains("geoclip-not-found", StringComparison.Ordinal), "…with the current not-found code");
                Expect(!Directory.Exists(store.RootPath!), "…and WITHOUT creating the managed store root: no filesystem touch");
            }

            // --- STORE ONLY ---------------------------------------------------------------------------------
            var storeAdopt = await store.AdoptAsync(storeOnlyKey, WriteBake(cacheRoot, [0x89, 0x50, 0x4E, 0x47, 5, 5]));
            Expect(storeAdopt.Success, "the managed store adopts a bake");
            var pageName = storeAdopt.PageFiles.Single();

            await using (var storeServer = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new NullAssetAdapter(),
                preferredPort: 13593,
                resourceCacheRoot: cacheRoot))
            {
                var storeUri = await storeServer.StartAsync();
                var manifest = await GetAsync(storeUri, "/geoclips/scenes/store_only.tscn?node=Visuals%2FSpine&anim=idle_loop&file=manifest.json");
                Expect(manifest.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the managed store serves a manifest with NO operator root configured");
                Expect(manifest.Body.Contains(pageName, StringComparison.Ordinal), "the served manifest is the ADOPTED one, pointing at the content-addressed page");
                Expect(
                    manifest.Headers.TryGetValue("Cache-Control", out var manifestCache) && manifestCache == "no-store",
                    "a pose manifest stays no-store — its client-form URL carries no policy version, so a gv bump must be able to change it");

                var page = await GetAsync(storeUri, $"/geoclips/scenes/store_only.tscn?node=Visuals%2FSpine&anim=idle_loop&file={pageName}");
                Expect(page.StatusLine.Contains("200 OK", StringComparison.Ordinal), "a shared page resolves through the pages/ fallback (it is not in the pose directory)");
                Expect(
                    page.Headers.TryGetValue("Cache-Control", out var pageCache) && pageCache == "public, max-age=31536000, immutable",
                    "a CONTENT-ADDRESSED page may be cached forever — its URL names its own bytes");
                Expect(
                    page.Headers.TryGetValue("Content-Type", out var pageType) && pageType == "image/png",
                    "a PNG page is served as image/png");

                var byKey = await GetAsync(storeUri, "/geoclips/" + Uri.EscapeDataString(storeOnlyKey) + "/manifest.json");
                Expect(byKey.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the operator ADDRESSING form also reads the managed store (a lookup, not a bake)");
                Expect(byKey.Body == manifest.Body, "both addressing forms serve byte-identical bodies from the store too");

                var absent = await GetAsync(storeUri, "/geoclips/scenes/store_only.tscn?node=Visuals%2FSpine&anim=never_baked&file=manifest.json");
                Expect(absent.StatusLine.Contains("404", StringComparison.Ordinal), "an unbaked identity 404s without a runtime host");
                Expect(absent.Body.Contains("geoclip-not-found", StringComparison.Ordinal), "…with the not-found code");

                // This server has no runtime host to bake through, so the route degrades to the same
                // 404 rather than half-producing anything. (A bake that returns INCOMPLETE takes the same shape —
                // it is refused before adoption, so the store resolves nothing and this is the response; see
                // GeoclipStoreTests.)
                var noRuntime = await GetAsync(storeUri, "/geoclips/scenes/store_only.tscn?node=Visuals%2FSpine&anim=never_baked&file=manifest.json");
                Expect(noRuntime.StatusLine.Contains("404", StringComparison.Ordinal), "a host with nothing to bake through still 404s");
                Expect(
                    !Directory.EnumerateDirectories(store.RootPath!)
                        .Any(d => Path.GetFileName(d) == CouchCoopGeoclipStore.DirectoryNameFor(
                            CouchCoopGeoclipStore.BuildGeoclipKey(
                                CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/store_only.tscn", "Visuals/Spine", "never_baked")))),
                    "…and writes no pose directory for the identity it could not produce");
            }

            // --- A WEBP PAGE, BESIDE THE PNG ONE ------------------------------------------------------------
            // The baker copies an imported texture's already-lossless WebP payload out verbatim instead of
            // decoding and re-encoding a PNG (~150 ms for a four-page rig), so it names the page for what it is.
            // The store must adopt that, keep the extension through the content-addressed rename, and the route
            // must type it correctly — WHILE the PNG page adopted above goes on serving out of the same store.
            var webpKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/webp_rig.tscn", "Visuals/Spine", "idle_loop");
            var webpAdopt = await store.AdoptAsync(webpKey, WriteBake(cacheRoot, [0x52, 0x49, 0x46, 0x46, 7, 7], "page-0.webp"));
            Expect(webpAdopt.Success, "a bake whose page is a WebP adopts");
            var webpPageName = webpAdopt.PageFiles.Single();
            Expect(webpPageName.EndsWith(".webp", StringComparison.Ordinal),
                $"…and the adopted name keeps the container the bake wrote (got '{webpPageName}')");

            await using (var mixedServer = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new NullAssetAdapter(),
                preferredPort: 13596,
                resourceCacheRoot: cacheRoot))
            {
                var mixedUri = await mixedServer.StartAsync();
                var webpPage = await GetAsync(mixedUri, $"/geoclips/scenes/webp_rig.tscn?node=Visuals%2FSpine&anim=idle_loop&file={webpPageName}");
                Expect(webpPage.StatusLine.Contains("200 OK", StringComparison.Ordinal),
                    "a webp page resolves through the pages/ fallback exactly as a PNG one does");
                Expect(
                    webpPage.Headers.TryGetValue("Content-Type", out var webpType) && webpType == "image/webp",
                    $"…and is served as image/webp (got '{(webpPage.Headers.TryGetValue("Content-Type", out var t) ? t : "none")}')");
                Expect(
                    webpPage.Headers.TryGetValue("Cache-Control", out var webpCache) && webpCache == "public, max-age=31536000, immutable",
                    "…and is content-addressed, so it caches forever like any other page");

                // THE MIX. Both pages are in one pages/ folder and both keep serving; nothing was migrated.
                var stillPng = await GetAsync(mixedUri, $"/geoclips/scenes/store_only.tscn?node=Visuals%2FSpine&anim=idle_loop&file={pageName}");
                Expect(stillPng.StatusLine.Contains("200 OK", StringComparison.Ordinal),
                    "the PNG page baked before the widening still serves from the same store");
                Expect(Directory.GetFiles(store.PagesPath!, "sheet-*").Length >= 2, "…and both containers sit in one shared folder");
            }

            // --- A REFUSAL RECEIPT IS NOT CONTENT -----------------------------------------------------------
            // A refused identity leaves a JSON verdict in the store (so the sweep stops re-baking it), and that
            // file must be unreachable through the route by every address it could be asked for. Note this runs
            // with the store root PRESENT, so the request gets past the "nothing is configured" gate and is
            // answered by the resolver itself — which is the thing under test.
            var refusedKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/refused.tscn", "Visuals/Spine", "die");
            Expect(await store.RecordRefusalAsync(refusedKey, "foreign", "foreignMeshes=8"), "the store records a refusal");
            var receiptName = CouchCoopGeoclipStore.RefusalFileNameFor(CouchCoopGeoclipStore.BuildGeoclipKey(refusedKey));

            await using (var refusedServer = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new NullAssetAdapter(),
                preferredPort: 13595,
                resourceCacheRoot: cacheRoot))
            {
                var refusedUri = await refusedServer.StartAsync();
                var manifest = await GetAsync(refusedUri, "/geoclips/scenes/refused.tscn?node=Visuals%2FSpine&anim=die&file=manifest.json");
                Expect(manifest.StatusLine.Contains("404", StringComparison.Ordinal),
                    "a REFUSED identity 404s: a receipt is a verdict, not a pose");
                Expect(manifest.Body.Contains("geoclip-not-found", StringComparison.Ordinal), "…with the ordinary not-found code");
                Expect(!manifest.Body.Contains("foreignMeshes", StringComparison.Ordinal),
                    "…and the receipt's contents are not what comes back");
                Expect(!manifest.Headers.ContainsKey(CouchCoopGeoclipProvider.RefusalHeader),
                    "…and with COUCHCOOP_GEOCLIP_DIAGNOSTICS unset the refusal is not on the wire either "
                    + "(AssertRefusalHeaderAsync covers the armed case)");

                var byName = await GetAsync(refusedUri, $"/geoclips/scenes/refused.tscn?node=Visuals%2FSpine&anim=die&file={receiptName}");
                Expect(byName.StatusLine.Contains("404", StringComparison.Ordinal), "…nor can the receipt be fetched by its own name");

                var byOperatorForm = await GetAsync(refusedUri, "/geoclips/" + Uri.EscapeDataString(refusedKey) + "/" + receiptName);
                Expect(byOperatorForm.StatusLine.Contains("404", StringComparison.Ordinal), "…through either addressing form");

                var asPage = await GetAsync(refusedUri, "/geoclips/scenes/refused.tscn?node=Visuals%2FSpine&anim=die&file=page-0.png");
                Expect(!asPage.StatusLine.Contains("200 OK", StringComparison.Ordinal), "…and an inline page is not a route artifact");
            }

            // --- BOTH ROOTS: the operator wins --------------------------------------------------------------
            var sharedKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/both.tscn", "Visuals/Spine", "idle_loop");
            Expect((await store.AdoptAsync(sharedKey, WriteBake(cacheRoot, [0x89, 0x50, 0x4E, 0x47, 6, 6]))).Success, "the store also holds the contested identity");

            Directory.CreateDirectory(operatorRoot);
            var operatorDir = Path.Combine(operatorRoot, CouchCoopGeoclipDirectory.SanitizeKey(sharedKey));
            Directory.CreateDirectory(operatorDir);
            File.WriteAllText(Path.Combine(operatorDir, "manifest.json"), "{\"meta\":{\"schema\":\"geoclip/1\"},\"operator\":true}");
            Environment.SetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar, operatorRoot);

            await using (var bothServer = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new NullAssetAdapter(),
                preferredPort: 13594,
                resourceCacheRoot: cacheRoot))
            {
                var bothUri = await bothServer.StartAsync();
                var contested = await GetAsync(bothUri, "/geoclips/scenes/both.tscn?node=Visuals%2FSpine&anim=idle_loop&file=manifest.json");
                Expect(contested.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the contested identity resolves");
                Expect(
                    contested.Body.Contains("\"operator\":true", StringComparison.Ordinal),
                    "COUCHCOOP_GEOCLIPS_DIR WINS. The operator override is what every QA recipe points at, so it must keep "
                    + "overriding whatever the host baked for itself");
                Expect(
                    contested.Headers.TryGetValue("Cache-Control", out var contestedCache) && contestedCache == "no-store",
                    "the operator root keeps no-store — an operator re-bakes into it and reloads");

                // …and the store is still consulted for what the operator root does NOT hold.
                var fallthrough = await GetAsync(bothUri, "/geoclips/scenes/store_only.tscn?node=Visuals%2FSpine&anim=idle_loop&file=manifest.json");
                Expect(fallthrough.StatusLine.Contains("200 OK", StringComparison.Ordinal), "an identity only the store holds still serves — the roots are ordered, not exclusive");
            }
        }
        finally
        {
            Environment.SetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar, previous);
            foreach (var directory in new[] { cacheRoot, operatorRoot, staticRoot })
            {
                try { Directory.Delete(directory, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }

    /// <summary>
    /// WHAT A GEOCLIP 404 MEANT, on the wire, behind <c>COUCHCOOP_GEOCLIP_DIAGNOSTICS=1</c>.
    /// </summary>
    /// <remarks>
    /// The route flattens every cause — a bake refused as incomplete, a refusal REMEMBERED from an earlier one,
    /// an address that is a lookup rather than a recipe, a host with no runtime to bake
    /// through — into one <c>geoclip-not-found</c> body. That body is deliberately unchanged and is asserted here
    /// to be BYTE-IDENTICAL with the header armed, because it is what clients read; the header is for the operator
    /// who armed it, and it exists because recovering these causes after the fact has meant reading refusal
    /// receipts out of the cache by hand.
    /// </remarks>
    private static async Task AssertRefusalHeaderAsync()
    {
        var cacheRoot = Path.Combine(Path.GetTempPath(), "couchcoop-geoclip-diag-" + Guid.NewGuid().ToString("N"));
        var staticRoot = Path.Combine(Path.GetTempPath(), "couchcoop-geoclip-static3-" + Guid.NewGuid().ToString("N"));
        var previousRoot = Environment.GetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar);
        var previousDiagnostics = Environment.GetEnvironmentVariable(CouchCoopGeoclipProvider.DiagnosticsEnvVar);
        var store = new CouchCoopGeoclipStore(cacheRoot);
        try
        {
            Directory.CreateDirectory(staticRoot);
            File.WriteAllText(Path.Combine(staticRoot, "index.html"), "<!doctype html><div>spa-index</div>");
            Environment.SetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar, null);

            // A store root has to exist, or the route answers `geoclips-not-configured` before it ever gets to a
            // cause worth naming. Adopting one identity creates it.
            var presentKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/diag_present.tscn", "Visuals/Spine", "idle_loop");
            Expect((await store.AdoptAsync(presentKey, WriteBake(cacheRoot, [0x89, 0x50, 0x4E, 0x47, 3, 3]))).Success,
                "the diagnostics store adopts one identity");

            var refusedKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/diag_refused.tscn", "Visuals/Spine", "idle_loop");
            Expect(await store.RecordRefusalAsync(refusedKey, "foreign", "foreignMeshes=74"), "…and remembers a refusal for another");

            const string refusedPath = "/geoclips/scenes/diag_refused.tscn?node=Visuals%2FSpine&anim=idle_loop&file=manifest.json";
            const string unknownPath = "/geoclips/scenes/diag_unknown.tscn?node=Visuals%2FSpine&anim=idle_loop&file=manifest.json";

            await using var server = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new NullAssetAdapter(),
                preferredPort: 13597,
                resourceCacheRoot: cacheRoot);
            var baseUri = await server.StartAsync();

            // --- DIAGNOSTICS OFF: the baseline body, and no header anywhere -----------------------------------
            Environment.SetEnvironmentVariable(CouchCoopGeoclipProvider.DiagnosticsEnvVar, null);
            var quiet = await GetAsync(baseUri, refusedPath);
            Expect(quiet.StatusLine.Contains("404", StringComparison.Ordinal), "a refused identity 404s");
            Expect(!quiet.Headers.ContainsKey(CouchCoopGeoclipProvider.RefusalHeader),
                "the diagnostic is OPT-IN: nothing on the wire until it is armed");

            // --- ARMED --------------------------------------------------------------------------------------
            Environment.SetEnvironmentVariable(CouchCoopGeoclipProvider.DiagnosticsEnvVar, "1");

            var remembered = await GetAsync(baseUri, refusedPath);
            Expect(remembered.Body == quiet.Body,
                "THE BODY IS UNCHANGED. The generic code is what a client reads and it stays byte-identical");
            Expect(remembered.Headers.TryGetValue(CouchCoopGeoclipProvider.RefusalHeader, out var rememberedHeader),
                "…and the cause rides a header instead");
            Expect(rememberedHeader!.StartsWith(CouchCoopGeoclipProvider.RefusedCachedCode, StringComparison.Ordinal),
                $"a durable receipt is reported as REMEMBERED, not as a bake that just ran (got '{rememberedHeader}')");
            Expect(rememberedHeader.Contains("foreignMeshes=74", StringComparison.Ordinal),
                "…carrying the completeness detail that used to need receipt archaeology to recover");
            Expect(rememberedHeader.Contains("claimProvenance=none", StringComparison.Ordinal),
                $"…and saying IN WORDS that no claim was graded, which is why this landed on the legacy arm "
                + $"rather than the ownership one (got '{rememberedHeader}')");
            Expect(!rememberedHeader.Contains('\r') && !rememberedHeader.Contains('\n'), "…on one line");

            // THE OWNERSHIP ARM, on a real response rather than through the formatter. This is the reading the
            // next live leg needs: whether an Ironclad's atlas claims matched exactly (bake admitted, goal met)
            // or by containment (refused, goal unmet) is decided by these two numbers, and until they rode the
            // header the only way to see them was to shape a separate env-lane bake and read its log.
            var ownershipKey = CouchCoopSpineClipProvider.BuildSpineKey(
                "res://scenes/diag_ownership.tscn", "Visuals/Spine", "attack");
            Expect(await store.RecordRefusalAsync(
                    ownershipKey, "ownership", "ownership=37 of claimed=44", claimsProven: 7, claimsUnproven: 37),
                "a receipt from the ownership arm is recorded with the evidence it graded");
            var owned = await GetAsync(
                baseUri, "/geoclips/scenes/diag_ownership.tscn?node=Visuals%2FSpine&anim=attack&file=manifest.json");
            Expect(owned.Headers.TryGetValue(CouchCoopGeoclipProvider.RefusalHeader, out var ownedHeader)
                && ownedHeader!.Contains("arm=ownership", StringComparison.Ordinal)
                && ownedHeader.Contains("claimsProven=7", StringComparison.Ordinal)
                && ownedHeader.Contains("claimsUnproven=37", StringComparison.Ordinal),
                $"the ownership arm reaches the wire with its counts (got '{ownedHeader ?? "<absent>"}')");
            Expect(owned.Body == quiet.Body, "…and its body is still the same generic 404");

            // This server has no embedded runtime to bake through — which is a statement
            // about the HOST and must not read as a statement about the rig.
            var noRuntime = await GetAsync(baseUri, unknownPath);
            Expect(noRuntime.Headers.TryGetValue(CouchCoopGeoclipProvider.RefusalHeader, out var noRuntimeHeader)
                && noRuntimeHeader!.StartsWith("geoclip-no-runtime-host", StringComparison.Ordinal),
                $"a host with nothing to bake through says THAT (got '{noRuntimeHeader}')");

            // The operator addressing form is a lookup, not a recipe, so it never drives a bake.
            var operatorForm = await GetAsync(baseUri, "/geoclips/" + Uri.EscapeDataString(refusedKey) + "/manifest.json");
            Expect(operatorForm.Headers.TryGetValue(CouchCoopGeoclipProvider.RefusalHeader, out var operatorHeader),
                "the operator form is explained too");
            Expect(operatorHeader!.StartsWith(CouchCoopGeoclipProvider.RefusedCachedCode, StringComparison.Ordinal),
                $"…and a receipt still outranks 'no bake was attempted' (got '{operatorHeader}')");

            var unknownByOperatorForm = await GetAsync(baseUri, "/geoclips/" + Uri.EscapeDataString("spine://no-such") + "/manifest.json");
            Expect(unknownByOperatorForm.Headers.TryGetValue(CouchCoopGeoclipProvider.RefusalHeader, out var lookupHeader)
                && lookupHeader!.StartsWith("geoclip-address-not-bakeable", StringComparison.Ordinal),
                $"…with no receipt, it reports the address shape (got '{lookupHeader}')");

            // And a 200 never carries it: the header is a failure diagnostic, not a route stamp.
            var served = await GetAsync(baseUri, "/geoclips/scenes/diag_present.tscn?node=Visuals%2FSpine&anim=idle_loop&file=manifest.json");
            Expect(served.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the adopted identity still serves");
            Expect(!served.Headers.ContainsKey(CouchCoopGeoclipProvider.RefusalHeader), "…with no refusal header on it");
        }
        finally
        {
            Environment.SetEnvironmentVariable(CouchCoopGeoclipDirectory.RootEnvVar, previousRoot);
            Environment.SetEnvironmentVariable(CouchCoopGeoclipProvider.DiagnosticsEnvVar, previousDiagnostics);
            foreach (var directory in new[] { cacheRoot, staticRoot })
            {
                try { Directory.Delete(directory, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }

    /// <summary>An upstream bake directory, for the store to repack into the published representation.</summary>
    /// <param name="pageFileName">
    /// The container the bake wrote its page in. A baker that copied the page out of an imported texture writes
    /// WebP, one that re-encoded the runtime texture writes PNG, and the store has to publish either.
    /// </param>
    private static string WriteBake(string underRoot, byte[] pageBytes, string pageFileName = "page-0.png")
    {
        var directory = Path.Combine(underRoot, "bakes", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        File.WriteAllText(
            Path.Combine(directory, "manifest.json"),
            "{\"meta\":{\"schema\":\"geoclip/1\"},\"pages\":[{\"id\":0,\"file\":\""
            + pageFileName + "\",\"width\":4,\"height\":4}]}");
        File.WriteAllBytes(Path.Combine(directory, pageFileName), pageBytes);
        File.WriteAllBytes(Path.Combine(directory, "verts.bin"), [1, 0, 2, 0]);
        return directory;
    }

    private static void AssertFileWhitelist()
    {
        Expect(CouchCoopGeoclipDirectory.IsAllowedFileName("manifest.json"), "manifest.json is servable");
        Expect(CouchCoopGeoclipDirectory.IsAllowedFileName("verts.bin"), "verts.bin is servable");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("page-0.png"), "an upstream raw page is never servable");
        Expect(CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-12.png"), "a packed geoclip/1 sheet is servable");

        // The page/sheet stem was widened from all-digits to HEX so the managed store's content-addressed names
        // are servable. Every name the old rule accepted still matches (a decimal index IS hex), which is what
        // keeps an operator-seeded directory serving exactly what it served before.
        Expect(
            CouchCoopGeoclipDirectory.IsAllowedFileName(CouchCoopGeoclipStore.PageFileNameFor([1, 2, 3], ".png")),
            "the store's own content-addressed page name is servable (if this fails, the store's pages 404)");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("page-a3f0.png"), "a raw page stem is never servable");
        Expect(CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-deadbeefcafe0123.png"), "a hex sheet stem is servable");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("page-g0.png"), "a non-hex page stem is refused");
        Expect(
            !CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-" + new string('a', 65) + ".png"),
            "an unbounded sheet stem is refused — the whitelist stays bounded");
        Expect(!CouchCoopGeoclipDirectory.IsPageFileName("manifest.json"), "the manifest is not a page");
        Expect(!CouchCoopGeoclipDirectory.IsPageFileName("verts.bin"), "neither is the vertex blob");
        Expect(CouchCoopGeoclipDirectory.IsPageFileName("sheet-0.png"), "a sheet is a published image");

        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-.png"), "an index-less sheet name is refused");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-x.png"), "a non-hex sheet index is refused");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("map.json"), "the lookup table itself is never served");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("../manifest.json"), "a traversing name is refused");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sub/sheet-0.png"), "a nested name is refused");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName(""), "an empty name is refused");
        Expect(CouchCoopGeoclipDirectory.ContentTypeFor("sheet-0.png") == "image/png", "a sheet is a PNG");
        Expect(CouchCoopGeoclipDirectory.ContentTypeFor("verts.bin") == "application/octet-stream", "verts.bin is opaque bytes");

        AssertWebpPagesAreWhitelistedJustAsStrictly();
    }

    /// <summary>
    /// A page may be a WEBP as well as a PNG — and the widening must be an extension, not a hole.
    /// </summary>
    /// <remarks>
    /// The baker stopped re-encoding pages out of the runtime texture: an exported build ships an imported-texture
    /// container whose payload is already a lossless WebP, so those bytes are copied out verbatim and the artifact
    /// is named for what it is. That means the route serves two containers, must type each correctly, and must
    /// keep the stem rule EXACTLY as tight for the new one — the whole reason the stem is a bounded hex run is to
    /// keep this route from addressing arbitrary files in a directory it did not write.
    /// </remarks>
    private static void AssertWebpPagesAreWhitelistedJustAsStrictly()
    {
        Expect(CouchCoopGeoclipDirectory.PageExtensions.Contains(".png") && CouchCoopGeoclipDirectory.PageExtensions.Contains(".webp"),
            "both containers are declared page extensions");
        Expect(CouchCoopGeoclipDirectory.PageExtensions[0] == ".png",
            "PNG is FIRST — the order is the preference a content-id lookup uses, and PNG is what every store "
            + "baked before this change holds");

        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("page-0.webp"), "an upstream webp page is never servable");
        Expect(CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-deadbeefcafe0123.webp"), "so is a webp sheet");
        Expect(
            CouchCoopGeoclipDirectory.IsAllowedFileName(CouchCoopGeoclipStore.PageFileNameFor([1, 2, 3], ".webp")),
            "the store's own content-addressed WEBP name is servable (if this fails, every webp page 404s)");
        Expect(CouchCoopGeoclipDirectory.ContentTypeFor("sheet-0.webp") == "image/webp", "a webp sheet is typed image/webp");
        Expect(CouchCoopGeoclipDirectory.ContentTypeFor("sheet-a3f0.webp") == "image/webp", "…and so is a webp sheet");
        Expect(CouchCoopGeoclipDirectory.PageExtensionOf("sheet-a3f0.webp") == ".webp", "the whitelist reports which container it accepted");
        Expect(CouchCoopGeoclipDirectory.PageExtensionOf("sheet-a3f0.png") == ".png", "…for either one");
        Expect(CouchCoopGeoclipDirectory.PageExtensionOf("verts.bin") is null, "…and reports nothing for a non-page");

        // THE STRICTNESS, restated for the new extension. Every clause the PNG rule enforces still holds.
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-.webp"), "an index-less webp sheet is refused");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-g0.webp"), "a non-hex webp sheet is refused");
        Expect(
            !CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-" + new string('a', 65) + ".webp"),
            "an unbounded webp stem is refused — the same length cap, not a looser one");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sub/sheet-0.webp"), "a nested webp name is refused");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("../sheet-0.webp"), "a traversing webp name is refused");

        // A DOUBLE EXTENSION IS NOT A PAGE. This is the shape a second extension invites: the leftover dot lands
        // in the stem, which is not hex, so neither spelling resolves.
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-ab.png.webp"), "a double extension is refused");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-ab.webp.png"), "…in either order");

        // Adding an extension must not become "accept any file": only the declared containers name a page.
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-0.jpg"), "an undeclared container is refused");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-0.exe"), "…and so is an executable one");
        Expect(!CouchCoopGeoclipDirectory.IsAllowedFileName("sheet-0"), "…and so is no container at all");
        Expect(CouchCoopGeoclipDirectory.ContentTypeFor("sheet-0.jpg") == "application/octet-stream",
            "an undeclared container is never given an image type");
    }

    private static void AssertKeySanitization()
    {
        var key = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", "Visuals/Spine", "idle");
        var sanitized = CouchCoopGeoclipDirectory.SanitizeKey(key);
        Expect(
            sanitized == "spine___scenes_a.tscn_node_Visuals_Spine_anim_idle_codec_webp_fps_15_q_85",
            "the sanitized directory name is the key with every non-[A-Za-z0-9._-] character replaced by _");
        Expect(!sanitized.Contains('/'), "a sanitized key carries no path separator");
        Expect(CouchCoopGeoclipDirectory.SanitizeKey("../../etc/passwd") == ".._.._etc_passwd", "dots survive but separators do not");
        Expect(
            CouchCoopGeoclipDirectory.SanitizeKey(key) == CouchCoopGeoclipDirectory.SanitizeKey(key),
            "sanitization is a pure function of the key");
    }

    private static async Task<Probe> GetAsync(Uri baseUri, string path)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, baseUri.Port);
        await using var stream = client.GetStream();
        var request = Encoding.ASCII.GetBytes(
            $"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{baseUri.Port}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(request);

        using var memory = new MemoryStream();
        await stream.CopyToAsync(memory);
        var text = Encoding.UTF8.GetString(memory.ToArray());
        var split = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        var headerText = split >= 0 ? text[..split] : text;
        var body = split >= 0 ? text[(split + 4)..] : string.Empty;
        var lines = headerText.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon > 0)
            {
                headers[line[..colon]] = line[(colon + 1)..].Trim();
            }
        }

        return new Probe(lines.FirstOrDefault() ?? string.Empty, headers, body);
    }

    private sealed record Probe(string StatusLine, Dictionary<string, string> Headers, string Body);

    /// <summary>An asset seam that answers nothing — this suite never asks the host for a game asset.</summary>
    private sealed class NullAssetAdapter : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
            string opaqueKey,
            CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default,
            CancellationToken cancellationToken = default)
            => Task.FromResult(CouchCoopAssetHttpResponse.Missing(new CouchCoopAssetHttpError(
                "asset-unavailable",
                "This suite serves no game assets.")));
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException("geoclip route expectation failed: " + because);
        }
    }
}
