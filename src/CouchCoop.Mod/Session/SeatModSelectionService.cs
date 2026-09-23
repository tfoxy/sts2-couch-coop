using System.Collections.Generic;

namespace CouchCoop.Mod.Session;

/// <summary>
/// What the host's seat-mod panel needs from seat mod selection: the mods this machine has, the ones the host
/// switched off, and a way to change that.
/// </summary>
/// <remarks>
/// The panel reads through this seam rather than naming the inventory and the store directly, so the UI can
/// be built and tested without a game, a <c>settings.save</c> or a mods directory behind it.
/// </remarks>
internal interface ISeatModSelectionSource
{
    /// <summary>
    /// Every mod seat selection knows about, one descriptor per id. Empty when that cannot be told — the
    /// panel then hides itself and no seat mod is disabled, which is exactly today's behaviour.
    /// </summary>
    IReadOnlyList<SeatModDescriptor> ReadInventory();

    /// <summary>
    /// The ids the host explicitly switched off. Never the cascade: that is derived on every read by
    /// <see cref="SeatModSelectionPlan.Resolve"/>.
    /// </summary>
    IReadOnlySet<string> ReadExplicitlyDisabled();

    /// <summary>Replace the explicit set. Best-effort: a store that cannot be written costs one re-pick.</summary>
    void WriteExplicitlyDisabled(IReadOnlyCollection<string> ids);
}

/// <summary>The host's own seat mod selection: the disk inventory, the explicit-choice store, and the rule.</summary>
/// <remarks>
/// <para>
/// THE INVENTORY IS READ ONCE PER PROCESS. The set of mods a game runs is fixed when it starts — subscribing or
/// unsubscribing takes effect at the next launch — while the QR dialog asks for the inventory every time it
/// opens and every seat spawn asks again. Only a successful read is kept: one that could not find the host's mod
/// list at all is retried on the next ask, so a transient failure does not hide the panel for the whole session.
/// </para>
/// <para>
/// THE STORE IS READ EVERY TIME, because it is the thing that changes: the host edits it from the panel, and the
/// next seat must launch with the edit.
/// </para>
/// <para>
/// Nothing here throws to a caller. A failure anywhere answers "no inventory" / "nothing chosen", which is
/// "no seat mod is disabled" — today's behaviour.
/// </para>
/// </remarks>
internal sealed class SeatModSelectionService : ISeatModSelectionSource
{
    internal static SeatModSelectionService Shared { get; } = new();

    private readonly Func<ISeatLoadedModSource, SeatModInventorySnapshot?> _readInventory;
    private readonly Func<string?> _storePath;
    private readonly object _gate = new();
    private ISeatLoadedModSource _loadedMods = NoSeatLoadedMods.Instance;
    private SeatModInventorySnapshot? _inventory;

    internal SeatModSelectionService()
        : this(
            loaded => SeatModInventory.Read(SeatModInventory.ResolveRoots(), loaded),
            SeatModSelectionStore.ResolvePath)
    {
    }

    /// <param name="readInventory">
    /// The inventory read, handed the current loaded-mod source; <see langword="null"/> means "could not be
    /// read", which is not cached.
    /// </param>
    /// <param name="storePath">Where the explicit set lives; <see langword="null"/> means nowhere.</param>
    internal SeatModSelectionService(
        Func<ISeatLoadedModSource, SeatModInventorySnapshot?> readInventory,
        Func<string?> storePath)
    {
        _readInventory = readInventory ?? throw new ArgumentNullException(nameof(readInventory));
        _storePath = storePath ?? throw new ArgumentNullException(nameof(storePath));
    }

    /// <summary>
    /// Supply the game's own account of which mods it loaded. Optional — the disk read is complete without it.
    /// Drops the cached inventory so the next read uses it.
    /// </summary>
    internal void UseLoadedMods(ISeatLoadedModSource source)
    {
        ArgumentNullException.ThrowIfNull(source);
        lock (_gate)
        {
            _loadedMods = source;
            _inventory = null;
        }
    }

    public IReadOnlyList<SeatModDescriptor> ReadInventory() => Inventory().Mods;

    public IReadOnlySet<string> ReadExplicitlyDisabled() => SeatModSelectionStore.TryRead(_storePath());

    public void WriteExplicitlyDisabled(IReadOnlyCollection<string> ids)
    {
        ArgumentNullException.ThrowIfNull(ids);
        SeatModSelectionStore.TryWrite(_storePath(), ids);
    }

    /// <summary>
    /// The mod-list rows a seat spawned NOW must be launched with disabled, by the host's choice: every row of
    /// every id <see cref="SeatModSelectionPlan.Resolve"/> answers for the stored explicit set — the cascade
    /// included, anything no longer allowed dropped. Never the <c>couchcoop</c> copy pin, which the seeder
    /// applies itself. Empty whenever anything fails.
    /// </summary>
    internal IReadOnlyList<SeatModRowKey> HostChosenSeatRows()
    {
        try
        {
            var inventory = Inventory();
            if (inventory.Mods.Count == 0) return [];
            var explicitlyDisabled = ReadExplicitlyDisabled();
            if (explicitlyDisabled.Count == 0) return [];
            return inventory.RowsFor(SeatModSelectionPlan.Resolve(inventory.Mods, explicitlyDisabled));
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"seat mod selection unavailable for this seat: {exception.GetType().Name}: {exception.Message} — "
                + "the seat launches with every mod the host runs");
            return [];
        }
    }

    /// <summary>The cached inventory, reading it if there is none yet.</summary>
    internal SeatModInventorySnapshot Inventory()
    {
        lock (_gate)
        {
            if (_inventory is not null) return _inventory;
            try
            {
                var read = _readInventory(_loadedMods);
                _inventory = read;
                return read ?? SeatModInventorySnapshot.Empty;
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr($"seat mod inventory read failed: {exception.GetType().Name}: {exception.Message}");
                return SeatModInventorySnapshot.Empty;
            }
        }
    }
}
