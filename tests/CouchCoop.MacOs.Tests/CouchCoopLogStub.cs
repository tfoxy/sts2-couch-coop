namespace CouchCoop.Mod.Session;

// The production seeder is source-linked to keep macOS filesystem tests game-free. Its diagnostic sink is
// deliberately inert here: calling the STS2 logger outside an engine can terminate the process natively.
public static class CouchCoopLog
{
    public static void Error(string message) { }
    public static void Info(string message) { }
    public static void Warn(string message) { }
    public static void Stderr(string message) { }
}
