using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;

namespace CouchCoop.Mod.Patches;

/// <summary>Invokes a Harmony-patched method through its entry point, outside a JIT-inlinable caller.</summary>
internal static class HostReflectionDispatch
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static TResult Invoke<TResult>(MethodInfo method, object instance, object?[] arguments)
    {
        try
        {
            var result = method.Invoke(instance, arguments);
            // ENet reports a successful start as a nullable error with no value.
            if (result is null && Nullable.GetUnderlyingType(typeof(TResult)) is not null)
                return default!;
            return (TResult)(result ?? throw new InvalidOperationException($"{method.Name} returned null."));
        }
        catch (TargetInvocationException exception) when (exception.InnerException is not null)
        {
            ExceptionDispatchInfo.Capture(exception.InnerException).Throw();
            throw;
        }
    }
}
