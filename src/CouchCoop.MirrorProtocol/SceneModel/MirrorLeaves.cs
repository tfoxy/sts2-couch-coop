namespace CouchCoop.MirrorProtocol.SceneModel;

// 1:1 C# port of the leaf value types in frontend/src/mirror/sceneTree.ts. These are immutable records (the
// TS interfaces are read as plain data); MirrorNode composes them. Field names/shapes mirror the TS members so
// the reader/applier port stays a faithful transliteration and the cross-language fixtures round-trip.

// MirrorRect: x/y/width/height in design space (TS MirrorRect).
public sealed record MirrorRect(double X, double Y, double Width, double Height);

// Linear 0..1 channels as Godot reports them; Html is "#rrggbbaa" (TS MirrorColor).
public sealed record MirrorColor(double R, double G, double B, double A, string Html);

// A plain {x,y} pair (the TS `{ x: number; y: number }` used for shader vector2 uniforms).
public sealed record MirrorVector2(double X, double Y);

// A plain {x,y,z} triple (shader vector3 uniforms — Godot-native-first extended kind).
public sealed record MirrorVector3(double X, double Y, double Z);

// A plain {x,y,z,w} quad (shader vector4/quaternion uniforms — Godot-native-first extended kind).
public sealed record MirrorVector4(double X, double Y, double Z, double W);

// TS MirrorText. `OutlineColorHtml`/`OutlineSize` are the per-tick (volatile) text-diagnostic outline values.
public sealed record MirrorText(
    string Text,
    string? ColorHtml,
    double? FontSizePx,
    string? Halign,
    string? Valign,
    string? OutlineColorHtml,
    double OutlineSize);

// TS MirrorMargins.
public sealed record MirrorMargins(double Left, double Top, double Right, double Bottom);

// TS MirrorFont.
public sealed record MirrorFont(string Family, string Url, string? Weight, string? Style);

// TS MirrorShadow.
public sealed record MirrorShadow(string ColorHtml, double OffsetX, double OffsetY);

// TS MirrorOutline (node-level, volatile).
public sealed record MirrorOutline(string ColorHtml, double Size);

// TS MirrorShaderParam. `Kind` selects which value field is set. The Godot-native-first extended kinds
// (vector3/vector4/rect2/transform2d and the flattened *Array kinds) ride the trailing optional fields; a
// native client re-hydrates them and the web ignores kinds it does not consume.
public sealed record MirrorShaderParam(
    string Name,
    string Kind,
    double? Number,
    bool? Bool,
    string? String,
    MirrorColor? Color,
    MirrorVector2? Vector2,
    string? ResourcePath,
    MirrorVector3? Vector3 = null,
    MirrorVector4? Vector4 = null,
    MirrorRect? Rect2 = null,
    IReadOnlyList<double>? Transform2D = null,
    IReadOnlyList<double>? NumberArray = null);

// TS MirrorRange.
public sealed record MirrorRange(double Value, double Min, double Max);

// One enemy-intent glyph animation frame (TS MirrorIntentFrame): atlas page url + source region/margin.
public sealed record MirrorIntentFrame(string Url, MirrorRect? Region, MirrorRect? Margin);

// Enemy-intent glyph frame set (TS MirrorIntentFrames).
public sealed record MirrorIntentFrames(string AnimationName, double Fps, IReadOnlyList<MirrorIntentFrame> Frames);

// One over-life particle gradient stop (gsw GradientStop): Offset 0..1, Color = [r,g,b,a] linear.
public sealed record MirrorGradientStop(double Offset, IReadOnlyList<double> Color);

// One over-life particle curve point (gsw CurvePoint).
public sealed record MirrorCurvePoint(double X, double Y);

// A GpuParticles2D/CpuParticles2D system flattened into gsw's ParticleSpecConfig shape. This mirrors exactly the
// fields `normalizeParticleSpec` produces (Vector2 tuples as [x,y], colors as [r,g,b,a]); `Emitting` is always the
// placeholder false (the per-tick ParticleEmitting overrides it at render time).
public sealed record MirrorParticleSpec(
    string Kind,
    double Amount,
    double AmountRatio,
    double Lifetime,
    double LifetimeRandomness,
    bool OneShot,
    bool Emitting,
    double Explosiveness,
    double Randomness,
    double Preprocess,
    double SpeedScale,
    double FixedFps,
    bool LocalCoords,
    double DrawOrder,
    double Seed,
    double EmissionShape,
    IReadOnlyList<double> EmissionOffset,
    IReadOnlyList<double> EmissionScale,
    double EmissionSphereRadius,
    double EmissionRingRadius,
    double EmissionRingInnerRadius,
    double EmissionRingHeight,
    IReadOnlyList<double> EmissionBoxExtents,
    IReadOnlyList<double> Direction,
    double Spread,
    double InitialVelocityMin,
    double InitialVelocityMax,
    double AngleMin,
    double AngleMax,
    double AngularVelocityMin,
    double AngularVelocityMax,
    IReadOnlyList<double> Gravity,
    double LinearAccelMin,
    double LinearAccelMax,
    double RadialAccelMin,
    double RadialAccelMax,
    double TangentialAccelMin,
    double TangentialAccelMax,
    double DampingMin,
    double DampingMax,
    bool DampingAsFriction,
    double OrbitVelocityMin,
    double OrbitVelocityMax,
    double ScaleMin,
    double ScaleMax,
    double HueVariationMin,
    double HueVariationMax,
    bool AlignY,
    IReadOnlyList<double> BaseColor,
    double OriginX,
    double OriginY,
    string? TextureUrl,
    double TextureWidth,
    double TextureHeight,
    double Hframes,
    double Vframes,
    bool AnimLoop,
    double AnimSpeedMin,
    double AnimSpeedMax,
    double AnimOffsetMin,
    double AnimOffsetMax,
    double BlendMode,
    IReadOnlyList<MirrorGradientStop>? ColorRamp,
    IReadOnlyList<MirrorGradientStop>? ColorInitialRamp,
    IReadOnlyList<MirrorCurvePoint>? ScaleCurve,
    IReadOnlyList<MirrorCurvePoint>? ScaleCurveX,
    IReadOnlyList<MirrorCurvePoint>? ScaleCurveY,
    IReadOnlyList<MirrorCurvePoint>? AlphaCurve,
    IReadOnlyList<MirrorCurvePoint>? HueCurve);
