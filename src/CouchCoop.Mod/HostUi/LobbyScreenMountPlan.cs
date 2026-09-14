namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Which lobby screens still need their mount hook, so <see cref="Patches.LobbyScreenMountPatch"/> can be
/// attempted more than once without ever patching the same target twice.
/// </summary>
/// <remarks>
/// <para>
/// WHY THIS IS NOT A BOOL. The patch used to latch "applied" on its FIRST call whatever the outcome, and its
/// documented consolation — "lobby panels fall back to the startup scan" — is inert: that scan is a one-shot
/// walk at mod init, when no lobby screen exists yet (it logs <c>seeded=0</c> on every launch). So a single
/// failed attempt cost the lobby its QR button for the rest of the process, silently, with the only evidence on
/// stderr. That is exactly what happened when MonoMod's exec-helper could not be loaded at mod-init time: all
/// eleven of the mod's patches died, and the dlopen that the very next caller made 18 ms later succeeded.
/// </para>
/// <para>
/// A failure here is worth retrying and a success never is, so the unit of state is the PENDING SET rather than
/// a flag: a second attempt re-patches only what is still missing, and a fully satisfied plan makes every later
/// attempt a no-op. Harmony would also happily install a second copy of the same postfix, which is the other
/// thing the pending set prevents.
/// </para>
/// <para>
/// Godot- and Harmony-free by construction (the per-target work is injected), so the retry contract is
/// unit-testable without an engine — the same shape as <see cref="LobbyScreenRegistry"/> and
/// <see cref="CouchCoopLobbyHostGate"/>.
/// </para>
/// </remarks>
internal sealed class LobbyScreenMountPlan
{
    private readonly object _gate = new();
    private readonly List<string> _pending;

    public LobbyScreenMountPlan(IEnumerable<string> targets)
    {
        ArgumentNullException.ThrowIfNull(targets);
        _pending = [.. targets];
        TargetCount = _pending.Count;
    }

    /// <summary>How many targets the plan started with — the denominator of the <c>targets=n/m</c> line.</summary>
    public int TargetCount { get; }

    /// <summary>The targets still unpatched, newest answer each call.</summary>
    public IReadOnlyList<string> Pending
    {
        get
        {
            lock (_gate)
            {
                return _pending.Count == 0 ? [] : _pending.ToArray();
            }
        }
    }

    /// <summary>Whether every target is installed and there is nothing left to attempt.</summary>
    public bool IsComplete
    {
        get
        {
            lock (_gate)
            {
                return _pending.Count == 0;
            }
        }
    }

    /// <summary>
    /// Try to install every target that is still pending.
    /// </summary>
    /// <param name="patchOne">
    /// Installs one target, returning whether it is now hooked. It is called ONLY for pending targets, so it
    /// never has to be idempotent itself. A throw is treated as a failure and leaves that target pending —
    /// a single bad target must not abandon its siblings.
    /// </param>
    /// <returns><see cref="IsComplete"/> after this attempt.</returns>
    public bool Attempt(Func<string, bool> patchOne)
    {
        ArgumentNullException.ThrowIfNull(patchOne);

        lock (_gate)
        {
            for (var index = _pending.Count - 1; index >= 0; index--)
            {
                bool patched;
                try
                {
                    patched = patchOne(_pending[index]);
                }
                catch
                {
                    patched = false;
                }

                if (patched)
                {
                    _pending.RemoveAt(index);
                }
            }

            return _pending.Count == 0;
        }
    }
}
