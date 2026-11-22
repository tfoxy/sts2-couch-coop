using CouchCoop.Mod.Session;
using Godot;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;

internal static class HeadlessViewportTests
{
    internal static void Run()
    {
        Action[] tests =
        [
            TargetsResolve,
            PostfixesAndSignalDeferAndCoalesce,
            PendingReassertRespectsStreamOwnership,
            StreamOwnedNotificationsDoNotApply,
            DisarmBeforeExecutionRestoresMirror,
            StartupAppliesAndConnectsOnce,
            EarlyStartupWaitsForReadyWithoutRetrying,
            ResizeFeedbackConvergesWithoutWrites,
            WindowedArmLetterboxesWithoutWindowWrites,
            WindowedRearmPreservesOriginalSettings,
            WindowedReleaseRestoresAllSettings,
            WindowedIdleReassertDoesNothing,
            WindowedStartupAndIdleHooksLeaveDisplayAlone,
            WindowedOwnedMountReassertsWithoutAdopting,
            WindowedResizeDoesNotInvalidatePresentation,
            WindowedDisplayApplyAdoptsBeforeReassertingInEitherOrder,
            WindowedDisplayAppliesCoalesceToLatestSettings,
            WindowedDisarmBeforeReassertAdoptsSettings,
            WindowedRearmBeforeReassertAdoptsSettings,
            WindowedAutoHandlersPauseSynchronousWrites,
            WindowedAutoDisplayApplyPreservesSnapshot,
            WindowedFixedDisplayApplyMatchingStreamAdoptsSettings,
            WindowedAutoRefitSurvivesRearmBeforeDeferredRelease,
            WindowedMissingAutoTargetRefusesOwnership,
            HeadlessAutoHandlerRunsNormally,
        ];
        foreach (var test in tests) test();
        Console.WriteLine($"HeadlessViewportTests: {tests.Length} passed.");
    }

    internal static void TargetsResolve()
    {
        var bindings = HeadlessViewportPatch.Bindings;
        Assert(bindings.Count == 3 && bindings.Select(binding => (binding.Type, binding.Method)).ToHashSet()
            .SetEquals([(typeof(NGame), nameof(NGame.ApplyDisplaySettings)),
                (typeof(NGame), nameof(NGame._Ready)), (typeof(NMainMenu), nameof(NMainMenu._Ready))]),
            "display, menu and startup each have one typed public target");
        Assert(bindings.Single(binding => binding.Method == nameof(NGame.ApplyDisplaySettings)).Postfix
            == nameof(HeadlessViewportPatch.AfterDisplaySettingsApplied),
            "display settings use the snapshot-adoption callback");
        foreach (var binding in bindings)
        {
            var target = HeadlessViewportPatch.Resolve(binding);
            Assert(target is { IsStatic: false, IsPublic: true } && target.DeclaringType == binding.Type
                && target.ReturnType == typeof(void) && target.GetParameters().Length == 0,
                $"{binding.Type.Name}.{binding.Method} resolves to its own public no-argument method");
        }
        var auto = HeadlessViewportPatch.AutoBindings;
        Assert(auto.Count == 2 && auto.Select(binding => binding.Type).ToHashSet()
            .SetEquals([typeof(NGlobalUi), typeof(NMainMenu)]), "both Auto refit screens have a target");
        foreach (var binding in auto)
        {
            var target = HeadlessViewportPatch.Resolve(binding);
            Assert(target is { IsStatic: false, IsPrivate: true } && target.DeclaringType == binding.Type
                && target.ReturnType == typeof(void)
                && target.GetParameters().Select(parameter => parameter.ParameterType).SequenceEqual(binding.Parameters),
                "Auto refit target resolves with its declared signature");
            var prefix = typeof(HeadlessViewportPatch).GetMethod(binding.Prefix,
                System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
            Assert(prefix?.ReturnType == typeof(bool)
                && prefix.GetParameters()[0].ParameterType == binding.Type, "Auto target has its typed skip prefix");
        }
    }

    private static void PostfixesAndSignalDeferAndCoalesce()
    {
        var fixture = new Fixture();
        fixture.WithHooks(() =>
        {
            foreach (var binding in HeadlessViewportPatch.Bindings.Where(binding => binding.Type != typeof(NGame)
                || binding.Method != nameof(NGame._Ready)))
                typeof(HeadlessViewportPatch).GetMethod(binding.Postfix,
                    System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!.Invoke(null, null);
            HeadlessViewportPatch.AfterWindowSizeChanged();
            Assert(fixture.Pending.Count == 1 && fixture.Applies == 0 && fixture.Attachments == 0,
                "postfixes and signal coalesce without reading or applying inline");
            fixture.RunNext();
            Assert(fixture.Applies == 1 && fixture.Attachments == 1, "one deferred mirror apply and root connection");
            fixture.AssertMirror();
            fixture.Window.Drift();
            HeadlessViewportPatch.AfterPresentationChanged();
            Assert(fixture.Applies == 1, "later drift is deferred too");
            fixture.RunNext();
            fixture.AssertMirror();
            Assert(fixture.Attachments == 1, "later notifications do not reconnect the signal");
        });
    }

    private static void PendingReassertRespectsStreamOwnership()
    {
        var fixture = new Fixture();
        fixture.Updates.Request();
        fixture.Presentation.SetStreamWidth(2340);
        var applies = fixture.Applies;
        var writes = fixture.Window.Writes;
        fixture.RunNext();
        Assert(fixture.Applies == applies + 1 && fixture.Window.Writes == writes,
            "ownership is checked at execution even when acquired after scheduling");
        Assert(fixture.Window.ContentScaleAspect == Window.ContentScaleAspectEnum.Expand
            && fixture.Window.Size == new Vector2I(2340, 1080), "wide presentation stays Expand at W");
    }

    private static void StreamOwnedNotificationsDoNotApply()
    {
        var fixture = new Fixture();
        fixture.Presentation.SetStreamWidth(2520);
        var applies = fixture.Applies;
        fixture.WithHooks(() =>
        {
            HeadlessViewportPatch.AfterGameReady();
            HeadlessViewportPatch.AfterPresentationChanged();
            fixture.Window.Drift();
            fixture.RunNext();
        });
        Assert(fixture.Applies == applies + 1 && fixture.Window.Size == new Vector2I(2520, 1080),
            "startup and display notifications cannot take ownership from a wide stream");
    }

    private static void DisarmBeforeExecutionRestoresMirror()
    {
        var fixture = new Fixture();
        fixture.Presentation.SetStreamWidth(2340);
        fixture.Updates.Request();
        fixture.Presentation.SetStreamWidth(1920);
        var writes = fixture.Window.Writes;
        fixture.RunNext();
        fixture.AssertMirror();
        Assert(fixture.Window.Writes == writes, "deferred reassert leaves a completed disarm unchanged");
    }

    private static void StartupAppliesAndConnectsOnce()
    {
        var fixture = new Fixture();
        fixture.WithHooks(() =>
        {
            fixture.Updates.Startup(); // Configure's late-start fallback.
            HeadlessViewportPatch.AfterGameReady();
            Assert(fixture.Pending.Count == 1, "fallback and ready share the pending startup apply");
            fixture.RunNext();
            fixture.Updates.Startup();
            HeadlessViewportPatch.AfterGameReady();
        });
        Assert(fixture.Pending.Count == 0 && fixture.Applies == 1 && fixture.Attachments == 1,
            "startup applies once and connects once, including late/repeated initialization");
    }

    private static void EarlyStartupWaitsForReadyWithoutRetrying()
    {
        var fixture = new Fixture { RootExists = false };
        fixture.Updates.Startup();
        fixture.RunNext();
        Assert(fixture.Applies == 0 && fixture.Pending.Count == 0 && fixture.Attachments == 0,
            "an early startup attempt leaves no retry queued");
        fixture.RootExists = true;
        fixture.WithHooks(HeadlessViewportPatch.AfterGameReady);
        fixture.RunNext();
        Assert(fixture.Applies == 1 && fixture.Attachments == 1, "the ready signal completes startup");
    }

    private static void ResizeFeedbackConvergesWithoutWrites()
    {
        var fixture = new Fixture();
        fixture.WithHooks(() =>
        {
            fixture.Window.SizeChanged = () =>
            {
                fixture.Window.ResetContent();
                HeadlessViewportPatch.AfterWindowSizeChanged();
            };
            HeadlessViewportPatch.AfterGameReady();
            fixture.RunNext();
            var writes = fixture.Window.Writes;
            Assert(writes == 3 && fixture.Pending.Count == 1, "correcting drift raises one resize notification");
            var previousError = Console.Error;
            using var log = new StringWriter();
            Console.SetError(log);
            try { fixture.RunNext(); }
            finally { Console.SetError(previousError); }
            Assert(log.ToString().Length == 0, "the drift-free second pass is silent");
            Assert(fixture.Applies == 2 && fixture.Window.Writes == writes && fixture.Pending.Count == 0,
                "the second pass writes nothing and schedules no further work");
            fixture.AssertMirror();
        });
    }

    private static HeadlessViewportConfigurator.Presentation WindowedPresentation(RecordingWindow window)
        => new((_, _) => throw new InvalidOperationException("windowed presentation used the headless path"),
            windowedRoot: () => window);

    private static void WindowedArmLetterboxesWithoutWindowWrites()
    {
        var window = new RecordingWindow();
        var presentation = WindowedPresentation(window);
        Assert(presentation.TrySetStreamWidth(2520), "windowed arm succeeds");
        Assert(presentation.StreamOwnsPresentation && presentation.StreamWidth == 2520,
            "wide windowed stream owns placement");
        Assert(window.SizeWrites == 0 && window.Size == new Vector2I(1920, 1920),
            "windowed arm never writes the OS window size");
        Assert(window.ContentScaleSize == new Vector2I(2520, 1080)
            && window.ContentScaleAspect == Window.ContentScaleAspectEnum.Keep
            && window.ContentScaleMode == Window.ContentScaleModeEnum.CanvasItems,
            "wide content uses Keep and the player's scale mode");
        var writes = window.Writes;
        Assert(presentation.ReassertMirror() && window.Writes == writes,
            "an owned reassertion with no drift writes nothing");
    }

    private static void WindowedRearmPreservesOriginalSettings()
    {
        var window = new RecordingWindow();
        var presentation = WindowedPresentation(window);
        presentation.SetStreamWidth(2520);
        presentation.SetStreamWidth(2160);
        Assert(window.ContentScaleSize == new Vector2I(2160, 1080), "rearm takes the new logical width");
        presentation.SetStreamWidth(1920);
        Assert(presentation.StreamOwnsPresentation && window.ContentScaleSize == new Vector2I(1920, 1080),
            "a standard windowed stream still owns the logical viewport");
        var target = new Vector2(0.1f, 0.2f);
        Assert(presentation.ResolvePlacement(target, 0.5f) == target, "standard stream placement stays exact");
        Assert(presentation.TryRestoreMirror(), "rearmed windowed stream releases");
        AssertPlayerSettings(window);
        Assert(window.SizeWrites == 0, "width changes and restoration never write window size");
    }

    private static void WindowedReleaseRestoresAllSettings()
    {
        foreach (var width in new[] { 1920, 2520 })
        {
            var window = new RecordingWindow();
            var presentation = WindowedPresentation(window);
            presentation.SetStreamWidth(width);
            window.ContentScaleMode = Window.ContentScaleModeEnum.Viewport;
            Assert(presentation.TryRestoreMirror() && !presentation.StreamOwnsPresentation,
                "disarm releases windowed presentation");
            AssertPlayerSettings(window);
            var writes = window.Writes;
            Assert(presentation.TryRestoreMirror() && window.Writes == writes,
                "repeated release does not write player settings");
            Assert(window.SizeWrites == 0, "release never writes window size");
        }
    }

    private static void WindowedIdleReassertDoesNothing()
    {
        var window = new RecordingWindow();
        var rootReads = 0;
        var presentation = new HeadlessViewportConfigurator.Presentation((_, _) => false,
            windowedRoot: () => { rootReads++; return window; });
        Assert(presentation.ReassertMirror() && rootReads == 0 && window.Writes == 0,
            "an unowned reassertion leaves the player's display entirely alone");
        presentation.SetStreamWidth(2520);
        presentation.TryRestoreMirror();
        window.Drift();
        var writes = window.Writes;
        var reads = rootReads;
        Assert(presentation.ReassertMirror() && rootReads == reads && window.Writes == writes,
            "after release, reassertion neither reads nor writes the player's root");
    }

    private static void AssertPlayerSettings(RecordingWindow window)
        => Assert(window.ContentScaleSize == new Vector2I(1680, 1080)
            && window.ContentScaleAspect == Window.ContentScaleAspectEnum.Expand
            && window.ContentScaleMode == Window.ContentScaleModeEnum.CanvasItems,
            "disarm restores the original content size, aspect and scale mode exactly");

    private static void WindowedStartupAndIdleHooksLeaveDisplayAlone()
    {
        var fixture = new Fixture(windowed: true);
        fixture.WithHooks(() =>
        {
            fixture.Updates.Startup();
            HeadlessViewportPatch.AfterGameReady();
            fixture.RunNext();
            Assert(fixture.Attachments == 1 && fixture.RootReads == 0 && fixture.Window.Writes == 0
                && fixture.Invalidations == 0 && fixture.Reassertions == 0,
                "windowed startup connects once without reading, writing or invalidating presentation");
            HeadlessViewportPatch.AfterPresentationChanged();
            HeadlessViewportPatch.AfterDisplaySettingsApplied();
            HeadlessViewportPatch.AfterWindowSizeChanged();
            HeadlessViewportPatch.AfterGameReady();
            Assert(fixture.Pending.Count == 0 && fixture.RootReads == 0 && fixture.Window.Writes == 0,
                "idle windowed hooks schedule no work and leave player settings alone");
        });
    }

    private static void WindowedOwnedMountReassertsWithoutAdopting()
    {
        var fixture = new Fixture(windowed: true);
        fixture.Presentation.SetStreamWidth(2520);
        fixture.Window.ContentScaleSize = new Vector2I(1600, 900);
        fixture.Window.ContentScaleAspect = Window.ContentScaleAspectEnum.Ignore;
        fixture.Window.ContentScaleMode = Window.ContentScaleModeEnum.Viewport;
        var reads = fixture.RootReads;
        var writes = fixture.Window.Writes;
        fixture.WithHooks(HeadlessViewportPatch.AfterPresentationChanged);
        Assert(fixture.Pending.Count == 1 && fixture.RootReads == reads && fixture.Window.Writes == writes,
            "mount reassertion is deferred");
        fixture.RunNext();
        Assert(fixture.RootReads == reads + 1 && fixture.Window.SizeWrites == 0
            && fixture.Window.ContentScaleSize == new Vector2I(2520, 1080)
            && fixture.Window.ContentScaleAspect == Window.ContentScaleAspectEnum.Keep,
            "an owned mount reasserts logical stream size without resizing the window");
        fixture.Presentation.TryRestoreMirror();
        AssertPlayerSettings(fixture.Window);
    }

    private static void WindowedResizeDoesNotInvalidatePresentation()
    {
        var fixture = new Fixture(windowed: true);
        fixture.Presentation.SetStreamWidth(2520);
        var reads = fixture.RootReads;
        var writes = fixture.Window.Writes;
        fixture.WithHooks(() =>
        {
            fixture.Window.SizeChanged = HeadlessViewportPatch.AfterWindowSizeChanged;
            fixture.Window.Size = new Vector2I(1280, 720); // The player resizes their window.
        });
        Assert(fixture.Pending.Count == 0 && fixture.Invalidations == 0 && fixture.Reassertions == 0
            && fixture.RootReads == reads && fixture.Window.Writes == writes + 1 && fixture.Window.SizeWrites == 1,
            "a player resize schedules no read, write or presentation transition");
        Assert(fixture.Window.ContentScaleSize == new Vector2I(2520, 1080)
            && fixture.Window.ContentScaleAspect == Window.ContentScaleAspectEnum.Keep,
            "Keep preserves the logical stream while the player's window changes size");
    }

    private static void WindowedDisplayApplyAdoptsBeforeReassertingInEitherOrder()
    {
        foreach (var displayFirst in new[] { false, true })
        {
            var fixture = new Fixture(windowed: true);
            fixture.Presentation.SetStreamWidth(2520);
            fixture.Window.ContentScaleSize = new Vector2I(1600, 900);
            fixture.Window.ContentScaleAspect = Window.ContentScaleAspectEnum.Ignore;
            fixture.Window.ContentScaleMode = Window.ContentScaleModeEnum.Viewport;
            var reads = fixture.RootReads;
            var writes = fixture.Window.Writes;
            fixture.WithHooks(() =>
            {
                if (displayFirst) HeadlessViewportPatch.AfterDisplaySettingsApplied();
                HeadlessViewportPatch.AfterWindowSizeChanged();
                HeadlessViewportPatch.AfterPresentationChanged();
                if (!displayFirst) HeadlessViewportPatch.AfterDisplaySettingsApplied();
            });
            Assert(fixture.RootReads == reads && fixture.Window.Writes == writes
                && fixture.Pending.Count == 1 && fixture.Invalidations == 1,
                "both notification orders coalesce without reading or writing inside the callback");
            fixture.RunNext();
            Assert(fixture.Window.ContentScaleSize == new Vector2I(2520, 1080)
                && fixture.Window.ContentScaleAspect == Window.ContentScaleAspectEnum.Keep
                && fixture.Window.ContentScaleMode == Window.ContentScaleModeEnum.Viewport
                && fixture.Reassertions == 1 && fixture.Pending.Count == 0,
                "display apply reasserts stream size and Keep with no resize feedback");
            fixture.Presentation.TryRestoreMirror();
            AssertUpdatedPlayerSettings(fixture.Window, new Vector2I(1600, 900));
            Assert(fixture.Window.SizeWrites == 0, "display changes and disarm never resize the window");
        }
    }

    private static void WindowedDisplayAppliesCoalesceToLatestSettings()
    {
        var fixture = new Fixture(windowed: true);
        fixture.Presentation.SetStreamWidth(2520);
        fixture.WithHooks(() =>
        {
            fixture.Window.ContentScaleSize = new Vector2I(1600, 900);
            HeadlessViewportPatch.AfterDisplaySettingsApplied();
            fixture.Window.ContentScaleSize = new Vector2I(1280, 720);
            fixture.Window.ContentScaleAspect = Window.ContentScaleAspectEnum.Ignore;
            fixture.Window.ContentScaleMode = Window.ContentScaleModeEnum.Viewport;
            HeadlessViewportPatch.AfterDisplaySettingsApplied();
        });
        Assert(fixture.Pending.Count == 1, "multiple display applies share one deferred reassertion");
        fixture.RunNext();
        fixture.Presentation.TryRestoreMirror();
        AssertUpdatedPlayerSettings(fixture.Window, new Vector2I(1280, 720));
        var writes = fixture.Window.Writes;
        fixture.WithHooks(HeadlessViewportPatch.AfterDisplaySettingsApplied);
        Assert(fixture.Pending.Count == 0 && fixture.Window.Writes == writes, "idle applies stay unowned");
    }

    private static void WindowedDisarmBeforeReassertAdoptsSettings()
    {
        var fixture = new Fixture(windowed: true);
        fixture.Presentation.SetStreamWidth(2520);
        ApplyUpdatedPlayerSettings(fixture);
        fixture.Presentation.TryRestoreMirror();
        AssertUpdatedPlayerSettings(fixture.Window, new Vector2I(1600, 900));
        var reads = fixture.RootReads;
        var writes = fixture.Window.Writes;
        fixture.RunNext();
        Assert(fixture.RootReads == reads && fixture.Window.Writes == writes && fixture.Reassertions == 0,
            "a queued callback after disarm leaves the adopted player settings alone");
        fixture.Presentation.SetStreamWidth(2160);
        fixture.Presentation.TryRestoreMirror();
        AssertUpdatedPlayerSettings(fixture.Window, new Vector2I(1600, 900));
    }

    private static void WindowedRearmBeforeReassertAdoptsSettings()
    {
        var fixture = new Fixture(windowed: true);
        fixture.Presentation.SetStreamWidth(2520);
        ApplyUpdatedPlayerSettings(fixture);
        fixture.Presentation.SetStreamWidth(2160);
        fixture.RunNext();
        Assert(fixture.Window.ContentScaleSize == new Vector2I(2160, 1080), "reassert uses the latest stream width");
        fixture.Presentation.TryRestoreMirror();
        AssertUpdatedPlayerSettings(fixture.Window, new Vector2I(1600, 900));
    }

    private static void ApplyUpdatedPlayerSettings(Fixture fixture)
    {
        fixture.Window.ContentScaleSize = new Vector2I(1600, 900);
        fixture.Window.ContentScaleAspect = Window.ContentScaleAspectEnum.Ignore;
        fixture.Window.ContentScaleMode = Window.ContentScaleModeEnum.Viewport;
        fixture.WithHooks(HeadlessViewportPatch.AfterDisplaySettingsApplied);
    }

    private static void AssertUpdatedPlayerSettings(RecordingWindow window, Vector2I size)
        => Assert(window.ContentScaleSize == size && window.ContentScaleAspect == Window.ContentScaleAspectEnum.Ignore
            && window.ContentScaleMode == Window.ContentScaleModeEnum.Viewport,
            "disarm restores the player's latest content size, aspect and scale mode");

    private static void WindowedAutoHandlersPauseSynchronousWrites()
    {
        foreach (var gameFirst in new[] { false, true })
        {
            var fixture = new Fixture(windowed: true) { AutoAspect = true };
            fixture.Window.SignalContentChanges = true;
            var fits = 0;
            var fitting = false;
            var restoredBeforeFit = false;
            void Refit()
            {
                fits++;
                restoredBeforeFit = fixture.Window.ContentScaleSize == new Vector2I(1680, 1080)
                    && fixture.Window.ContentScaleAspect == Window.ContentScaleAspectEnum.Expand;
                fitting = true;
                try
                {
                    // A game-side Auto refit changes content policy synchronously.
                    fixture.Window.ContentScaleSize = new Vector2I(1700, 1100);
                    fixture.Window.ContentScaleAspect = Window.ContentScaleAspectEnum.KeepHeight;
                }
                finally { fitting = false; }
            }
            void GameHandler()
            {
                if (!fitting && HeadlessViewportPatch.BeforeAutoWindowChanged(Refit)) Refit();
            }
            fixture.WithHooks(() =>
            {
                fixture.Window.SizeChanged = () =>
                {
                    if (gameFirst) GameHandler();
                    HeadlessViewportPatch.AfterWindowSizeChanged();
                    if (!gameFirst) GameHandler();
                };
                Assert(fixture.Presentation.TrySetStreamWidth(2520), "Auto stream acquires presentation");
                fixture.Window.Size = new Vector2I(1400, 900);
                Assert(fits == 0 && fixture.Window.ContentScaleSize == new Vector2I(2520, 1080)
                    && fixture.Window.ContentScaleAspect == Window.ContentScaleAspectEnum.Keep
                    && fixture.Pending.Count == 0, "paused synchronous Auto cannot overwrite or churn the stream");
                fixture.Presentation.TryRestoreMirror();
                AssertPlayerSettings(fixture.Window);
                Assert(fits == 0 && fixture.Pending.Count == 1, "restoration precedes a deferred game refit");
                fixture.RunNext();
                Assert(fits == 1 && restoredBeforeFit && fixture.Pending.Count == 0,
                    "release replays the pending game refit once after restoring the player snapshot");
                fixture.Window.Size = new Vector2I(1300, 800);
                Assert(fits == 2, "unowned Auto handler runs normally on resize");
                Assert(fixture.Window.SizeWrites == 2, "only the two player resizes write window size");
            });
        }
    }

    private static void WindowedAutoDisplayApplyPreservesSnapshot()
    {
        foreach (var releaseBeforeReassert in new[] { false, true })
        {
            var fixture = new Fixture(windowed: true) { AutoAspect = true };
            fixture.Presentation.SetStreamWidth(2520);
            fixture.WithHooks(HeadlessViewportPatch.AfterDisplaySettingsApplied); // Auto writes no content scale.
            if (!releaseBeforeReassert) fixture.RunNext();
            fixture.Presentation.TryRestoreMirror();
            AssertPlayerSettings(fixture.Window);
            if (releaseBeforeReassert) fixture.RunNext();
            AssertPlayerSettings(fixture.Window);
        }
    }

    private static void WindowedFixedDisplayApplyMatchingStreamAdoptsSettings()
    {
        foreach (var releaseBeforeReassert in new[] { false, true })
        {
            var fixture = new Fixture(windowed: true);
            fixture.Window.ContentScaleSize = new Vector2I(1680, 1260);
            fixture.Window.ContentScaleAspect = Window.ContentScaleAspectEnum.Keep;
            var playerMode = fixture.Window.ContentScaleMode;
            Assert(fixture.Presentation.TrySetStreamWidth(1920), "fixed 4:3 stream acquires presentation");
            fixture.Window.ContentScaleSize = new Vector2I(1920, 1080);
            fixture.Window.ContentScaleAspect = Window.ContentScaleAspectEnum.Keep;
            fixture.WithHooks(HeadlessViewportPatch.AfterDisplaySettingsApplied);
            if (!releaseBeforeReassert) fixture.RunNext();
            Assert(fixture.Presentation.TryRestoreMirror(), "fixed display settings restore successfully");
            AssertFixedSettings();
            if (releaseBeforeReassert) fixture.RunNext();
            AssertFixedSettings();

            void AssertFixedSettings()
                => Assert(fixture.Window.ContentScaleSize == new Vector2I(1920, 1080)
                    && fixture.Window.ContentScaleAspect == Window.ContentScaleAspectEnum.Keep
                    && fixture.Window.ContentScaleMode == playerMode && fixture.Window.SizeWrites == 0,
                    "disarm restores fixed 16:9 matching the stream with the player's mode and no window writes");
        }
    }

    private static void WindowedAutoRefitSurvivesRearmBeforeDeferredRelease()
    {
        var fixture = new Fixture(windowed: true) { AutoAspect = true };
        var fits = 0;
        fixture.Presentation.SetStreamWidth(2520);
        fixture.WithHooks(() => Assert(!HeadlessViewportPatch.BeforeAutoWindowChanged(() => fits++),
            "owned Auto is suppressed"));
        fixture.Presentation.TryRestoreMirror();
        fixture.Presentation.SetStreamWidth(2160);
        fixture.RunNext();
        Assert(fits == 0, "a deferred refit cannot overwrite a replacement stream");
        fixture.Presentation.TryRestoreMirror();
        fixture.RunNext();
        Assert(fits == 1, "the pending refit survives until ownership is finally released");
    }

    private static void WindowedMissingAutoTargetRefusesOwnership()
    {
        var missing = HeadlessViewportPatch.AutoBindings[0] with { Method = "MissingAutoTarget" };
        var window = new RecordingWindow();
        var presentation = new HeadlessViewportConfigurator.Presentation((_, _) => true,
            windowedRoot: () => window, usesAutoAspect: () => true,
            canPauseAuto: () => HeadlessViewportPatch.Resolve(missing) is not null);
        Assert(!presentation.TrySetStreamWidth(2520) && !presentation.StreamOwnsPresentation
            && window.Writes == 0, "an unresolved Auto target refuses windowed ownership without writes");
        Assert(presentation.BeforeAutoWindowChanged(() => { }), "fallback leaves the game handler enabled");
    }

    private static void HeadlessAutoHandlerRunsNormally()
    {
        var fixture = new Fixture();
        fixture.Presentation.SetStreamWidth(2520);
        fixture.WithHooks(() => Assert(HeadlessViewportPatch.BeforeAutoWindowChanged(() => { }),
            "headless presentation never suppresses game handlers"));
    }

    private sealed class Fixture
    {
        internal readonly Queue<Action> Pending = new();
        internal readonly RecordingWindow Window = new();
        internal readonly HeadlessViewportConfigurator.Presentation Presentation;
        internal readonly HeadlessViewportConfigurator.Reassertion Updates;
        internal bool RootExists = true;
        internal bool AutoAspect;
        internal int Attachments;
        internal int Applies;
        internal int RootReads;
        internal int Invalidations;
        internal int Reassertions;

        internal Fixture(bool windowed = false)
        {
            Presentation = new((expand, width) =>
            {
                Applies++;
                return HeadlessViewportConfigurator.ApplyPresentation(Window, expand, width);
            }, windowedRoot: windowed ? () => { RootReads++; return Window; } : null,
                usesAutoAspect: () => AutoAspect, deferAutoFit: Pending.Enqueue);
            Updates = new(Presentation, Pending.Enqueue, () =>
            {
                if (!RootExists) return false;
                Attachments++;
                return true;
            }, () => Invalidations++, success =>
            {
                Assert(success, "reassertion succeeds");
                Reassertions++;
            });
        }

        internal void RunNext() => Pending.Dequeue()();

        internal void WithHooks(Action action)
        {
            var previous = HeadlessViewportConfigurator.Updates;
            HeadlessViewportConfigurator.Updates = Updates;
            try { action(); }
            finally { HeadlessViewportConfigurator.Updates = previous; }
        }

        internal void AssertMirror()
            => Assert(Window.ContentScaleAspect == Godot.Window.ContentScaleAspectEnum.Keep
                && Window.ContentScaleSize == new Vector2I(1920, 1080) && Window.Size == new Vector2I(1920, 1080),
                "mirror uses Keep/1920x1080 for both content and window");
    }

    internal sealed class RecordingWindow : HeadlessViewportConfigurator.IPresentationWindow
    {
        private Window.ContentScaleAspectEnum _aspect = Window.ContentScaleAspectEnum.Expand;
        private Window.ContentScaleModeEnum _mode = Window.ContentScaleModeEnum.CanvasItems;
        private Vector2I _content = new(1680, 1080);
        private Vector2I _size = new(1920, 1920);
        internal int Writes;
        internal int SizeWrites;
        internal Action? SizeChanged;
        internal bool SignalContentChanges;

        public Window.ContentScaleAspectEnum ContentScaleAspect
        {
            get => _aspect;
            set
            {
                Writes++;
                var changed = _aspect != value;
                _aspect = value;
                if (changed && SignalContentChanges) SizeChanged?.Invoke();
            }
        }
        public Vector2I ContentScaleSize
        {
            get => _content;
            set
            {
                Writes++;
                var changed = _content != value;
                _content = value;
                if (changed && SignalContentChanges) SizeChanged?.Invoke();
            }
        }
        public Window.ContentScaleModeEnum ContentScaleMode
        {
            get => _mode;
            set
            {
                Writes++;
                var changed = _mode != value;
                _mode = value;
                if (changed && SignalContentChanges) SizeChanged?.Invoke();
            }
        }
        public Vector2I Size
        {
            get => _size;
            set { Writes++; SizeWrites++; _size = value; SizeChanged?.Invoke(); }
        }
        public Vector2 VisibleSize => new(_size.X, _size.Y);

        internal void ResetContent()
        {
            _aspect = Window.ContentScaleAspectEnum.Expand;
            _content = new(1680, 1080);
        }

        internal void Drift()
        {
            ResetContent();
            _size = new(1920, 1920);
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
