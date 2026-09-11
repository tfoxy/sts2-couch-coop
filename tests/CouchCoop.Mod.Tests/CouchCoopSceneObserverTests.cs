using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.SceneInspection;

// Unit checks for CouchCoopSceneObserver's retained-map merge (MergeVolatile) and its inverse volatile projection
// (ToVolatile): a volatile-only upsert (null Name) must KEEP the static styling block from the retained node while
// taking the fresh VOLATILE fields, and ToVolatile must DROP exactly that same static block (so the wire-diet
// projection carries only volatiles). A checked-in fixture (tests/fixtures/wire/static-fields.json) drives the
// three-way lockstep drift check shared with the vitest side (staticFields.spec.ts). Regression guard for the
// recurring bug where a static field silently vanishes one tick after a node appears (ClipChildren / ParticleSpec /
// Spine lessons). Pure (no socket / no live game); assert-or-throw harness style.
internal static class CouchCoopSceneObserverTests
{
    public static void Run()
    {
        SpineStaticBlockSurvivesVolatileUpsert();
        VolatileSpineFieldsComeFromTheUpsert();
        StaticFieldsFixtureLockstep_MergeVolatileKeeps();
        ProducerFieldSplitLockstep_MergeVolatileLosesNothing();
        ProducerFieldSplitLockstep_FixtureAgreesWithTheProducer();
        ToVolatileDropsStaticKeepsVolatile();
        ToVolatileRestoresOutlineAndGatesIntentFrames();
        ContentKeyIsStaticAcrossTheVolatileMerge();
        LineGeometryIsStickyAcrossTheVolatileMerge();
        ToVolatileGatesLineGeometryOnLineDirty();
        KeyframeOrderNamesOnlyNodesTheKeyframeCarries();
        KeyframeOrderKeepsTheRetainedSequence();
        NonLocalDeltaIsRejectedWithDiagnostic();
    }

    private static void NonLocalDeltaIsRejectedWithDiagnostic()
    {
        var runtime = (CouchCoopRuntimeHost)RuntimeHelpers.GetUninitializedObject(typeof(CouchCoopRuntimeHost));
        var observer = new CouchCoopSceneObserver(runtime);
        var emitted = false;
        observer.SceneDeltaChanged += _ => emitted = true;
        var rejected = new RuntimeSceneDelta(
            Full: true,
            ScreenType: "run",
            ScreenInstanceId: "screen:run:live",
            Upserts: [Node("rejected")],
            RemovedIds: [],
            OrderedIds: ["rejected"],
            TransformSpace: "global");
        var onDelta = typeof(CouchCoopSceneObserver).GetMethod("OnDelta", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var oldError = Console.Error;
        using var error = new StringWriter();
        try
        {
            Console.SetError(error);
            onDelta.Invoke(observer, [rejected]);
        }
        finally
        {
            Console.SetError(oldError);
        }

        Assert(!emitted, "a non-local upstream delta is not fanned out");
        Assert(observer.BuildKeyframe() is null, "a non-local upstream delta does not poison retained state");
        Assert(error.ToString().Contains("rejected scene delta without local transforms", StringComparison.Ordinal),
            "a rejected upstream transform contract is diagnosed");
    }

    // R10 KEYFRAME SELF-CONSISTENCY. The producer's order array used to include nodes it had never emitted (a
    // subtree born hidden is registered but pruned from every incremental capture), so the retained order held ids
    // with no retained node — and the keyframe shipped them in OrderedIds while silently dropping them from
    // Upserts. The client's ONLY structural-walk trigger is an orderedIds CHANGE, so having the id already in the
    // order meant the node's eventual first upsert placed nothing in the tree (the missing targeting arrow after a
    // game restart, the missing treasure relics until a browser reload). A keyframe must therefore name only nodes
    // it actually carries.
    private static void KeyframeOrderNamesOnlyNodesTheKeyframeCarries()
    {
        var nodes = new Dictionary<string, RuntimeSceneNodeDelta>
        {
            ["1"] = Node("1"),
            ["3"] = Node("3"),
        };
        // "2" is the pruned hidden node: in the order, never emitted, so no retained state exists for it.
        var (upserts, order) = CouchCoopSceneObserver.BuildKeyframeContents(["1", "2", "3"], nodes);

        Assert(order.Count == upserts.Count, "keyframe order and upserts have the same length");
        foreach (var id in order)
        {
            Assert(nodes.ContainsKey(id), $"keyframe order id {id} has a node in the keyframe");
        }

        Assert(!order.Contains("2"), "the never-emitted id is dropped from the keyframe order");
        Assert(string.Join(",", order) == "1,3", "the surviving keyframe order keeps the retained sequence");
    }

    private static void KeyframeOrderKeepsTheRetainedSequence()
    {
        // A complete order (the normal case with the R10 producer) is untouched — same ids, same order, same count.
        var nodes = new Dictionary<string, RuntimeSceneNodeDelta>
        {
            ["a"] = Node("a"),
            ["b"] = Node("b"),
            ["c"] = Node("c"),
        };
        var (upserts, order) = CouchCoopSceneObserver.BuildKeyframeContents(["c", "a", "b"], nodes);

        Assert(string.Join(",", order) == "c,a,b", "a complete order is passed through verbatim");
        Assert(string.Join(",", upserts.Select(u => u.Id)) == "c,a,b", "upserts follow the same paint order");
    }

    private static RuntimeSceneNodeDelta Node(string id, string? name = null) => new(
        Id: id, ParentId: null, Name: name ?? id, NodeType: "Godot.Node2D", Rect: null,
        Visible: true, Opacity: 1, ZIndex: null, Rotation: 0, Texture: null, NinePatch: false, Text: null);

    private static readonly RuntimeSceneColorSnapshot ExistingColor = new(0.1, 0.2, 0.3, 1, "#1a334cff");
    private static readonly RuntimeSceneColorSnapshot FreshColor = new(0.9, 0.8, 0.7, 1, "#e6ccb3ff");

    private static RuntimeSceneVector2Snapshot V(double x, double y) => new(x, y);
    private static RuntimeSceneResourceRefSnapshot Ref(string path) => new("Field", path, "Type", "Name");

    private static RuntimeSceneParticleSpecSnapshot MinimalSpec() => new(
        Kind: "GPUParticles2D", Amount: 8, AmountRatio: 1, Lifetime: 1, LifetimeRandomness: 0, OneShot: false,
        Explosiveness: 0, Randomness: 0, Preprocess: 0, SpeedScale: 1, FixedFps: 0, LocalCoords: false, DrawOrder: 0,
        Seed: 0, EmissionShape: 0, EmissionOffset: V(0, 0), EmissionScale: V(1, 1), EmissionSphereRadius: 0,
        EmissionRingRadius: 0, EmissionRingInnerRadius: 0, EmissionRingHeight: 0, EmissionBoxExtents: V(0, 0),
        Direction: V(0, 0), Spread: 0, InitialVelocityMin: 0, InitialVelocityMax: 0, AngleMin: 0, AngleMax: 0,
        AngularVelocityMin: 0, AngularVelocityMax: 0, Gravity: V(0, 0), LinearAccelMin: 0, LinearAccelMax: 0,
        RadialAccelMin: 0, RadialAccelMax: 0, TangentialAccelMin: 0, TangentialAccelMax: 0, DampingMin: 0,
        DampingMax: 0, DampingAsFriction: false, OrbitVelocityMin: 0, OrbitVelocityMax: 0, ScaleMin: 1, ScaleMax: 1,
        HueVariationMin: 0, HueVariationMax: 0, AlignY: false, BaseColor: new(1, 1, 1, 1, "#ffffffff"), OriginX: 0,
        OriginY: 0, Texture: null, TextureWidth: 0, TextureHeight: 0, Hframes: 1, Vframes: 1, AnimLoop: false,
        AnimSpeedMin: 0, AnimSpeedMax: 0, AnimOffsetMin: 0, AnimOffsetMax: 0, BlendMode: 0, ColorRamp: null,
        ColorInitialRamp: null, ScaleCurve: null, ScaleCurveX: null, ScaleCurveY: null, AlphaCurve: null,
        HueCurve: null);

    private static RuntimeSceneIntentFramesSnapshot IntentFrames(string anim) =>
        new(anim, 15, [new RuntimeSceneIntentFrameSnapshot("res://images/intent.png", null, null)]);

    // A fully-populated retained node: EVERY static field carries a distinctive non-default sentinel (so the
    // fixture drift check can prove MergeVolatile keeps it and ToVolatile drops it), plus distinctive VOLATILE
    // values (so we can prove those flow from the upsert / are carried by the projection).
    private static RuntimeSceneNodeDelta Sentinel() => Node("sentinel") with
    {
        // Volatile
        ParentId = "parent-1",
        Visible = true,
        Opacity = 0.5,
        ZIndex = 3,
        Texture = Ref("res://images/tex.png"),
        NinePatch = true,
        Modulate = ExistingColor,
        SelfModulate = ExistingColor,
        FillColor = ExistingColor,
        ScaleX = 2,
        ScaleY = 3,
        PivotX = 4,
        PivotY = 5,
        RangeValue = 10,
        RangeMin = 0,
        RangeMax = 20,
        Transform = new(V(1, 0), V(0, 1), V(11, 22)),
        LocalRect = new(V(0, 0), V(100, 50)),
        TextureRegion = new(V(1, 2), V(3, 4)),
        TextureMargin = new(V(5, 6), V(7, 8)),
        ShaderParameters = [new RuntimeSceneShaderParamSnapshot("u", "number", Number: 0.25)],
        ParticleEmitting = true,
        ParticleRestartEpoch = 7,
        SpineCurrentAnim = "idle",
        SpineTrackTime = 1.5,
        SpineLooping = false,
        // Producer-VOLATILE but MergeVolatile over-keeps (restored by ToVolatile).
        OutlineColor = ExistingColor,
        OutlineSize = 3,
        // Static block sentinels.
        Name = "existing-name",
        NodeType = "Existing.Type",
        ShowBehindParent = true,
        ClipChildren = 2,
        ClipContents = true,
        NinePatchMargins = new(1, 2, 3, 4),
        Font = Ref("res://fonts/f.ttf"),
        FontWeight = "bold",
        FontStyle = "italic",
        // Per-role rich-text fonts + their theme sizes / glyph spacing (add/keyframe only, like Font).
        RichBoldFont = Ref("res://fonts/kreon_bold.ttf"),
        RichItalicFont = Ref("res://fonts/kreon_italic.ttf"),
        RichBoldItalicFont = Ref("res://fonts/kreon_bold_italic.ttf"),
        RichBoldFontSizePx = 21,
        RichItalicFontSizePx = 22,
        RichBoldItalicFontSizePx = 23,
        RichBoldFontSpacingPx = 1,
        RichItalicFontSpacingPx = 2,
        RichBoldItalicFontSpacingPx = 3,
        Shadow = new(ExistingColor, V(1, 1), 2, 1, "src", []),
        RichText = true,
        Material = Ref("res://mat.tres"),
        Shader = Ref("res://shader.gdshader"),
        TextureStretchMode = 5,
        TextureFlipH = true,
        TextureFlipV = true,
        CanvasBlendMode = 1,
        ParticleSpec = MinimalSpec(),
        Spine = new RuntimeSceneSpineSnapshot("res://spine.tscn", "Node/Path", ["idle", "attack"]),
        SceneFilePath = "res://scene.tscn",
        MouseFilter = 1,
        AnchorLeft = 0.25,
        AnchorRight = 0.75,
        AnchorOwnerId = "owner-1",
        ContainerLayout = "hbox-center",
        IntentFrames = IntentFrames("idle"),
    };

    // A pure volatile-only upsert: Name null; every STATIC field at default; VOLATILE fields carry FRESH values.
    private static RuntimeSceneNodeDelta FreshVolatileUpsert() => new(
        Id: "sentinel", ParentId: "parent-2", Name: null, NodeType: null, Rect: null,
        Visible: false, Opacity: 0.9, ZIndex: 9, Rotation: 0, Texture: Ref("res://images/tex2.png"), NinePatch: false,
        Text: null)
    {
        Modulate = FreshColor,
        Transform = new(V(1, 0), V(0, 1), V(99, 88)),
        LocalRect = new(V(0, 0), V(10, 10)),
        OutlineColor = FreshColor,
        OutlineSize = 5,
        SpineCurrentAnim = "attack",
        SpineTrackTime = 0.4,
    };

    private static void SpineStaticBlockSurvivesVolatileUpsert()
    {
        var spine = new RuntimeSceneSpineSnapshot("res://scenes/backgrounds/main_menu_bg.tscn", "BgContainer/Bg", ["animation"]);
        var existing = Node("Bg") with { Spine = spine, SpineCurrentAnim = "animation", SpineTrackTime = 0.4 };
        var upsert = Node("Bg", name: null) with { Name = null, NodeType = null, SpineCurrentAnim = "animation", SpineTrackTime = 0.9 };

        var merged = CouchCoopSceneObserver.MergeVolatile(existing, upsert);
        Assert(merged.Spine is not null, "spine static block survives a volatile-only upsert");
        Assert(merged.Spine!.SceneResPath == "res://scenes/backgrounds/main_menu_bg.tscn", "retained spine scene path");
        Assert(merged.Spine!.NodePath == "BgContainer/Bg", "retained spine node path");
        Assert(merged.Name == "Bg", "name retained from the existing node");
        Assert(NearlyEqual(merged.SpineTrackTime, 0.9), "spine track time taken from the fresh upsert (volatile)");
    }

    private static void VolatileSpineFieldsComeFromTheUpsert()
    {
        var existing = Node("e") with { Spine = new RuntimeSceneSpineSnapshot("res://x.tscn", null, ["idle", "attack"]), SpineCurrentAnim = "idle" };
        var upsert = Node("e", name: null) with { Name = null, SpineCurrentAnim = "attack" };
        var merged = CouchCoopSceneObserver.MergeVolatile(existing, upsert);
        Assert(merged.SpineCurrentAnim == "attack", "current anim is the fresh volatile value, not the retained one");
        Assert(merged.Spine is not null && merged.Spine!.Animations.Count == 2, "anim LIST is static and retained");
    }

    // FIXTURE LOCKSTEP (C# side): every wire static field named in static-fields.json is KEPT from `existing` by
    // MergeVolatile on a volatile-only upsert. If someone drops a field from the keep-list, this fails (and the
    // fixture must be updated in lockstep with the vitest side).
    private static void StaticFieldsFixtureLockstep_MergeVolatileKeeps()
    {
        var staticFields = LoadWireStaticFields();
        var existing = Sentinel();
        var upsert = FreshVolatileUpsert();
        var merged = CouchCoopSceneObserver.MergeVolatile(existing, upsert);

        foreach (var wireName in staticFields)
        {
            var prop = PropFor(wireName);
            Assert(Equals(prop.GetValue(merged), prop.GetValue(existing)),
                $"MergeVolatile keeps static field '{wireName}' from existing");
        }

        // Sanity: a representative VOLATILE field flows from the upsert (not kept).
        Assert(NearlyEqual(merged.Opacity, upsert.Opacity), "MergeVolatile takes volatile Opacity from the upsert");
        Assert(merged.Transform!.Origin.X == upsert.Transform!.Origin.X, "MergeVolatile takes volatile Transform from the upsert");
    }

    // PRODUCER LOCKSTEP. The comment on MergeVolatile says its kept set MUST mirror the producer's
    // includeStatic-gated fields — and for years nothing checked it, which is how ClipChildren, ParticleSpec and
    // Spine each went missing for a while (a static field left off the list is read as "the game just cleared it"
    // on the first per-tick emission, so the node silently un-styles one tick after it appears). spirectl now
    // PUBLISHES the split it actually emits, so the mirror can be held to the producer instead of to a list
    // someone remembered to update.
    //
    // The probe is one delta pair and one assertion. `existing` carries a non-default value for every STATIC
    // field and the record default for every volatile one; `upsert` is the mirror image — the shape of a real
    // volatile-only emission, which ships volatiles and leaves the static block at its defaults. A correct merge
    // therefore takes each field from whichever side has the non-default value, and EVERY field of the result is
    // non-default. A static field the merge forgets to keep collapses to the default; so does a volatile field it
    // wrongly keeps. Either way the field shows up by name.
    //
    // Two deviations are deliberate and named rather than silently tolerated: OutlineColor/OutlineSize are
    // producer-volatile but over-kept here (ToVolatile restores them, see ToVolatileRestoresOutlineAndGatesIntentFrames),
    // and they are exactly the fixture's `volatileOutlineFields`.
    private static void ProducerFieldSplitLockstep_MergeVolatileLosesNothing()
    {
        var parameters = DeltaConstructor().GetParameters();
        var producerStatic = RuntimeSceneNodeDeltaFields.StaticFieldNames.ToHashSet(StringComparer.Ordinal);
        var producerVolatile = RuntimeSceneNodeDeltaFields.VolatileFieldNames.ToHashSet(StringComparer.Ordinal);
        var overKept = LoadWireFieldList("volatileOutlineFields")
            .Select(wire => char.ToUpperInvariant(wire[0]) + wire[1..])
            .ToHashSet(StringComparer.Ordinal);

        // A field the producer classifies as neither is a field this merge cannot reason about at all.
        foreach (var parameter in parameters)
        {
            var name = parameter.Name!;
            Assert(producerStatic.Contains(name) || producerVolatile.Contains(name),
                $"producer classifies RuntimeSceneNodeDelta.{name} as static or volatile");
            Assert(!(producerStatic.Contains(name) && producerVolatile.Contains(name)),
                $"producer classifies RuntimeSceneNodeDelta.{name} as exactly one of static/volatile");
        }

        // ...and a classified field the record no longer has means the producer moved on without us.
        foreach (var name in producerStatic.Concat(producerVolatile))
        {
            Assert(parameters.Any(parameter => string.Equals(parameter.Name, name, StringComparison.Ordinal)),
                $"producer field '{name}' still exists on RuntimeSceneNodeDelta");
        }

        var existing = BuildDelta(parameter => producerStatic.Contains(parameter.Name!));
        var upsert = BuildDelta(parameter => producerVolatile.Contains(parameter.Name!));
        var merged = CouchCoopSceneObserver.MergeVolatile(existing, upsert);

        foreach (var parameter in parameters)
        {
            var name = parameter.Name!;
            var value = typeof(RuntimeSceneNodeDelta).GetProperty(name)!.GetValue(merged);
            var wasDropped = Equals(value, DefaultValue(parameter));

            if (overKept.Contains(name))
            {
                // Documented over-keep: the volatile value is NOT taken from the upsert here on purpose.
                Assert(wasDropped, $"'{name}' is over-kept from the retained node (documented volatileOutlineField)");
                continue;
            }

            Assert(!wasDropped,
                producerStatic.Contains(name)
                    ? $"MergeVolatile keeps producer-static field '{name}' (a dropped static un-styles the node one tick after it appears)"
                    : $"MergeVolatile takes producer-volatile field '{name}' from the upsert");
        }
    }

    // The client-side lockstep fixture is a SUBSET of the producer's static set (it lists the fields the browser's
    // mergeNode is also driven from), so it is checked for agreement, not for equality: an entry the producer calls
    // volatile would have the client hoarding a value the producer re-sends, and a sticky/over-kept entry that is
    // really static would have it dropping one.
    private static void ProducerFieldSplitLockstep_FixtureAgreesWithTheProducer()
    {
        var producerStatic = RuntimeSceneNodeDeltaFields.StaticFieldNames.ToHashSet(StringComparer.Ordinal);
        var producerVolatile = RuntimeSceneNodeDeltaFields.VolatileFieldNames.ToHashSet(StringComparer.Ordinal);

        foreach (var wire in LoadWireStaticFields())
        {
            Assert(producerStatic.Contains(PropFor(wire).Name), $"fixture static field '{wire}' is producer-static");
        }

        foreach (var wire in LoadWireFieldList("stickyFields").Concat(LoadWireFieldList("volatileOutlineFields")))
        {
            Assert(producerVolatile.Contains(PropFor(wire).Name),
                $"fixture sticky/over-kept field '{wire}' is producer-volatile (it rides every emission)");
        }
    }

    private static ConstructorInfo DeltaConstructor()
        => typeof(RuntimeSceneNodeDelta).GetConstructors()
            .OrderByDescending(candidate => candidate.GetParameters().Length)
            .First();

    // A delta whose fields are non-default exactly where `nonDefault` says, and at the record's own default
    // everywhere else — so "which side did this field come from" is readable off the merged result.
    private static RuntimeSceneNodeDelta BuildDelta(Func<ParameterInfo, bool> nonDefault)
    {
        var ctor = DeltaConstructor();
        var args = ctor.GetParameters()
            .Select(parameter => nonDefault(parameter) ? NonDefaultValue(parameter) : DefaultValue(parameter))
            .ToArray();
        return (RuntimeSceneNodeDelta)ctor.Invoke(args);
    }

    private static object? DefaultValue(ParameterInfo parameter)
        => parameter.HasDefaultValue
            ? parameter.DefaultValue
            : parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType) : null;

    // Any value distinguishable from the field's OWN default — which is not always the type's default:
    // `SpineLooping` defaults to true, so "true" would have been indistinguishable from "the field was dropped"
    // and the probe would have passed vacuously for it.
    private static object NonDefaultValue(ParameterInfo parameter)
    {
        var value = DistinctValue(parameter);
        if (!Equals(value, DefaultValue(parameter)))
        {
            return value;
        }

        // The first choice collided with a non-zero declared default; the second cannot (they differ from each
        // other, and a parameter has one default).
        return value switch
        {
            bool flag => !flag,
            int number => number + 1,
            long number => number + 1,
            double number => number + 1,
            float number => number + 1,
            _ => throw new Exception(
                $"CouchCoopSceneObserverTests: no value distinguishable from the default of '{parameter.Name}'."),
        };
    }

    // Never inspected — only compared against the field's default — so payload types are instantiated without
    // running a constructor rather than hand-built one by one (which is what would rot the moment the producer
    // adds a field).
    private static object DistinctValue(ParameterInfo parameter)
    {
        var type = Nullable.GetUnderlyingType(parameter.ParameterType) ?? parameter.ParameterType;

        if (type == typeof(string)) return "sentinel-" + parameter.Name;
        if (type == typeof(bool)) return true;
        if (type == typeof(int)) return 7;
        if (type == typeof(long)) return 7L;
        if (type == typeof(double)) return 7.5d;
        if (type == typeof(float)) return 7.5f;
        if (type.IsEnum) return Enum.GetValues(type).GetValue(Enum.GetValues(type).Length - 1)!;
        if (type.IsArray) return Array.CreateInstance(type.GetElementType()!, 0);
        if (type.IsGenericType && type.GetGenericArguments().Length == 1)
        {
            // IReadOnlyList<T> / IReadOnlyCollection<T> / List<T>: an EMPTY sequence is still non-null, which is
            // the whole distinction the probe needs (and, for the sticky line unit, a real instruction).
            var elements = Array.CreateInstance(type.GetGenericArguments()[0], 0);
            if (type.IsAssignableFrom(elements.GetType())) return elements;
        }

        return RuntimeHelpers.GetUninitializedObject(type);
    }

    private static string[] LoadWireFieldList(string property)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(WireFixturePath("static-fields.json")));
        return doc.RootElement.GetProperty(property).EnumerateArray().Select(e => e.GetString()!).ToArray();
    }

    // FIXTURE LOCKSTEP (C# side): ToVolatile DROPS every wire static field (nulled/defaulted) while carrying the
    // volatile fields forward from the retained node — the inverse of MergeVolatile, single-sourced from it.
    private static void ToVolatileDropsStaticKeepsVolatile()
    {
        var staticFields = LoadWireStaticFields();
        var existing = Sentinel();
        var projection = CouchCoopSceneObserver.ToVolatile(existing, intentDirty: false, lineDirty: false);

        foreach (var wireName in staticFields)
        {
            var prop = PropFor(wireName);
            Assert(!Equals(prop.GetValue(projection), prop.GetValue(existing)),
                $"ToVolatile drops static field '{wireName}' (projected to default, not the retained sentinel)");
        }

        // Name null marks it a volatile-only upsert (the client's mergeNode takes the volatile-merge branch).
        Assert(projection.Name is null, "ToVolatile projection has null Name (volatile-only marker)");
        // Volatile fields are carried forward from the retained node.
        Assert(NearlyEqual(projection.Opacity, existing.Opacity), "ToVolatile carries volatile Opacity forward");
        Assert(projection.Transform!.Origin.X == existing.Transform!.Origin.X, "ToVolatile carries volatile Transform forward");
        Assert(projection.Modulate!.Html == existing.Modulate!.Html, "ToVolatile carries volatile Modulate forward");
        Assert(projection.ParentId == existing.ParentId, "ToVolatile carries ParentId (always volatile)");
    }

    // OutlineColor/OutlineSize are producer-VOLATILE but MergeVolatile over-keeps them; ToVolatile RESTORES the
    // retained value so the projection matches a real producer volatile-only upsert. IntentFrames are sticky:
    // included only when intentDirty.
    private static void ToVolatileRestoresOutlineAndGatesIntentFrames()
    {
        var existing = Sentinel();

        var clean = CouchCoopSceneObserver.ToVolatile(existing, intentDirty: false, lineDirty: false);
        Assert(clean.OutlineColor!.Html == existing.OutlineColor!.Html, "ToVolatile restores OutlineColor (producer-volatile)");
        Assert(NearlyEqual(clean.OutlineSize!.Value, existing.OutlineSize!.Value), "ToVolatile restores OutlineSize");
        Assert(clean.IntentFrames is null, "ToVolatile omits IntentFrames when not dirty (client carries retained set forward)");

        var dirty = CouchCoopSceneObserver.ToVolatile(existing, intentDirty: true, lineDirty: false);
        Assert(dirty.IntentFrames is not null && dirty.IntentFrames!.AnimationName == "idle",
            "ToVolatile ships the retained IntentFrames when dirty (intent changed this window)");
    }

    // R13 CONTENT KEY: the pooled-card content identity (`nc:{entry}#{serial}`) is STATIC — the producer emits it
    // with the static block only, so a volatile-only upsert must KEEP the retained key or a card node loses its
    // identity one tick after it appears (and a client keying DOM elements on it would re-create them every frame).
    // ToVolatile must DROP it, so the per-tick projection never re-ships a key the client already holds.
    //
    // The RE-ASSIGNMENT case (a pooled shell handed a different card) arrives as a STATIC payload — non-null Name —
    // which the retained map applies as a whole-node replacement (Apply), never through this merge, so the fresh key
    // wins there; the very next volatile merge then carries the NEW key forward (asserted below). The client leg of
    // that two-branch policy is covered by frontend/src/mirror/__tests__/contentKey.spec.ts.
    private static void ContentKeyIsStaticAcrossTheVolatileMerge()
    {
        var existing = Node("card") with { ContentKey = "nc:Strike#1" };
        var upsert = Node("card", name: null) with { Name = null, NodeType = null, Opacity = 0.25 };

        var merged = CouchCoopSceneObserver.MergeVolatile(existing, upsert);
        Assert(merged.ContentKey == "nc:Strike#1", "content key retained across a volatile-only upsert");
        Assert(NearlyEqual(merged.Opacity, 0.25), "volatile opacity still rides the upsert");

        // A node the producer never keyed (every non-card node) stays null — no invented identity.
        var plain = CouchCoopSceneObserver.MergeVolatile(Node("plain"), Node("plain", name: null) with { Name = null });
        Assert(plain.ContentKey is null, "content key stays null for a node the producer never keyed");

        // After a re-assignment replaced the retained node, the next volatile merge carries the NEW key (not the old).
        var reassigned = CouchCoopSceneObserver.MergeVolatile(existing with { ContentKey = "nc:Bash#2" }, upsert);
        Assert(reassigned.ContentKey == "nc:Bash#2", "a re-assigned pool slot's fresh key is the one carried forward");

        // Wire diet: the per-tick volatile projection drops it (the client keeps its retained key via mergeNode).
        var projection = CouchCoopSceneObserver.ToVolatile(existing, intentDirty: false, lineDirty: false);
        Assert(projection.ContentKey is null, "ToVolatile drops the static content key from the per-tick projection");
    }

    // LINE2D STROKE GEOMETRY (map quill annotations) is STICKY, exactly like IntentFrames and on the same producer
    // policy: points/width/colour ship as ONE unit only when the stroke's cheap signature changed, so a plain
    // volatile-only upsert carries null for all three and the retained values must survive. Without this every
    // finished stroke on the map goes blank one tick after it appears (the ClipChildren/ParticleSpec failure shape).
    // A fresh non-null upsert REPLACES — including an EMPTY array, which is the "cleared" instruction, not "unchanged".
    private static void LineGeometryIsStickyAcrossTheVolatileMerge()
    {
        var red = new RuntimeSceneColorSnapshot(1, 0, 0, 1, "#ff0000ff");
        var blue = new RuntimeSceneColorSnapshot(0, 0, 1, 1, "#0000ffff");
        var existing = Node("stroke") with { LinePoints = [1, 2, 3, 4], LineWidth = 4, LineColor = red };
        var quiet = Node("stroke", name: null) with { Name = null, NodeType = null, Opacity = 0.5 };

        var merged = CouchCoopSceneObserver.MergeVolatile(existing, quiet);
        Assert(merged.LinePoints is { Count: 4 }, "line points retained across a volatile-only upsert");
        Assert(NearlyEqual(merged.LineWidth!.Value, 4), "line width retained across a volatile-only upsert");
        Assert(merged.LineColor!.Html == "#ff0000ff", "line colour retained across a volatile-only upsert");

        // A stroke that GREW: the fresh unit wins outright (never merged point-wise).
        var grown = quiet with { LinePoints = [1, 2, 3, 4, 5, 6], LineWidth = 12, LineColor = blue };
        var afterGrowth = CouchCoopSceneObserver.MergeVolatile(existing, grown);
        Assert(afterGrowth.LinePoints is { Count: 6 }, "a fresh point array replaces the retained one");
        Assert(NearlyEqual(afterGrowth.LineWidth!.Value, 12), "a fresh width replaces the retained one");
        Assert(afterGrowth.LineColor!.Html == "#0000ffff", "a fresh colour replaces the retained one");

        // CLEARED (undo / clear-all): an EMPTY array is a real instruction and must beat the retained geometry.
        var cleared = CouchCoopSceneObserver.MergeVolatile(existing, quiet with { LinePoints = [] });
        Assert(cleared.LinePoints is { Count: 0 }, "an EMPTY point array (clear/undo) wins over the retained one");

        // A node the producer never streamed a stroke for (every node off the map) stays null — nothing invented.
        var plain = CouchCoopSceneObserver.MergeVolatile(Node("plain"), Node("plain", name: null) with { Name = null });
        Assert(plain.LinePoints is null && plain.LineWidth is null && plain.LineColor is null,
            "line fields stay null for a node that is not a Line2D");
    }

    // WIRE DIET: the retained map re-inflates every finished stroke's FULL point array, so a per-tick projection that
    // re-shipped them would cost kilobytes per map node per tick for geometry the client already holds. ToVolatile
    // gates all three on `lineDirty` (the coalescer's per-window "a fresh stroke was folded" flag) — the exact
    // IntentFrames shape. Dirty → ship the retained unit; clean → omit it and let the client carry its own forward.
    private static void ToVolatileGatesLineGeometryOnLineDirty()
    {
        var existing = Node("stroke") with
        {
            LinePoints = [1, 2, 3, 4],
            LineWidth = 4,
            LineColor = new RuntimeSceneColorSnapshot(1, 0, 0, 1, "#ff0000ff"),
        };

        var clean = CouchCoopSceneObserver.ToVolatile(existing, intentDirty: false, lineDirty: false);
        Assert(clean.LinePoints is null && clean.LineWidth is null && clean.LineColor is null,
            "ToVolatile omits the whole line unit when not dirty (client carries its retained geometry forward)");

        var dirty = CouchCoopSceneObserver.ToVolatile(existing, intentDirty: false, lineDirty: true);
        Assert(dirty.LinePoints is { Count: 4 }, "ToVolatile ships the retained points when the stroke changed");
        Assert(NearlyEqual(dirty.LineWidth!.Value, 4), "ToVolatile ships the retained width when dirty");
        Assert(dirty.LineColor!.Html == "#ff0000ff", "ToVolatile ships the retained colour when dirty");
    }

    // wire camelCase → RuntimeSceneNodeDelta PascalCase property (all wire static fields map by upper-casing the
    // first char). Reflection so the drift check is data-driven from the fixture, not a hand-maintained switch.
    private static PropertyInfo PropFor(string wireName)
    {
        var pascal = char.ToUpperInvariant(wireName[0]) + wireName[1..];
        return typeof(RuntimeSceneNodeDelta).GetProperty(pascal)
            ?? throw new Exception($"CouchCoopSceneObserverTests: no RuntimeSceneNodeDelta property for wire field '{wireName}'.");
    }

    private static string[] LoadWireStaticFields()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(WireFixturePath("static-fields.json")));
        return doc.RootElement.GetProperty("wireStaticFields").EnumerateArray().Select(e => e.GetString()!).ToArray();
    }

    // Walk up from the test binary to the repo root (marker: CouchCoop.sln) so the fixture resolves regardless of
    // where the worktree lives / where the test is launched from.
    private static string WireFixturePath(string file)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "CouchCoop.sln")))
        {
            dir = dir.Parent;
        }

        if (dir is null)
        {
            throw new Exception("CouchCoopSceneObserverTests: could not locate repo root (CouchCoop.sln) for wire fixtures.");
        }

        return Path.Combine(dir.FullName, "tests", "fixtures", "wire", file);
    }

    private static bool NearlyEqual(double a, double b) => Math.Abs(a - b) < 1e-6;

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"CouchCoopSceneObserverTests failed: {label}.");
        }
    }
}
