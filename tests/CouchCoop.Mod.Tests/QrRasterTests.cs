using CouchCoop.Mod.HostUi;

// The QR must render at the SAME on-screen size no matter which URL it carries.
//
// The bug this suite locks down: the display extent used to be `modules * raster * K` for the largest
// whole K that fit the budget, so the plain LAN URL (37 modules -> K=4 -> 592 design units) and the
// secure URL (41 modules -> K=3 -> 492) rendered at visibly different sizes. Ticking the "installable
// link" checkbox resized the thing the player was pointing a phone at.
//
// The fix keeps the whole-number rule that forced that — a fractional scale resamples the module grid,
// merges or splits modules, and can make a code unscannable at exactly the wrong moment — but moves it
// into the RASTER. Every module gets an identical whole number of source pixels and the leftover becomes
// centred WHITE PADDING, which is quiet zone and is explicitly allowed. The canvas, and therefore the
// TextureRect, is then the same size for every code.
//
// So the invariants below are:
//   1. the two REAL join URLs (not synthetic module counts) produce the same canvas and the same extent
//   2. every module occupies exactly PixelsPerModule x PixelsPerModule source pixels — no off-by-one row
//      or column from the integer division
//   3. the raster is a LOSSLESS rendering of the module matrix (every module recovers), and the padding
//      is nothing but opaque white
//   4. a pathological module count degrades instead of dividing to zero
//
// NOT verified here: that a real scanner decodes the image. QRCoder is an encoder only and nothing in
// this repo can decode, so what is proven is that the module matrix survives the raster bit for bit and
// is surrounded by more white than the spec requires — the two properties a decode depends on.
internal static class QrRasterTests
{
    // The two payloads the mod actually produces. Not synthetic sizes: the whole point is that the
    // difference between THESE is what the player saw.
    private const string PlainLanUrl = "http://worky.local:13337/";
    private const string SecureUrl = "https://192-168-0-89.my.local-ip.co:13338/";

    public static void Run()
    {
        TheTwoRealJoinUrlsAreDifferentSizedCodes();
        TheTwoRealJoinUrlsRenderAtTheSameOnScreenExtent();
        EveryModuleIsTheSameWholeNumberOfSourcePixels();
        TheRasterIsALosslessRenderingOfTheModuleMatrix();
        ThePaddingIsNothingButOpaqueWhiteQuietZone();
        TheExtentIsConstantAcrossEveryPlausibleModuleCount();
        APathologicalCodeDegradesInsteadOfDividingToZero();
        TheRasterRefusesToCrop();

        Console.WriteLine("QrRasterTests: ok");
    }

    private static HostLobbyQrOverlayLayout Layout => HostLobbyQrOverlayLayout.Default;

    private static OfflineQrCode Encode(string url)
        => OfflineQrCode.EncodeJoinUrl(new Uri(url), HostLobbyQrOverlayLayout.Default.QuietZoneModules);

    // ---- the premise ------------------------------------------------------------------------------

    // If these ever became the same size the suite below would pass vacuously, so pin them. The counts
    // are QRCoder 1.6.0 at ECC level Q: version 3 (37) for the short LAN URL, version 4 (41) once the
    // dashed provider host makes the payload longer.
    private static void TheTwoRealJoinUrlsAreDifferentSizedCodes()
    {
        Expect(Encode(PlainLanUrl).Size == 37, $"the plain LAN URL is a 37-module code (got {Encode(PlainLanUrl).Size})");
        Expect(Encode(SecureUrl).Size == 41, $"the secure URL is a 41-module code (got {Encode(SecureUrl).Size})");
    }

    // ---- 1. the same size on screen ---------------------------------------------------------------

    private static void TheTwoRealJoinUrlsRenderAtTheSameOnScreenExtent()
    {
        var plain = Encode(PlainLanUrl);
        var secure = Encode(SecureUrl);

        var plainPlan = Layout.RasterPlanFor(plain.Size);
        var securePlan = Layout.RasterPlanFor(secure.Size);

        // The TextureRect's box: a property of the layout alone, with no module count in sight.
        Expect(Layout.QrDisplayExtent == 592f, $"the QR's on-screen extent is 592 design units (got {Layout.QrDisplayExtent})");

        // And the source canvas both codes land on, which is what stops the box from resampling. Equal
        // canvases + an equal box = an equal scale = literally the same rendering size.
        Expect(plainPlan.CanvasPixels == securePlan.CanvasPixels,
            $"both real URLs rasterize onto the same canvas ({plainPlan.CanvasPixels} vs {securePlan.CanvasPixels})");
        Expect(plainPlan.CanvasPixels == Layout.QrRasterTargetPixels,
            $"...which is the layout's target canvas ({plainPlan.CanvasPixels} vs {Layout.QrRasterTargetPixels})");

        // One source pixel per design unit, so a module is a whole number of design units either way.
        Expect(Layout.QrRasterTargetPixels == (int)Layout.QrDisplayExtent,
            "the canvas is 1:1 with the on-screen extent, so no display-side scaling happens at all");

        // The concrete numbers behind "the code no longer visibly shrinks": 592 vs 574 of the same
        // 592-unit box (a 3% difference), where the old scheme gave 592 vs 492 (17%).
        Expect(plainPlan.PixelsPerModule == 16 && plainPlan.ContentPixels == 592,
            $"the 37-module code draws 16px modules filling the box exactly (got {plainPlan.PixelsPerModule}px / {plainPlan.ContentPixels})");
        Expect(securePlan.PixelsPerModule == 14 && securePlan.ContentPixels == 574,
            $"the 41-module code draws 14px modules and pads the last 18px (got {securePlan.PixelsPerModule}px / {securePlan.ContentPixels})");
    }

    private static void TheExtentIsConstantAcrossEveryPlausibleModuleCount()
    {
        var canvas = Layout.RasterPlanFor(21).CanvasPixels;
        foreach (var modules in PlausibleModuleCounts)
        {
            var plan = Layout.RasterPlanFor(modules);
            Expect(plan.CanvasPixels == canvas,
                $"every code shares one canvas ({modules} modules gave {plan.CanvasPixels}, expected {canvas})");
            Expect(plan.ContentPixels <= plan.CanvasPixels,
                $"the module grid never exceeds the canvas ({modules} modules)");
            // A module smaller than 4px would be coarser than the old scheme's worst case.
            Expect(plan.PixelsPerModule >= 4,
                $"modules stay at least 4 source pixels ({modules} modules gave {plan.PixelsPerModule})");
        }
    }

    private static int[] PlausibleModuleCounts => [21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69, 73, 77];

    // ---- 2. uniform modules -----------------------------------------------------------------------

    private static void EveryModuleIsTheSameWholeNumberOfSourcePixels()
    {
        foreach (var modules in PlausibleModuleCounts)
        {
            var plan = Layout.RasterPlanFor(modules);

            Expect(plan.ContentPixels == plan.Modules * plan.PixelsPerModule,
                $"the content edge is exactly modules x pixelsPerModule ({modules} modules)");
            Expect(plan.PadLeading + plan.ContentPixels + plan.PadTrailing == plan.CanvasPixels,
                $"leading pad + content + trailing pad accounts for the whole canvas ({modules} modules)");
            Expect(plan.PadTrailing - plan.PadLeading is 0 or 1,
                $"the pad is centred to within the odd pixel ({modules} modules: {plan.PadLeading}/{plan.PadTrailing})");
        }

        // And in the pixels themselves: every module block is one flat colour of exactly the same size.
        // The per-pixel comparison is done WITHOUT building a message (350k interpolated strings per code
        // would dominate the suite's runtime); only the first mismatch is described.
        foreach (var url in new[] { PlainLanUrl, SecureUrl })
        {
            var code = Encode(url);
            var plan = Layout.RasterPlanFor(code.Size);
            var pixels = QrRaster.RenderRgba8(code, plan);

            for (var moduleY = 0; moduleY < code.Size; moduleY++)
            {
                for (var moduleX = 0; moduleX < code.Size; moduleX++)
                {
                    var expected = code.IsDark(moduleX, moduleY) ? (byte)0 : byte.MaxValue;
                    var firstX = plan.PadLeading + (moduleX * plan.PixelsPerModule);
                    var firstY = plan.PadLeading + (moduleY * plan.PixelsPerModule);
                    var flat = true;

                    for (var y = firstY; flat && y < firstY + plan.PixelsPerModule; y++)
                    {
                        for (var x = firstX; x < firstX + plan.PixelsPerModule; x++)
                        {
                            if (ChannelAt(pixels, plan, x, y) != expected)
                            {
                                flat = false;
                                break;
                            }
                        }
                    }

                    Expect(flat,
                        $"module ({moduleX},{moduleY}) of the {code.Size}-module code is flat across all "
                        + $"{plan.PixelsPerModule}x{plan.PixelsPerModule} of its pixels");
                }
            }
        }
    }

    // ---- 3. lossless, and padded only with white --------------------------------------------------

    private static void TheRasterIsALosslessRenderingOfTheModuleMatrix()
    {
        foreach (var url in new[] { PlainLanUrl, SecureUrl })
        {
            var code = Encode(url);
            var plan = Layout.RasterPlanFor(code.Size);
            var pixels = QrRaster.RenderRgba8(code, plan);

            var recovered = 0;
            for (var moduleY = 0; moduleY < code.Size; moduleY++)
            {
                for (var moduleX = 0; moduleX < code.Size; moduleX++)
                {
                    Expect(QrRaster.IsModuleDark(pixels, plan, moduleX, moduleY) == code.IsDark(moduleX, moduleY),
                        $"module ({moduleX},{moduleY}) of the {code.Size}-module code reads back as it was written");
                    recovered++;
                }
            }

            Expect(recovered == code.Size * code.Size, "every module was checked");
        }
    }

    private static void ThePaddingIsNothingButOpaqueWhiteQuietZone()
    {
        var code = Encode(SecureUrl);
        var plan = Layout.RasterPlanFor(code.Size);
        var pixels = QrRaster.RenderRgba8(code, plan);

        Expect(plan.PadLeading > 0, "the 41-module code does get padded (otherwise this proves nothing)");
        Expect(pixels.Length == plan.CanvasPixels * plan.CanvasPixels * QrRaster.BytesPerPixel,
            "the buffer is exactly one RGBA canvas");

        var contentEnd = plan.PadLeading + plan.ContentPixels;
        var strayPad = 0;
        for (var y = 0; y < plan.CanvasPixels; y++)
        {
            for (var x = 0; x < plan.CanvasPixels; x++)
            {
                var inside = x >= plan.PadLeading && x < contentEnd && y >= plan.PadLeading && y < contentEnd;
                if (!inside && ChannelAt(pixels, plan, x, y) != byte.MaxValue)
                {
                    strayPad++;
                }
            }
        }

        Expect(strayPad == 0,
            $"{strayPad} pad pixels are not white — padding a QR is adding quiet zone, never marking it");

        // Every pixel is fully opaque and strictly black or white: no anti-aliasing, no alpha, nothing a
        // scanner has to threshold. Counted rather than asserted per pixel, for the same runtime reason.
        var notMonochrome = 0;
        var notOpaque = 0;
        for (var index = 0; index < pixels.Length; index += QrRaster.BytesPerPixel)
        {
            var value = pixels[index];
            if (value is not (0 or byte.MaxValue) || pixels[index + 1] != value || pixels[index + 2] != value)
            {
                notMonochrome++;
            }

            if (pixels[index + 3] != byte.MaxValue)
            {
                notOpaque++;
            }
        }

        Expect(notMonochrome == 0, $"{notMonochrome} pixels are neither pure black nor pure white");
        Expect(notOpaque == 0, $"{notOpaque} pixels are not fully opaque");
    }

    // ---- 4. degradation ---------------------------------------------------------------------------

    private static void APathologicalCodeDegradesInsteadOfDividingToZero()
    {
        // More modules than the canvas has pixels. The old floor would give 0 px per module and render
        // nothing; instead the module clamps to 1px and the canvas grows to hold the grid, so the code is
        // complete and uniform (merely downscaled by the constant-extent TextureRect). Cropping is never
        // an option — a clipped QR is not a QR.
        var huge = QrRasterPlan.For(1000, 592);
        Expect(huge.PixelsPerModule == 1, $"a 1000-module code clamps to 1px modules (got {huge.PixelsPerModule})");
        Expect(huge.CanvasPixels == 1000, $"...and the canvas grows to hold them (got {huge.CanvasPixels})");
        Expect(huge.ContentPixels == 1000 && huge.PadLeading == 0 && huge.PadTrailing == 0,
            "...with no padding and, crucially, no cropping");

        // Exactly at the boundary.
        var exact = QrRasterPlan.For(592, 592);
        Expect(exact.PixelsPerModule == 1 && exact.CanvasPixels == 592, "one pixel per module fits exactly");

        // No code at all: the dialog hides the texture, but the plan must still be a valid empty canvas.
        var none = QrRasterPlan.For(0, 592);
        Expect(none is { Modules: 0, PixelsPerModule: 0, ContentPixels: 0 } && none.CanvasPixels == 592,
            "zero modules is an empty canvas rather than a divide by zero");

        // A degenerate target cannot produce a zero-area image.
        Expect(QrRasterPlan.For(37, 0).CanvasPixels >= 1, "a zero target still yields a positive canvas");
        Expect(QrRasterPlan.For(37, -5).CanvasPixels >= 1, "a negative target still yields a positive canvas");

        // The shipped floor still leaves usable modules: MinQrDialogExtent is a v1 code at 4px/module.
        var floorLayout = HostLobbyQrOverlayLayout.Default with { QrDialogExtent = 0f };
        Expect(floorLayout.ResolvedQrDialogExtent == HostLobbyQrOverlayLayout.MinQrDialogExtent,
            "an absurd configured extent floors at MinQrDialogExtent");
        Expect(floorLayout.RasterPlanFor(21).PixelsPerModule == HostLobbyQrOverlayLayout.MinRasterPixelsPerModule,
            "...where a version-1 code still gets 4 source pixels per module");
    }

    private static void TheRasterRefusesToCrop()
    {
        var code = Encode(PlainLanUrl);
        var tooSmall = new QrRasterPlan(code.Size, PixelsPerModule: 16, CanvasPixels: 100);

        Expect(Throws(() => QrRaster.RenderRgba8(code, tooSmall)),
            "a canvas smaller than the grid is refused rather than silently clipping the code");
        Expect(Throws(() => QrRaster.RenderRgba8(code, Layout.RasterPlanFor(code.Size + 2))),
            "a plan built for a different module count is refused");
    }

    // ---- helpers ----------------------------------------------------------------------------------

    /// <summary>Red channel of one canvas pixel; the render is greyscale so one channel is the value.</summary>
    private static byte ChannelAt(byte[] pixels, QrRasterPlan plan, int x, int y)
        => pixels[(((y * plan.CanvasPixels) + x) * QrRaster.BytesPerPixel)];

    private static bool Throws(Action action)
    {
        try
        {
            action();
            return false;
        }
        catch (ArgumentException)
        {
            return true;
        }
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"QrRasterTests failed: {because}");
        }
    }
}
