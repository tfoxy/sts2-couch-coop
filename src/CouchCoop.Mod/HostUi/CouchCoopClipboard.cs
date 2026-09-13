namespace CouchCoop.Mod.HostUi;

/// <summary>Copies text and verifies the platform clipboard accepted the exact value.</summary>
public static class CouchCoopClipboard
{
    public static bool TryCopy(string text, Action<string> write, Func<string?> read)
    {
        if (text is null || write is null || read is null) return false;
        try
        {
            write(text);
            return string.Equals(read(), text, StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }
}
