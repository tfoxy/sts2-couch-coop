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

    /// <summary>
    /// One budget for a whole cache root — every cache hung under it at once.
    /// </summary>
    /// <remarks>
    /// <para>Coordinates on, and measures, the same directory: that directory holds every leaf
    /// (<c>assets/</c>, <c>geoclips/</c>, <c>astc/</c>, <c>pending/</c>), so there is nothing to infer. Its own
    /// <c>.cache-budget</c> sits inside and is excluded from measurement, and a purge takes the accounting with
    /// the tree it describes.</para>
    /// <para>The path is RESOLVED, which is what makes a host and its headless seats share one budget: a seat
    /// reaches the same bytes through a symlinked <c>cache</c> leaf, and two spellings of one directory must not
    /// mean two independent ceilings over the same disk.</para>
    /// </remarks>
    public static ManagedCacheQuota ForCacheRoot(string root)
    {
        var full = ResolvedFilePath.Resolve(root);
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
            // OUTSIDE the mutex, deliberately. This is a filesystem syscall against a path that may sit on a
            // network or automounted volume, and holding a cross-process lock across it lets one wedged mount
            // stall every other process's admission. Nothing it reads is shared state, and free space is
            // advisory to begin with — a few microseconds of staleness cannot matter against a 2 GiB reserve.
            var space = _freeSpace(_coordinationRoot);
            locked = Enter();
            if (!locked) return Denied();
            var state = LoadAndReconcile();
            var reserved = state.Reservations.Values.Sum(x => x.ChargedBytes);
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
            Console.Error.WriteLine("[couchcoop] cache-storage-limit: skipping new persistence; existing assets remain available.");
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

    /// <summary>
    /// Free space on the volume holding <paramref name="path"/>, or <see cref="long.MaxValue"/> when it cannot
    /// be determined.
    /// </summary>
    /// <remarks>
    /// <para>ONE VOLUME, NOT EVERY VOLUME. This used to enumerate every mounted drive and match the longest
    /// name that prefixed the path, which meant stat-ing every mount — a stale SMB/NFS share, or a macOS autofs
    /// entry that mounts on touch, blocks the whole enumeration. Asking about the one path we care about is both
    /// the direct question and the only one that cannot be made slow by a volume nothing here uses.</para>
    /// <para>IT FAILS OPEN, and that is not the same choice the accounting makes. An unreadable
    /// <c>state.json</c> fails CLOSED because the unknown is how much is already used, and writing on top of an
    /// unknown total is how the ceiling gets blown. Free space is a second, independent bound: when it cannot be
    /// read the ceiling still holds, so refusing as well would trade a real cache for no extra safety. The old
    /// shape got this backwards twice over — <c>First()</c> THREW when no drive matched, and the throw landed in
    /// the accounting catch, so a path the enumeration could not attribute refused every write for the life of
    /// the process AND reported it to the player as a storage limit it had not reached.</para>
    /// <para>The probe walks to the nearest existing ancestor first. A cache root that has not been created yet
    /// is an ordinary first run, not an unknown volume, and the old prefix match answered for it — reporting
    /// "unknown" there would silently retire the reserve on exactly the run that is about to fill the disk.</para>
    /// </remarks>
    internal static long AvailableFreeSpace(string path)
    {
        try
        {
            return new DriveInfo(NearestExistingDirectory(ResolvedFilePath.Resolve(path))).AvailableFreeSpace;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException
            or NotSupportedException or System.Security.SecurityException or InvalidOperationException)
        {
            return long.MaxValue;
        }
    }

    private static string NearestExistingDirectory(string path)
    {
        var directory = path;
        while (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            var parent = Path.GetDirectoryName(directory);
            if (string.IsNullOrEmpty(parent) || parent == directory) break;
            directory = parent;
        }
        return string.IsNullOrEmpty(directory) ? path : directory;
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
