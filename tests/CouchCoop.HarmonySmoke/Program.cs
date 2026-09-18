using CouchCoop.Mod.Patches;

var result = CouchCoopHarmonyProbe.Run();
if (!result.Succeeded)
{
    Console.Error.WriteLine($"harmony smoke failed: {result.Error ?? "unknown"}");
    return 1;
}

Console.WriteLine("harmony smoke: ok");
return 0;
