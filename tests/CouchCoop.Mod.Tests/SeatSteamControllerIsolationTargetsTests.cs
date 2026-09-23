using System.Reflection;
using CouchCoop.Mod.Patches;
using HarmonyLib;

// Regression guard for SeatSteamControllerIsolationPatch: the controller-refresh method it replaces on a spawned
// seat, and the two fields its prefix clears, must still resolve against the installed STS2 assemblies — in the
// shape the prefix assumes. A miss is not a crash: the patch logs and the seat carries on, with a controller
// plugged into the host driving the seat through Steam Input again and nothing on screen to say why. Pure
// metadata reflection over the same names the patch uses — NEVER construct a game type in this runner (see the
// note above HeadlessAudioMuteTargetsTests in BrowserServerRouteTests.cs: exit 139, no managed stack).
internal static class SeatSteamControllerIsolationTargetsTests
{
    public static void Run()
    {
        RefreshMethodResolvesInTheShapeThePrefixReplaces();
        ClearedFieldsAreNullableInstanceFields();
        EarlyControllerReleasesOnlyHeldActions();
    }

    private static void RefreshMethodResolvesInTheShapeThePrefixReplaces()
    {
        var type = SeatSteamControllerIsolationPatch.TargetType;
        var name = SeatSteamControllerIsolationPatch.RefreshMethodName;
        var method = AccessTools.Method(type, name, Type.EmptyTypes);

        Assert(method is not null, $"{type.FullName}.{name}() resolves against the installed STS2 assemblies");
        // DECLARED, not inherited: a prefix on a base-type method would reach every strategy, not this one.
        Assert(method!.DeclaringType == type, $"{type.Name}.{name}() is declared on {type.Name} itself");
        // A skipping prefix makes the method return `default` for its return type — only honest for void.
        Assert(method.ReturnType == typeof(void), $"{type.Name}.{name}() returns void (got {method.ReturnType.Name})");
        Assert(method.GetParameters().Length == 0, $"{type.Name}.{name}() takes no parameters");
        Assert(!method.IsStatic, $"{type.Name}.{name}() is an instance method (the prefix clears __instance)");
    }

    // The prefix writes null to both fields on the seat's input path, so each must be a per-instance field whose
    // null means "no controller" — a Nullable<> — or the write is wrong (or throws) every time the refresh runs.
    private static void ClearedFieldsAreNullableInstanceFields()
    {
        var type = SeatSteamControllerIsolationPatch.TargetType;
        // The underlying type is pinned by NAME, so a same-named field repurposed for something else fails here too
        // — and this project still names no Steamworks type.
        foreach (var (name, underlying) in new[]
                 {
                     (SeatSteamControllerIsolationPatch.ControllerHandleFieldName, "InputHandle_t"),
                     (SeatSteamControllerIsolationPatch.InputTypeFieldName, "ESteamInputType"),
                 })
        {
            var field = type.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
            Assert(field is not null, $"{type.Name}.{name} resolves as an instance field");
            Assert(field!.DeclaringType == type, $"{type.Name}.{name} is declared on {type.Name} itself");
            Assert(field.FieldType.IsGenericType && field.FieldType.GetGenericTypeDefinition() == typeof(Nullable<>),
                $"{type.Name}.{name} is a Nullable<> (got {field.FieldType.Name})");
            Assert(Nullable.GetUnderlyingType(field.FieldType)?.Name == underlying,
                $"{type.Name}.{name} holds a {underlying} (got {Nullable.GetUnderlyingType(field.FieldType)?.Name})");
        }
    }

    // The late-init drop: only held actions get a release, each exactly once, and every inspected name is released
    // back afterwards whether or not it was held — the same rule the joypad strip keeps for InputMap action names.
    private static void EarlyControllerReleasesOnlyHeldActions()
    {
        var held = new HashSet<string> { "controller_face_button_south", "ui_down" };
        var actions = new[] { "controller_face_button_south", "ui_accept", "ui_down", "mega_peek" };
        var releasedEvents = new List<string>();
        var releasedNames = new List<string>();

        var count = SeatSteamControllerIsolationPatch.ReleaseHeldActions(
            actions, held.Contains, releasedEvents.Add, releasedNames.Add);

        Assert(count == 2, $"two held actions are released (got {count})");
        Assert(releasedEvents.SequenceEqual(new[] { "controller_face_button_south", "ui_down" }),
            "a release is raised for each held action only, in map order");
        Assert(releasedNames.SequenceEqual(actions), "every inspected action name is released back, held or not");

        var none = SeatSteamControllerIsolationPatch.ReleaseHeldActions(
            actions, _ => false, _ => throw new Exception("nothing held: no release may be raised"));
        Assert(none == 0, "nothing held releases nothing");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[SeatSteamControllerIsolationTargetsTests] FAILED: {label}");
        }
    }
}
