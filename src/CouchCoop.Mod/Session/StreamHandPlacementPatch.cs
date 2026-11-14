using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using CouchCoop.Mod.Patches;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes.Cards.Holders;
using MegaCrit.Sts2.Core.Nodes.Combat;

namespace CouchCoop.Mod.Session;

/// <summary>Spread complete hand fan targets only while a wide stream owns the seat.</summary>
internal static class StreamHandPlacementPatch
{
    private static bool _applied;
    private static readonly Placement Fan = new(Regenerate);

    internal static MethodInfo? Resolve()
        => typeof(NHandCardHolder).GetMethod(nameof(NHandCardHolder.SetTargetPosition),
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly, [typeof(Vector2)]);

    internal static void Apply()
    {
        if (_applied) return;
        _applied = true;
        try
        {
            var target = Resolve() ?? throw new MissingMethodException(typeof(NHandCardHolder).FullName,
                nameof(NHandCardHolder.SetTargetPosition));
            new Harmony("com.couchcoop.stream-hand-placement").Patch(target,
                prefix: new HarmonyMethod(typeof(StreamHandPlacementPatch), nameof(BeforeTarget)));
        }
        catch (Exception exception)
        {
            CouchCoopPatchDiagnostics.PatchFailed(nameof(StreamHandPlacementPatch),
                $"{exception.GetType().Name}: {exception.Message}", costsCoop: false);
        }
    }

    internal static void SetWidth(int width) => Fan.SetWidth(width);

    private static bool Valid([NotNullWhen(true)] GodotObject? node)
        => node is Node n && GodotObject.IsInstanceValid(n) && !n.IsQueuedForDeletion();

    private static void BeforeTarget(NHandCardHolder __instance, ref Vector2 __0)
    {
        // Not wide: return before reading any game state, so the original target passes through untouched.
        if (!Fan.Wide) return;
        if (!Valid(__instance)) return;
        var hand = NPlayerHand.Instance;
        if (!Valid(hand)) return;
        __0 = Fan.ResolveTarget(__0, __instance.GetParent(), hand.CardHolderContainer);
    }

    // Called on the main-thread ownership boundary, before mirror sizing or capture resumes.
    private static void Regenerate(bool restore)
    {
        var hand = NPlayerHand.Instance;
        if (!Valid(hand) || !Valid(hand.CardHolderContainer)) return;
        hand.ForceRefreshCardIndices();
        if (!restore) return;
        foreach (var holder in hand.ActiveHolders)
            if (Valid(holder) && IsFanHolder(holder.GetParent(), hand.CardHolderContainer))
                holder.Position = new Vector2(holder.TargetPosition.X, holder.Position.Y);
    }

    internal static bool IsFanHolder(object? parent, object? fan)
        => fan is not null && ReferenceEquals(parent, fan);

    internal sealed class Placement(Action<bool> regenerate)
    {
        private int _width = 1920;
        internal bool Wide => _width > 1920;

        internal void SetWidth(int width)
        {
            width = Math.Max(1920, width);
            if (_width == width) return;
            _width = width;
            regenerate(!Wide);
        }

        internal Vector2 ResolveTarget(Vector2 target, object? parent, object? fan)
        {
            if (!Wide || !IsFanHolder(parent, fan)) return target;
            var designX = 960 + target.X;
            return new Vector2(designX + Math.Clamp(designX, 0, 1920) * (_width / 1920f - 1)
                - _width / 2f, target.Y);
        }
    }
}
