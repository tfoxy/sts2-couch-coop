namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The set of lobby screens currently alive in the game, held as Godot instance ids.
/// </summary>
/// <remarks>
/// <para>
/// THIS EXISTS TO DELETE A 4 Hz WHOLE-TREE WALK. The controller used to find its screens by running a
/// recursive DFS from <c>SceneTree.Root</c> every 0.25s — on the main thread, on every screen, forever,
/// whether or not any browser client was connected. The walk cost a native <c>IsInstanceValid</c>, a
/// <c>GetType()</c> and a marshaling <c>GetChildren()</c> per node, so on a combat tree it was a periodic
/// main-thread hitch that an unmodded game does not pay. <see cref="Patches.LobbyScreenMountPatch"/> now
/// pushes the two screens in as they are readied and this holds them, so the controller's tick has a fixed
/// one-or-two-element list to consult and there is NO periodic work at all outside a lobby.
/// </para>
/// <para>
/// IDS, NOT NODE REFERENCES, for the reason the static-background tracker keeps ids: a freed screen would
/// otherwise leave a dangling managed wrapper alive in this list for the life of the process.
/// <c>GodotObject.InstanceFromId</c> of a freed id is simply null, which is what <see cref="Live"/> prunes on.
/// </para>
/// <para>
/// LIVENESS IS "NOT FREED", NOT "IN THE TREE". A screen that is detached and re-attached, or merely hidden,
/// keeps its entry: Godot runs <c>_Ready</c> once per node (absent an explicit <c>RequestReady</c>), so
/// dropping an entry on tree-exit would lose a screen we could never be told about again. Visibility is the
/// controller's business and is re-read every tick.
/// </para>
/// <para>
/// Godot-free by construction — the liveness probe is injected — so the arm/disarm contract is unit-testable
/// without an engine. Locked because <see cref="Add"/> is reached from a Harmony postfix while
/// <see cref="Live"/> is reached from the scan timer; both are main-thread today, and the lock is what keeps
/// that from being load-bearing.
/// </para>
/// </remarks>
internal sealed class LobbyScreenRegistry(Func<ulong, bool> isAlive)
{
    private readonly object _gate = new();
    private readonly List<ulong> _ids = [];
    private readonly Func<ulong, bool> _isAlive = isAlive ?? throw new ArgumentNullException(nameof(isAlive));

    /// <summary>Whether any screen is registered. Does NOT prune — see <see cref="Live"/>.</summary>
    public bool IsOccupied
    {
        get
        {
            lock (_gate)
            {
                return _ids.Count > 0;
            }
        }
    }

    /// <summary>
    /// Register a readied lobby screen.
    /// </summary>
    /// <returns>
    /// <see langword="true"/> when this call took the registry from EMPTY to occupied — i.e. the caller must
    /// start the scan timer. A duplicate id (a screen re-readied via <c>RequestReady</c>) returns
    /// <see langword="false"/>, so a second mount can never start a second timer chain.
    /// </returns>
    public bool Add(ulong id)
    {
        lock (_gate)
        {
            if (_ids.Contains(id))
            {
                return false;
            }

            var wasEmpty = _ids.Count == 0;
            _ids.Add(id);
            return wasEmpty;
        }
    }

    /// <summary>
    /// The surviving ids, dropping any whose node has been freed.
    /// </summary>
    /// <remarks>
    /// Deliberately allocation-light and total: the liveness probe is guarded by the caller, so this can be
    /// the FIRST thing the scan tick does and the tick's "should I keep ticking?" answer can be taken from
    /// the count before anything that might throw runs.
    /// </remarks>
    public IReadOnlyList<ulong> Live()
    {
        lock (_gate)
        {
            for (var index = _ids.Count - 1; index >= 0; index--)
            {
                if (!_isAlive(_ids[index]))
                {
                    _ids.RemoveAt(index);
                }
            }

            return _ids.Count == 0 ? [] : _ids.ToArray();
        }
    }

    /// <summary>Forget everything. The mod's shutdown path; also the reset seam for tests.</summary>
    public void Clear()
    {
        lock (_gate)
        {
            _ids.Clear();
        }
    }
}
