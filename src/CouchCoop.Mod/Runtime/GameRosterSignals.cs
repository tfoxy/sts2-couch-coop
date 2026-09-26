using System.Runtime.CompilerServices;
using CouchCoop.Mod.Session;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Runs;

namespace CouchCoop.Mod.Runtime;

/// <summary>
/// The production wiring of the roster observer's signals: every event that can change who is in a lobby or a run,
/// attached while the observer exists and detached when it stops.
/// </summary>
/// <remarks>
/// <para>
/// The signals, and which fact each one covers:
/// </para>
/// <list type="bullet">
/// <item>The active-screen event (<see cref="GameScreenContext.SubscribeUpdated"/>): which screen is current, and so
/// the root scene and whether a lobby is on screen.</item>
/// <item>The typed hooks and CouchCoop's own name change (<see cref="CouchCoopRosterSignals"/>): someone joined or left a
/// lobby, a lobby was created, a run was cleaned up, a seat's display name changed.</item>
/// <item>The game's run-started event: a run began.</item>
/// <item>The host net service's client connected / disconnected events: a seat's connectedness, in a lobby and in a run.
/// The service is the one the lobby constructors recorded (<see cref="RosterHostService"/>), bound just before each read
/// and unbound with the observer.</item>
/// </list>
/// <para>
/// THERE IS NO TIMER AND NO BACKSTOP READ. A fact none of these covers is reported as a missed signal, not polled for.
/// The known ones: a remote player's platform name resolving late, and a mod that edits a lobby's players directly.
/// </para>
/// <para>
/// A signal that cannot be attached (the screen event on a build whose seam has moved) is logged once and the rest
/// still work; the roster then updates on the other signals only.
/// </para>
/// </remarks>
internal sealed class GameRosterSignals : IDisposable
{
    private static int _screenEventUnavailableLogged;

    private readonly object _gate = new();
    private readonly Action _wake;
    private readonly List<IDisposable> _parts = [];
    private HostServiceBinding? _hostBinding;
    private bool _disposed;

    private GameRosterSignals(Action wake) => _wake = wake;

    /// <summary>Attach every signal. Never throws: a signal that will not attach is skipped and reported.</summary>
    internal static GameRosterSignals Create(Action wake)
    {
        var signals = new GameRosterSignals(wake);
        signals.Attach();
        return signals;
    }

    private void Attach()
    {
        AddPart(() => GameScreenContext.SubscribeUpdated(_wake), "the active-screen event");
        if (_parts.Count == 0 && Interlocked.Exchange(ref _screenEventUnavailableLogged, 1) == 0)
        {
            CouchCoopLog.Stderr(
                "roster signals: the game's screen event is unavailable; the join picker follows the lobby and run signals only");
        }

        AddPart(() => CouchCoopRosterSignals.Listen(_wake), "the roster hooks");
        if (CouchCoopMod.EngineAvailable)
        {
            AttachGame();
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void AttachGame()
    {
        AddPart(() => new RunStartedSubscription(_wake), "the run-started event");
        var binding = new HostServiceBinding(_wake);
        lock (_gate)
        {
            _hostBinding = binding;
        }

        AddPart(() => binding, "the host peer events");
    }

    /// <summary>
    /// Called on the game main thread just before each roster read: bind to the host net service the lobby constructors
    /// last recorded, if it is not the one already bound.
    /// </summary>
    internal void BeforeRead()
    {
        HostServiceBinding? binding;
        lock (_gate)
        {
            binding = _disposed ? null : _hostBinding;
        }

        binding?.Refresh();
    }

    private void AddPart(Func<IDisposable?> attach, string what)
    {
        try
        {
            if (attach() is not { } part)
            {
                return;
            }

            var keep = false;
            lock (_gate)
            {
                if (!_disposed)
                {
                    _parts.Add(part);
                    keep = true;
                }
            }

            if (!keep)
            {
                part.Dispose();
            }
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"roster signals: {what} could not be attached ({exception.GetType().Name}: {exception.Message})");
        }
    }

    public void Dispose()
    {
        IDisposable[] parts;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            parts = [.. _parts];
            _parts.Clear();
            _hostBinding = null;
        }

        foreach (var part in parts)
        {
            try
            {
                part.Dispose();
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr($"roster signals: detaching failed ({exception.GetType().Name}: {exception.Message})");
            }
        }
    }

    /// <summary>The game's "a run has started" event, as a subscription that detaches itself.</summary>
    private sealed class RunStartedSubscription : IDisposable
    {
        private readonly Action<RunState> _handler;
        private RunManager? _manager;

        [MethodImpl(MethodImplOptions.NoInlining)]
        internal RunStartedSubscription(Action wake)
        {
            _handler = _ => wake();
            _manager = RunManager.Instance;
            if (_manager is not null)
            {
                _manager.RunStarted += _handler;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        public void Dispose()
        {
            var manager = Interlocked.Exchange(ref _manager, null);
            if (manager is not null)
            {
                manager.RunStarted -= _handler;
            }
        }
    }

    /// <summary>
    /// Listens for peers connecting and disconnecting on the host net service. Rebinds when the recorded service changes
    /// and lets go of it entirely on dispose.
    /// </summary>
    private sealed class HostServiceBinding : IDisposable
    {
        private readonly object _gate = new();
        private readonly Action<ulong> _connected;
        private readonly Action<ulong, NetErrorInfo> _disconnected;
        private INetHostGameService? _bound;
        private bool _disposed;

        internal HostServiceBinding(Action wake)
        {
            _connected = _ => wake();
            _disconnected = (_, _) => wake();
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        internal void Refresh()
        {
            var current = RosterHostService.Current as INetHostGameService;
            lock (_gate)
            {
                if (_disposed || ReferenceEquals(current, _bound))
                {
                    return;
                }

                Unbind();
                if (current is not null)
                {
                    current.ClientConnected += _connected;
                    current.ClientDisconnected += _disconnected;
                    _bound = current;
                }
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        public void Dispose()
        {
            lock (_gate)
            {
                _disposed = true;
                Unbind();
            }
        }

        // Under _gate.
        private void Unbind()
        {
            if (_bound is { } bound)
            {
                bound.ClientConnected -= _connected;
                bound.ClientDisconnected -= _disconnected;
                _bound = null;
            }
        }
    }
}
