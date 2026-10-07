using System.Diagnostics;
using System.Reflection;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes.Audio;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Audio.Host;

/// <summary>Observes host audio-proxy operations for live lanes and approximate joins.</summary>
internal static class HostAudioHooks
{
    private static readonly object Gate = new();
    private static readonly Harmony Harmony = new("com.couchcoop.audio-host");
    private static bool _installed;
    private static nint _musicProxy;
    private static nint _audioProxy;
    private static int _probing;
    private static int _probeHits;
    private static int _streamDisabled;
    private static Action<HostAudioOp>? _subscriber;

    internal static HostMusicState MusicState { get; } = new();
    internal static bool StreamAvailable => Volatile.Read(ref _streamDisabled) == 0;

    internal static void SetSubscriber(Action<HostAudioOp>? subscriber)
        => Interlocked.Exchange(ref _subscriber, subscriber);

    internal static void Apply()
    {
        if (CouchCoopMod.IsHeadlessClient ||
            string.Equals(System.Environment.GetEnvironmentVariable("COUCHCOOP_AUDIO"), "off", StringComparison.OrdinalIgnoreCase))
            return;

        lock (Gate)
        {
            if (_installed) return;
            _installed = true;
            try
            {
                var helper = ResolveMarshallingHelper()
                    ?? throw new MissingMethodException("Godot audio call marshalling helper was not resolved");
                Patch(AccessTools.Method(typeof(NAudioManager), "_EnterTree"), postfix: nameof(AudioReady));
                Patch(AccessTools.Method(typeof(NRunMusicController), "_Ready"), postfix: nameof(MusicReady));
                Patch(helper, prefix: helper.GetParameters().Length == 3
                    ? nameof(ProxyCall3) : nameof(ProxyCall5));
                ProbeMarshallingHook();
            }
            catch (Exception error)
            {
                DisableStream($"hook setup failed ({error.GetType().Name})");
            }
        }
    }

    private static void Patch(MethodBase? target, string? prefix = null, string? postfix = null)
    {
        if (target is null) throw new MissingMethodException("An audio hook target was not found");
        Harmony.Patch(target,
            prefix: prefix is null ? null : new HarmonyMethod(Local(prefix)),
            postfix: postfix is null ? null : new HarmonyMethod(Local(postfix)));
    }

    private static MethodInfo Local(string name) => typeof(HostAudioHooks).GetMethod(name,
        BindingFlags.NonPublic | BindingFlags.Static) ?? throw new MissingMethodException(nameof(HostAudioHooks), name);

    /// <summary>Resolve the helper from GodotObject.Call's own IL so its generated suffix is never pinned.</summary>
    internal static MethodInfo? ResolveMarshallingHelper()
    {
        var call = AccessTools.Method(typeof(GodotObject), nameof(GodotObject.Call),
            [typeof(StringName), typeof(Variant[])]);
        if (call is null) return null;
        var candidates = PatchProcessor.GetOriginalInstructions(call)
            .Select(instruction => instruction.operand)
            .OfType<MethodInfo>()
            .Where(method => method.DeclaringType?.FullName == "Godot.NativeCalls")
            .Where(method =>
            {
                var parameters = method.GetParameters();
                return parameters.Length switch
                {
                    3 => parameters[0].ParameterType == typeof(nint)
                        && parameters[1].ParameterType == typeof(Godot.NativeInterop.godot_string_name)
                        && parameters[2].ParameterType == typeof(ReadOnlySpan<Variant>),
                    5 => parameters[0].ParameterType == typeof(nint)
                        && parameters[1].ParameterType == typeof(nint)
                        && parameters[2].ParameterType == typeof(Godot.NativeInterop.godot_string_name)
                        && parameters[3].ParameterType == typeof(ReadOnlySpan<Variant>)
                        && parameters[4].ParameterType == typeof(Godot.NativeInterop.godot_string_name),
                    _ => false,
                };
            })
            .Distinct()
            .ToArray();
        return candidates.Length == 1 ? candidates[0] : null;
    }

    private static void AudioReady(Node __instance)
        => Volatile.Write(ref _audioProxy, __instance.GetNodeOrNull(FmodSingletonStub.ProxyNodeName)?.NativeInstance ?? 0);

    private static void MusicReady(Node __instance)
        => Volatile.Write(ref _musicProxy, __instance.GetNodeOrNull(FmodSingletonStub.ProxyNodeName)?.NativeInstance ?? 0);

    // A normal music refresh may have no proxy operation. Probe the native-call detour directly instead of
    // treating a no-op refresh as a broken hook and permanently disabling every stream lane.
    private static void ProbeMarshallingHook()
    {
        Volatile.Write(ref _probeHits, 0);
        Volatile.Write(ref _probing, 1);
        try
        {
            using var probe = new Node();
            using var result = probe.Call("get_name");
        }
        finally { Volatile.Write(ref _probing, 0); }
        if (Volatile.Read(ref _probeHits) == 0)
            throw new InvalidOperationException("Godot audio call marshalling hook did not observe its probe");
    }

    // Two pointer comparisons and an early return for the non-audio calls made throughout the process.
    private static void ProxyCall3(nint __0, Godot.NativeInterop.godot_string_name __1, ReadOnlySpan<Variant> __2)
        => OnProxyCall(__0, in __1, __2);

    private static void ProxyCall5(nint __1, Godot.NativeInterop.godot_string_name __2, ReadOnlySpan<Variant> __3)
        => OnProxyCall(__1, in __2, __3);

    private static void OnProxyCall(nint ptr, in Godot.NativeInterop.godot_string_name methodName, ReadOnlySpan<Variant> args)
    {
        if (Volatile.Read(ref _probing) != 0) Interlocked.Increment(ref _probeHits);
        var music = ptr == Volatile.Read(ref _musicProxy);
        if ((!music && ptr != Volatile.Read(ref _audioProxy)) || ptr == 0) return;

        try
        {
            using var method = Variant.CreateTakingOwnershipOfDisposableValue(
                Godot.NativeInterop.VariantUtils.CreateFromStringName(in methodName));
            var name = method.AsString();
            var ticks = Stopwatch.GetTimestamp();
            var timeUs = ticks / Stopwatch.Frequency * 1_000_000L
                + ticks % Stopwatch.Frequency * 1_000_000L / Stopwatch.Frequency;
            foreach (var operation in ProxyOpTable.Translate(music, name, args, timeUs))
            {
                MusicState.Apply(operation);
                Volatile.Read(ref _subscriber)?.Invoke(operation);
            }
        }
        catch (Exception error)
        {
            DisableStream($"proxy operation failed ({error.GetType().Name})");
        }
    }

    private static void DisableStream(string reason)
    {
        if (Interlocked.Exchange(ref _streamDisabled, 1) == 0)
            CouchCoopLog.Warn("[audio] music, ambience and loops disabled: " + reason);
    }
}
