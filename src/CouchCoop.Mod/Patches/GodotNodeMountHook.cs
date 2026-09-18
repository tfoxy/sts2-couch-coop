using System.Collections.Concurrent;
using System.Reflection;
using CouchCoop.Mod.HostUi;
using Godot;
using HarmonyLib;

namespace CouchCoop.Mod.Patches;

/// <summary>One bounded reason why a mount target could not be installed.</summary>
internal readonly record struct GodotNodeMountFailure(
    GodotNodeMountTarget Target,
    GodotNodeMountFailureKind Kind,
    string? Detail = null);

internal enum GodotNodeMountFailureKind
{
    TypeNotFound,
    MethodNotFound,
    MethodNotDeclared,
    MethodHasParameters,
    PatchFailed,
}

/// <summary>
/// Installs one shared Harmony postfix over a small set of declared Godot node lifecycle methods.
/// </summary>
/// <remarks>
/// Target resolution is deliberately declaration-only. Falling back to an inherited lifecycle method would turn
/// a narrow screen mount into a hook on every Godot node in the process. The retry/idempotence state is the same
/// <see cref="LobbyScreenMountPlan"/> used by the production adapter: a failed target remains pending, while a
/// successful target is never patched a second time.
/// </remarks>
internal sealed class GodotNodeMountHook
{
    private const int MaxDiagnosticLength = 480;
    private static readonly ConcurrentDictionary<MethodBase, CallbackRegistration> Callbacks = new();
    private static readonly MethodInfo SharedPostfix = typeof(GodotNodeMountHook).GetMethod(
        nameof(ReadyPostfix), BindingFlags.NonPublic | BindingFlags.Static)
        ?? throw new MissingMethodException(typeof(GodotNodeMountHook).FullName, nameof(ReadyPostfix));

    private readonly object _sync = new();
    private readonly Harmony _harmony;
    private readonly IReadOnlyDictionary<string, GodotNodeMountTarget> _targets;
    private readonly LobbyScreenMountPlan _plan;
    private readonly Action<Node> _callback;
    private readonly Action<GodotNodeMountFailure>? _patchFailure;
    private readonly Action<Exception>? _callbackFailure;

    internal GodotNodeMountHook(
        string harmonyOwnerId,
        IEnumerable<GodotNodeMountTarget> targets,
        Action<Node> callback,
        Action<GodotNodeMountFailure>? patchFailure = null,
        Action<Exception>? callbackFailure = null)
    {
        ArgumentNullException.ThrowIfNull(targets);
        ArgumentNullException.ThrowIfNull(callback);
        if (string.IsNullOrWhiteSpace(harmonyOwnerId))
        {
            throw new ArgumentException("A Harmony owner ID is required.", nameof(harmonyOwnerId));
        }

        var targetArray = targets.ToArray();
        if (targetArray.Length == 0 || targetArray.Any(target => string.IsNullOrWhiteSpace(target.TypeName)
            || string.IsNullOrWhiteSpace(target.MethodName)))
        {
            throw new ArgumentException("Mount targets must have full type and method names.", nameof(targets));
        }

        _targets = targetArray.ToDictionary(target => target.Key, StringComparer.Ordinal);
        if (_targets.Count != targetArray.Length)
        {
            throw new ArgumentException("Mount targets must be unique.", nameof(targets));
        }

        _plan = new LobbyScreenMountPlan(_targets.Keys);
        _harmony = new Harmony(harmonyOwnerId);
        _callback = callback;
        _patchFailure = patchFailure;
        _callbackFailure = callbackFailure;
    }

    internal int TargetCount => _plan.TargetCount;
    internal IReadOnlyList<string> Pending => _plan.Pending;
    internal bool IsComplete => _plan.IsComplete;

    /// <summary>Attempts only the targets still pending. A complete hook is inert.</summary>
    internal bool Apply()
    {
        lock (_sync)
        {
            if (_plan.IsComplete)
            {
                return true;
            }

            return _plan.Attempt(key => TryPatch(_targets[key]));
        }
    }

    internal static MethodInfo? ResolveDeclaredZeroArgumentMethod(
        GodotNodeMountTarget target,
        Action<GodotNodeMountFailure>? failure = null)
    {
        var type = AccessTools.TypeByName(target.TypeName);
        if (type is null)
        {
            failure?.Invoke(new(target, GodotNodeMountFailureKind.TypeNotFound));
            return null;
        }

        var methods = type.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public
            | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
            .Where(method => string.Equals(method.Name, target.MethodName, StringComparison.Ordinal))
            .ToArray();
        if (methods.Length == 0)
        {
            var inherited = AccessTools.Method(type, target.MethodName);
            failure?.Invoke(new(target, inherited is null
                ? GodotNodeMountFailureKind.MethodNotFound
                : GodotNodeMountFailureKind.MethodNotDeclared,
                inherited?.DeclaringType?.FullName));
            return null;
        }

        var zeroArgument = methods.FirstOrDefault(method => method.GetParameters().Length == 0);
        if (zeroArgument is null)
        {
            failure?.Invoke(new(target, GodotNodeMountFailureKind.MethodHasParameters));
        }

        return zeroArgument;
    }

    private bool TryPatch(GodotNodeMountTarget target)
    {
        var method = ResolveDeclaredZeroArgumentMethod(target, _patchFailure);
        if (method is null)
        {
            return false;
        }

        try
        {
            Callbacks[method] = new CallbackRegistration(_callback, _callbackFailure);
            _harmony.Patch(method, postfix: new HarmonyMethod(SharedPostfix));
            return true;
        }
        catch (Exception exception)
        {
            Callbacks.TryRemove(method, out _);
            _patchFailure?.Invoke(new(target, GodotNodeMountFailureKind.PatchFailed, Describe(exception)));
            return false;
        }
    }

    // Harmony supplies the exact target method, which makes this one static postfix safe for all hook instances.
    private static void ReadyPostfix(Node __instance, MethodBase __originalMethod)
    {
        if (Callbacks.TryGetValue(__originalMethod, out var callback))
        {
            callback.Invoke(__instance);
        }
    }

    private static string Describe(Exception exception)
    {
        var message = $"{exception.GetType().Name}: {exception.Message}";
        return message.Length <= MaxDiagnosticLength ? message : message[..MaxDiagnosticLength];
    }

    private readonly record struct CallbackRegistration(Action<Node> Callback, Action<Exception>? Failure)
    {
        internal void Invoke(Node instance)
        {
            try
            {
                Callback(instance);
            }
            catch (Exception exception)
            {
                try { Failure?.Invoke(exception); }
                catch { }
            }
        }
    }
}
