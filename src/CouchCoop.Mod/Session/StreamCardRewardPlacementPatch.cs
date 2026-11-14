using System.Reflection;
using CouchCoop.Mod.Patches;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Entities.CardRewardAlternatives;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Nodes.Cards.Holders;
using MegaCrit.Sts2.Core.Nodes.Screens.CardSelection;

namespace CouchCoop.Mod.Session;

/// <summary>Spread reward holders while a wide stream owns the presentation.</summary>
internal static class StreamCardRewardPlacementPatch
{
    private static bool _applied;
    private static readonly Placement<NCardRewardSelectionScreen, NGridCardHolder> Row = new(Place, RewardScreen);

    internal static MethodInfo? ResolveRefresh()
        => typeof(NCardRewardSelectionScreen).GetMethod(nameof(NCardRewardSelectionScreen.RefreshOptions),
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly,
            [typeof(IReadOnlyList<CardCreationResult>), typeof(IReadOnlyList<CardRewardAlternative>)]);

    internal static MethodInfo? ResolveTween()
        => StreamPositionTweenPatch.Resolve();

    internal static void Apply()
    {
        if (_applied) return;
        _applied = true;
        try
        {
            var harmony = new Harmony("com.couchcoop.stream-card-reward-placement");
            var refresh = ResolveRefresh() ?? throw new MissingMethodException(nameof(NCardRewardSelectionScreen.RefreshOptions));
            // Install before patching callers that could inline the managed engine wrapper.
            StreamPositionTweenPatch.Register(HandleTween);
            harmony.Patch(refresh,
                prefix: new HarmonyMethod(typeof(StreamCardRewardPlacementPatch), nameof(BeforeRefresh)));
        }
        catch (Exception exception)
        {
            CouchCoopPatchDiagnostics.PatchFailed(nameof(StreamCardRewardPlacementPatch),
                $"{exception.GetType().Name}: {exception.Message}", costsCoop: false);
        }
    }

    internal static void SetWidth(int width)
    {
        if (width > 1920)
            foreach (var screen in Row.Screens)
            {
                if (!GodotObject.IsInstanceValid(screen) || screen.IsQueuedForDeletion()) continue;
                if (screen.GetNodeOrNull<Control>("UI/CardRow") is not { } row) continue;
                Row.Discover(screen, row.GetChildren().OfType<NGridCardHolder>()
                    .Where(holder => !holder.IsQueuedForDeletion()), holder => holder.Position);
            }
        Row.SetWidth(width);
    }

    private sealed record Endpoint(NGridCardHolder Holder, Vector2 Design);
    private static readonly Dictionary<NGridCardHolder, PropertyTweener> Tweeners = new();

    private static void BeforeRefresh(NCardRewardSelectionScreen __instance)
    {
        if (Row.BeginRefresh(__instance))
            __instance.TreeExiting += () =>
            {
                foreach (var holder in Row.Remove(__instance)) Tweeners.Remove(holder);
            };
        else
            foreach (var holder in Row.Holders(__instance)) Tweeners.Remove(holder);
        Row.Clear(__instance);
    }

    private static void BeforeTween(GodotObject __0, NodePath __1, ref Variant __2, out Endpoint? __state)
    {
        __state = null;
        if (__0 is not NGridCardHolder holder) return;
        if (__1.ToString() != "position"
            || __2.VariantType != Variant.Type.Vector2) return;
        var design = __2.AsVector2();
        if (!Row.TryTrackEndpoint(holder, design)) return;
        __state = new(holder, design);
        if (Row.Wide) __2 = Spread(holder, design, Row.Width);
    }

    private static void AfterTween(PropertyTweener __result, Endpoint? __state)
    {
        if (__state is null) return;
        StreamPositionTweenPatch.Track(Tweeners, __state.Holder, __result,
            retire => StreamPositionTweenPatch.OnFinished(__result, retire));
    }

    private static NCardRewardSelectionScreen? RewardScreen(NGridCardHolder holder)
    {
        if (holder.GetParent() is not Control parent
            || parent.GetParent()?.GetParent() is not NCardRewardSelectionScreen screen) return null;
        return ReferenceEquals(screen.GetNodeOrNull<Control>("UI/CardRow"), parent) ? screen : null;
    }

    private static Action<PropertyTweener>? HandleTween(GodotObject node, NodePath property, ref Variant target)
    {
        BeforeTween(node, property, ref target, out var endpoint);
        return endpoint is null ? null : tweener => AfterTween(tweener, endpoint);
    }

    private static Vector2 Spread(NGridCardHolder holder, Vector2 design, int width)
    {
        var parent = ((CanvasItem)holder.GetParent()).GetGlobalTransform();
        return Spread(design, parent, width);
    }

    internal static Vector2 Spread(Vector2 design, Transform2D parent, int width)
    {
        if (width <= 1920) return design;
        var origin = parent * design;
        var designX = origin.X - (width - 1920) / 2f;
        var shift = Math.Clamp(designX, 0, 1920) * (width / 1920f - 1) - (width - 1920) / 2f;
        return parent.AffineInverse() * (origin + new Vector2(shift, 0));
    }

    private static void Place(NGridCardHolder holder, Vector2 design, int width)
    {
        if (!GodotObject.IsInstanceValid(holder) || holder.IsQueuedForDeletion()) return;
        var target = width > 1920 ? Spread(holder, design, width) : design;
        RestorePosition(holder, target, Tweeners,
            static (tweener, endpoint) => GodotObject.IsInstanceValid(tweener) ? tweener.From(endpoint) : null,
            static tweener => tweener.SetCustomInterpolator(Callable.From<double, double>(HoldInitial)),
            static (node, endpoint) => node.Position = endpoint);
    }

    internal static void RestorePosition<THolder, TTweener>(THolder holder, Vector2 target,
        Dictionary<THolder, TTweener> tweeners, Func<TTweener, Vector2, TTweener?> from,
        Action<TTweener> freeze, Action<THolder, Vector2> write)
        where THolder : notnull where TTweener : class
    {
        if (tweeners.TryGetValue(holder, out var tweener))
        {
            // Freeze only this position step. The native tween may still be fading other properties.
            // No replay, cancellation, game reads or correction pass is needed on later tween steps.
            var active = from(tweener, target);
            if (active is null) tweeners.Remove(holder); // The parent tween may already have been freed.
            else freeze(active);
        }
        write(holder, target);
    }

    private static double HoldInitial(double _) => 0;

    internal sealed class Placement<TScreen, THolder>(Action<THolder, Vector2, int> place,
        Func<THolder, TScreen?>? owner = null)
        where TScreen : class where THolder : class
    {
        private readonly Dictionary<TScreen, Dictionary<THolder, Vector2>> _screens = new();
        internal int Width { get; private set; } = 1920;
        internal bool Wide => Width > 1920;
        internal TScreen[] Screens => _screens.Keys.ToArray();

        internal bool BeginRefresh(TScreen screen)
        {
            if (_screens.ContainsKey(screen)) return false;
            _screens.Add(screen, new());
            return true;
        }

        internal THolder[] Holders(TScreen screen) => _screens[screen].Keys.ToArray();
        internal void Clear(TScreen screen) => _screens[screen].Clear();
        internal THolder[] Remove(TScreen screen)
        {
            if (!_screens.Remove(screen, out var records)) return [];
            return records.Keys.ToArray();
        }

        internal void Track(TScreen screen, THolder holder, Vector2 design) => _screens[screen][holder] = design;

        internal bool TryTrackEndpoint(THolder holder, Vector2 design)
        {
            var screen = owner?.Invoke(holder);
            if (screen is null || !_screens.ContainsKey(screen)) return false;
            Track(screen, holder, design);
            return true;
        }

        internal void Discover(TScreen screen, IEnumerable<THolder> holders, Func<THolder, Vector2> read)
        {
            foreach (var holder in holders)
                if (!_screens[screen].ContainsKey(holder)) _screens[screen].Add(holder, read(holder));
        }

        internal void SetWidth(int width)
        {
            width = Math.Max(1920, width);
            if (Width == width) return;
            Width = width;
            foreach (var records in _screens.Values)
                foreach (var (holder, design) in records) place(holder, design, width);
        }
    }
}
