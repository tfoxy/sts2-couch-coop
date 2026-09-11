using System.Text.Json;
using CouchCoop.Mod.Server;

if (args.Length != 4
    || !long.TryParse(args[1], out var maximum)
    || !long.TryParse(args[2], out var minimum))
{
    Console.Error.WriteLine("usage: CouchCoop.CacheQuota <astc-root> <maximum-bytes> <minimum-bytes> <grant-file>");
    return 2;
}

using var reservation = ManagedCacheQuota.ForAstcRoot(args[0]).TryReserveUpTo(maximum, minimum);
var grantFile = Path.GetFullPath(args[3]);
Directory.CreateDirectory(Path.GetDirectoryName(grantFile)!);
var temporary = grantFile + ".tmp";
File.WriteAllText(temporary, JsonSerializer.Serialize(new { grantedBytes = reservation?.Bytes ?? 0 }));
File.Move(temporary, grantFile, overwrite: true);
Console.WriteLine(JsonSerializer.Serialize(new { grantedBytes = reservation?.Bytes ?? 0 }));
Console.Out.Flush();

if (reservation is null) return 0;

// The parent owns stdin. Normal completion, exception, signal or parent death closes the pipe; disposing the
// reservation then releases the cross-process ledger even when the Godot child did not exit cleanly.
var buffer = new byte[1];
while (await Console.OpenStandardInput().ReadAsync(buffer) != 0) { }
return 0;
