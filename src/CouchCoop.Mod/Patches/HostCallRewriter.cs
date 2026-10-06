using System.Reflection;
using System.Reflection.Emit;
using HarmonyLib;

namespace CouchCoop.Mod.Patches;

/// <summary>Replaces one host-start call while retaining its Harmony labels and exception blocks.</summary>
internal static class HostCallRewriter
{
    internal static IEnumerable<CodeInstruction> ReplaceExactlyOne(
        IEnumerable<CodeInstruction> instructions, MethodInfo originalCall, MethodInfo dispatch)
    {
        var rewritten = instructions.ToList();
        var calls = rewritten.Where(instruction => instruction.Calls(originalCall)).ToArray();
        if (calls.Length != 1)
        {
            throw new InvalidOperationException($"expected exactly one {originalCall.Name} call, found {calls.Length}");
        }

        // Mutating the existing instruction retains branch labels and exception blocks on the replaced call.
        calls[0].opcode = OpCodes.Call;
        calls[0].operand = dispatch;
        return rewritten;
    }
}
