using System.Reflection;
using CouchCoop.Mod.Session;

// Guard for the OFF-SCREEN EXTRACTION exemption in CouchCoopHeadlessVisualSuspender.
//
// The hazard: all three freeze walks (spine, particles, decorative) are an unconditional DFS from
// SceneTree.Root. They are NOT scoped to the main viewport or to CurrentScene, and a SubViewport's children are
// ordinary children — so the walk reaches the detached rig inside the throwaway SubViewport an extraction
// (a geoclip geometry bake, or a spine still render) parents onto that same root, and sets
// ProcessMode=Disabled. spine-godot deforms in NOTIFICATION_INTERNAL_PROCESS, so a frozen rig never re-poses:
// the bake comes back holding ONE pose repeated across every frame it asked for. The freeze re-asserts on every
// rescan, so it is not a race a short bake reliably wins.
//
// The fix skips such a subtree wholesale, keyed on the node NAME spirectl stamps on those viewports. These tests
// pin the two halves that make it correct — it fires for the marked subtree, and it fires for NOTHING ELSE —
// plus the structural fact that all three walks consult it, which is the part a future edit would quietly drop.
internal static class HeadlessExtractionExemptionTests
{
    public static void Run()
    {
        TheMarkedSubtreeIsExempt();
        NothingElseIsExempt();
        AWalkOverAFakeTreeFreezesEverythingButTheMarkedSubtree();
        AllThreeWalksConsultTheExemption();
    }

    private static void TheMarkedSubtreeIsExempt()
    {
        Assert(
            CouchCoopHeadlessVisualSuspender.IsOffscreenExtractionSubtreeRoot(
                CouchCoopHeadlessVisualSuspender.OffscreenExtractionNodeName),
            "the node name spirectl stamps on an extraction viewport is exempt (otherwise a bake returns one pose "
            + "repeated across every frame)");
        Assert(
            CouchCoopHeadlessVisualSuspender.OffscreenExtractionNodeName == "Sts2OffscreenExtraction",
            "the marker string is the whole contract with spirectl — KEEP IN LOCKSTEP. If spirectl renames the "
            + "node, this constant must move with it, and this assertion is the reminder");

        // A UNIQUIFIED SIBLING IS STILL AN EXTRACTION VIEWPORT. Godot renames a duplicate sibling rather than
        // rejecting it, so the second extraction viewport alive under the root is `Sts2OffscreenExtraction2` (or an
        // engine-generated `@Sts2OffscreenExtraction@3`). An exact match would exempt the first and freeze the
        // second — the original bug, back and now intermittent. spirectl's own matcher
        // (Sts2OffscreenExtraction.IsExtractionSubtreeRoot) is prefix-based for exactly this reason; these two are
        // ONE contract and must answer identically for every input.
        foreach (var name in new[]
                 {
                     "Sts2OffscreenExtraction2", "Sts2OffscreenExtraction17",
                     "@Sts2OffscreenExtraction@3", "@Sts2OffscreenExtraction",
                 })
        {
            Assert(
                CouchCoopHeadlessVisualSuspender.IsOffscreenExtractionSubtreeRoot(name),
                $"'{name}' is a UNIQUIFIED extraction viewport and is exempt — the engine appends to a duplicate "
                + "sibling name, so an exact match would silently freeze every extraction after the first");
        }
    }

    // The scope guard, and the reason the exemption is keyed on a NAME rather than on the C# type: the node is a
    // plain SubViewport. Exempting the TYPE would un-freeze whatever the game itself renders off-screen and hand
    // back the CPU the suspender exists to reclaim — silently, since nothing else in the build would fail.
    private static void NothingElseIsExempt()
    {
        // The match is a case-sensitive PREFIX (see the seam's remarks: Godot uniquifies duplicate siblings), so
        // the guard here is that the prefix is one nothing but spirectl stamps. A name that merely CONTAINS the
        // marker, or differs in case, or is prefixed by anything at all, is not an extraction viewport.
        foreach (var name in new[]
                 {
                     "SubViewport", "Viewport", "SubViewportContainer", "Node", "Node2D", "SpineSprite",
                     "sts2offscreenextraction", "STS2OFFSCREENEXTRACTION",
                     "XSts2OffscreenExtraction", " Sts2OffscreenExtraction", "Sts2Offscreen", "",
                 })
        {
            Assert(
                !CouchCoopHeadlessVisualSuspender.IsOffscreenExtractionSubtreeRoot(name),
                $"'{name}' is NOT an extraction subtree root — the prefix is case-sensitive and anchored, so the "
                + "exemption can never widen into 'skip every SubViewport'");
        }

        Assert(!CouchCoopHeadlessVisualSuspender.IsOffscreenExtractionSubtreeRoot(null), "a nameless node is not exempt");
    }

    // The walk-level property, over a fake tree: the DFS shape the three walks share, driven by the SAME two
    // decision seams they call. The load-bearing case is the SECOND one — a non-marked SubViewport's spine
    // children must still be frozen, or this "fix" is a CPU regression wearing a bug fix's clothes.
    private static void AWalkOverAFakeTreeFreezesEverythingButTheMarkedSubtree()
    {
        var tree = new FakeNode("root")
        {
            Children =
            {
                new FakeNode("Combat")
                {
                    // The game's own creatures: frozen, as always.
                    Children = { new FakeNode("Byrdonis") { Children = { new FakeNode("Spine", isSpine: true) } } },
                },
                // The game's OWN off-screen render (e.g. a portrait viewport): NOT marked, so still frozen.
                new FakeNode("PortraitViewport")
                {
                    Children = { new FakeNode("Spine", isSpine: true) },
                },
                // The extraction: skipped, subtree and all.
                new FakeNode(CouchCoopHeadlessVisualSuspender.OffscreenExtractionNodeName)
                {
                    Children = { new FakeNode("BakedRig") { Children = { new FakeNode("Spine", isSpine: true) } } },
                },
            },
        };

        var frozen = new List<string>();
        WalkLikeTheSuspender(tree, frozen);

        Assert(frozen.Count == 2, $"exactly two of the three spine nodes freeze (froze {frozen.Count})");
        Assert(
            frozen.TrueForAll(path => !path.Contains(CouchCoopHeadlessVisualSuspender.OffscreenExtractionNodeName, StringComparison.Ordinal)),
            "no node under the marked extraction subtree is frozen — the rig has to keep deforming to be posed");
        Assert(
            frozen.Contains("root/PortraitViewport/Spine"),
            "a NON-marked SubViewport's spine children are STILL FROZEN. This is the scope guard: the exemption "
            + "must not become 'skip every off-screen viewport', which would give back the CPU win");
        Assert(frozen.Contains("root/Combat/Byrdonis/Spine"), "the scene's own creatures are still frozen");
    }

    // The DFS shape of FreezeAllSpine, calling the same two seams: the exemption first (continue, subtree and
    // all), then the freeze decision.
    private static void WalkLikeTheSuspender(FakeNode root, List<string> frozen)
    {
        var stack = new Stack<(FakeNode Node, string Path)>();
        stack.Push((root, root.Name));
        while (stack.Count > 0)
        {
            var (node, path) = stack.Pop();
            if (CouchCoopHeadlessVisualSuspender.IsOffscreenExtractionSubtreeRoot(node.Name))
            {
                continue;
            }

            if (CouchCoopHeadlessVisualSuspender.ShouldAssertSpineFreeze(alreadyDisabled: false, looksLikeSpine: node.IsSpine))
            {
                frozen.Add(path);
            }

            foreach (var child in node.Children)
            {
                stack.Push((child, path + "/" + child.Name));
            }
        }
    }

    // The structural half. The test above proves the DECISION is right; this proves the three real walks
    // actually ASK it — read straight out of their compiled bodies, so a walk that quietly stops consulting the
    // exemption fails here rather than in a live bake three weeks later.
    private static void AllThreeWalksConsultTheExemption()
    {
        var suspender = typeof(CouchCoopHeadlessVisualSuspender);
        var exemption = suspender.GetMethod(
            nameof(CouchCoopHeadlessVisualSuspender.IsOffscreenExtractionSubtreeRoot),
            BindingFlags.Public | BindingFlags.Static);
        Assert(exemption is not null, "IsOffscreenExtractionSubtreeRoot is the exemption seam");

        foreach (var walk in new[] { "FreezeAllSpine", "FreezeAllParticles", "FreezeDecorativeAnimators" })
        {
            var method = suspender.GetMethod(walk, BindingFlags.NonPublic | BindingFlags.Static);
            Assert(method is not null, $"{walk} is one of the three tree walks");
            Assert(
                CallsMethod(method!, exemption!),
                $"{walk} consults the extraction exemption. All three share the DFS from SceneTree.Root, so all "
                + "three reach a bake's own nodes; an extraction subtree exists for milliseconds and is freed, so "
                + "it is nobody's idle-CPU problem");
        }
    }

    // Scan a method body's IL for a `call`/`callvirt` to `target`. Crude on purpose: the alternative is a source
    // grep (brittle to formatting) or trusting a comment.
    private static bool CallsMethod(MethodInfo caller, MethodInfo target)
    {
        var il = caller.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            throw new Exception($"[HeadlessExtractionExemptionTests] FAILED: no IL for {caller.Name}");
        }

        var module = caller.Module;
        for (var i = 0; i + 4 < il.Length; i++)
        {
            if (il[i] is not (0x28 or 0x6F))
            {
                continue; // call / callvirt
            }

            try
            {
                if (module.ResolveMethod(BitConverter.ToInt32(il, i + 1)) is MethodInfo resolved
                    && resolved.MetadataToken == target.MetadataToken
                    && resolved.Module == target.Module)
                {
                    return true;
                }
            }
            catch (ArgumentException)
            {
                // Not a metadata token — the byte was operand data, not an opcode. Keep scanning.
            }
        }

        return false;
    }

    private sealed class FakeNode(string name, bool isSpine = false)
    {
        public string Name { get; } = name;

        public bool IsSpine { get; } = isSpine;

        public List<FakeNode> Children { get; } = [];
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[HeadlessExtractionExemptionTests] FAILED: {label}");
        }
    }
}
