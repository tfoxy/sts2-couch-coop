using Godot;
using MegaCrit.Sts2.Core.Saves;

namespace CouchCoop.Mod.Session;

/// <summary>
/// The game's own player preferences, for the handful of them a REMOTE viewer has to be told about.
///
/// Today that is exactly one: Settings -> Text Effects. The mirror animates the game's wavy and bouncing rich
/// text, and it cannot infer whether the player wants that — the game leaves the effect markup in the label's
/// string and skips the per-character transform instead, so identical BBCode arrives on the wire either way.
/// </summary>
public static class CouchCoopGamePrefs
{
    /// <summary>
    /// The current Text Effects preference, or null when it cannot be read (no engine, or a main loop that did not
    /// answer). The caller omits the field and the client keeps its own default of ENABLED, which is the game's.
    ///
    /// TWO GUARDS, AND THE FIRST ONE IS THE LOAD-BEARING ONE — the same pair
    /// <see cref="CouchCoopHeadlessVisualSuspender.GetEffectiveBaselineMaxFpsAsync"/> carries, for the same reason.
    /// The read itself is plain managed C# (a static, a field, a bool), but reaching the singleton can CONSTRUCT
    /// it, and constructing it resolves the user data directory through the engine. In a process that merely has
    /// GodotSharp on its probing path — every C# runner in this repo, they copy the DLL — that binds, JITs and then
    /// segfaults uncatchably, so <see cref="CouchCoopMod.EngineAvailable"/> and not the try/catch is what makes the
    /// next line safe. Second: the read is marshalled onto the game main thread, because a background thread
    /// reaching a not-yet-constructed singleton would build it out from under the game.
    /// </summary>
    public static async Task<bool?> GetTextEffectsEnabledAsync()
    {
        if (!CouchCoopMod.EngineAvailable)
        {
            return null;
        }

        var tcs = new TaskCompletionSource<bool?>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            Callable.From(() => tcs.TrySetResult(ReadOnMainThread())).CallDeferred();
        }
        catch
        {
            tcs.TrySetResult(null); // GodotSharp failed to LOAD — the case the latch does not cover
        }

        try
        {
            // Backstop so a stuck/paused main loop never leaks the read forever.
            return await tcs.Task.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
        }
        catch
        {
            return null; // timed out — the client keeps its own default
        }
    }

    // Logged at most once per process: this sits on the session-envelope path, which a viewer can re-enter as
    // often as they like, and a repeating line would bury the report a player copies out of godot.log.
    private static volatile bool _readFailureLogged;

    private static bool? ReadOnMainThread()
    {
        try
        {
            return SaveManager.Instance?.PrefsSave?.TextEffectsEnabled;
        }
        catch (Exception exception)
        {
            // Degraded, not lost: the mirror animates text the player may have turned off, which is cosmetic, so
            // this records and returns rather than failing the session envelope a viewer is waiting on.
            if (!_readFailureLogged)
            {
                _readFailureLogged = true;
                CouchCoopLog.Error(
                    $"{nameof(CouchCoopGamePrefs)}: text-effects preference unreadable "
                        + $"({exception.GetType().Name}: {exception.Message}) — the mirror assumes it is on.");
            }

            return null;
        }
    }
}
