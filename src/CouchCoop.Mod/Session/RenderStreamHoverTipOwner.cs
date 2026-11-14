using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.HoverTips;
using MegaCrit.Sts2.Core.Nodes.HoverTips;

namespace CouchCoop.Mod.Session;

// Capture resolves custom metadata once; stamp synchronously before creation returns, ahead of its frame pass.
internal static class RenderStreamHoverTipOwner
{
    internal const string MetadataKey = "couchcoop_rs_tip_owner";
    internal const string SizeMetadataKey = "couchcoop_rs_tip_owner_size";
    private static bool _installed;

    internal static MethodInfo[] Targets() =>
    [
        AccessTools.Method(typeof(NHoverTipSet), nameof(NHoverTipSet.CreateAndShow),
            [typeof(Control), typeof(IEnumerable<IHoverTip>), typeof(HoverTipAlignment)])
            ?? throw new MissingMethodException(nameof(NHoverTipSet.CreateAndShow)),
        AccessTools.Method(typeof(NHoverTipSet), nameof(NHoverTipSet.CreateAndShowMapPointHistory),
            [typeof(Control), typeof(NMapPointHistoryHoverTip)])
            ?? throw new MissingMethodException(nameof(NHoverTipSet.CreateAndShowMapPointHistory))
    ];

    internal static void Install()
    {
        if (_installed) return;
        _installed = true;
        try
        {
            var postfix = new HarmonyMethod(typeof(RenderStreamHoverTipOwner), nameof(AfterCreate));
            var harmony = new Harmony("com.couchcoop.render-stream-tip-owner");
            foreach (var target in Targets()) harmony.Patch(target, postfix: postfix);
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"[rs-tag] tip owner metadata unavailable: {exception.GetType().Name}: {exception.Message}");
        }
    }

    // Use the creation API's owner, the same association consumed by the node mirror. No geometry guesses.
    private static void AfterCreate(Control __0, NHoverTipSet? __result)
    {
        if (__result is null || !GodotObject.IsInstanceValid(__result) || !GodotObject.IsInstanceValid(__0)) return;
        WriteOwnerMetadata(__0.GetInstanceId(), __0.Size, (key, value) => __result.SetMeta(key, value));
    }

    internal static void WriteOwnerMetadata(ulong ownerId, Vector2 ownerSize, Action<string, string> write)
    {
        write(MetadataKey, ownerId.ToString(CultureInfo.InvariantCulture));
        // Control layout is needed even for owners with no draw commands (for example, hitboxes).
        write(SizeMetadataKey, JsonSerializer.Serialize(new[] { ownerSize.X, ownerSize.Y }));
    }
}
