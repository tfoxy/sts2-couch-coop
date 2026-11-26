using CouchCoop.Mod.HostUi;
using Godot;

internal static class CouchCoopGameHotkeysTests
{
    public static void Run()
    {
        LegacyBindings();
        OwnerBindings();
        MissingShapeLogsOnce();
        ResolutionFailureIsOptional();
        InvocationFailureIsOptional();
        SingletonFailureIsOptional();
        MissingSingletonCanRecover();
        ResolutionIsCached();
        IncompleteShapesAreRefused();
        Console.WriteLine("CouchCoopGameHotkeysTests: 9 cases passed");
    }

    public static void TargetsResolve()
    {
        Expect(CouchCoopGameHotkeys.Shared.IsAvailable, "the installed game's hotkey API has a supported shape");
    }

    private static void LegacyBindings()
    {
        var manager = LegacyManager.Instance = new();
        var hotkeys = new CouchCoopGameHotkeys(() => typeof(LegacyManager), UnexpectedLog);
        Action callback = () => { };
        Expect(hotkeys.TryPush("test", null!, callback, 42), "legacy push succeeds");
        Expect(manager.Action == "test" && manager.Callback == callback && manager.Priority == 42,
            "legacy push forwards action, callback and priority");
        Expect(hotkeys.TryRemove("test", null!, callback) && manager.Removed, "legacy remove succeeds");
    }

    private static void OwnerBindings()
    {
        var manager = OwnerManager.Instance = new();
        var hotkeys = new CouchCoopGameHotkeys(() => typeof(OwnerManager), UnexpectedLog);
        Action callback = () => { };
        // A real Node requires the engine. Null still exercises the owner overload and its argument positions.
        Expect(hotkeys.TryPush("owned", null!, callback), "owner push succeeds");
        Expect(manager.Action == "owned" && manager.Callback == callback && manager.Priority == -1,
            "owner push forwards callback and default priority in the correct positions");
        Expect(hotkeys.TryRemove("owned", null!, callback) && manager.Removed, "owner remove succeeds");
    }

    private static void MissingShapeLogsOnce()
    {
        var logs = new List<string>();
        var hotkeys = new CouchCoopGameHotkeys(() => null, logs.Add);
        for (var i = 0; i < 3; i++)
        {
            Expect(!hotkeys.TryPush("test", null!, () => { }), "missing push is optional");
            Expect(!hotkeys.TryRemove("test", null!, () => { }), "missing remove is optional");
        }
        Expect(logs.Count == 1 && logs[0].Contains("feature-disabled name=game-hotkeys"), "one actionable diagnostic");
    }

    private static void ResolutionFailureIsOptional()
    {
        var logs = new List<string>();
        var hotkeys = new CouchCoopGameHotkeys(() => throw new TypeLoadException("test type"), logs.Add);
        Expect(!hotkeys.IsAvailable && !hotkeys.TryPush("test", null!, () => { }), "type failure stays optional");
        Expect(logs.Count == 1 && logs[0].Contains("TypeLoadException: test type"), "resolution failure is logged once");
    }

    private static void InvocationFailureIsOptional()
    {
        var logs = new List<string>();
        LegacyManager.Instance = new() { Throw = true };
        var hotkeys = new CouchCoopGameHotkeys(() => typeof(LegacyManager), logs.Add);
        Expect(!hotkeys.TryPush("test", null!, () => { }), "throwing push stays optional");
        Expect(!hotkeys.TryRemove("test", null!, () => { }), "throwing remove stays optional");
        Expect(logs.Count == 1 && logs[0].Contains("MissingMethodException: test binding"),
            "the underlying invocation error is logged once");
    }

    private static void SingletonFailureIsOptional()
    {
        var logs = new List<string>();
        var hotkeys = new CouchCoopGameHotkeys(() => typeof(ThrowingSingleton), logs.Add);
        Expect(hotkeys.IsAvailable, "metadata resolution does not read the singleton");
        Expect(!hotkeys.TryPush("test", null!, () => { }) && !hotkeys.TryRemove("test", null!, () => { }),
            "throwing singleton stays optional for binding and cleanup");
        Expect(logs.Count == 1 && logs[0].Contains("MissingFieldException: test singleton"), "singleton error is logged once");
    }

    private static void MissingSingletonCanRecover()
    {
        LegacyManager.Instance = null;
        var hotkeys = new CouchCoopGameHotkeys(() => typeof(LegacyManager), UnexpectedLog);
        Expect(!hotkeys.TryPush("test", null!, () => { }), "an absent singleton is not a successful bind");
        LegacyManager.Instance = new();
        Expect(hotkeys.TryPush("test", null!, () => { }), "binding works when the singleton becomes available");
    }

    private static void ResolutionIsCached()
    {
        var count = 0;
        LegacyManager.Instance = new();
        var hotkeys = new CouchCoopGameHotkeys(() => { count++; return typeof(LegacyManager); }, UnexpectedLog);
        Expect(hotkeys.IsAvailable, "metadata resolves");
        hotkeys.TryPush("test", null!, () => { });
        hotkeys.TryRemove("test", null!, () => { });
        Expect(count == 1, "binding metadata is resolved once");
    }

    private static void IncompleteShapesAreRefused()
    {
        var logs = new List<string>();
        var hotkeys = new CouchCoopGameHotkeys(() => typeof(PushOnlyManager), logs.Add);
        Expect(!hotkeys.IsAvailable && logs.Count == 1, "a push without a matching remove is refused");
    }

    public class LegacyManager
    {
        public static LegacyManager? Instance { get; set; }
        public string? Action { get; private set; }
        public Action? Callback { get; private set; }
        public long Priority { get; private set; }
        public bool Removed { get; private set; }
        public bool Throw { get; init; }

        public void PushHotkeyPressedBinding(string action, Action callback, long priority)
        {
            if (Throw) throw new MissingMethodException("test binding");
            (Action, Callback, Priority) = (action, callback, priority);
        }

        public void RemoveHotkeyPressedBinding(string action, Action callback)
        {
            if (Throw) throw new MissingMethodException("test binding");
            Removed = Action == action && Callback == callback;
        }
    }

    public sealed class OwnerManager
    {
        public static OwnerManager Instance { get; set; } = new();
        public string? Action { get; private set; }
        public Action? Callback { get; private set; }
        public long Priority { get; private set; }
        public bool Removed { get; private set; }

        public void PushHotkeyPressedBinding(string action, Node owner, Action callback, long priority = -1)
            => (Action, Callback, Priority) = (action, callback, priority);
        public long RemoveHotkeyPressedBinding(string action, Node owner, Action callback)
        {
            Removed = Action == action && Callback == callback;
            return Priority;
        }
    }

    public sealed class ThrowingSingleton
    {
        public static ThrowingSingleton Instance => throw new MissingFieldException("test singleton");
        public void PushHotkeyPressedBinding(string action, Action callback, long priority) { }
        public void RemoveHotkeyPressedBinding(string action, Action callback) { }
    }

    public sealed class PushOnlyManager
    {
        public static PushOnlyManager Instance { get; } = new();
        public void PushHotkeyPressedBinding(string action, Action callback, long priority) { }
    }

    private static void UnexpectedLog(string message) => throw new Exception($"unexpected hotkey log: {message}");

    private static void Expect(bool condition, string label)
    {
        if (!condition) throw new Exception($"[CouchCoopGameHotkeysTests] FAILED: {label}");
    }
}
