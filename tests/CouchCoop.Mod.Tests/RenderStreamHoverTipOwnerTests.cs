using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using CouchCoop.Mod.Session;
using Godot;
using MegaCrit.Sts2.Core.Nodes.HoverTips;

internal static class RenderStreamHoverTipOwnerTests
{
    public static void Run()
    {
        var targets = RenderStreamHoverTipOwner.Targets();
        Assert(targets.Length == 2, "both tip creation routes are guarded");
        foreach (var target in targets)
        {
            Assert(target.DeclaringType == typeof(NHoverTipSet) && target.IsStatic
                && target.ReturnType == typeof(NHoverTipSet), "the postfix receives a created tip set");
            Assert(target.GetParameters()[0].ParameterType == typeof(Control), "argument zero is the tip owner");
        }

        var entries = new Dictionary<string, string>();
        var previousCulture = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-FR");
            RenderStreamHoverTipOwner.WriteOwnerMetadata(9007199254740993UL, new Vector2(190.5f, 250.25f),
                (key, value) => entries.Add(key, value));
        }
        finally
        {
            CultureInfo.CurrentCulture = previousCulture;
        }
        Assert(entries.Count == 2, "publish owner identity and local layout size together");
        Assert(entries["couchcoop_rs_tip_owner"] == "9007199254740993",
            "owner identity stays lossless above JavaScript's integer range");
        var size = JsonSerializer.Deserialize<float[]>(entries["couchcoop_rs_tip_owner_size"]);
        Assert(size is [190.5f, 250.25f], "layout size is culture-independent local Control geometry");

        entries.Clear();
        RenderStreamHoverTipOwner.WriteOwnerMetadata(1UL, Vector2.Zero, (key, value) => entries.Add(key, value));
        Assert(entries["couchcoop_rs_tip_owner_size"] == "[0,0]", "zero-size holders remain distinguishable from hitboxes");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
