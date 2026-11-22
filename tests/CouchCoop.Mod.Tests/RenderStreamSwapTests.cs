using CouchCoop.Mod.Session;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Server;

internal static class RenderStreamSwapTests
{
    public static void Run()
    {
        Action[] tests =
        [
            ForcedTrimBypassesIdleAndIntervalGates,
            IdleTrimRetainsItsGates,
            MissingTrimSymbolLatchesOffBothPaths,
            MixedRendererJoinOrders,
            MirrorWatchIntentResizesBeforeAdmission,
            HiddenAndDisconnectedMirrorReleaseConstraint,
            SquarestStreamAndNewestTargetWin,
            StandardStreamConstrainsWideViewer,
            NullAspectConstrainsArmedSeat,
            AspectUpdateRearmsAtNewWidth,
            QuantizedAspectUpdateKeepsCapture,
            GracePreservesPageFacts,
            DisconnectedPreferencesAreBounded,
            ReconnectRespectsSquarestViewer,
            PresentationReadyIsIndependentOfCapture,
            FailedReassertInvalidatesPendingReadiness,
            FailedPresentationRestoresOrRemainsUnready,
            LaterReassertSupersedesPendingReadiness,
            InitialMirrorDoesNoCaptureWork,
            ArmResumesBeforeCallingCapture,
            ArmUsesTheRequestingAspectAndConfiguredCap,
            WideArmOwnsPresentationUntilDisarmed,
            MirrorAndStandardArmKeepTheirPresentation,
            WindowedHostQrOpeningLoadsDetachedOnce,
            WindowedHostBrowserConnectionLoadsDetachedOnce,
            WindowedHostRequestBeforeDeferredLoadAttachesOnce,
            WindowedHostQuitBeforeUseOrWhileLeanDoesNotLoad,
            WindowedHostLoadsThenAttachesOnLaterRequests,
            WindowedHostHelpersFollowAttachment,
            WindowedHostHelperFailureKeepsMirror,
            WindowedHostIdleDisarmsThenDetaches,
            WindowedHostReturningPageSkipsDetach,
            WindowedHostAttachFailureKeepsMirror,
            WindowedHostLoadFailureCanRetry,
            WindowedHostDetachFailureStaysAttached,
            HeadlessCaptureNeverAttachesOrDetaches,
            WindowedHostQuitCannotAttachAgain,
            WindowedHostQuitDuringDisarmCannotRearmOrDetach,
            WindowedHostObservesAndRestoresPresentation,
            WindowedHostAspectRearmKeepsPlayerSettings,
            WindowedHostArmFailureRestoresPresentation,
            WindowedHostMissingAutoHooksKeepsMirror,
            WindowedHostDisposalRestoresPresentation,
            WideArmFailuresRestoreBeforeResumingMirror,
            DeferredDisarmedRestoresBeforeRearm,
            RestoreCompletionFollowsDeferredRestoration,
            DisposedSwapIgnoresDeferredRestore,
            OnlyArmedPublishesTheSnapshot,
            SpineFreezeFollowsArmedAndDisarm,
            FailedArmNeverArmsSpineFreeze,
            RefusedArmRestoresTheSuspender,
            ArmFailureAllowsAnExplicitRetry,
            PagesShareOneArm,
            OnlyTheLastMirrorRequestDisarms,
            MirrorCanCancelAnArmingCapture,
            DisarmClearsTheSnapshotBeforeCallingCapture,
            NeverConnectedCaptureGetsNinetySeconds,
            ConnectingCancelsGrace,
            OnlyTheLastClientLeavingStartsGrace,
            CancelledDeadlinesCannotDisarmALaterArm,
            ReleaseAndReloadDoNotResetGrace,
            RequestDuringDisarmRearmsAfterTeardown,
            WithdrawnDemandDuringDisarmDoesNotRearm,
            StreamEndedFailsWithoutAutomaticRearm,
            StreamEndedDuringArmingAlsoDisarms,
            NewDemandDuringFailedTeardownCanRearm,
            SecondArmUsesTheNewSignalSnapshot,
            NoCaptureReportsFailureWithoutSideEffects,
            SingletonDiscoverySubscribesOnlyOnce,
            DisposalCancelsGraceAndSignalSubscriptions,
            QuitStillDisarmsArmingAndArmedCaptures,
            DisarmRefusalsHandleAlreadyStoppedOrStopping,
            RefusedDisarmAllowsMirrorFallback,
        ];
        var failures = new List<Exception>();
        foreach (var test in tests)
        {
            try { test(); }
            catch (Exception exception) { Console.WriteLine($"FAIL {test.Method.Name}: {exception.Message}"); failures.Add(exception); }
        }
        if (failures.Count != 0) throw new AggregateException(failures);
        Console.WriteLine($"RenderStreamSwapTests: {tests.Length} passed.");
    }

    private static void SpineFreezeFollowsArmedAndDisarm()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true);
        Assert(!f.StreamSpinesArmed, "arming does not yet freeze spines");
        f.Capture.EmitArmed(Snapshot("stills"));
        Assert(f.StreamSpinesArmed && !f.SuspenderEnabled, "armed capture uses its own spine freeze");
        f.Swap.Request("page", false);
        Assert(!f.StreamSpinesArmed && !f.SuspenderEnabled, "disarm releases stream spines before restoring the mirror");
        f.Capture.EmitDisarmed();
        Assert(!f.StreamSpinesArmed && f.SuspenderEnabled, "mirror restoration leaves stream freeze off");
        f.Arm();
        f.Swap.Dispose();
        Assert(!f.StreamSpinesArmed, "disposal releases the stream freeze");
    }

    private static void WindowedHostQrOpeningLoadsDetachedOnce()
    {
        var frames = new Queue<Action>();
        using var f = new Fixture(windowedHost: true, deferredLoad: true);
        void Used() => f.Deferred!.CouchUsed(frames.Enqueue);
        CouchCoopQrDialog.NoteVisibilityChanged(false, Used);
        Assert(frames.Count == 0 && f.LoadCalls == 0, "mounting a closed join dialog does no capture work");
        CouchCoopQrDialog.NoteVisibilityChanged(true, Used);
        CouchCoopQrDialog.NoteVisibilityChanged(false, Used);
        CouchCoopQrDialog.NoteVisibilityChanged(true, Used);
        Assert(frames.Count == 1 && f.LoadCalls == 0, "QR openings coalesce and defer loading out of the signal");
        frames.Dequeue()();
        Assert(f.LoadCalls == 1 && f.Capture.CurrentAttachmentState == "detached"
            && f.Capture.AttachCalls == 0 && f.Capture.ArmCalls == 0 && !f.Helpers.Installed,
            "opening either join dialog starts only lean detached capture");
        CouchCoopQrDialog.NoteVisibilityChanged(true, Used);
        Assert(frames.Count == 0, "reopening QR after loading schedules no work");
        f.Arm();
        Assert(f.LoadCalls == 1 && f.Capture.AttachCalls == 1 && f.Capture.ArmCalls == 1,
            "host-view request after QR first use attaches and arms without another load");
    }

    private static void WindowedHostBrowserConnectionLoadsDetachedOnce()
    {
        var frames = new Queue<Action>();
        using var f = new Fixture(windowedHost: true, deferredLoad: true);
        var runtime = new BrowserServerRouteTests.RecordingSpirectlRuntime().NewEnvelopeFactory().RuntimeHost;
        var host = new HotReloadableBrowserServerHost(runtime, ".")
        {
            CaptureFirstUse = () => f.Deferred!.CouchUsed(frames.Enqueue),
        };
        var report = host.CreateBrowserDemandReporter();
        report(0, 1);
        Assert(frames.Count == 0 && f.LoadCalls == 0, "server startup and zero browser demand never load capture");
        report(1, 2);
        report(2, 3);
        Assert(frames.Count == 1 && f.LoadCalls == 0, "browser admissions defer and coalesce first use");
        frames.Dequeue()();
        report(0, 4);
        report(1, 5);
        host.CreateBrowserDemandReporter()(1, 1);
        Assert(f.LoadCalls == 1 && frames.Count == 0 && f.Capture.CurrentAttachmentState == "detached"
            && f.Capture.AttachCalls == 0 && f.Capture.ArmCalls == 0,
            "seat or host-view connections load lean once across reconnects and server generations");
        f.Arm();
        Assert(f.LoadCalls == 1 && f.Capture.AttachCalls == 1 && f.Capture.ArmCalls == 1,
            "host view attaches and arms the browser-triggered lean capture");
        host.DisposeAsync().AsTask().GetAwaiter().GetResult();
    }

    private static void WindowedHostRequestBeforeDeferredLoadAttachesOnce()
    {
        var frames = new Queue<Action>();
        using var f = new Fixture(windowedHost: true, deferredLoad: true);
        f.Deferred!.CouchUsed(frames.Enqueue);
        f.Arm();
        frames.Dequeue()();
        Assert(f.LoadCalls == 1 && f.Capture.AttachCalls == 1 && f.Capture.ArmCalls == 1,
            "request racing first use loads detached and attaches in the request turn; deferred callback is inert");
    }

    private static void WindowedHostQuitBeforeUseOrWhileLeanDoesNotLoad()
    {
        foreach (var state in new[] { "unused", "pending", "lean", "detached" })
        {
            var frames = new Queue<Action>();
            using var f = new Fixture(windowedHost: true, deferredLoad: true);
            if (state != "unused") f.Deferred!.CouchUsed(frames.Enqueue);
            if (state is "lean" or "detached") frames.Dequeue()();
            if (state == "detached")
            {
                f.Arm();
                f.Advance(RenderStreamSwap.GracePeriod);
                f.Capture.EmitDisarmed();
            }
            var loads = f.LoadCalls;
            var sequence = new HostCaptureQuitSequence(
                () => throw new Exception("unattached quit must not disarm"),
                _ => throw new Exception("unattached quit must not dispatch"),
                stopRenderer: () => { f.Deferred!.Stop(); f.Swap.Dispose(); });
            Assert(sequence.BeforeQuit(true, () => { }, captureAttached: false), $"{state} quit proceeds immediately");
            while (frames.TryDequeue(out var callback)) callback();
            f.Deferred!.CouchUsed(frames.Enqueue);
            f.Swap.Request("late", true);
            Assert(f.LoadCalls == loads && frames.Count == 0 && f.Deferred.EnsureLoaded() == "capture-stopped",
                $"{state} quit cancels pending first use and fences later loads");
        }
    }

    private static void WindowedHostLoadsThenAttachesOnLaterRequests()
    {
        using var f = new Fixture(windowedHost: true, deferredLoad: true);
        Assert(f.LoadCalls == 0 && f.Capture.Discoveries == 0 && f.Capture.Subscriptions == 0,
            "initial mirror demand never loads or queries capture");
        f.Arm();
        Assert(f.LoadCalls == 1 && f.Capture.AttachCalls == 1 && f.Capture.ArmCalls == 1,
            "first request without prior couch use loads detached, attaches and arms");
        Assert(f.Events.IndexOf("load") < f.Events.IndexOf("attach")
            && f.Events.IndexOf("attach") < f.Events.IndexOf("subscribe")
            && f.Events.IndexOf("subscribe") < f.Events.IndexOf("arm"), "load precedes subscription and arm");
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        Assert(f.Capture.AttachmentState == "detached", "mirror switch detaches after disarm");
        f.Events.Clear();
        f.Swap.Request("page", true);
        Assert(f.LoadCalls == 1 && f.Capture.AttachCalls == 2 && f.Capture.ArmCalls == 2,
            "later request attaches without loading again");
        Assert(f.Events.IndexOf("attach") < f.Events.IndexOf("arm"), "attach precedes the next arm");
    }

    private static void WindowedHostHelpersFollowAttachment()
    {
        var callbacks = new Queue<Action>();
        using var f = new Fixture(windowedHost: true, deferredLoad: true, deferSignal: callbacks.Enqueue);
        Assert(!f.Helpers.Installed && f.HelperInstalls == 0, "unused windowed host has no capture observers");
        f.Arm();
        Assert(f.Helpers.Installed && f.HelperInstalls == 1
            && f.Events.IndexOf("load") < f.Events.IndexOf("helpers:install")
            && f.Events.IndexOf("helpers:install") < f.Events.IndexOf("arm"),
            "load and current-node adoption finish before arm");
        f.Advance(RenderStreamSwap.GracePeriod);
        Assert(f.Helpers.Installed && f.HelperRemoves == 0, "observers remain installed during disarm");
        f.Capture.EmitDisarmed();
        f.Swap.Request("returning", true);
        callbacks.Dequeue()();
        Assert(f.Helpers.Installed && f.HelperInstalls == 1 && f.HelperRemoves == 0,
            "a returning page reuses observers without a detach cycle");
        f.Capture.EmitArmed(Snapshot("returning"));
        f.Swap.Request("page", false);
        f.Swap.Request("returning", false);
        f.Capture.EmitDisarmed();
        callbacks.Dequeue()();
        Assert(!f.Helpers.Installed && f.HelperRemoves == 1
            && f.Events.IndexOf("detach") < f.Events.IndexOf("helpers:remove"),
            "fully disarmed capture detaches before observers are removed");
        f.Events.Clear();
        f.Swap.Request("page", true);
        Assert(f.Helpers.Installed && f.HelperInstalls == 2
            && f.Events.IndexOf("attach") < f.Events.IndexOf("helpers:install")
            && f.Events.IndexOf("helpers:install") < f.Events.IndexOf("arm"),
            "reattach reinstalls observers before arming");
    }

    private static void WindowedHostHelperFailureKeepsMirror()
    {
        using var f = new Fixture(windowedHost: true, deferredLoad: true);
        f.HelpersSucceed = false;
        f.Swap.Request("page", true);
        Assert(f.Swap.State == "failed" && f.Capture.ArmCalls == 0 && !f.Helpers.Installed
            && f.HelperRemoves == 1 && f.Capture.DetachCalls == 1,
            "failed observer installation rolls back, detaches and keeps the mirror");
        f.HelpersSucceed = true;
        f.Swap.Request("page", true);
        Assert(f.Helpers.Installed && f.Capture.ArmCalls == 1, "explicit retry installs observers and arms");
    }

    private static void WindowedHostIdleDisarmsThenDetaches()
    {
        foreach (var release in new[] { false, true })
        {
            using var f = new Fixture(windowedHost: true, deferredLoad: true);
            f.Arm();
            if (release) f.Swap.Release("page");
            f.Advance(RenderStreamSwap.GracePeriod);
            Assert(f.Capture.DisarmCalls == 1 && f.Capture.DetachCalls == 0,
                "grace disarms before attempting detach, even with retained page preferences");
            f.Capture.EmitDisarmed();
            Assert(f.Capture.DetachCalls == 1 && f.Capture.AttachmentState == "detached"
                && f.Swap.State == "mirror", "disarmed detaches the idle host");
        }
    }

    private static void WindowedHostReturningPageSkipsDetach()
    {
        var callbacks = new Queue<Action>();
        using var f = new Fixture(windowedHost: true, deferredLoad: true, deferSignal: callbacks.Enqueue);
        f.Arm();
        f.Advance(RenderStreamSwap.GracePeriod);
        f.Capture.EmitDisarmed();
        f.Swap.Request("page", true);
        Assert(f.Capture.ArmCalls == 1 && f.Capture.DetachCalls == 0, "return waits for deferred disarm completion");
        callbacks.Dequeue()();
        Assert(f.Capture.ArmCalls == 2 && f.Capture.DetachCalls == 0 && f.Capture.AttachCalls == 1,
            "return during disarming re-arms the still attached capture");
    }

    private static void WindowedHostAttachFailureKeepsMirror()
    {
        using var f = new Fixture(windowedHost: true, deferredLoad: true);
        f.Arm();
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        f.Capture.AttachResult = 71;
        f.Swap.Request("page", true);
        Assert(f.Swap.State == "failed" && f.Swap.Reason == "attach-refused:71"
            && f.Swap.Snapshot is null && f.Swap.MirrorRestoreComplete,
            "attach refusal publishes the existing mirror fallback");
        Assert(f.Capture.ArmCalls == 1 && f.Capture.DetachCalls == 1
            && f.Logs.Any(log => log.Contains("attach-refused:71")), "failed attach is logged and never arms");
        Assert(!f.Helpers.Installed && f.HelperInstalls == 1, "failed attach leaves observers removed");
        f.Capture.AttachResult = 0;
        f.Swap.Request("page", true);
        Assert(f.Capture.AttachCalls == 3 && f.Capture.ArmCalls == 2, "explicit request retries failed attach");
    }

    private static void WindowedHostLoadFailureCanRetry()
    {
        using var f = new Fixture(windowedHost: true, deferredLoad: true);
        f.LoadSucceeds = false;
        f.Swap.Request("page", true);
        Assert(f.Swap.State == "failed" && f.Swap.Reason == "load-failed:Failed"
            && f.Swap.MirrorRestoreComplete && f.Capture.ArmCalls == 0 && f.Capture.AttachCalls == 0,
            "failed load leaves mirror available without attaching or arming");
        f.LoadSucceeds = true;
        f.Swap.Request("page", true);
        Assert(f.LoadCalls == 2 && f.Capture.ArmCalls == 1, "explicit request retries a failed load");
    }

    private static void WindowedHostDetachFailureStaysAttached()
    {
        using var f = new Fixture(windowedHost: true, deferredLoad: true);
        f.Arm();
        f.Capture.DetachResult = 72;
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        Assert(f.Swap.State == "mirror" && f.Capture.CurrentState == "standby"
            && f.Capture.AttachmentState == "attached" && f.Logs.Any(log => log.Contains("detach-refused:72")),
            "detach refusal logs its code and keeps attached standby usable");
        Assert(f.Helpers.Installed && f.HelperRemoves == 0, "detach failure keeps attached observers");
        f.Swap.Request("page", true);
        Assert(f.LoadCalls == 1 && f.Capture.AttachCalls == 1 && f.Capture.ArmCalls == 2,
            "attached standby arms directly after a failed detach");
    }

    private static void HeadlessCaptureNeverAttachesOrDetaches()
    {
        using var f = new Fixture();
        f.Arm();
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        f.Arm();
        f.Advance(RenderStreamSwap.GracePeriod);
        f.Capture.EmitDisarmed();
        Assert(f.Capture.AttachCalls == 0 && f.Capture.DetachCalls == 0
            && f.Capture.AttachmentReads == 0, "headless host and seat paths keep their init-time attachment");
        Assert(f.Helpers.Installed && f.HelperInstalls == 1 && f.HelperRemoves == 0,
            "headless host and seat observers keep their startup lifetime");
    }

    private static void WindowedHostQuitCannotAttachAgain()
    {
        using var f = new Fixture(windowedHost: true, deferredLoad: true);
        f.Arm();
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        f.Swap.Dispose();
        f.Swap.Request("late", true);
        Assert(f.LoadCalls == 1 && f.Capture.AttachCalls == 1 && f.Capture.ArmCalls == 1,
            "quit fence rejects requests while detached");
    }

    private static void WindowedHostQuitDuringDisarmCannotRearmOrDetach()
    {
        var callbacks = new Queue<Action>();
        using var f = new Fixture(windowedHost: true, deferredLoad: true, deferSignal: callbacks.Enqueue);
        f.Arm();
        f.Swap.Request("page", false);
        f.Swap.Request("page", true);
        f.Capture.EmitDisarmed();
        f.Swap.Dispose();
        callbacks.Dequeue()();
        Assert(f.Capture.ArmCalls == 1 && f.Capture.DetachCalls == 0 && f.Capture.AttachCalls == 1,
            "quit fence rejects deferred teardown and rearm callbacks");
    }

    private static void WindowedHostObservesAndRestoresPresentation()
    {
        foreach (var aspect in new[] { 16.0 / 9, 21.0 / 9 })
        {
            var frames = new Queue<Action>();
            using var f = new Fixture(windowedHost: true, deferPresentation: frames.Enqueue);
            f.Swap.Request("page", true, aspect);
            var width = aspect > 2 ? 2520 : 1920;
            Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == "observe", "windowed capture observes the root");
            Assert(f.Window!.SizeWrites == 0 && f.Window.ContentScaleSize == new Godot.Vector2I(width, 1080)
                && f.Window.ContentScaleAspect == Godot.Window.ContentScaleAspectEnum.Keep,
                "arm sets the logical viewport without resizing the window");
            Assert(!f.Swap.PresentationReady, "logical viewport readiness waits for the frame");
            frames.Dequeue()();
            Assert(f.Swap.PresentationReady && f.Swap.PresentationWidth == width,
                "logical presentation settles independently of the physical window size");
            f.Capture.EmitArmed(Snapshot("windowed"));
            f.Swap.Request("page", false);
            f.Capture.EmitDisarmed();
            Assert(f.Window.ContentScaleSize == new Godot.Vector2I(1680, 1080)
                && f.Window.ContentScaleAspect == Godot.Window.ContentScaleAspectEnum.Expand
                && f.Window.ContentScaleMode == Godot.Window.ContentScaleModeEnum.CanvasItems
                && !f.Presentation.StreamOwnsPresentation && f.Window.SizeWrites == 0,
                "capture teardown restores the player's settings without window writes");
            Assert(!f.Swap.MirrorRestoreComplete, "restoration readiness waits for a frame too");
            frames.Dequeue()();
            Assert(f.Swap.MirrorRestoreComplete && f.Swap.PresentationReady, "restored mirror settles");
        }
    }

    private static void WindowedHostMissingAutoHooksKeepsMirror()
    {
        using var f = new Fixture(windowedHost: true, autoHandlersAvailable: false);
        f.Swap.Request("page", true, 21.0 / 9);
        Assert(f.Capture.ArmCalls == 0 && f.Window!.Writes == 0 && !f.Presentation.StreamOwnsPresentation,
            "missing Auto hooks keep capture in standby and the player display unchanged");
        Assert(f.Swap.State == "failed" && f.Swap.Reason == "presentation-unavailable"
            && f.Swap.MirrorRestoreComplete && f.SuspenderEnabled,
            "the host keeps the old renderer when safe windowed presentation is unavailable");
    }

    private static void WindowedHostDisposalRestoresPresentation()
    {
        using var f = new Fixture(windowedHost: true);
        f.Swap.Request("page", true, 21.0 / 9);
        f.Swap.Dispose();
        Assert(!f.Presentation.StreamOwnsPresentation && f.Window!.ContentScaleSize == new Godot.Vector2I(1680, 1080)
            && f.Window.ContentScaleAspect == Godot.Window.ContentScaleAspectEnum.Expand
            && f.Window.SizeWrites == 0, "quit or renderer disposal releases the player's presentation snapshot");
        f.Capture.EmitDisarmed();
        Assert(f.Capture.ArmCalls == 1, "disposal restoration cannot rearm capture");
    }

    private static void WindowedHostArmFailureRestoresPresentation()
    {
        using var f = new Fixture(windowedHost: true);
        f.Capture.ArmResult = 1;
        f.Swap.Request("page", true, 21.0 / 9);
        Assert(f.Swap.State == "failed" && f.Swap.MirrorRestoreComplete && !f.Presentation.StreamOwnsPresentation,
            "failed windowed arm releases presentation");
        Assert(f.Window!.ContentScaleSize == new Godot.Vector2I(1680, 1080)
            && f.Window.ContentScaleAspect == Godot.Window.ContentScaleAspectEnum.Expand && f.Window.SizeWrites == 0,
            "failed arm restores player settings without window writes");
    }

    private static void WindowedHostAspectRearmKeepsPlayerSettings()
    {
        using var f = new Fixture(windowedHost: true);
        f.Swap.Request("page", true, 21.0 / 9);
        f.Capture.EmitArmed(Snapshot("wide"));
        f.Swap.Request("page", true, 2);
        f.Capture.EmitDisarmed();
        Assert(f.Capture.ArmCalls == 2 && f.Capture.Options!["GRC_ROOT_SIZE"] == "observe"
            && f.Window!.ContentScaleSize == new Godot.Vector2I(2160, 1080),
            "aspect rearm keeps observe mode and applies the new logical width");
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        Assert(f.Window!.ContentScaleSize == new Godot.Vector2I(1680, 1080)
            && f.Window.ContentScaleAspect == Godot.Window.ContentScaleAspectEnum.Expand && f.Window.SizeWrites == 0,
            "the second teardown restores the original player settings without resizing the window");
    }

    private static void FailedArmNeverArmsSpineFreeze()
    {
        using var f = new Fixture();
        f.Capture.ArmResult = 1;
        f.Swap.Request("page", true);
        Assert(!f.StreamSpinesArmed && f.SuspenderEnabled, "failed arm restores the old path without stream freeze");
    }

    private static void MixedRendererJoinOrders()
    {
        foreach (var mirrorFirst in new[] { true, false })
        {
            using var f = new Fixture();
            if (mirrorFirst) f.Swap.UpdatePage("old", false, true, null);
            f.Swap.Request("wide", true, 3);
            f.Capture.EmitArmed(Snapshot("wide"));
            if (!mirrorFirst)
            {
                f.Swap.UpdatePage("old", false, true, null);
                Assert(!f.Swap.PresentationReady && f.Swap.State == "disarming", "late mirror closes admission before teardown");
                f.Capture.EmitDisarmed();
                f.Capture.EmitArmed(Snapshot("mixed"));
            }
            Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:1920x1080", "either join order uses shared mirror dimensions");
            Assert(f.Swap.State == "armed" && f.Swap.PresentationReady && f.Swap.MirrorRestoreComplete,
                "capture remains armed while the mirror is ready at base dimensions");
        }
    }

    private static void MirrorWatchIntentResizesBeforeAdmission()
    {
        using var f = new Fixture();
        f.Swap.Request("wide", true, 3);
        f.Capture.EmitArmed(Snapshot("wide"));
        var epoch = f.Swap.PresentationEpoch;
        f.Swap.UpdatePage("returning", false, true, null);
        Assert(f.Swap.PresentationEpoch > epoch && !f.Swap.PresentationReady, "watch intent immediately fences wide scenes and input");
        f.Swap.Request("wide", true, 2.2);
        f.Capture.EmitDisarmed();
        Assert(f.Capture.ArmCalls == 2 && f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:1920x1080", "held mirror demand wins during teardown");
    }

    private static void HiddenAndDisconnectedMirrorReleaseConstraint()
    {
        foreach (var disconnect in new[] { true, false })
        {
            using var f = new Fixture();
            f.Swap.UpdatePage("old", false, true, null);
            f.Swap.Request("wide", true, 3);
            f.Capture.EmitArmed(Snapshot("base"));
            if (disconnect) f.Swap.Release("old");
            else f.Swap.UpdatePage("old", false, false, null);
            Assert(f.Swap.State == "disarming", "withdrawn watch intent recomputes effective dimensions");
            f.Capture.EmitDisarmed();
            Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:2520x1080", "remaining stream recovers its aspect");
        }
    }

    private static void SquarestStreamAndNewestTargetWin()
    {
        using var f = new Fixture();
        f.Swap.Request("first", true, 2);
        f.Capture.EmitArmed(Snapshot("first"));
        f.Swap.Request("second", true, 3);
        Assert(f.Capture.DisarmCalls == 0, "wider requester cannot override the squarest");
        f.Swap.Release("first");
        Assert(f.Swap.State == "disarming", "squarest disconnect recomputes");
        f.Swap.Request("second", true, 2.2);
        f.Swap.Request("second", true, 2.3);
        f.Capture.EmitDisarmed();
        Assert(f.Capture.DisarmCalls == 1 && f.Capture.ArmCalls == 2
            && f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:2484x1080", "one teardown applies only the latest target");
    }

    private static void StandardStreamConstrainsWideViewer()
    {
        using var f = new Fixture();
        f.Swap.Request("wide", true, 2);
        f.Swap.Request("standard", true, 16.0 / 9);
        f.Capture.EmitDisarmed();
        f.Capture.EmitArmed(Snapshot("shared"));
        Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:1920x1080", "squarest stream constrains the shared arm");
        f.Swap.Release("standard");
        Assert(f.Swap.State == "disarming", "departing squarest stream starts teardown");
        f.Capture.EmitDisarmed();
        Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:2160x1080", "remaining wide stream supplies the next arm");
    }

    private static void NullAspectConstrainsArmedSeat()
    {
        using var f = new Fixture();
        f.Swap.Request("wide", true, 2340.0 / 1080);
        f.Capture.EmitArmed(Snapshot("wide"));
        f.Swap.Request("unstretched", true);
        Assert(f.Capture.DisarmCalls == 1 && f.Swap.State == "disarming", "null aspect narrows an armed seat");
        f.Capture.EmitDisarmed();
        Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:1920x1080", "stretch off counts as standard aspect");
    }

    private static void AspectUpdateRearmsAtNewWidth()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true, 2340.0 / 1080);
        f.Capture.EmitArmed(Snapshot("wide"));
        f.Swap.UpdatePage("page", true, true, 21.0 / 9);
        Assert(f.Capture.DisarmCalls == 1 && f.Capture.ArmCalls == 1, "aspect update waits for teardown");
        f.Capture.EmitDisarmed();
        Assert(f.Capture.ArmCalls == 2 && f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:2520x1080", "aspect update re-arms at the new width");
    }

    private static void QuantizedAspectUpdateKeepsCapture()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true, 2340.0 / 1080);
        f.Capture.EmitArmed(Snapshot("wide"));
        f.Swap.UpdatePage("page", true, true, 2340.1 / 1080);
        Assert(f.Swap.State == "armed" && f.Capture.DisarmCalls == 0 && f.Capture.ArmCalls == 1,
            "aspect update with the same quantized width leaves capture alone");
    }

    private static void GracePreservesPageFacts()
    {
        using var f = new Fixture();
        f.Swap.UpdatePage("old", false, true, null);
        f.Swap.Request("wide", true, 3);
        f.Capture.EmitArmed(Snapshot("base"));
        f.Advance(TimeSpan.FromSeconds(90));
        f.Capture.EmitDisarmed();
        Assert(f.Capture.ArmCalls == 1 && f.Swap.WantingPages.Contains("wide"), "grace retires capture without deleting page preferences");
        f.Swap.Request("wide", true, 3);
        Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:1920x1080", "retry still respects retained mirror watch intent");
    }

    private static void DisconnectedPreferencesAreBounded()
    {
        using var f = new Fixture();
        for (var i = 0; i < RenderStreamSwap.MaxRetainedPages + 10; i++)
        {
            f.Swap.UpdatePage($"page-{i}", false, false, null);
            f.Swap.Release($"page-{i}");
        }
        var pages = (System.Collections.IDictionary)typeof(RenderStreamSwap)
            .GetField("_pages", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(f.Swap)!;
        Assert(pages.Count == RenderStreamSwap.MaxRetainedPages && !pages.Contains("page-0")
            && pages.Contains($"page-{RenderStreamSwap.MaxRetainedPages + 9}"), "only recent disconnected preferences are retained");
        Assert(f.Capture.Discoveries == 0, "retention maintenance does no capture work");
    }

    private static void ReconnectRespectsSquarestViewer()
    {
        using var f = new Fixture();
        f.Swap.Request("first", true, 2);
        f.Swap.Request("second", true, 2);
        f.Capture.EmitArmed(Snapshot("initial"));
        f.Swap.Release("first");
        f.Swap.UpdatePage("first", true, false, 3);
        Assert(f.Swap.State == "armed" && f.Capture.DisarmCalls == 0, "reconnected wider requester respects the squarest viewer");
        Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:2160x1080", "request order does not override the squarest aspect");
    }

    private static void PresentationReadyIsIndependentOfCapture()
    {
        var frames = new Queue<Action>();
        using var f = new Fixture(deferPresentation: frames.Enqueue);
        f.Swap.Request("wide", true, 3);
        Assert(!f.Swap.PresentationReady, "layout waits a frame");
        frames.Dequeue()();
        Assert(f.Swap.PresentationReady && f.Swap.State == "arming" && f.Swap.Snapshot is null, "settled layout is independent of capture readiness");
        f.Capture.EmitArmed(Snapshot("wide"));
        f.Capture.DisarmResult = 1;
        f.Swap.Request("wide", false);
        Assert(!f.Swap.PresentationReady && !f.Swap.MirrorRestoreComplete, "refused teardown cannot publish ready");
    }

    private static void FailedPresentationRestoresOrRemainsUnready()
    {
        foreach (var canRestore in new[] { true, false })
        {
            using var f = new Fixture(canApply: width => canRestore && width == 1920);
            f.Swap.Request("wide", true, 3);
            Assert(f.Capture.ArmCalls == 0 && f.Swap.State == "failed", "failed presentation never arms capture");
            Assert(f.Swap.PresentationReady == canRestore && f.SuspenderEnabled == canRestore,
                "failed presentation restores the mirror if possible and otherwise stays unready");
            Assert(f.PresentationChanges.SequenceEqual(new[] { (true, 2520), (false, 1920) }),
                "failed wide apply relinquishes presentation ownership before waiting for a root");
        }
    }

    private static void FailedReassertInvalidatesPendingReadiness()
    {
        var frames = new Queue<Action>();
        using var f = new Fixture(deferPresentation: frames.Enqueue);
        f.Swap.Request("wide", true, 3);
        typeof(RenderStreamSwap).GetMethod("ReassertedPresentation", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
            .Invoke(f.Swap, [false]);
        frames.Dequeue()();
        Assert(!f.Swap.PresentationReady && !f.Swap.MirrorRestoreComplete,
            "a failed reassert must invalidate an older deferred ready callback");
    }

    private static void LaterReassertSupersedesPendingReadiness()
    {
        var frames = new Queue<Action>();
        using var f = new Fixture(deferPresentation: frames.Enqueue);
        f.Swap.Request("wide", true, 3);
        typeof(RenderStreamSwap).GetMethod("InvalidatePresentation", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
            .Invoke(f.Swap, null);
        typeof(RenderStreamSwap).GetMethod("ReassertedPresentation", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
            .Invoke(f.Swap, [true]);
        frames.Dequeue()();
        Assert(!f.Swap.PresentationReady, "the first layout settlement cannot race a later reassertion");
        frames.Dequeue()();
        Assert(f.Swap.PresentationReady, "only the most recent successful reassert settles readiness");
    }

    private static void ForcedTrimBypassesIdleAndIntervalGates()
    {
        var calls = 0;
        var gate = new HeadlessMallocTrim.Gate(() => calls++);
        gate.MaybeTrim(idleMs: 0, nowMs: 100);
        Assert(calls == 0, "activity prevents an idle trim");
        gate.Trim(100);
        gate.Trim(101);
        Assert(calls == 2 && gate.TrimCount == 2, "teardown trims immediately even within the maintenance interval");
        gate.MaybeTrim(idleMs: 5000, nowMs: 102);
        Assert(calls == 2, "forced trim also starts the maintenance interval");
    }

    private static void IdleTrimRetainsItsGates()
    {
        var calls = 0;
        var gate = new HeadlessMallocTrim.Gate(() => calls++);
        gate.MaybeTrim(idleMs: 4999, nowMs: 100);
        Assert(calls == 0, "maintenance waits for idle");
        gate.MaybeTrim(idleMs: 5000, nowMs: 100);
        gate.MaybeTrim(idleMs: 5000, nowMs: 30099);
        Assert(calls == 1, "maintenance retains its minimum interval");
        gate.MaybeTrim(idleMs: 5000, nowMs: 30100);
        Assert(calls == 2, "maintenance can trim at the interval boundary");
    }

    private static void MissingTrimSymbolLatchesOffBothPaths()
    {
        foreach (var error in new Exception[] { new DllNotFoundException(), new EntryPointNotFoundException() })
        foreach (var forceFirst in new[] { false, true })
        {
            var calls = 0;
            var gate = new HeadlessMallocTrim.Gate(() => { calls++; throw error; });
            if (forceFirst) gate.Trim(100);
            else gate.MaybeTrim(idleMs: 5000, nowMs: 100);
            gate.Trim(101);
            gate.MaybeTrim(idleMs: 5000, nowMs: 30100);
            Assert(calls == 1 && gate.TrimCount == 0, "a missing libc symbol latches off both paths after one attempt");
        }
    }

    private static void InitialMirrorDoesNoCaptureWork()
    {
        using var f = new Fixture();
        Assert(f.Swap.State == "mirror" && f.Swap.Reason is null && f.Swap.Snapshot is null, "initial mirror state");
        Assert(f.Events.Count == 0 && f.Capture.Discoveries == 0 && f.Deadlines.Count == 0, "construction has no capture effects");
    }

    private static void ArmResumesBeforeCallingCapture()
    {
        using var f = new Fixture();
        f.Capture.BeforeArm = () => Assert(f.Events[0] == "subscribe" && f.Events.IndexOf("suspender:False") < f.Events.IndexOf("changed:arming") && f.Events[^1] == "arm",
            "subscribe and resume before arm, publishing arming along the way");
        f.Swap.Request("page", true);
        Assert(f.Swap.State == "arming" && f.Swap.Snapshot is null, "arming has no descriptor");
        Assert(f.Capture.Options is { Count: 1 } && f.Capture.Options["GRC_ROOT_SIZE"] == "presentation:1920x1080",
            "only the per-arm root size overrides the standby environment");
    }

    private static void ArmUsesTheRequestingAspectAndConfiguredCap()
    {
        foreach (var (aspect, cap, width) in new (double?, int, int)[]
        {
            (null, 2520, 1920), (double.NaN, 2520, 1920), (double.PositiveInfinity, 2520, 1920),
            (0.2, 2520, 1920), (5.1, 2520, 1920), (0.25, 2520, 1920),
            (2340.0 / 1080, 2520, 2340), (3, 2520, 2520), (3, 2600, 2600),
            (1940.0 / 1080, 2520, 1938), (3, 1000, 1920),
        })
        {
            using var f = new Fixture(cap);
            f.Swap.Request("page", true, aspect);
            Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == $"presentation:{width}x1080", "aspect follows presentation width clamping");
        }
    }

    private static void WideArmOwnsPresentationUntilDisarmed()
    {
        using var f = new Fixture();
        f.Capture.BeforeArm = () => Assert(f.PresentationChanges.SequenceEqual(new[] { (true, 2340) }),
            "expand and the wide window are set before capture queries the presentation");
        f.Swap.Request("page", true, 2340.0 / 1080);
        Assert(f.Presentation.ReassertMirror() && f.PresentationChanges[^1] == (true, 2340), "arming reasserts its effective wide presentation");
        f.Capture.EmitArmed(Snapshot("wide"));
        f.Presentation.ReassertMirror();
        Assert(f.PresentationChanges[^1] == (true, 2340), "armed notifications retain wide presentation");
        f.Swap.Request("page", false);
        f.Presentation.ReassertMirror();
        Assert(f.PresentationChanges[^1] == (true, 2340), "capture retains presentation during teardown");
        f.Capture.EmitDisarmed();
        Assert(f.PresentationChanges[^1] == (false, 1920), "disarmed restores Keep and a 1920 window");
        Assert(f.PresentationWhenResumed is (false, 1920), "mirror resumes only after its presentation is restored");
        f.Presentation.ReassertMirror();
        Assert(f.PresentationChanges[^1] == (false, 1920), "mirror re-asserts resume after restoration");
    }

    private static void MirrorAndStandardArmKeepTheirPresentation()
    {
        using var f = new Fixture();
        f.Presentation.ReassertMirror();
        Assert(f.PresentationChanges.SequenceEqual(new[] { (false, 1920) }), "mirror seat asserts Keep and 1920");
        f.Swap.Request("page", true, 1920.0 / 1080);
        f.Capture.EmitArmed(Snapshot("standard"));
        Assert(f.PresentationChanges.All(p => p == (false, 1920)), "16:9 arm retains base presentation");
        f.Presentation.ReassertMirror();
        Assert(f.PresentationChanges.All(p => p == (false, 1920)),
            "16:9 capture keeps the existing mirror policy");
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        Assert(f.PresentationChanges.All(p => p == (false, 1920)), "16:9 teardown retains base presentation");
    }

    private static void WideArmFailuresRestoreBeforeResumingMirror()
    {
        foreach (var synchronous in new[] { false, true })
        {
            var nextFrame = new Queue<Action>();
            using var f = new Fixture(deferSignal: nextFrame.Enqueue);
            if (synchronous) f.Capture.ArmResult = 9;
            f.Swap.Request("page", true, 2340.0 / 1080);
            if (!synchronous)
            {
                f.Capture.EmitArmFailed("failed");
                Assert(f.PresentationChanges.Count == 1 && !f.SuspenderEnabled, "signal waits a frame before restoring");
                nextFrame.Dequeue()();
            }
            Assert(f.Swap.State == "failed" && f.PresentationWhenResumed is (false, 1920), "failed arm restores before mirror resume");
            Assert(f.PresentationChanges.SequenceEqual(new[] { (true, 2340), (false, 1920) }), "failed arm releases wide ownership");
        }
    }

    private static void DeferredDisarmedRestoresBeforeRearm()
    {
        var nextFrame = new Queue<Action>();
        using var f = new Fixture(deferSignal: nextFrame.Enqueue);
        f.Swap.Request("page", true, 2340.0 / 1080);
        f.Capture.EmitArmed(Snapshot("wide"));
        f.Swap.Request("page", false);
        f.Swap.Release("page");
        f.Swap.Request("reload", true, 2520.0 / 1080);
        f.Capture.EmitDisarmed();
        f.Capture.EmitDisarmed();
        Assert(!f.SuspenderEnabled && f.PresentationChanges.Count == 1, "disarmed signal does no inline window reads or writes");
        nextFrame.Dequeue()();
        Assert(f.PresentationChanges.SequenceEqual(new[] { (true, 2340), (false, 1920), (true, 2520) }), "restore precedes the next wide arm");
        Assert(f.PresentationWhenResumed is (false, 1920) && f.Capture.ArmCalls == 2, "resume sees mirror dimensions before rearm");
        nextFrame.Dequeue()();
        Assert(f.Swap.State == "arming" && f.PresentationChanges.Count == 3, "duplicate deferred teardown cannot restore over a newer arm");
    }

    private static void RestoreCompletionFollowsDeferredRestoration()
    {
        foreach (var failed in new[] { false, true })
        {
            var nextFrame = new Queue<Action>();
            using var f = new Fixture(deferSignal: nextFrame.Enqueue);
            Assert(f.Swap.MirrorRestoreComplete, "initial mirror is restored");
            f.Swap.Request("page", true, 2340.0 / 1080);
            f.Capture.EmitArmed(Snapshot("wide"));
            if (failed) f.Capture.EmitStreamEnded("ended");
            else f.Swap.Request("page", false);
            Assert(!f.Swap.MirrorRestoreComplete, "early fallback is not a restoration completion");
            f.Capture.EmitDisarmed();
            Assert(!f.Swap.MirrorRestoreComplete, "capture signal alone cannot release the mirror");
            var changes = f.Changes.Count;
            nextFrame.Dequeue()();
            Assert(f.Swap.MirrorRestoreComplete && f.SuspenderEnabled && f.PresentationWhenResumed is (false, 1920),
                "completion follows presentation and visual-suspender restoration");
            Assert(f.Changes.Count > changes, "completion is published even for a failed stream");
        }
    }

    private static void DisposedSwapIgnoresDeferredRestore()
    {
        var nextFrame = new Queue<Action>();
        using var f = new Fixture(deferSignal: nextFrame.Enqueue);
        f.Swap.Request("page", true, 2340.0 / 1080);
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        f.Swap.Dispose();
        nextFrame.Dequeue()();
        Assert(f.PresentationChanges.Count == 1 && !f.SuspenderEnabled, "disposed swap cannot change the window from a queued signal");
    }

    private static void OnlyArmedPublishesTheSnapshot()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true);
        var snapshot = Snapshot("first");
        f.Capture.EmitArmed(snapshot);
        Assert(ReferenceEquals(f.Swap.Snapshot, snapshot), "signal facts are preserved, including certificate and root size");
        Assert(f.Swap.State == "armed" && f.Swap.Reason is null, "armed is exposed to pages");
        Assert(f.Changes[^1] == ("armed", snapshot), "change notification sees the armed snapshot");
        Assert(!snapshot.ToString().Contains(snapshot.Token, StringComparison.Ordinal), "snapshot formatting excludes the token");
    }

    private static void RefusedArmRestoresTheSuspender()
    {
        foreach (var result in new[] { 31, 44 })
        {
            using var f = new Fixture();
            f.Capture.ArmResult = result;
            f.Swap.Request("page", true);
            Assert(f.Swap.State == "failed" && f.Swap.Reason == $"arm-refused:{result}", "refusal is observable without a signal");
            Assert(f.SuspenderEnabled && f.Swap.Snapshot is null && f.Deadlines.Count == 0, "refusal restores mirror immediately");
            f.Capture.ArmResult = 0;
            f.Swap.Request("page", true);
            Assert(f.Capture.ArmCalls == 2 && f.Swap.State == "arming", "an explicit request retries a refused arm");
        }
    }

    private static void ArmFailureAllowsAnExplicitRetry()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true);
        f.Capture.EmitArmFailed("capture-start-failed");
        Assert(f.Swap.State == "failed" && f.Swap.Reason == "capture-start-failed" && f.SuspenderEnabled, "arm failure restores mirror");
        Assert(f.Capture.ArmCalls == 1 && f.TrimCalls == 0, "failure does not automatically retry or trim");
        f.Swap.Request("page", true);
        Assert(f.Swap.State == "arming" && f.Swap.Reason is null && f.Capture.Subscriptions == 1, "retry keeps the persistent subscription");
    }

    private static void PagesShareOneArm()
    {
        using var f = new Fixture();
        f.Swap.Request("one", true);
        f.Swap.Request("two", true, 3);
        f.Capture.EmitArmed(Snapshot("first"));
        f.Swap.Request("two", true, 2);
        Assert(f.Capture.ArmCalls == 1 && f.Capture.Subscriptions == 1, "requests during arming and armed share the capture");
        Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:1920x1080", "the first requester owns this arm's size");
    }

    private static void OnlyTheLastMirrorRequestDisarms()
    {
        using var f = new Fixture();
        f.Arm();
        f.Swap.Request("two", true);
        f.Swap.Request("page", false);
        Assert(f.Capture.DisarmCalls == 0, "another wanting page keeps the capture");
        f.Swap.Request("two", false);
        Assert(f.Capture.DisarmCalls == 1 && f.Capture.DisarmReason == "mirror", "last explicit mirror request disarms");

        using var released = new Fixture();
        released.Arm();
        released.Swap.Request("two", true);
        released.Swap.Release("page");
        Assert(released.Capture.DisarmCalls == 0, "one released page does not disarm");
        released.Swap.Request("two", false);
        Assert(released.Capture.DisarmCalls == 1, "released pages no longer count as wanting the stream");
    }

    private static void MirrorCanCancelAnArmingCapture()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true);
        f.Swap.Request("page", false);
        Assert(f.Capture.DisarmCalls == 1 && f.Swap.State == "disarming", "arming can be cancelled");
        f.Capture.EmitArmed(Snapshot("late"));
        Assert(f.Swap.Snapshot is null && f.Deadlines.Count == 0, "late armed cannot republish during teardown");
        f.Capture.EmitDisarmed();
        Assert(f.SuspenderEnabled && f.TrimCalls == 1 && f.Capture.ArmCalls == 1, "cancelled arm stays in mirror after teardown");
    }

    private static void DisarmClearsTheSnapshotBeforeCallingCapture()
    {
        using var f = new Fixture();
        f.Arm();
        f.Events.Clear();
        f.Capture.BeforeDisarm = () =>
        {
            Assert(f.Swap.Snapshot is null && f.Swap.State == "disarming", "descriptor is already cleared inside Disarm");
            Assert(f.Events.SequenceEqual(new[] { "changed:armed", "changed:disarming", "disarm" }), "change notification precedes capture teardown");
            Assert(!f.SuspenderEnabled && f.TrimCalls == 0, "suspender and trim wait for disarmed");
        };
        f.Swap.Request("page", false);
        Assert(f.Capture.LingerMs == 1500, "normal teardown keeps the capture's default linger");
        f.Capture.EmitDisarmed();
        Assert(f.Events.IndexOf("suspender:True") < f.Events.IndexOf("trim") && f.Events[^1] == "changed:mirror", "disarmed resumes memory saving then requests trim");
        f.Capture.EmitDisarmed();
        Assert(f.TrimCalls == 1, "a duplicate disarmed signal cannot trim again");
    }

    private static void NeverConnectedCaptureGetsNinetySeconds()
    {
        using var f = new Fixture();
        f.Arm();
        Assert(f.Deadlines is [{ Delay: var delay }] && delay == TimeSpan.FromSeconds(90), "armed starts one ninety-second grace for zero clients");
        var reads = f.Capture.ClientReads;
        f.Advance(TimeSpan.FromMilliseconds(89_999));
        Assert(f.Capture.DisarmCalls == 0, "grace does not expire early");
        f.Advance(TimeSpan.FromMilliseconds(1));
        Assert(f.Capture.DisarmReason == "grace" && f.Swap.Snapshot is null, "never-connected capture disarms at grace");
        Assert(f.Capture.ClientReads == reads && f.Capture.StateReads == 0, "deadline does not poll capture state");
        f.Capture.EmitDisarmed();
        Assert(f.Capture.ArmCalls == 1 && f.Swap.WantingPages.SequenceEqual(new[] { "page" }), "grace preserves page preference without automatically rearming");
    }

    private static void ConnectingCancelsGrace()
    {
        using var f = new Fixture();
        f.Arm();
        f.Capture.EmitClientConnected(1);
        Assert(f.Deadlines[0].Cancelled, "client connection cancels the grace handle");
        f.Advance(TimeSpan.FromMinutes(5));
        Assert(f.Capture.DisarmCalls == 0, "connected stream is not timed out");

        using var alreadyConnected = new Fixture();
        alreadyConnected.Capture.ClientCount = 1;
        alreadyConnected.Arm();
        Assert(alreadyConnected.Deadlines.Count == 0, "armed with clients does not start grace");
    }

    private static void OnlyTheLastClientLeavingStartsGrace()
    {
        using var f = new Fixture();
        f.Capture.ClientCount = 2;
        f.Arm();
        f.Capture.EmitClientLeft(1);
        Assert(f.Deadlines.Count == 0, "non-last client departure does not start grace");
        f.Capture.EmitClientLeft(0);
        Assert(f.Deadlines.Count == 1, "last departure starts a one-shot grace");
        f.Capture.EmitClientConnected(1);
        Assert(f.Deadlines[0].Cancelled, "reconnection cancels departure grace");
        f.Capture.EmitClientLeft(0);
        f.Advance(TimeSpan.FromSeconds(90));
        Assert(f.Capture.DisarmReason == "grace", "a later last departure gets its own grace");
    }

    private static void CancelledDeadlinesCannotDisarmALaterArm()
    {
        using var f = new Fixture();
        f.Arm();
        var stale = f.Deadlines[0];
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        f.Arm();
        stale.Callback();
        Assert(f.Capture.DisarmCalls == 1 && f.Swap.State == "armed", "cancelled callback cannot affect a newer arm");
    }

    private static void ReleaseAndReloadDoNotResetGrace()
    {
        using var f = new Fixture();
        f.Arm();
        f.Advance(TimeSpan.FromSeconds(40));
        f.Swap.Release("page");
        Assert(f.Capture.DisarmCalls == 0, "socket closure alone does not disarm");
        f.Swap.Request("reload", true);
        Assert(f.Deadlines.Count == 1 && f.Capture.ArmCalls == 1, "reload inherits the current arm and deadline");
        f.Advance(TimeSpan.FromSeconds(50));
        Assert(f.Capture.DisarmReason == "grace", "page demand alone does not extend stream-client grace");
    }

    private static void RequestDuringDisarmRearmsAfterTeardown()
    {
        using var f = new Fixture();
        f.Arm();
        f.Swap.Request("page", false);
        f.Swap.Release("page");
        f.Swap.Request("reload", true, 2340.0 / 1080);
        Assert(f.Capture.ArmCalls == 1 && f.Swap.Snapshot is null, "request waits while disarming");
        f.Events.Clear();
        f.Capture.EmitDisarmed();
        Assert(f.Events.IndexOf("suspender:True") < f.Events.IndexOf("trim") && f.Events.IndexOf("trim") < f.Events.IndexOf("suspender:False") && f.Events[^1] == "arm",
            "teardown restores and trims before the next arm resumes visuals");
        Assert(f.Capture.ArmCalls == 2 && f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:2340x1080", "pending page supplies the next size");
    }

    private static void WithdrawnDemandDuringDisarmDoesNotRearm()
    {
        foreach (var release in new[] { false, true })
        {
            using var f = new Fixture();
            f.Arm();
            f.Swap.Request("page", false);
            f.Swap.Request("reload", true);
            if (release) f.Swap.Release("reload");
            else f.Swap.Request("reload", false);
            f.Capture.EmitDisarmed();
            Assert(f.Capture.ArmCalls == 1 && f.Swap.State == "mirror", "withdrawn pending demand does not rearm");
        }
    }

    private static void StreamEndedFailsWithoutAutomaticRearm()
    {
        using var f = new Fixture();
        f.Arm();
        f.Swap.Request("two", true);
        var reason = new string('x', 100);
        f.Capture.BeforeDisarm = () => Assert(f.Swap.State == "failed" && f.Swap.Reason == reason && f.Swap.Snapshot is null,
            "failure and mirror fallback are published before disarm");
        f.Capture.EmitStreamEnded(reason);
        Assert(f.Capture.DisarmReason == "stream-ended" && f.Deadlines[0].Cancelled, "ended disarms with a bounded reason and cancels grace");
        f.Capture.EmitDisarmed();
        Assert(f.Swap.State == "failed" && f.Swap.Reason == reason && f.Capture.ArmCalls == 1, "failure survives teardown without retry");
    }

    private static void StreamEndedDuringArmingAlsoDisarms()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true);
        f.Capture.EmitStreamEnded("stopped");
        f.Capture.EmitDisarmed();
        Assert(f.Capture.DisarmCalls == 1 && f.Swap.State == "failed" && f.SuspenderEnabled, "stream ended during startup also restores mirror");
    }

    private static void NewDemandDuringFailedTeardownCanRearm()
    {
        using var f = new Fixture();
        f.Arm();
        f.Capture.EmitStreamEnded("stopped");
        f.Swap.Request("retry", true);
        f.Capture.EmitDisarmed();
        Assert(f.Capture.ArmCalls == 2 && f.Swap.State == "arming" && f.Swap.Reason is null, "new explicit demand can retry after failure teardown");
    }

    private static void SecondArmUsesTheNewSignalSnapshot()
    {
        using var f = new Fixture();
        f.Arm();
        var old = f.Swap.Snapshot;
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        f.Swap.Request("page", true);
        Assert(f.Swap.Snapshot is null, "old descriptor is unavailable during the second arm");
        var current = Snapshot("second");
        f.Capture.EmitArmed(current);
        Assert(f.Swap.Snapshot == current && current.Token != old!.Token && current.CertificateHash != old.CertificateHash,
            "second signal replaces both token and certificate without file reads");
        Assert(f.Capture.Subscriptions == 1, "signals are subscribed once across arms");
    }

    private static void NoCaptureReportsFailureWithoutSideEffects()
    {
        using var f = new Fixture();
        f.Capture.Available = false;
        f.Swap.Request("page", true);
        Assert(f.Swap.State == "failed" && f.Swap.Reason == "no-capture", "missing capture gives a page-visible reason");
        Assert(f.SuspenderEnabled && f.Capture.ArmCalls == 0 && f.Capture.Subscriptions == 0 && f.Deadlines.Count == 0,
            "no capture has no native or timer effects");
        f.Swap.Request("page", false);
        Assert(f.Swap.State == "mirror" && f.Swap.Reason is null, "mirror clears the no-capture failure");
    }

    private static void SingletonDiscoverySubscribesOnlyOnce()
    {
        using var f = new Fixture();
        f.Capture.Available = false;
        f.Swap.Request("page", true);
        f.Capture.Available = true;
        f.Swap.Request("page", true);
        Assert(f.Capture.Subscriptions == 1 && f.Swap.State == "arming", "next message can find the singleton without startup polling");
        f.Capture.EmitArmFailed("failed");
        f.Swap.Request("page", true);
        Assert(f.Capture.Subscriptions == 1, "retry does not subscribe again");
    }

    private static void DisposalCancelsGraceAndSignalSubscriptions()
    {
        using var f = new Fixture();
        f.Arm();
        var signals = f.Capture.Signals!;
        f.Swap.Dispose();
        f.Swap.Dispose();
        Assert(f.Deadlines[0].Cancelled && f.Capture.Unsubscriptions == 1, "disposal cancels the deadline and unsubscribes once");
        var events = f.Events.Count;
        f.Deadlines[0].Callback();
        signals.Armed(Snapshot("late"));
        signals.Disarmed();
        signals.ArmFailed("late");
        signals.StreamEnded("late");
        signals.ClientLeft(1, "late");
        f.Swap.Request("late", true);
        Assert(f.Events.Count == events && f.Capture.DisarmCalls == 0, "late callbacks and requests have no effects");
    }

    private static void QuitStillDisarmsArmingAndArmedCaptures()
    {
        foreach (var armed in new[] { false, true })
        {
            using var f = new Fixture();
            f.Swap.Request("page", true);
            if (armed) f.Capture.EmitArmed(Snapshot("first"));
            var done = 0;
            new RenderStreamCaptureQuit(f.Capture, () => done++, (delay, callback) => f.Schedule(delay, callback)).Run();
            Assert(done == 0 && f.Capture.DisarmReason == "seat-quit" && f.Capture.LingerMs == 0, "quit waits for active capture teardown");
            f.Capture.EmitDisarmed();
            Assert(done == 1 && f.Capture.ArmCalls == 1 && f.Swap.Snapshot is null, "quit completes without the swap controller rearming old demand");
        }
    }

    private static void DisarmRefusalsHandleAlreadyStoppedOrStopping()
    {
        foreach (var result in new[] { 3, 44 })
        {
            using var f = new Fixture();
            f.Arm();
            f.Capture.DisarmResult = result;
            f.Swap.Request("page", false);
            Assert(f.Swap.Snapshot is null && f.Swap.State == (result == 3 ? "mirror" : "disarming"), "refused disarm still clears descriptor");
            Assert(f.SuspenderEnabled == (result == 3), "already stopped restores immediately; already stopping waits");
            if (result == 44) f.Capture.EmitDisarmed();
            Assert(f.SuspenderEnabled && f.TrimCalls == 1, "stopped capture restores memory saving once");
        }
    }

    private static void RefusedDisarmAllowsMirrorFallback()
    {
        using var f = new Fixture();
        f.Arm();
        f.Capture.DisarmResult = 1;
        f.Swap.Request("page", false);
        Assert(f.Swap.State == "failed" && f.Swap.Reason == "disarm-refused:1", "refused disarm reports failure");
        Assert(!f.Swap.MirrorRestoreComplete && !f.Swap.PresentationReady, "refused disarm cannot claim a restored presentation");
    }

    private static RenderStreamSnapshot Snapshot(string arm) => new(
        "127.0.0.1:19849", $"test-token-{arm}", $"test-certificate-{arm}", "2340x1080", 16);

    private sealed class Fixture : IDisposable
    {
        internal readonly List<string> Events = [];
        internal readonly List<string> Logs = [];
        internal int LoadCalls;
        internal readonly RenderStreamSelf.DeferredCapture? Deferred;
        internal bool LoadSucceeds = true;
        internal readonly List<(string State, RenderStreamSnapshot? Snapshot)> Changes = [];
        internal readonly List<Deadline> Deadlines = [];
        internal readonly FakeCapture Capture;
        internal readonly RenderStreamSwap Swap;
        internal readonly RenderStreamCaptureHelpers Helpers;
        internal int HelperInstalls, HelperRemoves;
        internal bool HelpersSucceed = true;
        internal readonly HeadlessViewportConfigurator.Presentation Presentation;
        internal readonly HeadlessViewportTests.RecordingWindow? Window;
        internal readonly List<(bool Expand, int Width)> PresentationChanges = [];
        internal (bool Expand, int Width)? PresentationWhenResumed;
        internal bool SuspenderEnabled = true;
        internal bool StreamSpinesArmed;
        internal int TrimCalls;
        private TimeSpan _now;

        internal Fixture(int maxWidth = 2520, Action<Action>? deferSignal = null, Action<Action>? deferPresentation = null,
            Func<int, bool>? canApply = null, bool windowedHost = false, bool autoHandlersAvailable = true, bool deferredLoad = false)
        {
            Capture = new FakeCapture(Events);
            Helpers = new(windowedHost, () =>
            {
                HelperInstalls++;
                Events.Add("helpers:install");
                if (!HelpersSucceed) throw new InvalidOperationException("helper install failed");
            }, () => { HelperRemoves++; Events.Add("helpers:remove"); }, () => { });
            Helpers.Start();
            Events.Clear();
            if (deferredLoad)
            {
                Capture.Available = false;
                Capture.CurrentAttachmentState = "detached";
                Deferred = new RenderStreamSelf.DeferredCapture("/capture/stream.gdextension", _ =>
                {
                    LoadCalls++;
                    Events.Add("load");
                    if (LoadSucceeds)
                    {
                        Capture.Available = true;
                        Capture.CurrentAttachmentState = "detached";
                    }
                    return new(LoadSucceeds, LoadSucceeds ? "Ok" : "Failed");
                });
            }
            if (windowedHost) Window = new();
            Presentation = new HeadlessViewportConfigurator.Presentation((expand, width) =>
            {
                PresentationChanges.Add((expand, width));
                return canApply?.Invoke(width) ?? true;
            }, windowedRoot: windowedHost ? () => Window : null, canPauseAuto: () => autoHandlersAvailable);
            Swap = new RenderStreamSwap(Capture, Schedule,
                on =>
                {
                    SuspenderEnabled = on;
                    if (on && PresentationChanges.Count != 0) PresentationWhenResumed = PresentationChanges[^1];
                    Events.Add($"suspender:{on}");
                },
                () => { TrimCalls++; Events.Add("trim"); },
                () => { Events.Add($"changed:{Swap!.State}"); Changes.Add((Swap.State, Swap.Snapshot)); },
                Presentation.SetStreamWidth, maxWidth, deferSignal, deferPresentation,
                trySetPresentationWidth: Presentation.TrySetStreamWidth,
                setStreamSpinesArmed: on => StreamSpinesArmed = on,
                tryRestorePresentation: windowedHost ? Presentation.TryRestoreMirror : null,
                windowedHost: windowedHost, ensureCaptureLoaded: () => Deferred?.EnsureLoaded(), log: Logs.Add,
                setCaptureAttached: Helpers.SetAttached);
        }

        internal void Arm()
        {
            Swap.Request("page", true);
            Capture.EmitArmed(Snapshot("first"));
        }

        internal IDisposable Schedule(TimeSpan delay, Action callback)
        {
            var deadline = new Deadline(delay, _now + delay, callback);
            Deadlines.Add(deadline);
            return deadline;
        }

        internal void Advance(TimeSpan elapsed)
        {
            _now += elapsed;
            foreach (var deadline in Deadlines.Where(d => !d.Cancelled && !d.Fired && d.At <= _now).ToArray())
            {
                deadline.Fired = true;
                deadline.Callback();
            }
        }

        public void Dispose() => Swap.Dispose();
    }

    private sealed class Deadline(TimeSpan delay, TimeSpan at, Action callback) : IDisposable
    {
        internal TimeSpan Delay => delay;
        internal TimeSpan At => at;
        internal Action Callback => callback;
        internal bool Cancelled;
        internal bool Fired;
        public void Dispose() => Cancelled = true;
    }

    internal sealed class FakeCapture(List<string> events) : IRenderStreamCapture
    {
        internal bool Available = true;
        internal int Discoveries, StateReads, ClientReads, ArmCalls, DisarmCalls, Subscriptions, Unsubscriptions;
        internal int ArmResult, DisarmResult, ClientCount;
        internal int AttachCalls, DetachCalls, AttachmentReads;
        internal int AttachResult, DetachResult;
        internal string CurrentAttachmentState = "attached";
        internal string CurrentState = "standby";
        internal string? DisarmReason;
        internal int LingerMs;
        internal Dictionary<string, string>? Options;
        internal Action? BeforeArm, BeforeDisarm;
        internal RenderStreamCaptureSignals? Signals;
        private readonly Dictionary<string, Action> _oneShot = [];

        public bool HasSingleton { get { Discoveries++; return Available; } }
        public int Clients { get { ClientReads++; return ClientCount; } }
        public string State() { StateReads++; return CurrentState; }

        public string AttachmentState { get { AttachmentReads++; return CurrentAttachmentState; } }

        public int Attach()
        {
            Assert(CurrentState == "standby", "attach requires a disarmed capture");
            AttachCalls++;
            events.Add("attach");
            if (AttachResult == 0) CurrentAttachmentState = "attached";
            return AttachResult;
        }

        public int Detach()
        {
            Assert(CurrentState == "standby", "detach requires a fully disarmed capture");
            DetachCalls++;
            events.Add("detach");
            if (DetachResult == 0) CurrentAttachmentState = "detached";
            return DetachResult;
        }

        public int Arm(IReadOnlyDictionary<string, string> options)
        {
            Assert(CurrentAttachmentState == "attached", "arm requires attachment");
            Assert(Signals is not null, "persistent signals are subscribed before arm");
            ArmCalls++;
            Options = new(options);
            events.Add("arm");
            BeforeArm?.Invoke();
            if (ArmResult == 0) CurrentState = "arming";
            return ArmResult;
        }

        public int Disarm(string reason, int lingerMs)
        {
            DisarmCalls++;
            DisarmReason = reason;
            LingerMs = lingerMs;
            events.Add("disarm");
            BeforeDisarm?.Invoke();
            if (DisarmResult == 0) CurrentState = "disarming";
            return DisarmResult;
        }

        public IDisposable Subscribe(RenderStreamCaptureSignals signals)
        {
            Assert(Signals is null, "only one persistent subscription is installed");
            Signals = signals;
            Subscriptions++;
            events.Add("subscribe");
            return new Subscription(() => { Signals = null; Unsubscriptions++; });
        }

        public void ConnectOneShot(string signal, Action callback) => _oneShot.Add(signal, callback);
        internal void EmitArmed(RenderStreamSnapshot snapshot) { CurrentState = "armed"; Signals?.Armed(snapshot); }
        internal void EmitArmFailed(string reason) { CurrentState = "standby"; Signals?.ArmFailed(reason); }
        internal void EmitStreamEnded(string reason) { CurrentState = "ended"; Signals?.StreamEnded(reason); }
        internal void EmitClientConnected(int clients) { ClientCount = clients; Signals?.ClientConnected(1); }
        internal void EmitClientLeft(int clients) { ClientCount = clients; Signals?.ClientLeft(1, "closed"); }
        internal void EmitDisarmed()
        {
            CurrentState = "standby";
            Signals?.Disarmed();
            if (_oneShot.Remove("disarmed", out var callback)) callback();
        }

        private sealed class Subscription(Action unsubscribe) : IDisposable
        {
            public void Dispose() => unsubscribe();
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"RenderStreamSwapTests: {message}");
    }
}
