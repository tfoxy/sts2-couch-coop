using System.Text.Json;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Loader;

// WS-2: the overlay layout contract exists in FOUR places that cannot reference each other.
//
//   1. HostLobbyQrOverlayLayout.Default            (CouchCoop.Mod)          — what the UI runs on
//   2. CouchCoopHotLogic.DescribeOverlayLayoutJson (CouchCoop.Mod.HotReload)— what a reload ships
//   3. CouchCoopHotReloadProtocol.GetOverlayLayoutJson (CouchCoop.Mod.Loader) — the stable shell's copy
//   4. CouchCoopHotReloadProtocol.ValidateOverlayLayout (same)              — the gate all of them pass
//
// The duplication is structural, not laziness: the shell must validate an incoming layout without
// binding to the collectible load context, and the hot-reload logic must describe one without binding
// to Godot. But triplicated constants rot silently — a field added in one copy deserialises to 0 in
// another and the failure shows up as a mysteriously invisible or mis-sized control at runtime.
//
// This suite is what makes four copies survivable. It compares them as DATA rather than as text: each
// JSON producer is deserialised into the runtime record and compared with record equality (which for a
// positional record compares exactly the constructor fields, ignoring the computed properties), and
// the JSON key sets are compared directly so a stale extra field is caught too.
internal static class CouchCoopQrLayoutContractTests
{
    public static void Run()
    {
        AllThreeCopiesAgree();
        JsonKeySetsAreIdentical();
        DefaultLayoutPassesItsOwnValidator();
        ValidatorRejectsOutOfBounds();
        DisplayExtentIsConstant();
        TheCardStillHasRoomForTheConstantExtent();
        ButtonRectMatchesTheAgreedGeometry();
        ConnectionCompanionClearsTheQrCard();

        Console.WriteLine("CouchCoopQrLayoutContractTests: ok");
    }

    private static JsonSerializerOptions JsonOptions { get; } = new(JsonSerializerDefaults.Web);

    // Reached by reflection, not by a compile reference: CouchCoop.Mod.HotReload is deliberately NOT
    // referenced by this project (it is loaded into a collectible context at runtime, and referencing
    // it would defeat that), so it is copied to the output as content instead. This is the same
    // name-based lookup CouchCoopHotReloadProtocol performs, which means the test also proves the
    // method is still findable under the name the shell uses.
    private static readonly Lazy<string> _hotLogicJson = new(() =>
    {
        var path = Path.Combine(AppContext.BaseDirectory, "CouchCoop.Mod.HotReload.dll");
        if (!File.Exists(path))
        {
            throw new InvalidOperationException(
                $"CouchCoopQrLayoutContractTests: the hot-reload logic assembly is missing at {path}. "
                + "The drift guard cannot run, and a silently skipped drift guard is worse than none.");
        }

        var type = System.Reflection.Assembly.LoadFrom(path)
            .GetType("CouchCoop.Mod.HotReload.CouchCoopHotLogic", throwOnError: true)!;
        var method = type.GetMethod("DescribeOverlayLayoutJson", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
            ?? throw new InvalidOperationException("CouchCoopQrLayoutContractTests: CouchCoopHotLogic.DescribeOverlayLayoutJson was not found.");

        return (string)method.Invoke(null, null)!;
    });

    private static string HotLogicJson => _hotLogicJson.Value;

    // The shell returns its compiled-in default until a hot-reload generation activates; nothing in
    // this suite triggers one, and it runs before the reload tests do.
    private static string ShellJson => CouchCoopHotReloadProtocol.GetOverlayLayoutJson();

    private static HostLobbyQrOverlayLayout Parse(string json, string source)
        => JsonSerializer.Deserialize<HostLobbyQrOverlayLayout>(json, JsonOptions)
            ?? throw new InvalidOperationException($"CouchCoopQrLayoutContractTests: {source} produced no layout");

    // ---- the drift guard ------------------------------------------------------------------------------------

    private static void AllThreeCopiesAgree()
    {
        var runtime = HostLobbyQrOverlayLayout.Default;

        Expect(Parse(HotLogicJson, "hot-reload logic") == runtime,
            "the hot-reload logic's layout equals the runtime default");
        Expect(Parse(ShellJson, "loader shell") == runtime,
            "the loader shell's layout equals the runtime default");
    }

    private static void JsonKeySetsAreIdentical()
    {
        var hotLogicKeys = KeysOf(HotLogicJson);
        var shellKeys = KeysOf(ShellJson);

        Expect(hotLogicKeys.SetEquals(shellKeys),
            $"both JSON producers emit the same field set (hot-reload: [{string.Join(",", hotLogicKeys.Order())}] shell: [{string.Join(",", shellKeys.Order())}])");

        // Named explicitly so ADDING a field is a deliberate act in all four copies rather than an
        // accident in one. A field the runtime record does not have would deserialise to nothing.
        HashSet<string> expected =
        [
            "left", "top", "right", "bottom",
            "qrDialogExtent", "quietZoneModules",
            "titleFontScale", "urlFontScale", "buttonFontScale",
            "panelPadding", "panelCornerRadius", "panelBorderWidth",
            "panelColor", "panelBorderColor",
        ];

        Expect(hotLogicKeys.SetEquals(expected),
            $"the emitted field set is exactly the agreed contract (got [{string.Join(",", hotLogicKeys.Order())}])");
    }

    private static HashSet<string> KeysOf(string json)
    {
        using var document = JsonDocument.Parse(json);
        return [.. document.RootElement.EnumerateObject().Select(property => property.Name)];
    }

    // ---- validation bounds ----------------------------------------------------------------------------------

    private static void DefaultLayoutPassesItsOwnValidator()
    {
        // The fourth copy. A default that its own gate rejects would mean a hot reload of the shipped
        // values is refused — the worst kind of drift, because nothing looks wrong until someone reloads.
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(HotLogicJson) is null,
            $"the hot-reload default passes validation (got: {CouchCoopHotReloadProtocol.ValidateOverlayLayout(HotLogicJson)})");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(ShellJson) is null,
            $"the shell default passes validation (got: {CouchCoopHotReloadProtocol.ValidateOverlayLayout(ShellJson)})");
    }

    private static void ValidatorRejectsOutOfBounds()
    {
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Mutate("\"qrDialogExtent\":592", "\"qrDialogExtent\":40")) is not null,
            "a QR extent below one version-1 code at 4px per module is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Mutate("\"buttonFontScale\":1.75", "\"buttonFontScale\":0")) is not null,
            "a zero button font scale is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Mutate("\"buttonFontScale\":1.75", "\"buttonFontScale\":40")) is not null,
            "an absurd button font scale is rejected");
        // The button rect must still be able to host its own caption.
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Mutate("\"bottom\":868", "\"bottom\":742")) is not null,
            "a button too short for its scaled label line is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout("{ not json") is not null,
            "malformed JSON is rejected rather than thrown");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Mutate("\"panelColor\":\"#0e1117f7\"", "\"panelColor\":\"puce\"")) is not null,
            "a non-HTML colour is rejected");
    }

    private static string Mutate(string find, string replace)
    {
        var json = HotLogicJson;
        Expect(json.Contains(find, StringComparison.Ordinal),
            $"the mutation anchor '{find}' still exists in the emitted JSON");
        return json.Replace(find, replace, StringComparison.Ordinal);
    }

    // ---- constant-extent invariant --------------------------------------------------------------------------

    // The QR renders at ONE size, whatever it encodes. `qrDialogExtent` is now that exact size rather
    // than a budget a whole-number multiple had to fit inside — the whole-number rule moved into the
    // raster, where the leftover becomes white quiet-zone padding (QrRasterTests owns that half).
    private static void DisplayExtentIsConstant()
    {
        var layout = HostLobbyQrOverlayLayout.Default;

        Expect(layout.QrDialogExtent == 592f, $"the shipped extent is 592 design units (got {layout.QrDialogExtent})");
        Expect(layout.QrDisplayExtent == layout.ResolvedQrDialogExtent,
            "the on-screen extent IS the configured extent, with no module count in the derivation");
        Expect(layout.QrRasterTargetPixels == 592,
            $"the raster canvas is 1:1 with it (got {layout.QrRasterTargetPixels})");

        // The floor still applies to an absurd hot-reloaded value.
        var floored = layout with { QrDialogExtent = 1f };
        Expect(floored.QrDisplayExtent == HostLobbyQrOverlayLayout.MinQrDialogExtent,
            "an absurd extent floors at one version-1 code at 4px per module");
    }

    // The card's rows are stacked by hand, so the extent is not free to grow: the QR has to clear the URL,
    // notice and close rows underneath it. This is why the constant is 592 rather than the 620 the old
    // budget carried.
    //
    // THESE ARE MIRRORED CONSTANTS, and the mirror can go stale — CouchCoopQrDialog's geometry is `private
    // const` (it is Godot-coupled and cannot be constructed here), so this test cannot read the real
    // values. It has silently drifted once already: the numbers stayed at the pre-web-link layout while
    // the dialog grew a second toggle row, and the assertions below went on passing against geometry that
    // no longer existed. If you move a row in CouchCoopQrDialog, move it here too. The single-select
    // redesign removed both toggle rows (their methods are option rows now), which is why the card is
    // 936 with the QR at 152 — and why the expanded option list, the new thing that must fit, gets its
    // own assertion below.
    private static void TheCardStillHasRoomForTheConstantExtent()
    {
        var layout = HostLobbyQrOverlayLayout.Default;

        const float designSpaceHeight = 1080f;
        const float panelHeight = 936f;    // CouchCoopQrDialog.PanelHeight
        const float qrTop = 152f;          // CouchCoopQrDialog.QrTop
        const float urlGap = 6f, urlHeight = 32f, noticeGap = 2f, noticeHeight = 40f;
        const float closeHeight = 73f;     // CouchCoopSkipButton.DesignSize.Y
        const float closeInset = 16f;      // CouchCoopModalDialog.DismissBottomInset

        var noticeBottom = qrTop + layout.QrDisplayExtent + urlGap + urlHeight + noticeGap + noticeHeight;
        var closeTop = panelHeight - layout.ResolvedPanelPadding - closeHeight - closeInset;

        Expect(noticeBottom <= closeTop,
            $"the notice row (bottom {noticeBottom}) clears the close button (top {closeTop}) at the constant extent");
        Expect(closeTop + closeHeight <= panelHeight, "the close button stays inside the card");
        Expect(panelHeight <= designSpaceHeight,
            $"the card ({panelHeight}) still fits the {designSpaceHeight}-tall design space");

        // The expanded option list hangs below the closed select row and draws over the QR; at the
        // decision layer's hard cap it must still bottom out inside the card, because the select has no
        // scrolling — the cap IS the fit guarantee.
        const float selectTop = 72f;       // CouchCoopQrDialog.SelectTop
        const float rowHeight = 64f;       // CouchCoopQrHostSelect.RowHeight
        var listBottom = selectTop + rowHeight + (QrHostOptions.MaxOptions * rowHeight);
        Expect(listBottom <= panelHeight,
            $"a fully expanded option list (bottom {listBottom}) stays inside the card ({panelHeight})");
    }

    private static void ButtonRectMatchesTheAgreedGeometry()
    {
        var layout = HostLobbyQrOverlayLayout.Default;

        // The rect keeps the replaced QR container's left/top and frees its bottom; the QA probe
        // asserts these exact screen coordinates on both lobby screens.
        Expect(layout.OffsetLeft == 226f && layout.OffsetTop == 732f, "the button keeps the old container's left/top");
        Expect(layout.OffsetRight == 578f && layout.OffsetBottom == 868f, "and frees the bottom to 868");
        Expect(layout.ButtonWidth == 352f && layout.ButtonHeight == 136f, "giving a 352x136 button");

        // 352:136 is event_button.png's 284:110 aspect, so the borrowed art is not stretched.
        var buttonAspect = layout.ButtonWidth / layout.ButtonHeight;
        Expect(MathF.Abs(buttonAspect - (284f / 110f)) < 0.02f, "the button matches event_button.png's aspect");
    }

    private static void ConnectionCompanionClearsTheQrCard()
    {
        const float qrLeft = (1920f - 1000f) / 2f;
        var companionRight = CouchCoopConnectionLayout.Left + CouchCoopConnectionLayout.Width;
        Expect(CouchCoopConnectionLayout.Top == 72f && CouchCoopConnectionLayout.Height == 936f,
            "the connection companion shares the QR card's vertical extent");
        Expect(companionRight + CouchCoopConnectionLayout.Gap == qrLeft,
            "the connection companion leaves a fixed gap before the unchanged QR card");
        Expect(CouchCoopConnectionLayout.Left >= 0f,
            "the connection companion remains inside the 1920-wide design space");

        // Godot scales the same design coordinates uniformly for the 1280x800 Deck-friendly
        // viewport.  The side card must retain both its gap and its clearance from the QR card.
        const float scale = 1280f / 1920f;
        var scaledCompanionRight = companionRight * scale;
        var scaledQrLeft = qrLeft * scale;
        Expect(scaledCompanionRight < scaledQrLeft,
            "the scaled 1280-wide companion still clears the QR card");
        Expect(MathF.Abs((scaledQrLeft - scaledCompanionRight) - CouchCoopConnectionLayout.Gap * scale) < 0.01f,
            "the scaled companion keeps the QR-card gap");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"CouchCoopQrLayoutContractTests failed: {because}");
        }
    }
}
