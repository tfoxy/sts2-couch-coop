using Godot;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Removes controller bindings from a spawned headless seat's input map.
/// A seat has no local player, so leaving its joypad actions installed lets a controller connected to the host
/// steer that seat as well. Keyboard and mouse actions remain available for the browser-input bridge.
/// This closes the ENGINE joypad route only. A controller Steam Input reports never goes through the InputMap;
/// <see cref="Patches.SeatSteamControllerIsolationPatch"/> closes that route.
/// </summary>
internal static class HeadlessJoypadInputMapIsolation
{
    /// <summary>
    /// Removes all joypad bindings when this is a headless seat. The generic core keeps the removal semantics
    /// testable without constructing Godot objects outside an engine.
    /// </summary>
    public static int RemoveJoypadBindings()
    {
        return RemoveMatchingBindings(
            isHeadlessClient: true,
            InputMap.GetActions(),
            InputMap.ActionGetEvents,
            IsJoypadEvent,
            InputMap.ActionEraseEvent,
            action => action.Dispose());
    }

    internal static bool IsJoypadEventType(Type eventType)
    {
        return typeof(InputEventJoypadButton).IsAssignableFrom(eventType)
            || typeof(InputEventJoypadMotion).IsAssignableFrom(eventType);
    }

    internal static int RemoveMatchingBindings<TAction, TEvent>(
        bool isHeadlessClient,
        IEnumerable<TAction> actions,
        Func<TAction, IEnumerable<TEvent>> eventsForAction,
        Func<TEvent, bool> shouldRemove,
        Action<TAction, TEvent> remove,
        Action<TAction>? releaseAction = null)
    {
        if (!isHeadlessClient)
        {
            return 0;
        }

        var removed = 0;
        foreach (var action in actions)
        {
            try
            {
                // InputMap's event array must not be mutated while it is being enumerated. The copy also makes a
                // repeated application naturally idempotent: after the first pass, no matching event reaches remove.
                foreach (var inputEvent in eventsForAction(action).ToArray())
                {
                    if (!shouldRemove(inputEvent))
                    {
                        continue;
                    }

                    remove(action, inputEvent);
                    removed++;
                }
            }
            finally
            {
                // GetActions() returns StringName values that own a native handle. Do not release the typed array
                // itself or InputEvents owned by InputMap; only release the action name after its calls are complete.
                releaseAction?.Invoke(action);
            }
        }

        return removed;
    }

    private static bool IsJoypadEvent(InputEvent inputEvent) => IsJoypadEventType(inputEvent.GetType());
}
