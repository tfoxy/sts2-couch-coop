using System;
using System.Threading;
using System.Threading.Tasks;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

internal static class HeadlessAssetLoadingActivityTests
{
    internal static async Task RunAsync()
    {
        TargetsResolve();
        await OverlappingLoadsKeepTheSeatActiveUntilTheLastCompletion();
        await EveryTerminalOutcomeReleasesItsRegistration();
        await CompletionFromAnotherThreadReleasesItsRegistration();
        await RepeatedObserversAndCompletedLoadsStayBalanced();
    }

    internal static void TargetsResolve()
    {
        var target = HeadlessAssetLoadingActivityPatch.ResolveTarget();
        Assert(target is { IsPublic: true, IsStatic: false },
            "the load-activity patch resolves the public load-queue entry");
        Assert(target is not null && typeof(Task).IsAssignableFrom(target.ReturnType),
            "the load-queue entry returns its completion Task");
    }

    private static async Task OverlappingLoadsKeepTheSeatActiveUntilTheLastCompletion()
    {
        var loads = new PendingAssetLoads();
        var first = new TaskCompletionSource();
        var second = new TaskCompletionSource();
        var observeFirst = loads.Track(first.Task);
        var observeSecond = loads.Track(second.Task);
        Assert(loads.HasPendingLoads, "starting loads prevents idle throttling");

        first.SetResult();
        await observeFirst;
        Assert(loads.HasPendingLoads, "finishing one of two loads keeps the seat active");
        second.SetResult();
        await observeSecond;
        Assert(!loads.HasPendingLoads, "the last load completion permits idle throttling again");
    }

    private static async Task EveryTerminalOutcomeReleasesItsRegistration()
    {
        var loads = new PendingAssetLoads();
        var failed = new TaskCompletionSource();
        var canceled = new TaskCompletionSource();
        var observeFailure = loads.Track(failed.Task);
        var observeCancellation = loads.Track(canceled.Task);
        var error = new InvalidOperationException("asset failure");
        failed.SetException(error);
        await observeFailure;
        Assert(loads.HasPendingLoads, "one failure cannot end another pending load");
        canceled.SetCanceled(new CancellationToken(canceled: true));
        await observeCancellation;
        Assert(!loads.HasPendingLoads, "fault and cancellation both release activity");
        Assert(failed.Task.IsFaulted && ReferenceEquals(failed.Task.Exception?.InnerException, error),
            "the game's load task preserves its original failure");
        Assert(canceled.Task.IsCanceled, "the game's load task preserves cancellation");
    }

    private static async Task CompletionFromAnotherThreadReleasesItsRegistration()
    {
        var loads = new PendingAssetLoads();
        var load = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var observation = loads.Track(load.Task);
        await Task.Run(load.SetResult);
        await observation;
        Assert(!loads.HasPendingLoads, "completion from a worker thread is visible to the FPS policy");
    }

    private static async Task RepeatedObserversAndCompletedLoadsStayBalanced()
    {
        var loads = new PendingAssetLoads();
        var load = new TaskCompletionSource();
        var first = loads.Track(load.Task);
        var second = loads.Track(load.Task);
        load.SetResult();
        await Task.WhenAll(first, second);
        await loads.Track(load.Task);
        await loads.Track(Task.CompletedTask);
        Assert(!loads.HasPendingLoads, "duplicate registrations and completed loads leave no activity behind");

        var next = new TaskCompletionSource();
        var observeNext = loads.Track(next.Task);
        Assert(loads.HasPendingLoads, "a later load still becomes active after balanced completions");
        next.SetResult();
        await observeNext;
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition) throw new Exception($"[HeadlessAssetLoadingActivityTests] FAILED: {label}");
    }
}
