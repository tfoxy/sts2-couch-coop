using CouchCoop.Mod.Runtime;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Server;

/// <summary>
/// The ONE place couch-coop calls the spirectl geometry baker. Everything above it
/// (<see cref="CouchCoopGeoclipProvider"/>, the store, the route) speaks these couch-owned records, so when W1's
/// <c>ISpirectlRuntime.BakeSpineGeoClip</c> signature shifts, the edit is confined to
/// <see cref="CouchCoopRuntimeGeoclipBaker.Bake"/> below and nothing else moves.
/// </summary>
/// <remarks>
/// The call is SYNCHRONOUS and blocking on purpose: the runtime marshals the bake onto the Godot main thread and
/// waits, exactly as <c>ISpirectlAssetProvider.GetAsset</c> does. The provider is what puts it on a
/// <see cref="Task.Run(Action)"/> and behind <see cref="CouchCoopAssetExtractionGate"/> — an implementation of
/// this interface must not do either, or the gate would be taken twice.
/// </remarks>
public interface ICouchCoopGeoclipBaker
{
    CouchCoopGeoclipBakeOutcome Bake(CouchCoopGeoclipBakeCommand command);
}

/// <param name="SampleTimeSeconds">
/// The pose to sample, or null to let the producer's own rule choose (spirectl's
/// <c>Sts2SpineStillFrame.ChooseSampleTime</c>: an explicit request wins, a terminal <c>die/death/dead/defeat</c>
/// clip resolves to its duration, everything else to the midpoint). Null is what the on-demand lane sends — the
/// pose policy is the producer's, and duplicating it here is how the two would drift.
/// </param>
/// <param name="MaxFrames">Null = the whole clip. 1 = the single-pose bake this round's payoff rests on.</param>
/// <param name="AnimationNames">
/// Every animation of this RIG to bake in one scene load, or null for the single-animation command. The producer
/// always includes <paramref name="AnimationName"/> and always first, so this is "and these too" rather than a
/// second way of saying the same thing.
///
/// <para>90-96 % of a pose-only bake is the per-SCENE bracket sweep and slot↔mesh association, and N separate
/// commands pay it N times. The producer decides for itself whether the shared association actually holds for
/// each pose and re-bakes the ones it does not, so this is a request, not an instruction.</para>
/// </param>
/// <param name="KnownPageContentIds">
/// Atlas-page content ids this host already has in its shared page folder
/// (<see cref="CouchCoopGeoclipStore.KnownPageContentIds"/>). The producer describes those pages in the manifest
/// and does not write them.
/// </param>
public sealed record CouchCoopGeoclipBakeCommand(
    string SceneResPath,
    string? NodePath,
    string AnimationName,
    double? SampleTimeSeconds,
    string OutputDirectory,
    int Fps,
    int? MaxFrames,
    IReadOnlyList<string>? AnimationNames = null,
    IReadOnlySet<string>? KnownPageContentIds = null,
    long MaxOutputBytes = ManagedCacheQuota.DefaultEntryLimitBytes);

/// <summary>
/// What ONE animation of a rig bake produced. The completeness counters are per pose because the guard that reads
/// them is per pose: a batch that reported one merged verdict could admit a pose the guard would have refused.
/// </summary>
/// <param name="Batched">
/// False when the producer re-baked this pose in its own scene load because the shared association did not hold
/// for it. The field that keeps a measurement honest — a rig that fell back cost what it always cost.
/// </param>
/// <param name="ClaimsProven">
/// Of THIS pose's slot→mesh claims, how many carry a positive ownership proof. See
/// <see cref="CouchCoopGeoclipBakeOutcome.ClaimsProven"/>; scoped per pose for the same reason
/// <paramref name="Associated"/> is, because a pose shows its own subset of the rig's slots.
/// </param>
/// <param name="ClaimsUnproven">Of the same claims, how many rest on something weaker.</param>
/// <param name="ClaimProofNote">
/// The producer's <c>kind=count</c> roll-up of HOW the claims were made (<c>atlas:uv-region-exact=37</c>,
/// <c>color-flip=12</c>, …). Reported, never graded — the counters above are what the rule reads.
/// </param>
/// <param name="MeshesValidated">
/// How many meshes the producer's RID sweep actually validated for THIS pose. With
/// <paramref name="SweepTruncated"/> it is what
/// <see cref="CouchCoopGeoclipProvider.IsRetryableAcquisitionShortfall(CouchCoopGeoclipPoseOutcome)"/> reads to
/// tell an acquisition that came up short from a verdict about the rig. Zero means the producing path recorded
/// no sweep counters at all — missing evidence, read as NOT retryable.
/// </param>
/// <param name="SweepTruncated">
/// True when some window of the sweep swept a subset of its own plan because it hit its candidate cap. A
/// truncated sweep's shortfall says nothing about whether the plan was right, so it is a configuration verdict
/// and it STICKS.
/// </param>
public sealed record CouchCoopGeoclipPoseOutcome(
    string AnimationName,
    bool Success,
    string? ManifestPath,
    int PartCount,
    int FrameCount,
    double SampleTimeSeconds,
    string? SampleTimeSource,
    bool Complete,
    int SlotsEverVisible,
    int Associated,
    int ForeignMeshes,
    bool Batched,
    string? FailureReason,
    int ClaimsProven = 0,
    int ClaimsUnproven = 0,
    string ClaimProofNote = "",
    // ── The two counters the rig lane's retryability verdict is derived from ─────────────────────────────
    //
    // The producer stamps a top-level RefusalRetryable on the whole result, but that flag describes the FIRST
    // refused pose of a rig bake and a rig result with one adoptable pose carries no flag at all — while couch's
    // rig lane judges, refuses and records each pose ALONE. So the per-pose lane cannot read a top-level answer
    // and needs the numbers the answer is computed from.
    int MeshesValidated = 0,
    bool SweepTruncated = false);

/// <param name="SampleTimeSource">
/// Which arm of the pose rule fired — <c>requested</c> / <c>terminal-end</c> / <c>mid</c> / <c>degenerate</c>.
/// Carried through because it is a live-gate assertion (G1), not decoration.
/// </param>
/// <param name="Complete">
/// The baker's own verdict that it acquired everything it set out to. NOT advisory — see
/// <see cref="CouchCoopGeoclipProvider"/>: an incomplete bake is refused entry to the store.
/// </param>
/// <param name="SlotsEverVisible">Slots the bake saw with an attachment at the sampled pose.</param>
/// <param name="Associated">Of those, how many were associated with a real mesh surface.</param>
/// <param name="ForeignMeshes">
/// Surfaces inside the bake's RID bracket that no slot claimed. UNCLAIMED, which is not the same as
/// mis-attributed: a rig mints geometry for attachments that are not drawable at the sampled pose, and other rigs
/// and VFX mint inside the bracket throughout a live fight. It is a first-class REPORTED counter and, on its own,
/// no longer a refusal — see <see cref="CouchCoopGeoclipProvider.IncompletenessReason(bool,int,int,int,int,int,bool?)"/>.
/// </param>
/// <param name="ClaimsProven">
/// How many of this bake's slot→mesh claims carry a POSITIVE ownership proof: a colour-flip response (foreign
/// geometry cannot answer a nudge aimed at our slot), or an atlas match whose corners coincide with the region
/// the slot's attachment names.
///
/// <para>WITH <paramref name="ClaimsUnproven"/> THIS IS WHAT THE THIRD ARM GRADES, so it has to reach the rule
/// intact. Both being zero means the producing path recorded no provenance at all — an older embedded bridge, or
/// a seam that does not carry the counters — and the rule reads that as MISSING evidence rather than as clean
/// evidence, falling back to the bare leftover count. That fail-closed reading is the only thing standing between
/// "we did not ask" and "we asked and the answer was fine".</para>
/// </param>
/// <param name="ClaimsUnproven">
/// How many claims rest on something weaker: a bare containment match against the named atlas region, or the
/// last-slot/last-mesh elimination rule. Non-zero next to unclaimed geometry is the one shape in which
/// contamination could actually have corrupted a claim.
/// </param>
/// <param name="RefusedFromMemo">
/// True when the producer answered from its own IN-PROCESS refusal memo instead of baking.
/// </param>
/// <param name="RefusalRetryable">
/// The producer's own verdict that its refusal is a RETRYABLE ACQUISITION FAULT rather than a verdict about the
/// rig: its RID sweep validated fewer meshes than there were slots to fill, and the sweep was not cut short by
/// its own candidate cap.
///
/// <para>WHY COUCH CARES. That shape means the sweep's PLAN did not cover the rig's own meshes, which is a
/// property of Godot's RID allocator at that instant and not of the rig — a creature death earlier in the session
/// frees RIDs, the allocator leaves bump-allocation, the rig's meshes land at recycled indices outside the
/// inferred hull, and they are never probed. A later bake of the SAME identity can pass. spirectl already
/// declines to pin one in its in-process memo; couch writes a DURABLE receipt, so a couch that pinned it anyway
/// would poison that identity on disk for every later launch on the strength of one unlucky moment. The provider
/// is what acts on it — see <see cref="CouchCoopGeoclipProvider"/> — by refusing this request without recording
/// the refusal.</para>
///
/// <para>False on every other refusal arm and on a memo replay. It is deliberately narrow: a refusal that is
/// retryable when it should be sticky costs a full re-bake on every request for ever, so the flag is carried
/// from the producer verbatim and is only honoured where the producer actually judged this bake — see
/// <c>CouchCoopGeoclipProvider</c>'s refusal branch.</para>
/// </param>
public sealed record CouchCoopGeoclipBakeOutcome(
    bool Success,
    string? ManifestPath,
    IReadOnlyList<string> PageFileNames,
    int PartCount,
    int FrameCount,
    double SampleTimeSeconds,
    string? SampleTimeSource,
    long ElapsedMs,
    string? ErrorCode,
    string? ErrorMessage,
    bool Complete = false,
    int SlotsEverVisible = 0,
    int Associated = 0,
    int ForeignMeshes = 0,
    IReadOnlyList<CouchCoopGeoclipPoseOutcome>? Poses = null,
    int ScenesLoaded = 1,
    string? BatchNote = null,
    string? RefusalArm = null,
    string? RefusalReason = null,
    bool RefusedFromMemo = false,
    int ClaimsProven = 0,
    int ClaimsUnproven = 0,
    bool RefusalRetryable = false)
{
    public static CouchCoopGeoclipBakeOutcome Failure(string code, string message)
        => new(false, null, [], 0, 0, 0d, null, 0L, code, message);

    /// <summary>
    /// The per-animation outcomes, never null: a producer that reported none is described by the top-level
    /// fields, which is what a single-animation bake has always meant.
    /// </summary>
    public IReadOnlyList<CouchCoopGeoclipPoseOutcome> PoseOutcomes => Poses ?? [];
}

/// <summary>
/// The real adapter: <see cref="CouchCoopRuntimeHost"/> → the embedded spirectl runtime's geometry baker.
/// </summary>
/// <remarks>
/// <para>
/// The forward itself is <see cref="CouchCoopRuntimeHost.BakeSpineGeoClip"/>, shaped exactly like
/// <see cref="CouchCoopRuntimeHost.GetSpineCatalog"/> — capability guard, then the runtime call. Everything this
/// class adds is TRANSLATION: couch-owned command in, couch-owned outcome out, so the store, the provider, the
/// route and the prerender job never see a spirectl type.
/// </para>
/// <para>
/// A <see cref="NotSupportedException"/> from the capability guard is caught rather than propagated, because
/// that is how a host whose embedded runtime is older than this code must degrade: a structured failure the
/// provider turns into a 404, not an unhandled throw out of a bake task.
/// </para>
/// </remarks>
public sealed class CouchCoopRuntimeGeoclipBaker(ISpineGeoClipBaker baker, ICouchCoopCapabilityPolicy capabilities) : ICouchCoopGeoclipBaker
{
    /// <summary>
    /// The capability id this bake is guarded on, and the code the provider reports when the guard refuses.
    /// It is spirectl's published <c>spine-geoclip-bake</c> id, by reference — see
    /// <see cref="CouchCoopRuntimeHost.SpineGeoClipBakeCapability"/>.
    /// </summary>
    public const string GeoclipBakeCapability = CouchCoopRuntimeHost.SpineGeoClipBakeCapability;

    /// <summary>
    /// A bake refused because it was asked for from the Godot MAIN THREAD. Its own code, not folded into the
    /// generic runtime-failure bucket: every other failure says something about the RIG, this one says the HOST
    /// called the seam wrongly, and a sweep that cannot tell them apart reports a broken caller as a broken
    /// creature. The provider's <c>Task.Run</c> is what keeps it from ever firing.
    /// </summary>
    public const string MainThreadRefusalCode = "geoclip-bake-main-thread";

    /// <summary>The couch-side code prefix for a structured spirectl bake failure.</summary>
    private const string FailureCodePrefix = "geoclip-bake-";

    private readonly ISpineGeoClipBaker _baker = baker ?? throw new ArgumentNullException(nameof(baker));
    private readonly ICouchCoopCapabilityPolicy _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));

    public CouchCoopGeoclipBakeOutcome Bake(CouchCoopGeoclipBakeCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        try
        {
            _capabilities.RequireCapability(GeoclipBakeCapability);
            return Map(_baker.BakeSpineGeoClip(ToRequest(command)));
        }
        catch (NotSupportedException exception)
        {
            return CouchCoopGeoclipBakeOutcome.Failure(GeoclipBakeCapability, exception.Message);
        }
    }

    /// <summary>
    /// The couch command as a spirectl request. <c>PoseOnly</c> is stated EXPLICITLY even though it defaults to
    /// true upstream, so a future default flip there cannot silently change what this store contains — and it is
    /// derived from <see cref="CouchCoopGeoclipBakeCommand.MaxFrames"/> rather than hard-coded, because that
    /// field is where a caller already says "one pose" (1) or "the whole clip" (null).
    /// </summary>
    internal static SpineGeoClipBakeRequestSnapshot ToRequest(CouchCoopGeoclipBakeCommand command)
        => new(
            SceneResPath: command.SceneResPath,
            NodePath: command.NodePath,
            AnimationName: command.AnimationName,
            SampleTimeSeconds: command.SampleTimeSeconds,
            OutputDirectory: command.OutputDirectory,
            Fps: command.Fps,
            MaxFrames: command.MaxFrames,
            PoseOnly: command.MaxFrames == CouchCoopGeoclipProvider.SinglePoseFrames,
            AnimationNames: command.AnimationNames,
            KnownPageContentIds: command.KnownPageContentIds,
            MaxOutputBytes: command.MaxOutputBytes);

    /// <summary>
    /// The spirectl result as a couch outcome. The completeness COUNTERS are carried through UNJUDGED —
    /// <see cref="CouchCoopGeoclipProvider.IncompletenessReason(CouchCoopGeoclipBakeOutcome)"/> is the local
    /// backstop that decides what they mean, so this cannot quietly admit a bake the provider would refuse. The
    /// producer's own refusal VERDICT (arm, reason, and whether its in-process memo answered instead of baking)
    /// rides alongside them.
    /// </summary>
    /// <remarks>
    /// THE CLAIM COUNTERS ARE LOAD-BEARING PLUMBING, not decoration. Couch keeps its own copy of the admission
    /// rule, and that rule's third arm grades <c>ClaimsProven</c>/<c>ClaimsUnproven</c>; a mapper that dropped
    /// them would leave the local rule looking at 0/0 for every bake, which it reads as "no provenance" and
    /// answers with the legacy bare-leftover arm. That is SAFE — it refuses exactly what it refused before — and
    /// it is also silent, so the whole ownership change would do nothing while every suite stayed green. Hence
    /// <c>GeoclipPrerenderTests.TheSeamCarriesClaimProvenanceIntoTheAdmissionRule</c>, which drives a snapshot
    /// through this mapper and asserts on the VERDICT rather than on the field.
    /// </remarks>
    internal static CouchCoopGeoclipBakeOutcome Map(SpineGeoClipBakeResultSnapshot result)
    {
        ArgumentNullException.ThrowIfNull(result);
        return new CouchCoopGeoclipBakeOutcome(
            result.Success,
            result.ManifestPath,
            result.PageFileNames ?? [],
            result.PartCount,
            result.FrameCount,
            result.SampleTimeSeconds,
            string.IsNullOrWhiteSpace(result.SampleTimeSource) ? null : result.SampleTimeSource,
            (long)Math.Round(result.ElapsedMs, MidpointRounding.AwayFromZero),
            ErrorCode(result.Error),
            ErrorMessage(result.Error),
            Complete: result.Complete,
            SlotsEverVisible: result.SlotsVisible,
            Associated: result.Associated,
            ForeignMeshes: result.ForeignMeshes,
            Poses: result.Poses is null ? null : [.. result.Poses.Select(MapPose)],
            ScenesLoaded: result.ScenesLoaded,
            BatchNote: result.BatchNote,
            // The producer's OWN verdict on the same completeness rule, carried verbatim. Unlike the counters
            // above this is already judged — see the provider, which prefers it over re-deriving the same answer.
            RefusalArm: result.RefusalArm,
            RefusalReason: result.RefusalReason,
            RefusedFromMemo: result.RefusedFromMemo,
            // Unjudged like the counters above, and for a sharper reason: these ARE the third arm's input.
            ClaimsProven: result.ClaimsProven,
            ClaimsUnproven: result.ClaimsUnproven,
            // JUDGED, like the arm and the reason it travels with, and carried VERBATIM rather than re-derived:
            // the producer's sweep counters are the only evidence for it, and a mapper that inferred it from the
            // couch-side counters would be answering a question it cannot see the inputs to. The provider decides
            // what to do with it, and only where the producer actually judged this bake.
            RefusalRetryable: result.RefusalRetryable);
    }

    /// <summary>
    /// One animation's outcome, carried through UNJUDGED for the same reason the top-level counters are: the
    /// provider's completeness guard is the only thing that decides what they mean, per pose.
    /// </summary>
    internal static CouchCoopGeoclipPoseOutcome MapPose(SpineGeoClipBakePoseSnapshot pose)
        => new(
            pose.AnimationName,
            pose.Success,
            pose.ManifestPath,
            pose.PartCount,
            pose.FrameCount,
            pose.SampleTimeSeconds,
            string.IsNullOrWhiteSpace(pose.SampleTimeSource) ? null : pose.SampleTimeSource,
            pose.Complete,
            pose.SlotsVisible,
            pose.Associated,
            pose.ForeignMeshes,
            pose.Batched,
            pose.FailureReason,
            // Per POSE, not the rig roll-up: the rig lane judges each pose alone, so a pose graded on another
            // pose's evidence is exactly the mis-admission the per-pose rule exists to prevent.
            pose.ClaimsProven,
            pose.ClaimsUnproven,
            pose.ClaimProofNote ?? string.Empty,
            // The sweep's own two numbers, per POSE. There is no per-pose retryability flag upstream to carry, so
            // these are what the rig lane's verdict is derived from; dropping them would leave every pose reading
            // 0/false, which the rule reads as missing evidence and refuses stickily — silently, with every suite
            // still green. Hence GeoclipStoreTests' rig-lane boundary pair, which asserts on the RECEIPT.
            pose.MeshesValidated,
            pose.SweepTruncated);

    private static string? ErrorCode(AssetExtractFailure? error)
    {
        if (error is null)
        {
            return null;
        }

        return IsMainThreadRefusal(error)
            ? MainThreadRefusalCode
            : FailureCodePrefix + Kebab(error.Code.ToString());
    }

    // The bake refuses a main-thread call by NAME, in a detail rather than in the code (the code is the generic
    // runtime failure), so that detail is what has to be read to keep the two apart.
    private static bool IsMainThreadRefusal(AssetExtractFailure error)
        => error.Details is { } details
            && details.Any(detail =>
                string.Equals(detail.Field, "thread", StringComparison.Ordinal)
                && string.Equals(detail.Value, "main", StringComparison.Ordinal));

    // Details carry the actionable half of a bake failure (which field was missing, which thread it was called
    // on), and the provider only surfaces the message — so fold them in rather than dropping them.
    private static string? ErrorMessage(AssetExtractFailure? error)
    {
        if (error is null)
        {
            return null;
        }

        var details = error.Details is null
            ? []
            : error.Details
                .Select(detail => $"{detail.Field}={detail.Value}")
                .Where(text => text.Length > 1)
                .ToArray();
        return details.Length == 0 ? error.Message : $"{error.Message} ({string.Join("; ", details)})";
    }

    private static string Kebab(string pascal)
    {
        var builder = new System.Text.StringBuilder(pascal.Length + 4);
        foreach (var character in pascal)
        {
            if (char.IsUpper(character) && builder.Length > 0)
            {
                builder.Append('-');
            }

            builder.Append(char.ToLowerInvariant(character));
        }

        return builder.ToString();
    }
}
