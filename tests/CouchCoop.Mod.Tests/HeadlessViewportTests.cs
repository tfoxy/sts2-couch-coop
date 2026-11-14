using CouchCoop.Mod.Session;
using Godot;
using MegaCrit.Sts2.Core.Nodes;
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
        foreach (var binding in bindings)
        {
            var target = HeadlessViewportPatch.Resolve(binding);
            Assert(target is { IsStatic: false, IsPublic: true } && target.DeclaringType == binding.Type
                && target.ReturnType == typeof(void) && target.GetParameters().Length == 0,
                $"{binding.Type.Name}.{binding.Method} resolves to its own public no-argument method");
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
            HeadlessViewportPatch.AfterPresentationChanged(); // The root signal uses this same callback.
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
        Assert(fixture.Applies == applies && fixture.Window.Writes == writes,
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
            fixture.RunNext();
        });
        Assert(fixture.Applies == applies && fixture.Window.Size == new Vector2I(2520, 1080),
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
                HeadlessViewportPatch.AfterPresentationChanged();
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

    private sealed class Fixture
    {
        internal readonly Queue<Action> Pending = new();
        internal readonly RecordingWindow Window = new();
        internal readonly HeadlessViewportConfigurator.Presentation Presentation;
        internal readonly HeadlessViewportConfigurator.Reassertion Updates;
        internal bool RootExists = true;
        internal int Attachments;
        internal int Applies;

        internal Fixture()
        {
            Presentation = new((expand, width) =>
            {
                Applies++;
                return HeadlessViewportConfigurator.ApplyPresentation(Window, expand, width);
            });
            Updates = new(Presentation, Pending.Enqueue, () =>
            {
                if (!RootExists) return false;
                Attachments++;
                return true;
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

    private sealed class RecordingWindow : HeadlessViewportConfigurator.IPresentationWindow
    {
        private Window.ContentScaleAspectEnum _aspect = Window.ContentScaleAspectEnum.Expand;
        private Vector2I _content = new(1680, 1080);
        private Vector2I _size = new(1920, 1920);
        internal int Writes;
        internal Action? SizeChanged;

        public Window.ContentScaleAspectEnum ContentScaleAspect
        {
            get => _aspect;
            set { Writes++; _aspect = value; }
        }
        public Vector2I ContentScaleSize { get => _content; set { Writes++; _content = value; } }
        public Vector2I Size
        {
            get => _size;
            set { Writes++; _size = value; SizeChanged?.Invoke(); }
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
