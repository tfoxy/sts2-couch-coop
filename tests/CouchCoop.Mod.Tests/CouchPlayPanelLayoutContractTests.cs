using CouchCoop.Mod.HostUi;

internal static class CouchPlayPanelLayoutContractTests
{
    public static void Run()
    {
        const float qrRight = (1920f + CouchCoopQrDialog.PanelWidth) / 2f;
        Expect(CouchCoopSeatModLayout.Left > qrRight, "Couch play clears the centre card");
        Expect(CouchCoopSeatModLayout.Left + CouchCoopSeatModLayout.Width <= 1920f, "right edge fits");
        Expect(CouchCoopSeatModLayout.Top >= 0f
            && CouchCoopSeatModLayout.Top + CouchCoopSeatModLayout.Height <= 1080f, "height fits");
        Expect(CouchCoopQrHostSelect.RowWidth <= CouchCoopSeatModLayout.InnerWidth, "select fits card padding");
        Expect(CouchCoopSeatModLayout.TitleTop + CouchCoopSeatModLayout.TitleHeight <= CouchCoopCouchPlayPanel.SelectTop,
            "title clears select");
        Expect(CouchCoopCouchPlayPanel.SelectTop + CouchCoopQrHostSelect.RowHeight < CouchCoopCouchPlayPanel.DescriptionTop,
            "closed select clears description");
        Expect(CouchCoopCouchPlayPanel.SelectTop + CouchCoopQrHostSelect.RowHeight * 4f
            <= CouchCoopSeatModLayout.Height - CouchCoopSeatModLayout.Padding, "expanded three-option select fits");
        Expect(CouchCoopCouchPlayPanel.DescriptionTop + CouchCoopCouchPlayPanel.DescriptionHeight
            <= CouchCoopSeatModLayout.Height - CouchCoopSeatModLayout.Padding, "wrapping description fits");
        Console.WriteLine("CouchPlayPanelLayoutContractTests: 8 checks ok");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition) throw new InvalidOperationException($"CouchPlayPanelLayoutContractTests failed: {because}");
    }
}
