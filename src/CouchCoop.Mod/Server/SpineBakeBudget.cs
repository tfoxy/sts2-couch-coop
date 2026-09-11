using System.Globalization;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Round-8 item 14 — the admission policy for the host's Spine bake, so game instances stay healthy while clips
/// bake and the machine never hangs. PURE (no Godot, no IO, no clock): every decision is a function of the live
/// instance count, so it is unit-testable and cheap enough to sample per request.
/// </summary>
/// <remarks>
/// <para>
/// A bake renders a clip frame-by-frame on the Godot MAIN thread and encodes those frames on background threads.
/// One bake at a time is already enforced by the provider's <c>ExtractionGate</c> (a SemaphoreSlim(1,1) — it is
/// what keeps the ENet tick alive and must NOT be widened). The remaining problem is machine-wide: couch co-op
/// runs one headless STS2 per browser seat, so N game instances plus a bake compete for the same cores.
/// </para>
/// <para>
/// Two levers, both driven from the instance count:
/// <list type="bullet">
///   <item><b>Degrade</b> — at or above <see cref="DefaultInstanceLimit"/> live instances, a full clip bake is
///   answered with the SINGLE-frame still for the same identity instead (cheap, already often cached). The
///   response is marked degraded so it is never cached under the full-clip key and never escalated by a client;
///   the next request after the pressure drops gets the real bake.</item>
///   <item><b>Encode fan-out</b> — the producer's frame-encode budget (spirectl
///   <c>Sts2RenderEncodeBudget</c>) leaves one core per live instance alone.</item>
/// </list>
/// </para>
/// </remarks>
public static class SpineBakeBudget
{
    /// <summary>
    /// Overrides the degrade threshold (see <see cref="DefaultInstanceLimit"/>). Present because the shipped rule
    /// is "instances &gt;= ProcessorCount", which on a big host box never fires with co-op's 4-instance ceiling —
    /// so degradation can only be exercised (QA, or a user on a busy machine) by lowering the limit. Values &lt;= 0
    /// or unparsable fall back to the default.
    /// </summary>
    public const string InstanceLimitEnvVar = "COUCHCOOP_SPINE_BAKE_INSTANCE_LIMIT";

    /// <summary>The live degrade threshold for this process (env override, else <see cref="DefaultInstanceLimit"/>).</summary>
    public static int InstanceLimit { get; } = ResolveInstanceLimit(
        Environment.GetEnvironmentVariable(InstanceLimitEnvVar),
        Environment.ProcessorCount);

    /// <summary>
    /// The default threshold: one game instance per core. At that point the machine has no spare core for the
    /// bake's own render/encode work, so a full clip bake would come out of the games' frame budget.
    /// </summary>
    public static int DefaultInstanceLimit(int processorCount) => Math.Max(2, processorCount);

    /// <summary>Pure resolve of the threshold from the raw env value (null/blank/&lt;=0 ⇒ the default).</summary>
    public static int ResolveInstanceLimit(string? rawEnvValue, int processorCount)
    {
        if (!string.IsNullOrWhiteSpace(rawEnvValue)
            && int.TryParse(rawEnvValue.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            && parsed > 0)
        {
            return parsed;
        }

        return DefaultInstanceLimit(processorCount);
    }

    /// <summary>
    /// Whether a full clip bake requested right now must be degraded to a single frame. Sampled per request, so a
    /// seat leaving restores full bakes immediately (nothing is latched).
    /// </summary>
    public static bool ShouldDegrade(int gameInstances, int instanceLimit)
        => instanceLimit > 0 && gameInstances >= instanceLimit;

    /// <summary>
    /// How many STS2 instances are alive on this machine, INCLUDING this one.
    /// <para>
    /// On the HOST that is 1 (itself) + every seat whose headless process is live — the host's seat table is
    /// authoritative. On a spawned HEADLESS client there is no seat table (it owns no seats), so its slot number is
    /// the best available LOWER BOUND: slots are handed out lowest-free-first from
    /// <c>HeadlessClientManager</c>'s 2..4 range, so "I am slot N" means the host plus at least N-1 seats exist.
    /// </para>
    /// </summary>
    public static int CountGameInstances(IReadOnlyList<MirrorSeatDescription>? seats, string? headlessSlot)
    {
        if (seats is not null)
        {
            var live = 0;
            foreach (var seat in seats)
            {
                if (seat.ProcessLive)
                {
                    live++;
                }
            }

            return 1 + live;
        }

        if (!string.IsNullOrWhiteSpace(headlessSlot)
            && int.TryParse(headlessSlot.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var slot)
            && slot > 1)
        {
            return slot;
        }

        return 1;
    }
}
