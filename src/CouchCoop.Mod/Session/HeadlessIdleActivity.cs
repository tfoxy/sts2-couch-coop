using System;
using System.Threading;

namespace CouchCoop.Mod.Session;

/// <summary>
/// A tiny, lock-free "last activity" clock shared across the mod. <see cref="Mark"/> stamps the current tick
/// whenever something meaningful happens (a browser input is injected, or a scene delta is emitted);
/// <see cref="MsSinceActivity"/> reports how long the headless client has been idle.
///
/// The only reader is <see cref="CouchCoopHeadlessVisualSuspender"/>, which freezes spine + particle simulation
/// once the client has been idle past a threshold. <see cref="Mark"/> is called from BOTH the game main thread
/// (input injection) and a spirectl BACKGROUND thread (the scene-delta observer), so the timestamp is written /
/// read via <see cref="Volatile"/> — a single 64-bit field, no lock. Writing it on the host too (where the
/// suspender is never installed) is a harmless couple of instructions nobody reads.
/// </summary>
public static class HeadlessIdleActivity
{
    // Seeded to "now" so a just-started client isn't treated as already-idle before the first Mark().
    private static long _lastActivityMs = Environment.TickCount64;

    /// <summary>Records that activity just happened. Safe to call from any thread.</summary>
    public static void Mark() => Volatile.Write(ref _lastActivityMs, Environment.TickCount64);

    /// <summary>Milliseconds elapsed since the last <see cref="Mark"/>. Safe to call from any thread.</summary>
    public static long MsSinceActivity() => Environment.TickCount64 - Volatile.Read(ref _lastActivityMs);
}
