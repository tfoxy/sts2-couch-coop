using System.Reflection;
using System.Runtime.CompilerServices;
using CouchCoop.Mod.Patches;
using HarmonyLib;

internal static class HostReflectionDispatchTests
{
    private static int _limitCalls;
    private static int _transportCalls;
    private static int _enetCalls;

    internal static void Run()
    {
        var target = typeof(Fixture).GetMethod(nameof(Fixture.Start))!;
        var caller = typeof(Fixture).GetMethod(nameof(Fixture.Caller))!;
        var limit = typeof(HostReflectionDispatchTests).GetMethod(nameof(RaiseCap), BindingFlags.NonPublic | BindingFlags.Static)!;
        var transport = typeof(HostReflectionDispatchTests).GetMethod(nameof(ReplaceHost), BindingFlags.NonPublic | BindingFlags.Static)!;
        var transpiler = typeof(HostReflectionDispatchTests).GetMethod(nameof(TranspileCaller), BindingFlags.NonPublic | BindingFlags.Static)!;
        var harmony = new Harmony("com.couchcoop.tests.host-reflection-dispatch");
        _limitCalls = _transportCalls = 0;

        harmony.Patch(target, prefix: new HarmonyMethod(limit, Priority.Normal));
        harmony.Patch(target, prefix: new HarmonyMethod(transport, Priority.Last));
        harmony.Patch(caller, transpiler: new HarmonyMethod(transpiler));
        var enet = typeof(Fixture).GetMethod(nameof(Fixture.StartEnet))!;
        harmony.Patch(enet, postfix: new HarmonyMethod(typeof(HostReflectionDispatchTests)
            .GetMethod(nameof(ObserveEnet), BindingFlags.NonPublic | BindingFlags.Static)!));
        try
        {
            _enetCalls = 0;
            Assert(HostReflectionDispatch.Invoke<int?>(enet, new Fixture(), [false]) is null,
                "successful ENet-style nullable result stays null");
            Assert(HostReflectionDispatch.Invoke<int?>(enet, new Fixture(), [true]) == 7,
                "failed ENet-style result is preserved");
            Assert(_enetCalls == 2, "reflection dispatch observes both ENet postfix calls");
            var task = new Fixture().Caller(4);
            Assert(task.GetAwaiter().GetResult() == 12,
                "rewritten caller returns the replacing prefix's task with the adjusted cap");
            Assert(_limitCalls == 1 && _transportCalls == 1,
                "rewritten caller enters both installed Harmony prefixes once under normal JIT settings");
        }
        finally
        {
            harmony.UnpatchAll(harmony.Id);
        }
    }

    private static IEnumerable<CodeInstruction> TranspileCaller(IEnumerable<CodeInstruction> instructions)
        => HostCallRewriter.ReplaceExactlyOne(
            instructions,
            typeof(Fixture).GetMethod(nameof(Fixture.Start))!,
            typeof(HostReflectionDispatchTests).GetMethod(nameof(Dispatch), BindingFlags.NonPublic | BindingFlags.Static)!);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static Task<int> Dispatch(Fixture fixture, int cap)
        => HostReflectionDispatch.Invoke<Task<int>>(typeof(Fixture).GetMethod(nameof(Fixture.Start))!, fixture, [cap]);

    private static void ObserveEnet() => _enetCalls++;

    private static void RaiseCap(ref int cap)
    {
        _limitCalls++;
        cap = 12;
    }

    private static bool ReplaceHost(int cap, ref Task<int> __result)
    {
        _transportCalls++;
        __result = Task.FromResult(cap);
        return false;
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"host reflection dispatch: {message}");
    }

    private sealed class Fixture
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        public Task<int> Start(int cap) => Task.FromResult(cap);

        [MethodImpl(MethodImplOptions.NoInlining)]
        public int? StartEnet(bool fail) => fail ? 7 : null;

        [MethodImpl(MethodImplOptions.NoInlining)]
        public Task<int> Caller(int cap) => Start(cap);
    }
}
