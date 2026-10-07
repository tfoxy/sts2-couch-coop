using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.Audio.Takes;

/// <summary>Short SFX only. Disk admission is optional; a denied write keeps the in-memory take usable.</summary>
internal sealed class TakeCache
{
    internal const long DefaultMemoryLimit = 64L * 1024 * 1024;
    private readonly object gate = new();
    private readonly Dictionary<string, (byte[] Wav, LinkedListNode<string> Node)> entries = new(StringComparer.Ordinal);
    private readonly LinkedList<string> order = new();
    private readonly string? root;
    private readonly ManagedCacheQuota? quota;
    private readonly long limit;
    private long bytes;

    internal TakeCache(string? versionRoot, ManagedCacheQuota? quota, long memoryLimit = DefaultMemoryLimit)
    {
        root = versionRoot is null ? null : Path.Combine(versionRoot, "audio");
        this.quota = quota;
        limit = memoryLimit;
    }

    internal long MemoryBytes { get { lock (gate) return bytes; } }
    internal int MemoryCount { get { lock (gate) return entries.Count; } }

    internal byte[]? Get(string bankset, string keyId)
    {
        if (!Valid(bankset, keyId)) return null;
        string id = bankset + "/" + keyId;
        lock (gate)
        {
            if (entries.TryGetValue(id, out var found))
            {
                order.Remove(found.Node); order.AddFirst(found.Node);
                return found.Wav;
            }
        }
        string? path = FilePath(bankset, keyId);
        if (path is null) return null;
        try
        {
            var file = new FileInfo(path);
            if (!file.Exists || file.Length is < 44 or > 20_000_000) return null;
            byte[] wav = File.ReadAllBytes(path);
            if (!wav.AsSpan(0, 4).SequenceEqual("RIFF"u8)) return null;
            Remember(id, wav);
            return wav;
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    internal void Put(string bankset, string keyId, byte[] wav)
    {
        if (!Valid(bankset, keyId) || wav.Length < 44 || !wav.AsSpan(0, 4).SequenceEqual("RIFF"u8))
            throw new ArgumentException("Invalid audio take");
        string id = bankset + "/" + keyId;
        Remember(id, wav);
        string? path = FilePath(bankset, keyId);
        if (path is null || quota is null) return;
        using var admission = quota.TryReserve(wav.Length);
        if (admission is null) return;
        string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(temp, wav);
            File.Move(temp, path, overwrite: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        finally { try { File.Delete(temp); } catch (IOException) { } }
    }

    internal IReadOnlyList<string> ReadyIds(string bankset)
    {
        if (!ValidId(bankset)) return [];
        var ids = new HashSet<string>(StringComparer.Ordinal);
        lock (gate)
            foreach (string key in entries.Keys)
                if (key.StartsWith(bankset + "/", StringComparison.Ordinal)) ids.Add(key[(bankset.Length + 1)..]);
        string? directory = root is null ? null : Path.Combine(root, "1", bankset);
        if (directory is not null && Directory.Exists(directory))
            foreach (string file in Directory.EnumerateFiles(directory, "*.wav").Take(4096))
            {
                string id = Path.GetFileNameWithoutExtension(file);
                if (ValidId(id)) ids.Add(id);
            }
        return ids.Order(StringComparer.Ordinal).Take(4096).ToArray();
    }

    private void Remember(string id, byte[] wav)
    {
        if (wav.Length > limit) return;
        lock (gate)
        {
            if (entries.Remove(id, out var old)) { order.Remove(old.Node); bytes -= old.Wav.Length; }
            var node = order.AddFirst(id);
            entries[id] = (wav, node); bytes += wav.Length;
            while (bytes > limit && order.Last is { } tail)
            {
                order.RemoveLast();
                var removed = entries[tail.Value];
                entries.Remove(tail.Value); bytes -= removed.Wav.Length;
            }
        }
    }

    private string? FilePath(string bankset, string keyId) => root is null ? null : Path.Combine(root, "1", bankset, keyId + ".wav");
    private static bool Valid(string bankset, string keyId) => ValidId(bankset) && ValidId(keyId);
    private static bool ValidId(string value) => value.Length == 32 && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
}
