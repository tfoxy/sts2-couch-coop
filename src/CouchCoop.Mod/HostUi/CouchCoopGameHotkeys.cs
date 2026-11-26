using System.Reflection;
using CouchCoop.Mod.Session;
using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>Optional hotkey bindings across the supported game API shapes.</summary>
internal sealed class CouchCoopGameHotkeys
{
    internal static readonly CouchCoopGameHotkeys Shared = new(
        () => Type.GetType("MegaCrit.Sts2.Core.Nodes.CommonUi.NHotkeyManager, sts2"),
        message =>
        {
            if (CouchCoopMod.EngineAvailable) CouchCoopLog.Warn(message);
            else CouchCoopLog.Stderr(message);
        });

    private sealed record Bindings(PropertyInfo Instance, MethodInfo Push, MethodInfo Remove, bool HasOwner, long DefaultSequence);

    private readonly Lazy<Bindings?> _bindings;
    private readonly Action<string> _log;
    private int _reported;

    internal CouchCoopGameHotkeys(Func<Type?> managerType, Action<string> log)
    {
        _log = log;
        _bindings = new Lazy<Bindings?>(() => Resolve(managerType));
    }

    // Resolves metadata only; the compatibility gate must not read a Godot singleton.
    internal bool IsAvailable => _bindings.Value is not null;

    internal bool TryPush(string action, Node owner, Action callback, long? sequence = null)
        => Invoke(push: true, action, owner, callback, sequence);

    internal bool TryRemove(string action, Node owner, Action callback)
        => Invoke(push: false, action, owner, callback, 0);

    private Bindings? Resolve(Func<Type?> managerType)
    {
        try
        {
            var type = managerType();
            var instance = type?.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy);
            if (type is not null && instance?.GetMethod is { IsStatic: true }
                && type.IsAssignableFrom(instance.PropertyType))
            {
                foreach (var hasOwner in new[] { true, false })
                {
                    Type[] pushArgs = hasOwner
                        ? [typeof(string), typeof(Node), typeof(Action), typeof(long)]
                        : [typeof(string), typeof(Action), typeof(long)];
                    Type[] removeArgs = hasOwner
                        ? [typeof(string), typeof(Node), typeof(Action)]
                        : [typeof(string), typeof(Action)];
                    var push = type.GetMethod("PushHotkeyPressedBinding", pushArgs);
                    var remove = type.GetMethod("RemoveHotkeyPressedBinding", removeArgs);
                    if (push is { IsStatic: false, ContainsGenericParameters: false } && push.ReturnType == typeof(void)
                        && remove is { IsStatic: false, ContainsGenericParameters: false }
                        && (remove.ReturnType == typeof(void) || remove.ReturnType == typeof(long)))
                        return new Bindings(instance, push, remove, hasOwner,
                            push.GetParameters()[^1].DefaultValue is long sequence ? sequence : 0);
                }
            }

            Report("no supported binding shape");
        }
        catch (Exception exception)
        {
            Report(exception);
        }
        return null;
    }

    private bool Invoke(bool push, string action, Node owner, Action callback, long? sequence)
    {
        try
        {
            if (_bindings.Value is not { } bindings || bindings.Instance.GetValue(null) is not { } manager)
                return false;

            object?[] args = push
                ? bindings.HasOwner ? [action, owner, callback, sequence ?? bindings.DefaultSequence]
                    : [action, callback, sequence ?? bindings.DefaultSequence]
                : bindings.HasOwner ? [action, owner, callback] : [action, callback];
            (push ? bindings.Push : bindings.Remove).Invoke(manager, args);
            return true;
        }
        catch (Exception exception)
        {
            Report(exception);
            return false;
        }
    }

    private void Report(Exception exception)
    {
        if (exception is TargetInvocationException { InnerException: { } inner }) exception = inner;
        Report($"{exception.GetType().Name}: {exception.Message}");
    }

    private void Report(string reason)
    {
        if (Interlocked.Exchange(ref _reported, 1) == 0)
            _log($"feature-disabled name=game-hotkeys reason={reason}");
    }
}
