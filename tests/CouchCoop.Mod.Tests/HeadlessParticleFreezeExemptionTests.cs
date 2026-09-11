using System.Reflection;
using CouchCoop.Mod.Session;
using Godot;

// Regression guard for the PARTICLE-freeze exemption in CouchCoopHeadlessVisualSuspender — the game-side half of
// the "phantom potion pinned over the top-left portrait" bug (live-confirmed on the mirror as
// `.../PotionHolder/Potion/VfxPotionFlash/Potion/Container/Image`).
//
// The bug: the headless suspender freezes EVERY particle node permanently (ProcessMode=Disabled), because the
// browser re-runs the particle sim itself from the streamed spec. But `NPotionFlashVfx` only removes itself once
// its `%Flash` CPUParticles2D burst reports `finished`, and only the (now disabled) particle process ever emits
// that. So the flash VFX was never removed: the copy of the potion it paints into its own 60x60 SubViewport —
// which has no computable viewport->screen prefix — stayed in the tree forever and streamed at viewport-local
// coordinates, i.e. over the portrait at the design origin.
//
// The fix exempts that VFX's whole subtree from the freeze so the one-shot completes, `finished` fires, and the
// node deletes itself. These tests assert the properties that make the exemption CORRECT, against the installed
// STS2 assemblies (pure metadata reflection — no live game, no native Godot call):
//
//   * every exempt name still resolves to a Godot Node type (the match is by C# type NAME, so a game-side rename
//     would silently un-exempt it and quietly restore the leak);
//   * the exempt type still declares the members its removal runs through (`_Ready` + `FlashAndFree`) — a rename
//     guard, since keeping that removal alive is the whole point of the exemption. If the game ever removed the
//     VFX some other way, the exemption would be dead weight and should be revisited;
//   * the exemption decision itself is exact (only the listed names, subtree-rooted) — no general un-freezing;
//   * no exempt type is ALSO a whole-node decorative freeze target, which would re-disable the same subtree by
//     ProcessMode inheritance and re-break the self-free through the back door.
internal static class HeadlessParticleFreezeExemptionTests
{
    public static void Run()
    {
        EveryExemptTypeResolves();
        ThePotionFlashVfxIsExempt();
        TheExemptionIsExactAndSubtreeRooted();
        NoExemptTypeIsAlsoWholeNodeDecorativeFrozen();
    }

    // The freeze matches by C# type NAME (GetType().Name), so a rename in the game silently disables the exemption
    // (and silently restores the phantom). Resolve every exempt name against the installed sts2.dll.
    private static void EveryExemptTypeResolves()
    {
        var missing = new List<string>();
        var notANode = new List<string>();
        foreach (var name in CouchCoopHeadlessVisualSuspender.ParticleFreezeExemptScriptTypes)
        {
            var type = ResolveGameType(name);
            if (type is null)
            {
                missing.Add(name);
            }
            else if (!typeof(Node).IsAssignableFrom(type))
            {
                notANode.Add($"{name} ({type.FullName})");
            }
        }

        Assert(missing.Count == 0,
            $"every particle-freeze-exempt type resolves against the installed STS2 assemblies (missing: {string.Join("; ", missing)})");
        Assert(notANode.Count == 0,
            $"every particle-freeze-exempt type is a Godot.Node (not: {string.Join("; ", notANode)})");
    }

    // The specific regression: the potion flash VFX must stay exempt, and it must still be the kind of node the
    // exemption is FOR — one whose removal is gated on its own particle burst reaching `finished`.
    private static void ThePotionFlashVfxIsExempt()
    {
        Assert(CouchCoopHeadlessVisualSuspender.IsParticleFreezeExemptSubtreeRoot("NPotionFlashVfx"),
            "NPotionFlashVfx is exempt from the particle freeze, so `%Flash` reaches `finished` and FlashAndFree() "
            + "QueueFrees the VFX (otherwise its SubViewport copy of the potion leaks and streams at the design origin)");

        var vfx = ResolveGameType("NPotionFlashVfx");
        Assert(vfx?.GetMethod("_Ready", Flags) is not null,
            "NPotionFlashVfx still declares _Ready — where its burst is set up");
        Assert(vfx?.GetMethod("FlashAndFree", Flags) is not null,
            "NPotionFlashVfx still declares FlashAndFree — the member that drives its removal, which the exemption "
            + "exists to keep alive. If the game freed this VFX some other way, the exemption would be dead weight");
    }

    // Scope guard: the exemption is a named allow-list applied to a SUBTREE ROOT, not a general un-freezing. Raw
    // particle classes and the sibling flash VFX (which free themselves off tweens, not off `finished`, and so are
    // unharmed by the freeze) must stay frozen.
    private static void TheExemptionIsExactAndSubtreeRooted()
    {
        foreach (var name in new[]
                 {
                     "CpuParticles2D", "GpuParticles2D", "Node2D", "NPowerFlashVfx", "NRelicFlashVfx", "NUiFlashVfx",
                     "NPotion", "NPotionFlash", "NPotionFlashVfx2", "",
                 })
        {
            Assert(!CouchCoopHeadlessVisualSuspender.IsParticleFreezeExemptSubtreeRoot(name),
                $"'{name}' is NOT particle-freeze exempt (the exemption is an exact-name allow-list — no general un-freezing)");
        }

        Assert(CouchCoopHeadlessVisualSuspender.ParticleFreezeExemptScriptTypes.Count == 1,
            "the particle-freeze exemption stays a one-entry allow-list. The other VFX that share the "
            + "self-free-on-`finished` idiom (NHitSparkVfx, NBlockSparkVfx, NLineBurstVfx, NGroundFireVfx, "
            + "NCeremonialBeastVfx) are NOT unfixed leaks any more: they stay frozen and are covered by the "
            + "synthesized `finished` nudge + the ceremonial-beast death-delay cap (see "
            + "HeadlessParticleFinishNudgeTests). Growing this list is therefore a deliberate REGRESSION of that "
            + "mechanism — an exempt node resumes simulating, which is the CPU this freeze exists to reclaim");
    }

    // ProcessMode is INHERITED: a WholeNode decorative freeze (ProcessMode=Disabled) on an exempt VFX root would
    // disable its particle child anyway, re-breaking the self-free through a different lever. The two policies must
    // not overlap.
    private static void NoExemptTypeIsAlsoWholeNodeDecorativeFrozen()
    {
        foreach (var name in CouchCoopHeadlessVisualSuspender.ParticleFreezeExemptScriptTypes)
        {
            Assert(!CouchCoopHeadlessVisualSuspender.DecorativeAnimatorTypes.ContainsKey(name),
                $"'{name}' is particle-freeze exempt, so it must not ALSO be a decorative-freeze target "
                + "(ProcessMode is inherited — disabling the VFX root would re-freeze its particles)");
        }
    }

    private const BindingFlags Flags =
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly;

    // The exempt names are bare C# type NAMES (matching the runtime GetType().Name check). Scan the loaded STS2
    // assembly for a unique match rather than hardcoding namespaces, which have moved between game versions.
    private static Type? ResolveGameType(string typeName)
    {
        var sts2 = typeof(MegaCrit.Sts2.Core.Nodes.Audio.NAudioManager).Assembly;
        return Array.Find(sts2.GetTypes(), t => t.Name == typeName);
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[HeadlessParticleFreezeExemptionTests] FAILED: {label}");
        }
    }
}
