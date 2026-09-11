using System.Reflection;
using System.Threading.Tasks;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Session;
using Godot;

// Regression guard for WS-1: the headless one-shot `finished` NUDGE and the ceremonial-beast DEATH-DELAY CAP.
//
// The problem. The headless suspender permanently freezes every particle node (ProcessMode=Disabled) because the
// browser re-runs the particle sim itself. But five VFX only take themselves off screen once a particle node has
// reported `finished` — and that signal comes from the node's own, now-disabled, process. Frozen, they never leave.
// One of the five is worse than a leak: the ceremonial beast's death burst is what releases the creature's death
// animation, and nothing bounds the wait, so a frozen one can HANG A BOSS DEATH FOREVER. The rename guards below
// name the members the runtime code reflects on; what each one means on screen is described where it is asserted.
//
// A frozen one-shot owes a SECOND thing its process can no longer do, and the mirror is what noticed: Godot clears
// `Emitting` at the end of a one-shot cycle FROM THAT PROCESS, so on a frozen node the flag latches true forever,
// the producer keeps streaming `particleEmitting: true`, and the browser keeps drawing a burst the real game
// finished long ago (the permanent "energy ring" over the combat energy counter — the whole regent energy-VFX
// cluster, every node of it authored `one_shot = true, emitting = false`). The nudge now performs BOTH halves of
// the end-of-cycle, at the same natural due time.
//
// The fix has three legs, and these tests pin the properties that make each one correct, against the installed
// STS2 assemblies (pure metadata reflection — no live game, no scene tree, no native Godot call):
//
//   1. Freeze-time nudge — a frozen one-shot caught mid-burst gets its end-of-burst (EmitSignal("finished") AND
//      `Emitting = false`) scheduled for the burst's NATURAL end (Godot's own `lifetime * (2 - explosiveness)` +
//      margin), not immediately, so game pacing and the browser's re-simulated tail both survive.
//   2. Restart hook — HeadlessParticleRestartNudgePatch schedules the same nudge for a burst (re)started on an
//      already-frozen node (`Emitting` LATCHES true on a frozen node, so no state edge is observable).
//   3. Death-delay cap — HeadlessDeathDelayCapPatch bounds NCeremonialBeastVfx.GetDelayTask(). REQUIRED: the
//      beast's particle Restart() is triggered by a SPINE animation event, and headless freezes spine too, so no
//      particle-level nudge can ever reach it.
//
// Everything below is either a pure decision table (no Godot types at all) or a rename guard: the runtime code
// matches game shapes by NAME, so a game-side rename would silently restore the leak/stall with no other symptom.
internal static class HeadlessParticleFinishNudgeTests
{
    public static void Run()
    {
        TheFreezeNudgeDecisionTable();
        TheRestartNudgeDecisionTable();
        TheDelayFormulaMatchesGodotsActiveTime();
        TheDelayFormulaIsClamped();
        TheDueNudgeDecisionTable();
        TheEmittingClearFiresAtTheNaturalEndAndNotBefore();
        TheFiveLeakingVfxStillSelfFreeOnFinished();
        TheParticleHarmonyTargetsStillExist();
        TheBeastIsTheOnlyDeathDelayer();
        TheDeathDelayCapTargetResolves();
        TheDeathDelayCapEnvParsing();
        TheNudgedVfxAreNotExemptedOrDecorativelyFrozen();
    }

    // --- Leg 1: pure decision seams ---------------------------------------------------------------------------

    // Only a ONE-SHOT that is currently EMITTING owes its listeners a `finished`: a looping emitter never reports
    // finished at all, and an idle one-shot has either not started yet (the next scan catches it) or already
    // reported. Nudging a looper would deliver a signal the game never expects.
    private static void TheFreezeNudgeDecisionTable()
    {
        foreach (var (oneShot, emitting, expected, why) in new[]
                 {
                     (true, true, true, "a one-shot caught MID-BURST is exactly the leak case — its process is about "
                                        + "to be disabled and only that process emits `finished`"),
                     (true, false, false, "an idle one-shot owes nothing yet; if it starts later the restart hook "
                                          + "(or the next freeze walk) schedules the nudge"),
                     (false, true, false, "a LOOPING emitter never emits `finished`, so a synthesized one would be a "
                                          + "signal the game never expects"),
                     (false, false, false, "a stopped looper owes nothing"),
                 })
        {
            Assert(CouchCoopHeadlessVisualSuspender.ShouldNudgeOnFreeze(oneShot, emitting) == expected,
                $"ShouldNudgeOnFreeze(oneShot: {oneShot}, emitting: {emitting}) == {expected} — {why}");
        }
    }

    // The restart hook only matters for nodes the freeze walk ALREADY froze. An unfrozen node still runs its own
    // process and emits its own real `finished`; nudging it would double-fire.
    private static void TheRestartNudgeDecisionTable()
    {
        foreach (var (frozen, oneShot, expected, why) in new[]
                 {
                     (true, true, true, "a one-shot restarted on a FROZEN node starts a cycle whose process never "
                                        + "runs — the case the hook exists for (the beast's DeathParticles.Restart)"),
                     (true, false, false, "a frozen LOOPER never reports finished, frozen or not"),
                     (false, true, false, "an unfrozen one-shot emits its own real `finished`; a nudge would double-fire"),
                     (false, false, false, "an unfrozen looper needs nothing"),
                 })
        {
            Assert(CouchCoopHeadlessVisualSuspender.ShouldNudgeOnRestart(frozen, oneShot) == expected,
                $"ShouldNudgeOnRestart(alreadyFrozen: {frozen}, oneShot: {oneShot}) == {expected} — {why}");
        }
    }

    // Godot's one-shot cycle length is `lifetime * (2 - explosiveness)` (particles.cpp `active_time`): at
    // explosiveness 1 every particle is born at t=0 so the cycle is one lifetime; at 0 births are spread over a
    // full lifetime so the last particle dies at 2x lifetime. We add a 0.25s margin and emit THEN, so the browser's
    // independently re-simulated burst has drawn its tail before the VFX's removal delta arrives.
    private static void TheDelayFormulaMatchesGodotsActiveTime()
    {
        foreach (var (lifetime, explosiveness, expected, why) in new[]
                 {
                     (1.0, 1.0, 1.25, "fully explosive: one lifetime + 0.25s margin"),
                     (1.0, 0.0, 2.25, "not explosive: births spread over a lifetime, so 2x lifetime + margin"),
                     (2.0, 0.5, 3.25, "2 * (2 - 0.5) + 0.25"),
                     (0.75, 0.8, 1.15, "the hit-spark spec shape: 0.75 * 1.2 + 0.25"),
                     // The live case this leg was designed around: ceremonial_beast.tscn DeathParticles has
                     // lifetime = 7.0, explosiveness = 0.94. Under the cap (10s) by a comfortable margin, which is
                     // why HeadlessDeathDelayCapPatch's 10s default is a backstop and not a truncation.
                     (7.0, 0.94, 7.67, "the beast's DeathParticles (lifetime 7.0, explosiveness 0.94)"),
                 })
        {
            var actual = CouchCoopHeadlessVisualSuspender.FinishNudgeDelaySeconds(lifetime, explosiveness);
            Assert(System.Math.Abs(actual - expected) < 1e-9,
                $"FinishNudgeDelaySeconds(lifetime: {lifetime}, explosiveness: {explosiveness}) == {expected} "
                + $"(got {actual}) — {why}");
        }
    }

    // Clamps exist so no particle spec can make the nudge useless: too early would free the VFX while the client is
    // still drawing the burst's opening frames; too late would pin a pending entry (and, for the beast, a death
    // sequence) for minutes.
    private static void TheDelayFormulaIsClamped()
    {
        foreach (var (lifetime, explosiveness, expected, why) in new[]
                 {
                     (0.05, 1.0, 0.5, "a tiny lifetime clamps UP to the 0.5s floor — never fire before the browser "
                                      + "has drawn the burst it is re-simulating"),
                     (0.0, 1.0, 0.5, "a zero lifetime clamps to the floor rather than firing on the same tick"),
                     (7.0, 0.0, 10.0, "7 * 2 + 0.25 = 14.25 clamps DOWN to the 10s ceiling"),
                     (1000.0, 1.0, 10.0, "an absurd lifetime still clamps to the ceiling — no entry is pinned forever"),
                     (-5.0, 1.0, 0.5, "a negative lifetime clamps to the floor instead of scheduling in the past"),
                 })
        {
            var actual = CouchCoopHeadlessVisualSuspender.FinishNudgeDelaySeconds(lifetime, explosiveness);
            Assert(System.Math.Abs(actual - expected) < 1e-9,
                $"FinishNudgeDelaySeconds(lifetime: {lifetime}, explosiveness: {explosiveness}) == {expected} "
                + $"(got {actual}) — {why}");
        }
    }

    // What a DUE nudge actually does. The `finished` emit is unconditional (the listeners are awaiting it whatever
    // the flag ended up saying); the `Emitting` clear is only ever the write the node's own process would have
    // made, so it is refused for anything that is not still a latched one-shot. Clearing a LOOPER would stop an
    // emitter the game deliberately has running — the game owns that flag for a looper, and turns it off through
    // NParticlesContainer when it wants it off.
    private static void TheDueNudgeDecisionTable()
    {
        foreach (var (oneShot, emitting, expectClear, why) in new[]
                 {
                     (true, true, true, "the stuck-ring case: a frozen one-shot still latched EMITTING at the end "
                                        + "of its burst — the write its disabled process owed"),
                     (true, false, false, "a one-shot that already reads not-emitting owes nothing: the game "
                                          + "stopped it, or the freeze was lifted and its own process ended the "
                                          + "cycle. This also makes a re-fire inert, so the clear can never "
                                          + "ping-pong with the restart hook"),
                     (false, true, false, "a LOOPING emitter is the game's to stop — clearing it here would kill an "
                                          + "ambient VFX that is supposed to keep running"),
                     (false, false, false, "a stopped looper owes nothing"),
                 })
        {
            var actions = CouchCoopHeadlessVisualSuspender.ComputeDueNudgeActions(oneShot, emitting);
            Assert(actions.ClearEmitting == expectClear,
                $"ComputeDueNudgeActions(oneShot: {oneShot}, emitting: {emitting}).ClearEmitting == {expectClear} "
                + $"— {why}");
            Assert(actions.EmitFinished,
                $"…and the `finished` emit stays unconditional (oneShot: {oneShot}, emitting: {emitting}): the VFX "
                + "awaiting it must free itself however the flag ended up");
        }
    }

    // TIMING is the whole design of this nudge, for the flag clear even more than for the signal: the browser
    // re-simulates the burst on ITS own clock, so clearing `Emitting` at freeze time would erase a burst the client
    // has only just started drawing — the stuck-ring defect mirrored. Replay a whole burst on a simulated clock and
    // pin that NOTHING happens until the natural end. Both halves ride this one due instant
    // (ComputeDueNudgeActions is evaluated only for entries IsFinishNudgeDue has released), so the clear cannot
    // drift earlier than the emit.
    private static void TheEmittingClearFiresAtTheNaturalEndAndNotBefore()
    {
        // The live case: vfx_common_ring_polar_a as instanced in regent_energy_vfx_front (lifetime 0.4,
        // explosiveness 0) ⇒ 0.4 * 2 + 0.25 margin = 1.05s after the freeze catches it mid-burst.
        const long freezeMs = 1_000_000;
        var delay = CouchCoopHeadlessVisualSuspender.FinishNudgeDelaySeconds(0.4, 0.0);
        Assert(System.Math.Abs(delay - 1.05) < 1e-9,
            $"the energy ring's burst window is 1.05s (got {delay})");
        var dueMs = CouchCoopHeadlessVisualSuspender.FinishNudgeDueMs(freezeMs, delay);
        Assert(dueMs == freezeMs + 1050, $"scheduled 1050ms after the freeze (got {dueMs - freezeMs}ms)");

        foreach (var (nowMs, expected, why) in new[]
                 {
                     (freezeMs, false, "AT FREEZE TIME nothing fires — the client is drawing the burst's opening "
                                       + "frames right now"),
                     (freezeMs + 1, false, "one tick later, still nothing"),
                     (freezeMs + 1049, false, "one millisecond short of the natural end is still short"),
                     (freezeMs + 1050, true, "the burst's natural end: `finished` is emitted AND `Emitting` is "
                                             + "cleared, so the mirror stops drawing it"),
                     (freezeMs + 5000, true, "a late tick (the 0.2s Timer cadence, or a stalled frame) still fires "
                                             + "— due is a deadline, not a window"),
                 })
        {
            Assert(CouchCoopHeadlessVisualSuspender.IsFinishNudgeDue(dueMs, nowMs) == expected,
                $"IsFinishNudgeDue(due: freeze+1050ms, now: freeze+{nowMs - freezeMs}ms) == {expected} — {why}");
        }
    }

    // --- Rename guards over the game assembly ------------------------------------------------------------------

    // The five VFX the nudge exists for must still take themselves off screen on `finished`. If a game update ever
    // removes one some other way, the reasoning behind the nudge (and the risk this leg mitigates) has changed and
    // should be re-derived — a green build here is what makes "they are covered" true. These are RENAME guards: the
    // runtime code finds these members by name, so a rename would silently restore the leak with no other symptom.
    private static void TheFiveLeakingVfxStillSelfFreeOnFinished()
    {
        // (type, particle member the removal waits on, the member that drives the removal)
        foreach (var (typeName, particleMember, driver) in new[]
                 {
                     ("NHitSparkVfx", "_specks", "FlashAndFree"),
                     ("NBlockSparkVfx", "_specks", "FlashAndFree"),
                     ("NGroundFireVfx", "_ember", "AnimateIn"),
                     ("NCeremonialBeastVfx", "_deathParticles", "FinishTaskWhenDeathParticlesFinished"),
                 })
        {
            var type = ResolveGameType(typeName);
            Assert(type is not null,
                $"{typeName} still exists in the installed STS2 assemblies (the nudge exists for it)");
            Assert(type!.GetField(particleMember, Flags) is not null,
                $"{typeName} still declares `{particleMember}` — the particle node whose `finished` the freeze "
                + "suppresses and the nudge synthesizes");
            Assert(type.GetMethod(driver, Flags) is not null,
                $"{typeName} still declares `{driver}`, the member that drives its removal. If it were gone, the "
                + "VFX would leave the screen some other way and the nudge would be dead weight");
        }

        // NLineBurstVfx is the odd one out: it is ITSELF the emitter, so there is no separate particle member to
        // look for — which is also why a subtree exemption would have had to exempt the emitter itself.
        var lineBurst = ResolveGameType("NLineBurstVfx");
        Assert(lineBurst is not null, "NLineBurstVfx still exists in the installed STS2 assemblies");
        Assert(typeof(GpuParticles2D).IsAssignableFrom(lineBurst!),
            "NLineBurstVfx is itself a GpuParticles2D, so the freeze that disables its process is also what "
            + "suppresses the signal its own removal waits on");
        Assert(lineBurst!.GetMethod("DeleteAfterComplete", Flags) is not null,
            "NLineBurstVfx still declares DeleteAfterComplete — the member that drives its removal");

        // The beast's stall path specifically: its death burst is started off a SPINE animation event, and headless
        // freezes spine too, so no particle-level nudge can ever reach it. That is why leg 3 (the cap) is required,
        // not optional. All three members are resolved by name at runtime, hence the rename guards.
        var beast = ResolveGameType("NCeremonialBeastVfx")!;
        Assert(beast.GetField("_deathTask", Flags) is not null,
            "NCeremonialBeastVfx still declares `_deathTask` — the wait the death-delay cap bounds");
        Assert(beast.GetMethod("TurnOnDeathParticles", Flags) is not null,
            "NCeremonialBeastVfx still declares TurnOnDeathParticles — what starts the death burst");
        Assert(beast.GetMethod("OnAnimationEvent", Flags) is not null,
            "NCeremonialBeastVfx still declares OnAnimationEvent — the spine-event entry point the spine freeze cuts");
    }

    // HeadlessParticleRestartNudgePatch resolves Restart by NAME and Emitting through its property setter, and the
    // freeze walk reads OneShot/Lifetime/Explosiveness to compute the nudge delay. A GodotSharp binding change to
    // any of these silently disables a hook, so assert them all against the linked GodotSharp.
    private static void TheParticleHarmonyTargetsStillExist()
    {
        foreach (var type in new[] { typeof(GpuParticles2D), typeof(CpuParticles2D) })
        {
            var restart = System.Array.Find(
                type.GetMethods(BindingFlags.Instance | BindingFlags.Public),
                m => m.Name == "Restart" && !m.IsGenericMethodDefinition);
            Assert(restart is not null,
                $"{type.Name}.Restart(...) exists — HeadlessParticleRestartNudgePatch resolves it BY NAME (the "
                + "binding exposes it as Restart() or Restart(bool keepSeed) depending on engine version)");

            Assert(type.GetProperty("Emitting")?.GetSetMethod() is not null,
                $"{type.Name}.Emitting has a public setter — the patch postfixes set_Emitting for `Emitting = true` "
                + "bursts (NGroundFireVfx starts its ember that way, not via Restart), and the due nudge WRITES it "
                + "(`Emitting = false`) to end a frozen one-shot's cycle for the mirror");

            // OneShot/Emitting drive the DECISION (they must stay boolean flags); Lifetime/Explosiveness feed the
            // delay arithmetic and only need to widen to double (GodotSharp binds real_t as float and double
            // engine properties as double, and that split has moved between engine versions).
            foreach (var member in new[] { "OneShot", "Emitting" })
            {
                var property = type.GetProperty(member, BindingFlags.Instance | BindingFlags.Public);
                Assert(property is not null,
                    $"{type.Name}.{member} exists — the freeze walk reads it to decide whether to nudge");
                Assert(property!.PropertyType == typeof(bool),
                    $"{type.Name}.{member} is still a bool (got {property.PropertyType.Name}) — "
                    + "ShouldNudgeOnFreeze/ShouldNudgeOnRestart are boolean decision tables over exactly these two");
            }

            foreach (var member in new[] { "Lifetime", "Explosiveness" })
            {
                var property = type.GetProperty(member, BindingFlags.Instance | BindingFlags.Public);
                Assert(property is not null,
                    $"{type.Name}.{member} exists — the freeze walk reads it to SIZE the nudge "
                    + "(lifetime * (2 - explosiveness) + margin)");
                Assert(property!.PropertyType == typeof(float) || property.PropertyType == typeof(double),
                    $"{type.Name}.{member} is a floating-point number (got {property.PropertyType.Name}) so it "
                    + "widens to the double the delay formula takes");
            }

            // METADATA ONLY, deliberately: reading a StringName VALUE here would call
            // godotsharp_string_name_new_from_string on a linked-but-not-running GodotSharp and hard-SIGSEGV the
            // whole runner (see the note at the top of BrowserServerRouteTests.cs). Asserting the field exists and
            // is a StringName is the strongest rename guard available without a live engine.
            var finished = type.GetNestedType("SignalName")?.GetField(
                "Finished", BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy);
            Assert(finished is not null,
                $"{type.Name}.SignalName.Finished exists — the nudge emits exactly this signal, and the VFX above "
                + "await exactly this signal");
            Assert(finished!.FieldType == typeof(StringName),
                $"{type.Name}.SignalName.Finished is a StringName (got {finished.FieldType.Name}) — the suspender "
                + "passes it straight to GodotObject.EmitSignal(StringName, ...)");
        }

        Assert(HeadlessParticleRestartNudgePatch.TargetCount == 4,
            "the restart nudge patches 4 targets (Restart + set_Emitting on each of Gpu/CpuParticles2D)");
    }

    // Leg 3 is scoped to ONE type on purpose: today exactly one VFX can hold a creature's death animation open.
    // A second `IDeathDelayer` would be a second unbounded wait this cap does not cover, so fail loudly here
    // rather than silently under-covering a live boss fight.
    private static void TheBeastIsTheOnlyDeathDelayer()
    {
        var sts2 = Sts2Assembly;
        var delayer = System.Array.Find(sts2.GetTypes(), t => t.Name == "IDeathDelayer");
        Assert(delayer is not null && delayer.IsInterface,
            "IDeathDelayer still exists as an interface in the game assembly — a creature's death animation waits "
            + "on every implementer, and nothing bounds that wait");

        var implementers = new List<string>();
        foreach (var type in sts2.GetTypes())
        {
            if (type != delayer && !type.IsInterface && delayer!.IsAssignableFrom(type))
            {
                implementers.Add(type.Name);
            }
        }

        Assert(implementers.Count == 1 && implementers[0] == HeadlessDeathDelayCapPatch.TargetTypeName,
            "NCeremonialBeastVfx is the ONLY IDeathDelayer in the game assembly (found: "
            + $"{(implementers.Count == 0 ? "<none>" : string.Join(", ", implementers))}). A new implementer would "
            + "reintroduce an unbounded headless death await that HeadlessDeathDelayCapPatch does not cap");
    }

    // The cap resolves its target the same way it will at runtime (bare-name scan over the game assembly), so a
    // rename fails here instead of degrading to a log line on a live boss fight.
    private static void TheDeathDelayCapTargetResolves()
    {
        var target = HeadlessDeathDelayCapPatch.ResolveTarget();
        Assert(target is not null,
            $"HeadlessDeathDelayCapPatch resolves {HeadlessDeathDelayCapPatch.TargetTypeName}."
            + $"{HeadlessDeathDelayCapPatch.TargetMethodName}() by name-scan over the installed game assembly");
        Assert(target!.ReturnType == typeof(Task),
            $"{HeadlessDeathDelayCapPatch.TargetMethodName} still returns a bare Task (got {target.ReturnType.Name}) "
            + "— the postfix replaces `ref Task __result`, so a Task<T> or ValueTask would break the patch");
        Assert(target.GetParameters().Length == 0,
            "GetDelayTask() still takes no parameters (the IDeathDelayer contract the cap patches)");
    }

    // The cap is always armed: the safe 10s default holds for blank, invalid, or non-positive values while a
    // positive operator override remains available.
    private static void TheDeathDelayCapEnvParsing()
    {
        foreach (var (raw, expected, why) in new (string?, double, string)[]
                 {
                     (null, HeadlessDeathDelayCapPatch.DefaultCapSeconds, "unset ⇒ default 10s (beast death "
                                                                          + "particles are lifetime 7 + margin)"),
                     ("", HeadlessDeathDelayCapPatch.DefaultCapSeconds, "blank ⇒ default"),
                     ("   ", HeadlessDeathDelayCapPatch.DefaultCapSeconds, "whitespace ⇒ default"),
                     ("0", HeadlessDeathDelayCapPatch.DefaultCapSeconds, "zero retains the safe default"),
                     ("-3", HeadlessDeathDelayCapPatch.DefaultCapSeconds, "a negative cap is meaningless ⇒ safe default"),
                     ("2.5", 2.5, "a fractional override is honoured"),
                     ("30", 30, "a larger override is honoured"),
                     ("banana", HeadlessDeathDelayCapPatch.DefaultCapSeconds,
                         "unparseable ⇒ default; a typo must not silently remove the deadlock guard"),
                 })
        {
            var actual = HeadlessDeathDelayCapPatch.ParseCapSeconds(raw);
            Assert(System.Math.Abs(actual - expected) < 1e-9,
                $"ParseCapSeconds({(raw is null ? "null" : $"\"{raw}\"")}) == {expected} (got {actual}) — {why}");
        }
    }

    // Scope guard: the nudge REPLACES exemption for these five. They must stay frozen (that is the whole CPU win)
    // and they must not be decorative-freeze targets either — a WholeNode decorative freeze would disable the VFX
    // root, and ProcessMode is inherited, so its particles would be re-disabled through a different lever.
    private static void TheNudgedVfxAreNotExemptedOrDecorativelyFrozen()
    {
        foreach (var name in new[]
                 {
                     "NHitSparkVfx", "NBlockSparkVfx", "NLineBurstVfx", "NGroundFireVfx", "NCeremonialBeastVfx",
                 })
        {
            Assert(!CouchCoopHeadlessVisualSuspender.IsParticleFreezeExemptSubtreeRoot(name),
                $"'{name}' is NOT particle-freeze exempt — it stays frozen (zero sim cost) and gets the "
                + "synthesized `finished` nudge instead");
            Assert(!CouchCoopHeadlessVisualSuspender.ParticleFreezeExemptScriptTypes.Contains(name),
                $"'{name}' is absent from the exemption allow-list");
            Assert(!CouchCoopHeadlessVisualSuspender.DecorativeAnimatorTypes.ContainsKey(name),
                $"'{name}' is not a decorative-freeze target either (ProcessMode is inherited — a WholeNode freeze "
                + "on the VFX root would re-disable its particles behind the nudge's back)");
        }

        // And the live-proven exemption stays exactly as it was: exempt subtrees are skipped BEFORE the freeze, so
        // they are never nudged, and the two mechanisms cannot collide.
        Assert(CouchCoopHeadlessVisualSuspender.IsParticleFreezeExemptSubtreeRoot("NPotionFlashVfx"),
            "NPotionFlashVfx keeps its live-proven exemption (the nudge does not replace it; exempt subtrees are "
            + "skipped before freezing, so they are never nudged)");
    }

    private const BindingFlags Flags =
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly;

    private static Assembly Sts2Assembly => typeof(MegaCrit.Sts2.Core.Nodes.Audio.NAudioManager).Assembly;

    // The runtime code matches game classes by bare C# type NAME; namespaces have moved between game versions, so
    // scan for the name exactly as the runtime does.
    private static System.Type? ResolveGameType(string typeName)
        => System.Array.Find(Sts2Assembly.GetTypes(), t => t.Name == typeName);

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new System.Exception($"[HeadlessParticleFinishNudgeTests] FAILED: {label}");
        }
    }
}
