using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CouchCoop.Mod.Server;

/// <summary>Cross-process admission for generated files; existing cache entries are never evicted.</summary>
internal sealed class ManagedCacheQuota
{
    public const long DefaultCeilingBytes = 4L * 1024 * 1024 * 1024;
    public const long DefaultFreeSpaceReserveBytes = 2L * 1024 * 1024 * 1024;
    public const long DefaultEntryLimitBytes = 128L * 1024 * 1024;
    private static readonly ConcurrentDictionary<string, Mutex> Mutexes = new(StringComparer.Ordinal);
    private static readonly long ProcessStarted = ReadProcessStart(Environment.ProcessId);
    private static long _lastDiagnostic;
    private readonly string _coordinationRoot;
    private readonly string[] _managedRoots;
    private readonly string _statePath;
    private readonly long _ceilingBytes;
    private readonly long _freeSpaceReserveBytes;
    private readonly long _entryLimitBytes;
    private readonly long _allocationUnitBytes;
    private readonly TimeSpan _reconcileInterval;
    private readonly Func<string, long> _freeSpace;
    private readonly Mutex _mutex;

    internal ManagedCacheQuota(string coordinationRoot, IReadOnlyList<string>? managedRoots = null,
        long ceilingBytes = DefaultCeilingBytes, long freeSpaceReserveBytes = DefaultFreeSpaceReserveBytes,
        long entryLimitBytes = DefaultEntryLimitBytes, Func<string, long>? freeSpace = null,
        long allocationUnitBytes = 4096, TimeSpan? reconcileInterval = null)
    {
        if (ceilingBytes < 0 || freeSpaceReserveBytes < 0 || entryLimitBytes < 0 || allocationUnitBytes < 1)
            throw new ArgumentOutOfRangeException(nameof(ceilingBytes));
        _coordinationRoot = ResolvedFilePath.Resolve(coordinationRoot);
        _managedRoots = (managedRoots ?? [_coordinationRoot]).Select(ResolvedFilePath.Resolve).Distinct(PathComparer).ToArray();
        _ceilingBytes = ceilingBytes;
        _freeSpaceReserveBytes = freeSpaceReserveBytes;
        _entryLimitBytes = entryLimitBytes;
        _allocationUnitBytes = allocationUnitBytes;
        _reconcileInterval = reconcileInterval ?? TimeSpan.FromSeconds(30);
        _freeSpace = freeSpace ?? AvailableFreeSpace;
        _statePath = Path.Combine(_coordinationRoot, ".cache-budget", "state.json");
        var key = OperatingSystem.IsWindows() ? _coordinationRoot.ToUpperInvariant() : _coordinationRoot;
        var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
        _mutex = Mutexes.GetOrAdd(identity, id => new Mutex(false, "couchcoop-cache-quota-" + id));
    }

    internal string CoordinationRoot => _coordinationRoot;
    public long EntryLimitBytes => _entryLimitBytes;
    private static StringComparer PathComparer => OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    public static ManagedCacheQuota ForAssetRoot(string root) => ForCacheRoot(root);
    public static ManagedCacheQuota ForAstcRoot(string root) => ForCacheRoot(root);

    private static ManagedCacheQuota ForCacheRoot(string root)
    {
        // Headless profiles link individual cache directories, not their parent. Resolve the leaf first.
        var full = ResolvedFilePath.Resolve(root);
        if (new[] { "assets", "astc-cache", "resource-cache" }.Contains(Path.GetFileName(full), PathComparer))
        {
            var parent = Path.GetDirectoryName(full)!;
            return new ManagedCacheQuota(parent,
                [Path.Combine(parent, "assets"), Path.Combine(parent, "astc-cache"), Path.Combine(parent, "resource-cache")]);
        }
        return new ManagedCacheQuota(full, [full]);
    }

    public Reservation? TryReserve(long bytes, bool enforceEntryLimit = true)
        => Reserve(bytes, bytes, enforceEntryLimit);

    public Reservation? TryReserveUpTo(long maximumBytes, long minimumBytes = 1)
        => Reserve(maximumBytes, minimumBytes, enforceEntryLimit: false);

    private Reservation? Reserve(long maximum, long minimum, bool enforceEntryLimit)
    {
        if (minimum < 0 || maximum < minimum || (enforceEntryLimit && maximum > _entryLimitBytes)) return null;
        var locked = false;
        try
        {
            locked = Enter();
            if (!locked) return Denied();
            var state = LoadAndReconcile();
            var reserved = state.Reservations.Values.Sum(x => x.ChargedBytes);
            var space = _freeSpace(_coordinationRoot);
            var available = Math.Min(checked(_ceilingBytes - state.UsedBytes - reserved),
                checked(space - _freeSpaceReserveBytes - reserved));
            // Metadata and allocation slack are included before any data or temporary file is created.
            var granted = Math.Min(maximum, Math.Max(0, available - MetadataAllowance));
            granted = Math.Min(granted, Math.Max(0, available / _allocationUnitBytes * _allocationUnitBytes - MetadataAllowance));
            if (granted < minimum || (granted == 0 && maximum != 0)) return Denied();
            var charged = checked(Round(granted) + MetadataAllowance);
            if (charged > available) return Denied();
            var id = Guid.NewGuid().ToString("N");
            state.Reservations.Add(id, new ReservationRecord(Environment.ProcessId, ProcessStarted, granted, charged));
            Save(state);
            return new Reservation(this, id, granted);
        }
        catch (Exception e) when (IsAccountingFailure(e)) { return Denied(); }
        finally { if (locked) _mutex.ReleaseMutex(); }
    }

    private long MetadataAllowance => _allocationUnitBytes == 1 ? 0 : 2 * _allocationUnitBytes;
    private long Round(long bytes) => checked((bytes + _allocationUnitBytes - 1) / _allocationUnitBytes * _allocationUnitBytes);

    private UsageState LoadAndReconcile()
    {
        var state = File.Exists(_statePath)
            ? JsonSerializer.Deserialize<UsageState>(File.ReadAllText(_statePath)) ?? throw new IOException("Invalid cache accounting state.")
            : new UsageState();
        if (state.UsedBytes < 0 || state.ScannedAt < 0 || state.ScannedAt > DateTime.UtcNow.Ticks
            || state.Reservations.Values.Any(x => x.ChargedBytes < 0 || x.Bytes < 0))
            throw new IOException("Invalid cache accounting totals.");
        var roots = state.ManagedRoots.Concat(_managedRoots).Distinct(PathComparer).OrderBy(x => x, PathComparer).ToArray();
        var dead = state.Reservations.Where(x => ReadProcessStart(x.Value.Pid) != x.Value.Started).Select(x => x.Key).ToArray();
        var now = DateTime.UtcNow.Ticks;
        if (dead.Length > 0 || !roots.SequenceEqual(state.ManagedRoots, PathComparer)
            || now - state.ScannedAt >= _reconcileInterval.Ticks)
        {
            // Reconcile before reclaiming crashed writers: they may have left staged or completed files.
            state.UsedBytes = MeasureManagedBytes(roots);
            state.ManagedRoots = roots;
            state.ScannedAt = now;
            foreach (var id in dead) state.Reservations.Remove(id);
            Save(state);
        }
        return state;
    }

    private long MeasureManagedBytes(string[] roots)
    {
        long total = 0;
        var visited = new HashSet<string>(PathComparer);
        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;
            var pending = new Stack<string>();
            pending.Push(root);
            while (pending.TryPop(out var directory))
            {
                if (!visited.Add(directory)) continue;
                foreach (var path in Directory.EnumerateFileSystemEntries(directory))
                {
                    if (PathComparer.Equals(path, Path.GetDirectoryName(_statePath))) continue;
                    var attributes = File.GetAttributes(path);
                    // Operator links are not managed data. The configured root itself was resolved above.
                    if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                    if ((attributes & FileAttributes.Directory) != 0) pending.Push(path);
                    else total = checked(total + Round(new FileInfo(path).Length));
                }
            }
        }
        return total;
    }

    private void Release(string id)
    {
        var locked = false;
        try
        {
            locked = Enter();
            if (!locked) return; // Keep the reservation charged; a later process census can reclaim it.
            var state = LoadAndReconcile();
            if (!state.Reservations.Remove(id, out var entry)) return;
            // Large staging grants often publish a much smaller artifact. Recount on their release so
            // ordinary geoclip batches don't temporarily consume the ceiling with unused reservations.
            // Small writes retain a conservative upper bound until the periodic census.
            if (entry.ChargedBytes >= 16L * 1024 * 1024 || _reconcileInterval == TimeSpan.Zero)
            {
                state.UsedBytes = MeasureManagedBytes(state.ManagedRoots);
                state.ScannedAt = DateTime.UtcNow.Ticks;
            }
            else state.UsedBytes = checked(state.UsedBytes + entry.ChargedBytes);
            Save(state);
        }
        catch (Exception e) when (IsAccountingFailure(e)) { Denied(); }
        finally { if (locked) _mutex.ReleaseMutex(); }
    }

    private bool Enter()
    {
        try { return _mutex.WaitOne(TimeSpan.FromSeconds(2)); }
        catch (AbandonedMutexException) { return true; }
    }

    private void Save(UsageState state)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_statePath)!);
        var temp = _statePath + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(state));
        File.Move(temp, _statePath, overwrite: true);
    }

    private static Reservation? Denied()
    {
        var now = Environment.TickCount64;
        var previous = Volatile.Read(ref _lastDiagnostic);
        if ((previous == 0 || now - previous >= 30_000)
            && Interlocked.CompareExchange(ref _lastDiagnostic, now, previous) == previous)
            Console.Error.WriteLine("[couch-coop] cache-storage-limit: skipping new persistence; existing assets remain available.");
        return null;
    }

    private static bool IsAccountingFailure(Exception e)
        => e is IOException or UnauthorizedAccessException or JsonException or OverflowException or ArgumentException or InvalidOperationException;

    private static long ReadProcessStart(int pid)
    {
        try
        {
            if (OperatingSystem.IsLinux())
            {
                // Process.StartTime converts the Linux boot-relative timestamp using a per-process
                // wall-clock estimate. Its ticks differ between readers; /proc starttime is stable.
                var stat = File.ReadAllText($"/proc/{pid}/stat");
                var fields = stat[(stat.LastIndexOf(')') + 2)..].Split(' ');
                return long.Parse(fields[19], System.Globalization.CultureInfo.InvariantCulture);
            }
            using var process = Process.GetProcessById(pid);
            return process.HasExited ? -1 : process.StartTime.ToUniversalTime().Ticks;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception
            or IOException or UnauthorizedAccessException or FormatException or OverflowException) { return -1; }
    }

    private static long AvailableFreeSpace(string path)
    {
        var full = ResolvedFilePath.Resolve(path);
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        return DriveInfo.GetDrives().Where(d => d.IsReady)
            .Where(d => full.Equals(d.Name.TrimEnd(Path.DirectorySeparatorChar), comparison)
                || full.StartsWith(d.Name.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, comparison))
            .OrderByDescending(d => d.Name.Length).First().AvailableFreeSpace;
    }

    private sealed class UsageState
    {
        public long UsedBytes { get; set; }
        public long ScannedAt { get; set; }
        public string[] ManagedRoots { get; set; } = [];
        public Dictionary<string, ReservationRecord> Reservations { get; set; } = new(StringComparer.Ordinal);
    }
    private sealed record ReservationRecord(int Pid, long Started, long Bytes, long ChargedBytes);

    internal sealed class Reservation(ManagedCacheQuota owner, string id, long bytes) : IDisposable
    {
        private ManagedCacheQuota? _owner = owner;
        public long Bytes { get; } = bytes;
        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Release(id);
    }
}
