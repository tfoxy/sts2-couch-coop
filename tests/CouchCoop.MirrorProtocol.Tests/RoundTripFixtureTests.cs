using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// The THIRD leg of the cross-language round-trip: the C# server serializer (BrowserSceneDeltaMessageTests) writes
// tests/fixtures/wire/roundtrip-delta.json, roundTripFixture.spec.ts parses it in TS, and THIS suite parses the
// SAME checked-in bytes through the shared SceneDeltaReader/SceneTreeApplier — asserting the same expectations, so
// a wire-format change on ANY of the three sides breaks a test.
internal static class RoundTripFixtureTests
{
    public static void Run()
    {
        ParsesAndAppliesTheServerDeltaToExpectedState();
    }

    private static void ParsesAndAppliesTheServerDeltaToExpectedState()
    {
        var raw = TestFixtures.ReadWire("roundtrip-delta.json");
        var delta = SceneDeltaReader.Parse(raw);
        Check.That(delta is not null, "delta parsed");

        var state = MirrorState.Create();
        SceneTreeApplier.ApplySceneDelta(state, delta!);

        Check.SequenceEqual(state.OrderedIds, ["root", "card"], "orderedIds");
        Check.Equal(state.Nodes.Count, 2, "node count");

        var root = state.Nodes["root"];
        Check.Equal(root.Name, "Root", "root.name");
        Check.Equal(root.ParentId, null, "root.parentId");
        // Omitted defaults refilled by the reader.
        Check.Equal(root.Visible, true, "root.visible");
        Check.Equal(root.Opacity, 1.0, "root.opacity");
        Check.Equal(root.ScaleX, 1.0, "root.scaleX");
        Check.SequenceClose(root.Transform, [1, 0, 0, 1, 0, 0], "root.transform");

        var card = state.Nodes["card"];
        Check.Equal(card.ParentId, "root", "card.parentId");
        // Meaningful non-defaults preserved; scaleX omitted (=1), scaleY written (=2).
        Check.Equal(card.Visible, false, "card.visible");
        Check.Equal(card.Opacity, 0.5, "card.opacity");
        Check.Equal(card.ScaleX, 1.0, "card.scaleX");
        Check.Equal(card.ScaleY, 2.0, "card.scaleY");
        Check.Equal(card.ZIndex, 5, "card.zIndex");
        // Float-cast transform / localRect parsed transparently.
        Check.SequenceClose(card.Transform, [1, 0, 0, 1, 960.5, 540], "card.transform");
        Check.That(card.LocalRect is not null, "card.localRect not null");
        Check.Equal(card.LocalRect!.X, 0.0, "card.localRect.x");
        Check.Equal(card.LocalRect.Y, 0.0, "card.localRect.y");
        Check.Equal(card.LocalRect.Width, 100.0, "card.localRect.width");
        Check.Equal(card.LocalRect.Height, 16.0, "card.localRect.height");
        // Resource-ref slimmed to path → resolved to the /res/ url.
        Check.Equal(card.TextureUrl, "/res/images/card.png", "card.textureUrl");
        // Color html-only → channels derived.
        Check.That(card.Modulate is not null, "card.modulate not null");
        Check.Equal(card.Modulate!.Html, "#ff8040ff", "card.modulate.html");
        Check.Close(card.Modulate.R, 1, "card.modulate.r");
        Check.Close(card.Modulate.G, 0x80 / 255.0, "card.modulate.g");
        Check.Close(card.Modulate.B, 0x40 / 255.0, "card.modulate.b");
        // Nested Text: content, derived color html, applied font size, alignment.
        Check.That(card.Text is not null, "card.text not null");
        Check.Equal(card.Text!.Text, "HP", "card.text.text");
        Check.Equal(card.Text.ColorHtml, "#ffffffff", "card.text.colorHtml");
        Check.Equal(card.Text.FontSizePx, 24.0, "card.text.fontSizePx");
        Check.Equal(card.Text.Halign, "center", "card.text.halign");
        Check.Equal(card.Text.Valign, "center", "card.text.valign");
    }
}
