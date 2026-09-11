using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-ATLAS: the pure AtlasTexture `.tres` parser (client-side crop of standalone relic/intent atlas node textures).
// Fixture bodies are REAL `.tres` text fetched read-only from the live host (relic_atlas.sprites/*.tres — akabeko,
// anchor, vajra) plus a real non-atlas ShaderMaterial `.tres`; synthetic bodies cover the margin-absent, filter_clip,
// embedded-SubResource-atlas, and malformed edges.
internal static class AtlasTextureParserTests
{
    public static void Run()
    {
        RealRelicBodies();
        MarginAbsentDefaultsZero();
        FilterClipParsed();
        SubResourceAtlasRejected();
        NonAtlasBodiesRejected();
        MalformedBodiesRejected();
    }

    // Real relic_atlas sprite `.tres` bodies (fetched from http://127.0.0.1:13337). All carry a non-zero margin —
    // the crux for the client crop matching Godot's `get_size() = region.size + margin.size` framing.
    private const string Akabeko =
        """
        [gd_resource type="AtlasTexture" load_steps=2 format=3 uid="uid://2vv7n1"]

        [ext_resource type="Texture2D" path="res://images/atlases/relic_atlas.png" id="1"]

        [resource]
        atlas = ExtResource("1")
        region = Rect2(1616, 536, 81, 69)
        margin = Rect2(2, 10, 4, 16)
        """;

    private const string Anchor =
        """
        [gd_resource type="AtlasTexture" load_steps=2 format=3 uid="uid://bymv8uf"]

        [ext_resource type="Texture2D" path="res://images/atlases/relic_atlas.png" id="1"]

        [resource]
        atlas = ExtResource("1")
        region = Rect2(1504, 4, 74, 82)
        margin = Rect2(4, 1, 11, 3)
        """;

    private const string Vajra =
        """
        [gd_resource type="AtlasTexture" load_steps=2 format=3 uid="uid://c1nyg4q"]

        [ext_resource type="Texture2D" path="res://images/atlases/relic_atlas.png" id="1"]

        [resource]
        atlas = ExtResource("1")
        region = Rect2(444, 364, 79, 78)
        margin = Rect2(3, 3, 6, 7)
        """;

    // A real non-atlas `.tres` (a transition ShaderMaterial) — must be REJECTED (kept on the server-crop path).
    private const string FadeTransitionMaterial =
        """
        [gd_resource type="ShaderMaterial" load_steps=2 format=3 uid="uid://c02rttrnpcdyu"]

        [ext_resource type="Shader" path="res://shaders/fade_transition.gdshader" id="1_0d6mo"]

        [resource]
        resource_local_to_scene = true
        shader = ExtResource("1_0d6mo")
        shader_parameter/threshold = 1.0
        """;

    private static void RealRelicBodies()
    {
        var akabeko = AtlasTextureResourceParser.Parse(Akabeko);
        Check.That(akabeko is not null, "akabeko parses");
        Check.Equal(akabeko!.AtlasPath, "res://images/atlases/relic_atlas.png", "akabeko atlas page path");
        Check.Close(akabeko.Region.X, 1616, "akabeko region x");
        Check.Close(akabeko.Region.Y, 536, "akabeko region y");
        Check.Close(akabeko.Region.Width, 81, "akabeko region w");
        Check.Close(akabeko.Region.Height, 69, "akabeko region h");
        Check.Close(akabeko.Margin.X, 2, "akabeko margin x");
        Check.Close(akabeko.Margin.Y, 10, "akabeko margin y");
        Check.Close(akabeko.Margin.Width, 4, "akabeko margin w");
        Check.Close(akabeko.Margin.Height, 16, "akabeko margin h");
        Check.That(!akabeko.FilterClip, "akabeko filter_clip absent ⇒ false");

        var anchor = AtlasTextureResourceParser.Parse(Anchor);
        Check.That(anchor is not null, "anchor parses");
        Check.Close(anchor!.Region.X, 1504, "anchor region x");
        Check.Close(anchor.Region.Height, 82, "anchor region h");
        Check.Close(anchor.Margin.Width, 11, "anchor margin w");

        var vajra = AtlasTextureResourceParser.Parse(Vajra);
        Check.That(vajra is not null, "vajra parses");
        Check.Close(vajra!.Region.Width, 79, "vajra region w");
        Check.Close(vajra.Margin.Height, 7, "vajra margin h");
    }

    // A standalone AtlasTexture with NO margin line → margin defaults to Rect2(0,0,0,0) (the client crop then reduces
    // to the bare-region draw, matching the server's zero-margin bare crop).
    private static void MarginAbsentDefaultsZero()
    {
        const string body =
            """
            [gd_resource type="AtlasTexture" load_steps=2 format=3 uid="uid://zeromgn"]

            [ext_resource type="Texture2D" path="res://images/atlases/card_atlas.png" id="1"]

            [resource]
            atlas = ExtResource("1")
            region = Rect2(10, 20, 30, 40)
            """;

        var p = AtlasTextureResourceParser.Parse(body);
        Check.That(p is not null, "margin-absent body parses");
        Check.Equal(p!.AtlasPath, "res://images/atlases/card_atlas.png", "margin-absent atlas path");
        Check.Close(p.Region.X, 10, "margin-absent region x");
        Check.Close(p.Margin.X, 0, "margin-absent margin x defaults 0");
        Check.Close(p.Margin.Y, 0, "margin-absent margin y defaults 0");
        Check.Close(p.Margin.Width, 0, "margin-absent margin w defaults 0");
        Check.Close(p.Margin.Height, 0, "margin-absent margin h defaults 0");
    }

    private static void FilterClipParsed()
    {
        const string body =
            """
            [gd_resource type="AtlasTexture" load_steps=2 format=3 uid="uid://fclip"]

            [ext_resource type="Texture2D" path="res://images/atlases/p.png" id="1"]

            [resource]
            atlas = ExtResource("1")
            region = Rect2(0, 0, 8, 8)
            margin = Rect2(0, 0, 0, 0)
            filter_clip = true
            """;

        var p = AtlasTextureResourceParser.Parse(body);
        Check.That(p is not null, "filter_clip body parses");
        Check.That(p!.FilterClip, "filter_clip = true parsed");
    }

    // An AtlasTexture whose atlas page is an embedded SubResource (not independently fetchable) → REJECTED so the
    // caller keeps the server crop.
    private static void SubResourceAtlasRejected()
    {
        const string body =
            """
            [gd_resource type="AtlasTexture" load_steps=2 format=3 uid="uid://subatlas"]

            [sub_resource type="ImageTexture" id="ImageTexture_x"]

            [resource]
            atlas = SubResource("ImageTexture_x")
            region = Rect2(0, 0, 8, 8)
            """;

        Check.That(AtlasTextureResourceParser.Parse(body) is null, "SubResource atlas rejected (no fetchable page)");
    }

    private static void NonAtlasBodiesRejected()
    {
        Check.That(
            AtlasTextureResourceParser.Parse(FadeTransitionMaterial) is null,
            "real ShaderMaterial .tres rejected");

        // A Font `.tres`, a gd_scene, a JSON doc, raw shader source, empty, and raw PNG bytes are all not atlases.
        Check.That(
            AtlasTextureResourceParser.Parse("[gd_resource type=\"FontFile\" format=3]\n\n[resource]\n") is null,
            "FontFile .tres rejected");
        Check.That(
            AtlasTextureResourceParser.Parse("[gd_scene load_steps=2 format=3]\n\n[node name=\"Root\"]\n") is null,
            "gd_scene rejected");
        Check.That(
            AtlasTextureResourceParser.Parse("{\"type\":\"AtlasTexture\",\"region\":{}}") is null,
            "JSON doc (starts with '{') rejected");
        Check.That(
            AtlasTextureResourceParser.Parse("shader_type canvas_item;\nvoid fragment(){}") is null,
            "raw shader source rejected");
        Check.That(AtlasTextureResourceParser.Parse("") is null, "empty body rejected");
        Check.That(AtlasTextureResourceParser.Parse("PNG\r\n\n") is null, "raw PNG bytes rejected");
    }

    // An AtlasTexture header but a missing/malformed region, or an unresolved atlas id, → REJECTED.
    private static void MalformedBodiesRejected()
    {
        // Region present but atlas ExtResource id doesn't resolve (no matching ext_resource).
        Check.That(
            AtlasTextureResourceParser.Parse(
                "[gd_resource type=\"AtlasTexture\" format=3]\n\n[resource]\natlas = ExtResource(\"9\")\nregion = Rect2(0, 0, 4, 4)\n") is null,
            "unresolved atlas ext id rejected");

        // Atlas resolves but region line is absent.
        Check.That(
            AtlasTextureResourceParser.Parse(
                "[gd_resource type=\"AtlasTexture\" format=3]\n\n[ext_resource type=\"Texture2D\" path=\"res://p.png\" id=\"1\"]\n\n[resource]\natlas = ExtResource(\"1\")\n") is null,
            "region-absent rejected");

        // Region literal malformed (only 3 args).
        Check.That(
            AtlasTextureResourceParser.Parse(
                "[gd_resource type=\"AtlasTexture\" format=3]\n\n[ext_resource type=\"Texture2D\" path=\"res://p.png\" id=\"1\"]\n\n[resource]\natlas = ExtResource(\"1\")\nregion = Rect2(0, 0, 4)\n") is null,
            "malformed 3-arg Rect2 region rejected");
    }
}
