using CouchCoop.Mod.Session;
using Godot;

namespace CouchCoop.Mod.Tests;

// The test runner has no Godot engine: use runtime types as the classification seam, but never construct a Godot
// object. The mutable plain collections below exercise the same enumeration/removal path production uses.
internal static class HeadlessJoypadInputMapIsolationTests
{
    private sealed record Binding(Type EventType);

    public static void Run()
    {
        ClassifiesOnlyJoypadEvents();
        RemovesJoypadsAndPreservesKeyboardAndMouse();
        RepeatedHeadlessApplicationIsIdempotent();
        HostActivationLeavesTheInputMapUntouched();
        ReleasesEveryInspectedAction();
    }

    private static void ClassifiesOnlyJoypadEvents()
    {
        Assert(HeadlessJoypadInputMapIsolation.IsJoypadEventType(typeof(InputEventJoypadButton)),
            "joypad button bindings are selected");
        Assert(HeadlessJoypadInputMapIsolation.IsJoypadEventType(typeof(InputEventJoypadMotion)),
            "joypad motion bindings are selected");
        Assert(!HeadlessJoypadInputMapIsolation.IsJoypadEventType(typeof(InputEventKey)),
            "keyboard bindings are not selected");
        Assert(!HeadlessJoypadInputMapIsolation.IsJoypadEventType(typeof(InputEventMouseButton)),
            "mouse-button bindings are not selected");
    }

    private static void RemovesJoypadsAndPreservesKeyboardAndMouse()
    {
        var actions = SampleActions();

        var removed = Remove(actions, isHeadlessClient: true);

        Assert(removed == 2, "the headless pass removes every joypad binding");
        Assert(actions["confirm"].Select(binding => binding.EventType).SequenceEqual(
                new[] { typeof(InputEventKey), typeof(InputEventMouseButton) }),
            "the headless pass preserves keyboard and mouse bindings");
    }

    private static void RepeatedHeadlessApplicationIsIdempotent()
    {
        var actions = SampleActions();

        Assert(Remove(actions, isHeadlessClient: true) == 2, "the first pass removes the joypad bindings");
        Assert(Remove(actions, isHeadlessClient: true) == 0, "the second pass has nothing left to remove");
    }

    private static void HostActivationLeavesTheInputMapUntouched()
    {
        var actions = SampleActions();
        var eventLookupCalled = false;

        var removed = HeadlessJoypadInputMapIsolation.RemoveMatchingBindings(
            isHeadlessClient: false,
            actions.Keys,
            action =>
            {
                eventLookupCalled = true;
                return actions[action];
            },
            binding => HeadlessJoypadInputMapIsolation.IsJoypadEventType(binding.EventType),
            (action, binding) => actions[action].Remove(binding));

        Assert(removed == 0, "a windowed host does not activate the filter");
        Assert(!eventLookupCalled, "a windowed host does not even inspect InputMap events");
        Assert(actions["confirm"].Count == 4, "a windowed host keeps all of its mappings");
    }

    private static void ReleasesEveryInspectedAction()
    {
        var actions = SampleActions();
        actions["cancel"] = [new(typeof(InputEventKey))];
        var released = new List<string>();

        var removed = HeadlessJoypadInputMapIsolation.RemoveMatchingBindings(
            isHeadlessClient: true,
            actions.Keys,
            action => actions[action],
            binding => HeadlessJoypadInputMapIsolation.IsJoypadEventType(binding.EventType),
            (action, binding) => actions[action].Remove(binding),
            released.Add);

        Assert(removed == 2, "removal still examines every action before release");
        Assert(released.SequenceEqual(new[] { "confirm", "cancel" }),
            "the release callback runs once for every inspected action, including an action with no joypad binding");
    }

    private static Dictionary<string, List<Binding>> SampleActions() => new()
    {
        ["confirm"] =
        [
            new(typeof(InputEventKey)),
            new(typeof(InputEventMouseButton)),
            new(typeof(InputEventJoypadButton)),
            new(typeof(InputEventJoypadMotion))
        ]
    };

    private static int Remove(Dictionary<string, List<Binding>> actions, bool isHeadlessClient)
    {
        return HeadlessJoypadInputMapIsolation.RemoveMatchingBindings(
            isHeadlessClient,
            actions.Keys,
            action => actions[action],
            binding => HeadlessJoypadInputMapIsolation.IsJoypadEventType(binding.EventType),
            (action, binding) => actions[action].Remove(binding));
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"HeadlessJoypadInputMapIsolationTests failed: {label}.");
        }
    }
}
