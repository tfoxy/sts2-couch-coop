using System.Globalization;
using System.Text;
using System.Text.Json;

namespace CouchCoop.MirrorProtocol.SceneModel;

// 1:1 C# port of the tolerant parse path in frontend/src/mirror/sceneTree.ts (`parseSceneDelta` + `normalizeNode`
// and every `normalize*`/`spec*` helper). The wire OMITS fields at the client fallback default, so the reader must
// refill exactly those defaults, accept the slimmed leaf shapes (color `{html}`, vector2 float `{x,y}`, resource
// ref `{resourcePath}`), and tolerate legacy/absent fields. Reads from a JsonElement (or UTF-8 bytes / string);
// no JsonElement is retained past parse, so the backing JsonDocument can be disposed immediately.
public static class SceneDeltaReader
{
    // Parse a `scene-delta` message from a UTF-8 byte array WITHOUT copying: JsonDocument reads the caller's
    // buffer through ReadOnlyMemory and is disposed before returning, and no JsonElement is retained past parse
    // (class doc above), so borrowing the buffer is safe. byte[] is an EXACT-MATCH overload (identity conversion),
    // so the parse pipeline's byte[] call binds here over the copying span overload below with no caller change —
    // this is what removes the multi-MB LOH copy per keyframe. Returns null for a non-object / wrong-type /
    // unparseable message (mirroring parseSceneDelta returning null).
    public static MirrorDelta? Parse(byte[] utf8Json)
    {
        try
        {
            using var doc = JsonDocument.Parse((ReadOnlyMemory<byte>)utf8Json);
            return Parse(doc.RootElement);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // Parse a `scene-delta` message from UTF-8 bytes. Returns null for a non-object / wrong-type / unparseable
    // message (mirroring parseSceneDelta returning null). NOTE: a span has no stable backing memory JsonDocument
    // could borrow, so this overload COPIES the payload — callers holding a byte[] should let the overload above
    // bind (it does by exact match).
    public static MirrorDelta? Parse(ReadOnlySpan<byte> utf8Json)
    {
        try
        {
            using var doc = JsonDocument.Parse(utf8Json.ToArray());
            return Parse(doc.RootElement);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static MirrorDelta? Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return Parse(doc.RootElement);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // Port of parseSceneDelta(raw).
    public static MirrorDelta? Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (AsStringOrEmptyIfNotString(Get(root, "type")) != "scene-delta")
        {
            return null;
        }

        var upserts = new List<MirrorNode>();
        if (Get(root, "upserts") is { ValueKind: JsonValueKind.Array } upsertsArr)
        {
            foreach (var entry in upsertsArr.EnumerateArray())
            {
                var node = NormalizeNode(entry);
                if (node is not null)
                {
                    upserts.Add(node);
                }
            }
        }

        var hints = new List<MirrorTweenHint>();
        if (Get(root, "hints") is { ValueKind: JsonValueKind.Array } hintsArr)
        {
            foreach (var entry in hintsArr.EnumerateArray())
            {
                var hint = NormalizeTweenHint(entry);
                if (hint is not null)
                {
                    hints.Add(hint);
                }
            }
        }

        var cardFlights = new List<MirrorCardFlightHint>();
        if (Get(root, "cardFlights") is { ValueKind: JsonValueKind.Array } flightsArr)
        {
            foreach (var entry in flightsArr.EnumerateArray())
            {
                var flight = NormalizeCardFlight(entry);
                if (flight is not null)
                {
                    cardFlights.Add(flight);
                }
            }
        }

        return new MirrorDelta
        {
            Full = IsTrue(Get(root, "full")),
            ScreenType = AsString(Get(root, "screenType")),
            Upserts = upserts,
            RemovedIds = StringArray(Get(root, "removedIds")) ?? [],
            OrderedIds = StringArray(Get(root, "orderedIds")),
            OrderPatch = NormalizeOrderPatch(Get(root, "orderPatch")),
            Hints = hints,
            CardFlights = cardFlights,
        };
    }

    // ---- node ---------------------------------------------------------------------------------------------------

    private static MirrorNode? NormalizeNode(JsonElement raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return null;
        }

        var el = record.Value;
        var id = AsString(Get(el, "id"));
        if (id.Length == 0)
        {
            return null;
        }

        var spine = NormalizeSpine(Get(el, "spine"));
        var sceneFilePath = AsString(Get(el, "sceneFilePath"));
        var spineCurrentAnim = AsString(Get(el, "spineCurrentAnim"));
        var spineSkin = AsString(Get(el, "spineSkin"));
        var spineMat = AsString(Get(el, "spineMat"));

        var node = new MirrorNode
        {
            Id = id,
            ParentId = IsNullish(Get(el, "parentId")) ? null : Stringify(Get(el, "parentId")),
            Name = AsString(Get(el, "name")),
            NodeType = AsString(Get(el, "nodeType")),
            ShowBehindParent = IsTrue(Get(el, "showBehindParent")),
            ClipChildren = (int)AsNumber(Get(el, "clipChildren")),
            // `Control.clip_contents` — omitted by the producer unless TRUE, so absent reads as false (the
            // wire-defaults convention). NOT the same property as `clipChildren` above; see MirrorNode.
            ClipContents = IsTrue(Get(el, "clipContents")),
            NinePatchMargins = NormalizeMargins(Get(el, "ninePatchMargins")),
            Font = NormalizeFont(Get(el, "font"), Get(el, "fontWeight"), Get(el, "fontStyle")),
            // Per-role rich-text fonts — same resolved-descriptor shape as `font`, but the producer streams no
            // weight/style for a role (the FILE is the role), so both are read as null and the client sets neither
            // declaration on the injected @font-face. Absent on every node without a distinct role font.
            RichBoldFont = NormalizeFont(Get(el, "richBoldFont"), null, null),
            RichItalicFont = NormalizeFont(Get(el, "richItalicFont"), null, null),
            RichBoldItalicFont = NormalizeFont(Get(el, "richBoldItalicFont"), null, null),
            RichBoldFontSizePx = NullableNumber(Get(el, "richBoldFontSizePx")),
            RichItalicFontSizePx = NullableNumber(Get(el, "richItalicFontSizePx")),
            RichBoldItalicFontSizePx = NullableNumber(Get(el, "richBoldItalicFontSizePx")),
            RichBoldFontSpacingPx = NullableNumber(Get(el, "richBoldFontSpacingPx")),
            RichItalicFontSpacingPx = NullableNumber(Get(el, "richItalicFontSpacingPx")),
            RichBoldItalicFontSpacingPx = NullableNumber(Get(el, "richBoldItalicFontSpacingPx")),
            Outline = NormalizeOutline(Get(el, "outlineColor"), Get(el, "outlineSize")),
            Shadow = NormalizeShadow(Get(el, "shadow")),
            RichText = IsTrue(Get(el, "richText")),
            ShaderId = NormalizeResourcePath(Get(el, "shader")),
            MaterialRef = NormalizeResourcePath(Get(el, "material")),
            ShaderParams = NormalizeShaderParams(Get(el, "shaderParameters")),
            TextureStretchMode = IsNullish(Get(el, "textureStretchMode")) ? null : (int)AsNumber(Get(el, "textureStretchMode")),
            TextureFlipH = IsTrue(Get(el, "textureFlipH")),
            TextureFlipV = IsTrue(Get(el, "textureFlipV")),
            CanvasBlendMode = IsNullish(Get(el, "canvasBlendMode")) ? null : (int)AsNumber(Get(el, "canvasBlendMode")),
            ParticleSpec = NormalizeParticleSpec(Get(el, "particleSpec")),
            ParticleEmitting = IsTrue(Get(el, "particleEmitting")),
            ParticleRestartEpoch = (long)AsNumber(Get(el, "particleRestartEpoch")),
            SpineSceneResPath = spine.SceneResPath,
            SpineNodePath = spine.NodePath,
            SpineAnimations = spine.Animations,
            SpineSkelResPath = spine.SkelResPath,
            SceneFilePath = sceneFilePath.Length > 0 ? sceneFilePath : null,
            MouseFilter = Get(el, "mouseFilter") is { ValueKind: JsonValueKind.Number } mf ? (int)mf.GetDouble() : null,
            AnchorLeft = IsNullish(Get(el, "anchorLeft")) ? null : AsNumber(Get(el, "anchorLeft")),
            AnchorRight = IsNullish(Get(el, "anchorRight")) ? null : AsNumber(Get(el, "anchorRight")),
            AnchorOwnerId = Get(el, "anchorOwnerId") is { ValueKind: JsonValueKind.String } ao ? ao.GetString() : null,
            ContainerLayout = Get(el, "containerLayout") is { ValueKind: JsonValueKind.String } clv ? clv.GetString() : null,
            SpineCurrentAnim = spineCurrentAnim.Length > 0 ? spineCurrentAnim : null,
            SpineSkin = spineSkin.Length > 0 ? spineSkin : null,
            SpineMat = spineMat.Length > 0 ? spineMat : null,
            SpinePaused = IsTrue(Get(el, "spinePaused")),
            SpineTrackTime = AsNumber(Get(el, "spineTrackTime")),
            SpineLooping = NotFalse(Get(el, "spineLooping")),
            Transform = NormalizeTransform(Get(el, "transform")),
            LocalRect = NormalizeRect(Get(el, "localRect")),
            Visible = NotFalse(Get(el, "visible")),
            Opacity = IsNullish(Get(el, "opacity")) ? 1 : AsNumber(Get(el, "opacity")),
            Rotation = AsNumber(Get(el, "rotation")),
            ScaleX = IsNullish(Get(el, "scaleX")) ? 1 : AsNumber(Get(el, "scaleX")),
            ScaleY = IsNullish(Get(el, "scaleY")) ? 1 : AsNumber(Get(el, "scaleY")),
            PivotX = AsNumber(Get(el, "pivotX")),
            PivotY = AsNumber(Get(el, "pivotY")),
            ZIndex = IsNullish(Get(el, "zIndex")) ? null : (int)AsNumber(Get(el, "zIndex")),
            TextureUrl = NormalizeTextureUrl(Get(el, "texture")),
            TextureRegion = NormalizeRect(Get(el, "textureRegion")),
            TextureMargin = NormalizeRect(Get(el, "textureMargin")),
            NinePatch = IsTrue(Get(el, "ninePatch")),
            Modulate = NormalizeColor(Get(el, "modulate")),
            SelfModulate = NormalizeColor(Get(el, "selfModulate")),
            FillColor = NormalizeColor(Get(el, "fillColor")),
            Range = NormalizeRange(el),
            Text = NormalizeText(Get(el, "text")),
            IntentFrames = NormalizeIntentFrames(Get(el, "intentFrames")),
            // Line2D stroke geometry (sticky unit). An absent `linePoints` stays null ("unchanged"); an EMPTY
            // array is preserved as an empty list ("cleared" — erase the stroke), which is why this cannot reuse
            // AsNumberArray (that collapses empty → null).
            LinePoints = NormalizeLinePoints(Get(el, "linePoints")),
            LineWidth = NullableNumber(Get(el, "lineWidth")),
            LineColor = NormalizeColor(Get(el, "lineColor")),
        };

        return SceneTreeApplier.ApplyIntentFrame0(node);
    }

    // ---- leaves -------------------------------------------------------------------------------------------------

    private static MirrorMargins? NormalizeMargins(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return null;
        }

        var el = record.Value;
        var margins = new MirrorMargins(
            AsNumber(Get(el, "left")),
            AsNumber(Get(el, "top")),
            AsNumber(Get(el, "right")),
            AsNumber(Get(el, "bottom")));
        // All-zero margins behave like a plain stretched texture — no need to nine-patch.
        return margins.Left != 0 || margins.Top != 0 || margins.Right != 0 || margins.Bottom != 0 ? margins : null;
    }

    // A nullable numeric wire field: absent/null stays null (the null is MEANINGFUL — "nothing to say for this
    // role"), anything else parses through the shared numeric coercion.
    private static double? NullableNumber(JsonElement? raw) => IsNullish(raw) ? null : AsNumber(raw);

    private static MirrorFont? NormalizeFont(JsonElement? raw, JsonElement? weightRaw, JsonElement? styleRaw)
    {
        var path = NormalizeResourcePath(raw);
        if (path is null)
        {
            return null;
        }

        var segments = path.Split('/');
        var file = segments[^1];
        var family = file;
        var dot = file.LastIndexOf('.');
        if (dot >= 0 && dot < file.Length - 1)
        {
            family = file[..dot];
        }

        return family.Length > 0
            ? new MirrorFont(family, MirrorResourceUrl(path), NormalizeFontWeight(weightRaw), NormalizeFontStyle(styleRaw))
            : null;
    }

    private static string? NormalizeFontWeight(JsonElement? raw)
    {
        var v = AsString(raw).Trim().ToLowerInvariant();
        if (v.Length == 0)
        {
            return null;
        }

        if (v is "bold" or "normal")
        {
            return v;
        }

        if (v.Length is 3 or 4 && v.All(char.IsAsciiDigit))
        {
            return v;
        }

        return v.Contains("bold", StringComparison.Ordinal) ? "bold" : null;
    }

    private static string? NormalizeFontStyle(JsonElement? raw)
    {
        var v = AsString(raw).Trim().ToLowerInvariant();
        return v is "italic" or "oblique" ? v : null;
    }

    private static MirrorOutline? NormalizeOutline(JsonElement? colorRaw, JsonElement? sizeRaw)
    {
        var color = NormalizeColor(colorRaw);
        var size = IsNullish(sizeRaw) ? 0 : AsNumber(sizeRaw);
        return color is not null && size > 0 ? new MirrorOutline(color.Html, size) : null;
    }

    private static MirrorColor? NormalizeColor(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return null;
        }

        var el = record.Value;
        var html = AsString(Get(el, "html"));
        // Channels-first precedence: OLD recordings ship r/g/b/a (+html); the slimmed wire ships html-only.
        if (!IsNullish(Get(el, "r")) || !IsNullish(Get(el, "g")) || !IsNullish(Get(el, "b")) || !IsNullish(Get(el, "a")))
        {
            return new MirrorColor(
                AsNumberOr(Get(el, "r"), 1),
                AsNumberOr(Get(el, "g"), 1),
                AsNumberOr(Get(el, "b"), 1),
                AsNumberOr(Get(el, "a"), 1),
                html);
        }

        var (r, g, b, a) = ChannelsFromHtml(html);
        return new MirrorColor(r, g, b, a, html);
    }

    private static MirrorShadow? NormalizeShadow(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return null;
        }

        var el = record.Value;
        var color = NormalizeColor(Get(el, "color"));
        var offset = AsRecord(Get(el, "offset"));
        var offsetX = offset is null ? 0 : AsNumber(Get(offset.Value, "x"));
        var offsetY = offset is null ? 0 : AsNumber(Get(offset.Value, "y"));
        if (color is null || (offsetX == 0 && offsetY == 0))
        {
            return null;
        }

        return new MirrorShadow(color.Html, offsetX, offsetY);
    }

    private static MirrorRange? NormalizeRange(JsonElement record)
    {
        if (IsNullish(Get(record, "rangeValue")))
        {
            return null;
        }

        return new MirrorRange(
            AsNumber(Get(record, "rangeValue")),
            AsNumberOr(Get(record, "rangeMin"), 0),
            AsNumberOr(Get(record, "rangeMax"), 100));
    }

    private static string? NormalizeResourcePath(JsonElement? raw)
    {
        var record = AsRecord(raw);
        var path = record is null ? "" : AsString(Get(record.Value, "resourcePath"));
        return path.Length > 0 ? path : null;
    }

    private static string? NormalizeTextureUrl(JsonElement? raw)
    {
        var resourcePath = NormalizeResourcePath(raw);
        return resourcePath is not null ? MirrorResourceUrl(resourcePath) : null;
    }

    private static MirrorText? NormalizeText(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return null;
        }

        var el = record.Value;
        var content = !IsNullish(Get(el, "text")) ? AsString(Get(el, "text")) : AsString(Get(el, "rawText"));
        if (content.Length == 0)
        {
            return null;
        }

        var color = AsRecord(Get(el, "textColor"));
        var layout = AsRecord(Get(el, "layout"));
        var outline = AsRecord(Get(el, "outlineColor"));
        return new MirrorText(
            content,
            color is not null && !IsNullish(Get(color.Value, "html")) ? AsString(Get(color.Value, "html")) : null,
            !IsNullish(Get(el, "appliedFontSize"))
                ? AsNumber(Get(el, "appliedFontSize"))
                : !IsNullish(Get(el, "fontSize"))
                    ? AsNumber(Get(el, "fontSize"))
                    : null,
            layout is not null && !IsNullish(Get(layout.Value, "horizontalAlignment")) ? AsString(Get(layout.Value, "horizontalAlignment")) : null,
            layout is not null && !IsNullish(Get(layout.Value, "verticalAlignment")) ? AsString(Get(layout.Value, "verticalAlignment")) : null,
            outline is not null && !IsNullish(Get(outline.Value, "html")) ? AsString(Get(outline.Value, "html")) : null,
            !IsNullish(Get(el, "outlineSize")) ? AsNumber(Get(el, "outlineSize")) : 0);
    }

    private static MirrorRect? NormalizeRect(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return null;
        }

        var el = record.Value;
        var position = AsRecord(Get(el, "position"));
        var size = AsRecord(Get(el, "size"));
        if (position is null || size is null)
        {
            return null;
        }

        return new MirrorRect(
            AsNumber(Get(position.Value, "x")),
            AsNumber(Get(position.Value, "y")),
            AsNumber(Get(size.Value, "x")),
            AsNumber(Get(size.Value, "y")));
    }

    private static IReadOnlyList<double>? NormalizeTransform(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return null;
        }

        var el = record.Value;
        var x = AsRecord(Get(el, "xAxis"));
        var y = AsRecord(Get(el, "yAxis"));
        var o = AsRecord(Get(el, "origin"));
        if (x is null || y is null || o is null)
        {
            return null;
        }

        return
        [
            AsNumber(Get(x.Value, "x")),
            AsNumber(Get(x.Value, "y")),
            AsNumber(Get(y.Value, "x")),
            AsNumber(Get(y.Value, "y")),
            AsNumber(Get(o.Value, "x")),
            AsNumber(Get(o.Value, "y")),
        ];
    }

    private static (string? SceneResPath, string? NodePath, IReadOnlyList<string>? Animations, string? SkelResPath) NormalizeSpine(JsonElement? raw)
    {
        var record = AsRecord(raw);
        var sceneResPath = record is null ? "" : AsString(Get(record.Value, "sceneResPath"));
        if (record is null || sceneResPath.Length == 0)
        {
            return (null, null, null, null);
        }

        var el = record.Value;
        var animations = new List<string>();
        if (Get(el, "animations") is { ValueKind: JsonValueKind.Array } arr)
        {
            foreach (var name in arr.EnumerateArray())
            {
                var s = AsString(name);
                if (s.Length > 0)
                {
                    animations.Add(s);
                }
            }
        }

        var nodePath = AsString(Get(el, "nodePath"));
        // RuntimeSceneSpineSnapshot.SkelResPath → `spine.skelResPath` (camelCase). STATIC (add/keyframe only);
        // null/absent when the producer didn't capture a skeleton path. Drives the #8 `&skel=` retry.
        var skelResPath = AsString(Get(el, "skelResPath"));
        return (sceneResPath, nodePath.Length > 0 ? nodePath : null, animations, skelResPath.Length > 0 ? skelResPath : null);
    }

    private static IReadOnlyList<MirrorShaderParam>? NormalizeShaderParams(JsonElement? raw)
    {
        if (raw is not { ValueKind: JsonValueKind.Array } arr)
        {
            return null;
        }

        var parameters = new List<MirrorShaderParam>();
        foreach (var entry in arr.EnumerateArray())
        {
            var record = AsRecord(entry);
            var name = record is null ? "" : AsString(Get(record.Value, "name"));
            if (record is null || name.Length == 0)
            {
                continue;
            }

            var el = record.Value;
            parameters.Add(new MirrorShaderParam(
                name,
                AsString(Get(el, "kind")),
                IsNullish(Get(el, "number")) ? null : AsNumber(Get(el, "number")),
                Get(el, "bool") is { ValueKind: JsonValueKind.True or JsonValueKind.False } b ? b.GetBoolean() : null,
                IsNullish(Get(el, "string")) ? null : AsString(Get(el, "string")),
                NormalizeColor(Get(el, "color")),
                NormalizeVector2(Get(el, "vector2")),
                NormalizeResourcePath(Get(el, "resource")),
                NormalizeVector3(Get(el, "vector3")),
                NormalizeVector4(Get(el, "vector4")),
                NormalizeFlatRect(Get(el, "rect2")),
                AsTransform6(Get(el, "transform2D")),
                AsNumberArray(Get(el, "numberArray"))));
        }

        return parameters.Count > 0 ? parameters : null;
    }

    private static MirrorVector2? NormalizeVector2(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null || IsNullish(Get(record.Value, "x")) || IsNullish(Get(record.Value, "y")))
        {
            return null;
        }

        var el = record.Value;
        return new MirrorVector2(AsNumber(Get(el, "x")), AsNumber(Get(el, "y")));
    }

    // {x,y,z} → MirrorVector3 (shader vector3 uniform, Godot-native-first extended kind).
    private static MirrorVector3? NormalizeVector3(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null
            || IsNullish(Get(record.Value, "x"))
            || IsNullish(Get(record.Value, "y"))
            || IsNullish(Get(record.Value, "z")))
        {
            return null;
        }

        var el = record.Value;
        return new MirrorVector3(AsNumber(Get(el, "x")), AsNumber(Get(el, "y")), AsNumber(Get(el, "z")));
    }

    // {x,y,z,w} → MirrorVector4 (shader vector4/quaternion uniform, Godot-native-first extended kind).
    private static MirrorVector4? NormalizeVector4(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null
            || IsNullish(Get(record.Value, "x"))
            || IsNullish(Get(record.Value, "y"))
            || IsNullish(Get(record.Value, "z"))
            || IsNullish(Get(record.Value, "w")))
        {
            return null;
        }

        var el = record.Value;
        return new MirrorVector4(
            AsNumber(Get(el, "x")),
            AsNumber(Get(el, "y")),
            AsNumber(Get(el, "z")),
            AsNumber(Get(el, "w")));
    }

    // Flat {x,y,width,height} → MirrorRect (shader rect2 uniform — distinct from NormalizeRect's nested
    // position/size localRect/region shape).
    private static MirrorRect? NormalizeFlatRect(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null
            || IsNullish(Get(record.Value, "x"))
            || IsNullish(Get(record.Value, "y"))
            || IsNullish(Get(record.Value, "width"))
            || IsNullish(Get(record.Value, "height")))
        {
            return null;
        }

        var el = record.Value;
        return new MirrorRect(
            AsNumber(Get(el, "x")),
            AsNumber(Get(el, "y")),
            AsNumber(Get(el, "width")),
            AsNumber(Get(el, "height")));
    }

    // A JSON array of numbers → flat double list (shader *Array uniforms; the element stride rides the kind).
    private static IReadOnlyList<double>? AsNumberArray(JsonElement? raw)
    {
        if (raw is not { ValueKind: JsonValueKind.Array } arr)
        {
            return null;
        }

        var values = new List<double>(arr.GetArrayLength());
        foreach (var e in arr.EnumerateArray())
        {
            if (e.ValueKind != JsonValueKind.Number)
            {
                return null;
            }

            values.Add(e.GetDouble());
        }

        return values.Count > 0 ? values : null;
    }

    // A Line2D's flattened `[x0,y0,x1,y1,…]` stroke geometry. Unlike AsNumberArray this PRESERVES an empty array
    // (the "stroke cleared" instruction) and only returns null for an absent / non-array / non-numeric payload
    // ("unchanged — keep the retained geometry"). An unpaired trailing coordinate is dropped: it is not a point.
    private static IReadOnlyList<double>? NormalizeLinePoints(JsonElement? raw)
    {
        if (raw is not { ValueKind: JsonValueKind.Array } arr)
        {
            return null;
        }

        var values = new List<double>(arr.GetArrayLength());
        foreach (var e in arr.EnumerateArray())
        {
            if (e.ValueKind != JsonValueKind.Number)
            {
                return null;
            }

            values.Add(e.GetDouble());
        }

        if (values.Count % 2 != 0)
        {
            values.RemoveAt(values.Count - 1);
        }

        return values;
    }

    private static MirrorIntentFrames? NormalizeIntentFrames(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return null;
        }

        var el = record.Value;
        var animationName = AsString(Get(el, "animationName"));
        var frames = new List<MirrorIntentFrame>();
        if (Get(el, "frames") is { ValueKind: JsonValueKind.Array } arr)
        {
            foreach (var entry in arr.EnumerateArray())
            {
                var fr = AsRecord(entry);
                if (fr is null)
                {
                    continue;
                }

                var atlasPath = AsString(Get(fr.Value, "atlasPath"));
                if (atlasPath.Length == 0)
                {
                    continue;
                }

                frames.Add(new MirrorIntentFrame(
                    MirrorResourceUrl(atlasPath),
                    NormalizeRect(Get(fr.Value, "region")),
                    NormalizeRect(Get(fr.Value, "margin"))));
            }
        }

        if (animationName.Length == 0 || frames.Count == 0)
        {
            return null;
        }

        var fps = AsNumber(Get(el, "fps"));
        return new MirrorIntentFrames(animationName, fps > 0 ? fps : 15, frames);
    }

    // ---- particle spec ------------------------------------------------------------------------------------------

    private static MirrorParticleSpec? NormalizeParticleSpec(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return null;
        }

        var r = record.Value;
        var kind = AsString(Get(r, "kind"));
        if (kind is not ("GPUParticles2D" or "CPUParticles2D"))
        {
            return null;
        }

        return new MirrorParticleSpec(
            Kind: kind,
            Amount: AsNumber(Get(r, "amount")),
            AmountRatio: AsNumberOr(Get(r, "amountRatio"), 1),
            Lifetime: AsNumberOr(Get(r, "lifetime"), 1),
            LifetimeRandomness: AsNumber(Get(r, "lifetimeRandomness")),
            OneShot: IsTrue(Get(r, "oneShot")),
            Emitting: false,
            Explosiveness: AsNumber(Get(r, "explosiveness")),
            Randomness: AsNumber(Get(r, "randomness")),
            Preprocess: AsNumber(Get(r, "preprocess")),
            SpeedScale: AsNumberOr(Get(r, "speedScale"), 1),
            FixedFps: AsNumber(Get(r, "fixedFps")),
            LocalCoords: IsTrue(Get(r, "localCoords")),
            DrawOrder: AsNumber(Get(r, "drawOrder")),
            Seed: AsNumber(Get(r, "seed")),
            EmissionShape: AsNumber(Get(r, "emissionShape")),
            EmissionOffset: SpecVec2(Get(r, "emissionOffset")),
            EmissionScale: SpecVec2(Get(r, "emissionScale"), 1),
            EmissionSphereRadius: AsNumber(Get(r, "emissionSphereRadius")),
            EmissionRingRadius: AsNumber(Get(r, "emissionRingRadius")),
            EmissionRingInnerRadius: AsNumber(Get(r, "emissionRingInnerRadius")),
            EmissionRingHeight: AsNumber(Get(r, "emissionRingHeight")),
            EmissionBoxExtents: SpecVec2(Get(r, "emissionBoxExtents")),
            Direction: SpecVec2(Get(r, "direction")),
            Spread: AsNumber(Get(r, "spread")),
            InitialVelocityMin: AsNumber(Get(r, "initialVelocityMin")),
            InitialVelocityMax: AsNumber(Get(r, "initialVelocityMax")),
            AngleMin: AsNumber(Get(r, "angleMin")),
            AngleMax: AsNumber(Get(r, "angleMax")),
            AngularVelocityMin: AsNumber(Get(r, "angularVelocityMin")),
            AngularVelocityMax: AsNumber(Get(r, "angularVelocityMax")),
            Gravity: SpecVec2(Get(r, "gravity")),
            LinearAccelMin: AsNumber(Get(r, "linearAccelMin")),
            LinearAccelMax: AsNumber(Get(r, "linearAccelMax")),
            RadialAccelMin: AsNumber(Get(r, "radialAccelMin")),
            RadialAccelMax: AsNumber(Get(r, "radialAccelMax")),
            TangentialAccelMin: AsNumber(Get(r, "tangentialAccelMin")),
            TangentialAccelMax: AsNumber(Get(r, "tangentialAccelMax")),
            DampingMin: AsNumber(Get(r, "dampingMin")),
            DampingMax: AsNumber(Get(r, "dampingMax")),
            DampingAsFriction: IsTrue(Get(r, "dampingAsFriction")),
            OrbitVelocityMin: AsNumber(Get(r, "orbitVelocityMin")),
            OrbitVelocityMax: AsNumber(Get(r, "orbitVelocityMax")),
            ScaleMin: AsNumberOr(Get(r, "scaleMin"), 1),
            ScaleMax: AsNumberOr(Get(r, "scaleMax"), 1),
            HueVariationMin: AsNumber(Get(r, "hueVariationMin")),
            HueVariationMax: AsNumber(Get(r, "hueVariationMax")),
            AlignY: IsTrue(Get(r, "alignY")),
            BaseColor: SpecColor(Get(r, "baseColor")),
            OriginX: AsNumber(Get(r, "originX")),
            OriginY: AsNumber(Get(r, "originY")),
            TextureUrl: NormalizeTextureUrl(Get(r, "texture")),
            TextureWidth: AsNumber(Get(r, "textureWidth")),
            TextureHeight: AsNumber(Get(r, "textureHeight")),
            Hframes: AsNumberOr(Get(r, "hframes"), 1),
            Vframes: AsNumberOr(Get(r, "vframes"), 1),
            AnimLoop: IsTrue(Get(r, "animLoop")),
            AnimSpeedMin: AsNumber(Get(r, "animSpeedMin")),
            AnimSpeedMax: AsNumber(Get(r, "animSpeedMax")),
            AnimOffsetMin: AsNumber(Get(r, "animOffsetMin")),
            AnimOffsetMax: AsNumber(Get(r, "animOffsetMax")),
            BlendMode: AsNumber(Get(r, "blendMode")),
            ColorRamp: SpecStops(Get(r, "colorRamp")),
            ColorInitialRamp: SpecStops(Get(r, "colorInitialRamp")),
            ScaleCurve: SpecPoints(Get(r, "scaleCurve")),
            ScaleCurveX: SpecPoints(Get(r, "scaleCurveX")),
            ScaleCurveY: SpecPoints(Get(r, "scaleCurveY")),
            AlphaCurve: SpecPoints(Get(r, "alphaCurve")),
            HueCurve: SpecPoints(Get(r, "hueCurve")));
    }

    private static IReadOnlyList<double> SpecVec2(JsonElement? raw, double fallback = 0)
    {
        var record = AsRecord(raw);
        return record is not null
            ? [AsNumber(Get(record.Value, "x")), AsNumber(Get(record.Value, "y"))]
            : [fallback, fallback];
    }

    private static IReadOnlyList<double> SpecColor(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return [1, 1, 1, 1];
        }

        var el = record.Value;
        if (!IsNullish(Get(el, "r")) || !IsNullish(Get(el, "g")) || !IsNullish(Get(el, "b")) || !IsNullish(Get(el, "a")))
        {
            return [AsNumberOr(Get(el, "r"), 1), AsNumberOr(Get(el, "g"), 1), AsNumberOr(Get(el, "b"), 1), AsNumberOr(Get(el, "a"), 1)];
        }

        var (r, g, b, a) = ChannelsFromHtml(AsString(Get(el, "html")));
        return [r, g, b, a];
    }

    private static IReadOnlyList<MirrorGradientStop>? SpecStops(JsonElement? raw)
    {
        if (raw is not { ValueKind: JsonValueKind.Array } arr)
        {
            return null;
        }

        var stops = new List<MirrorGradientStop>();
        foreach (var entry in arr.EnumerateArray())
        {
            var record = AsRecord(entry);
            if (record is not null)
            {
                stops.Add(new MirrorGradientStop(AsNumber(Get(record.Value, "offset")), SpecColor(Get(record.Value, "color"))));
            }
        }

        return stops.Count > 0 ? stops : null;
    }

    private static IReadOnlyList<MirrorCurvePoint>? SpecPoints(JsonElement? raw)
    {
        if (raw is not { ValueKind: JsonValueKind.Array } arr)
        {
            return null;
        }

        var points = new List<MirrorCurvePoint>();
        foreach (var entry in arr.EnumerateArray())
        {
            var record = AsRecord(entry);
            if (record is not null)
            {
                points.Add(new MirrorCurvePoint(AsNumber(Get(record.Value, "x")), AsNumber(Get(record.Value, "y"))));
            }
        }

        return points.Count > 0 ? points : null;
    }

    // ---- delta sub-structures -----------------------------------------------------------------------------------

    private static MirrorOrderPatch? NormalizeOrderPatch(JsonElement? raw)
    {
        var record = AsRecord(raw);
        if (record is null)
        {
            return null;
        }

        var el = record.Value;
        var parents = new List<MirrorOrderParent>();
        if (Get(el, "parents") is { ValueKind: JsonValueKind.Array } arr)
        {
            foreach (var entry in arr.EnumerateArray())
            {
                var pr = AsRecord(entry);
                if (pr is null)
                {
                    continue;
                }

                var p = AsString(Get(pr.Value, "p"));
                if (p.Length == 0)
                {
                    continue;
                }

                parents.Add(new MirrorOrderParent(p, StringArray(Get(pr.Value, "c")) ?? []));
            }
        }

        return new MirrorOrderPatch(StringArray(Get(el, "roots")), parents);
    }

    private static MirrorTweenHint? NormalizeTweenHint(JsonElement entry)
    {
        var record = AsRecord(entry);
        if (record is null)
        {
            return null;
        }

        var r = record.Value;
        var targetId = AsString(Get(r, "targetId"));
        var property = AsString(Get(r, "property"));
        if (targetId.Length == 0 || property.Length == 0)
        {
            return null;
        }

        return new MirrorTweenHint(
            targetId,
            property,
            Get(r, "to") is { ValueKind: JsonValueKind.String } to ? to.GetString() : null,
            Get(r, "durationMs") is { ValueKind: JsonValueKind.Number } dm ? dm.GetDouble() : 0,
            Get(r, "trans") is { ValueKind: JsonValueKind.String } tr ? tr.GetString() : null,
            Get(r, "ease") is { ValueKind: JsonValueKind.String } ea ? ea.GetString() : null,
            AsTransform6(Get(r, "endTransform")),
            Get(r, "endOpacity") is { ValueKind: JsonValueKind.Number } eo ? eo.GetDouble() : null,
            Get(r, "group") is { ValueKind: JsonValueKind.String } gr ? gr.GetString() : null,
            AsTransform6(Get(r, "startTransform")),
            Get(r, "startOpacity") is { ValueKind: JsonValueKind.Number } so ? so.GetDouble() : null);
    }

    // WS-3 declarative card flight. STRICT on the geometry (a flight the client cannot integrate must be dropped
    // rather than half-applied — the producer has stopped streaming these nodes, so a bad replay freezes them):
    // every required point/basis must be present with the right arity and the integrator scalars must be usable.
    // Port of normalizeCardFlight in frontend/src/mirror/sceneTree.ts; the two must stay byte-identical in what
    // they accept (SceneDeltaParseParityTests replays the wire fixtures through both).
    private static MirrorCardFlightHint? NormalizeCardFlight(JsonElement entry)
    {
        var record = AsRecord(entry);
        if (record is null)
        {
            return null;
        }

        var r = record.Value;
        var targetId = AsString(Get(r, "targetId"));
        if (targetId.Length == 0)
        {
            return null;
        }

        var start = AsNumberArray(Get(r, "start"), 2);
        var end = AsNumberArray(Get(r, "end"), 2);
        var control = AsNumberArray(Get(r, "control"), 2);
        var basis = AsNumberArray(Get(r, "basis"), 4);
        if (start is null || end is null || control is null || basis is null)
        {
            return null;
        }

        var duration = AsFiniteNumber(Get(r, "duration"));
        var speed0 = AsFiniteNumber(Get(r, "speed0"));
        var accel = AsFiniteNumber(Get(r, "accel"));
        var scale0 = AsFiniteNumber(Get(r, "scale0"));
        var windowMs = AsFiniteNumber(Get(r, "windowMs"));
        if (duration is not > 0 || speed0 is not > 0 || accel is null || scale0 is null || windowMs is not > 0
            || Math.Abs(scale0.Value) <= 1e-6)
        {
            return null;
        }

        var trailId = Get(r, "trailId") is { ValueKind: JsonValueKind.String } t ? t.GetString() : null;

        // The two OPTIONAL fields are the one place this parser is deliberately LENIENT, and in the opposite
        // direction to everything above: an absent, misspelled or future kind FAILS OPEN to "shuffle" rather than
        // dropping the entry. Dropping is the safe answer for unusable geometry (nothing can be integrated from it);
        // here the numbers are all valid, so the worst an unknown kind costs is the wrong flavour of motion, while a
        // drop would leave a suppressed node frozen. `rot0` only seeds a turn, so anything unusable reads as 0.
        var kind = Get(r, "kind") is { ValueKind: JsonValueKind.String } k
            && string.Equals(k.GetString(), "discard", StringComparison.Ordinal)
            ? "discard"
            : "shuffle";
        var rot0 = AsFiniteNumber(Get(r, "rot0")) ?? 0;

        return new MirrorCardFlightHint(
            targetId,
            string.IsNullOrEmpty(trailId) ? null : trailId,
            start,
            end,
            control,
            basis,
            speed0.Value,
            accel.Value,
            duration.Value,
            scale0.Value,
            windowMs.Value,
            kind,
            rot0);
    }

    private static double? AsFiniteNumber(JsonElement? raw)
    {
        if (raw is not { ValueKind: JsonValueKind.Number } n)
        {
            return null;
        }

        var value = n.GetDouble();
        return double.IsFinite(value) ? value : null;
    }

    // A fixed-arity array of finite numbers, or null (wrong kind / wrong length / any non-finite entry).
    private static IReadOnlyList<double>? AsNumberArray(JsonElement? raw, int arity)
    {
        if (raw is not { ValueKind: JsonValueKind.Array } arr || arr.GetArrayLength() != arity)
        {
            return null;
        }

        var values = new double[arity];
        var i = 0;
        foreach (var e in arr.EnumerateArray())
        {
            if (e.ValueKind != JsonValueKind.Number)
            {
                return null;
            }

            var value = e.GetDouble();
            if (!double.IsFinite(value))
            {
                return null;
            }

            values[i++] = value;
        }

        return values;
    }

    private static IReadOnlyList<double>? AsTransform6(JsonElement? raw)
    {
        if (raw is not { ValueKind: JsonValueKind.Array } arr || arr.GetArrayLength() != 6)
        {
            return null;
        }

        var values = new double[6];
        var i = 0;
        foreach (var e in arr.EnumerateArray())
        {
            if (e.ValueKind != JsonValueKind.Number)
            {
                return null;
            }

            values[i++] = e.GetDouble();
        }

        return values;
    }

    // ---- primitive helpers (port of asRecord/asString/asNumber/asNumberOr/channelsFromHtml/mirrorResourceUrl) ----

    private static JsonElement? Get(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v) ? v : null;

    private static JsonElement? AsRecord(JsonElement? v) =>
        v is { ValueKind: JsonValueKind.Object } e ? e : null;

    // TS `x == null`: undefined OR null.
    private static bool IsNullish(JsonElement? v) => v is null || v.Value.ValueKind == JsonValueKind.Null;

    private static bool IsTrue(JsonElement? v) => v is { ValueKind: JsonValueKind.True };

    // TS `x !== false`: everything except an explicit boolean false.
    private static bool NotFalse(JsonElement? v) => v is not { ValueKind: JsonValueKind.False };

    private static string AsString(JsonElement? v) =>
        v is { ValueKind: JsonValueKind.String } e ? e.GetString() ?? "" : "";

    // The exact string returned for a non-string property so `AsString(...) != "scene-delta"` matches TS.
    private static string AsStringOrEmptyIfNotString(JsonElement? v) => AsString(v);

    private static double AsNumber(JsonElement? v) =>
        v is { ValueKind: JsonValueKind.Number } e && e.TryGetDouble(out var d) && double.IsFinite(d) ? d : 0;

    private static double AsNumberOr(JsonElement? v, double fallback) =>
        v is { ValueKind: JsonValueKind.Number } e && e.TryGetDouble(out var d) && double.IsFinite(d) ? d : fallback;

    // Port of JS `String(value)` for the id-coercion sites (parentId/removedIds/orderedIds). Practically always a
    // string on the wire; numbers/bools are stringified with JS-compatible spellings for defensiveness.
    private static string Stringify(JsonElement? v) => v switch
    {
        null => "",
        { ValueKind: JsonValueKind.String } e => e.GetString() ?? "",
        { ValueKind: JsonValueKind.Number } e => e.GetRawText(),
        { ValueKind: JsonValueKind.True } => "true",
        { ValueKind: JsonValueKind.False } => "false",
        { ValueKind: JsonValueKind.Null } => "null",
        { } e => e.GetRawText(),
    };

    private static List<string>? StringArray(JsonElement? v)
    {
        if (v is not { ValueKind: JsonValueKind.Array } arr)
        {
            return null;
        }

        var list = new List<string>(arr.GetArrayLength());
        foreach (var e in arr.EnumerateArray())
        {
            list.Add(Stringify(e));
        }

        return list;
    }

    // Port of channelsFromHtml: Godot #RRGGBB / #RRGGBBAA → linear channels in 0..1; invalid/absent → opaque white.
    private static (double R, double G, double B, double A) ChannelsFromHtml(string html)
    {
        var hex = html.StartsWith('#') ? html[1..] : html;
        if (hex.Length is not (6 or 8))
        {
            return (1, 1, 1, 1);
        }

        if (!TryByte(hex, 0, out var r) || !TryByte(hex, 1, out var g) || !TryByte(hex, 2, out var b))
        {
            return (1, 1, 1, 1);
        }

        double a = 1;
        if (hex.Length == 8 && !TryByte(hex, 3, out a))
        {
            return (1, 1, 1, 1);
        }

        return (r, g, b, a);

        static bool TryByte(string hex, int index, out double value)
        {
            if (int.TryParse(hex.AsSpan(index * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var raw))
            {
                value = raw / 255.0;
                return true;
            }

            value = 0;
            return false;
        }
    }

    // Port of mirrorResourceUrl: `res://images/x.png` → `/res/images/x.png`, per-segment encodeURIComponent.
    public static string MirrorResourceUrl(string resourcePath)
    {
        var trimmed = resourcePath.StartsWith("res://", StringComparison.Ordinal)
            ? resourcePath["res://".Length..]
            : resourcePath;
        return "/res/" + string.Join('/', trimmed.Split('/').Select(EncodeUriComponent));
    }

    // Faithful port of JS encodeURIComponent: keep the unreserved set A-Za-z0-9 - _ . ! ~ * ' ( ), percent-encode
    // every other byte of the UTF-8 encoding (uppercase hex). Uri.EscapeDataString differs on !~*'() so it can't
    // be used directly.
    private static string EncodeUriComponent(string segment)
    {
        var sb = new StringBuilder(segment.Length);
        foreach (var b in Encoding.UTF8.GetBytes(segment))
        {
            var c = (char)b;
            if (b < 0x80 && (char.IsAsciiLetterOrDigit(c) || "-_.!~*'()".IndexOf(c) >= 0))
            {
                sb.Append(c);
            }
            else
            {
                sb.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
            }
        }

        return sb.ToString();
    }
}
