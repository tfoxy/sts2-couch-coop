using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Runtime;

/// <summary>
/// Where the things that can change who is in the lobby or the run announce it: the typed game hooks
/// (<see cref="Patches.RosterSignalPatch"/>) and CouchCoop's own display-name overrides. Nothing here reads the game.
/// </summary>
/// <remarks>
/// <para>
/// A signal only WAKES: whoever listens (the roster observer, which exists only while a viewer is parked on the join
/// picker) marks the roster dirty and reads it once, one frame later. With no listener a raise is a null check, so the
/// hooks cost nothing while nobody is served. There is no queue and no timer.
/// </para>
/// <para>
/// A static, and in <c>Runtime/</c> on purpose: the hooks live in the mod assembly while the server that listens is
/// compiled into every hot-reload generation, so an instance held on either side would not be seen by the other.
/// </para>
/// </remarks>
public static class CouchCoopRosterSignals
{
    private static Action? _woken;
    private static int _listeners;

    /// <summary>How many listeners are attached right now. The zero-client contract asserts this is 0 with nobody served.</summary>
    public static int ListenerCount => Volatile.Read(ref _listeners);

    /// <summary>
    /// A seat's display-name override was set or cleared, which changes the name the roster reports for it. Called by
    /// <see cref="Session.CouchCoopLobbyParticipation.SetClientName"/> after the game accepted the change; the only signal
    /// the game gives for a name is the one CouchCoop itself causes.
    /// </summary>
    public static void NoteNameChanged() => Raise();

    /// <summary>The roster may have changed. Never throws into the caller (a game callback may be the caller).</summary>
    internal static void Raise()
    {
        try
        {
            Volatile.Read(ref _woken)?.Invoke();
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"roster signal listener failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>Attach <paramref name="wake"/>; dispose the result to detach it. Balanced, so the count is exact.</summary>
    internal static IDisposable Listen(Action wake)
    {
        ArgumentNullException.ThrowIfNull(wake);
        lock (Sync)
        {
            _woken += wake;
            _listeners++;
        }

        return new Listener(wake);
    }

    private static readonly object Sync = new();

    private sealed class Listener(Action wake) : IDisposable
    {
        private Action? _wake = wake;

        public void Dispose()
        {
            var attached = Interlocked.Exchange(ref _wake, null);
            if (attached is null)
            {
                return;
            }

            lock (Sync)
            {
                _woken -= attached;
                _listeners--;
            }
        }
    }
}
