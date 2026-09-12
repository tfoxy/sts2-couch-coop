using CouchCoop.Mod.HostUi;

// Steam Deck: can a controller activate a CouchCoop button?
//
// On a Deck in Game Mode there is no mouse. The game's own clickable controls activate on the select
// action from `_GuiInput`, but that script virtual is never dispatched into this assembly (the mod is
// built without Godot's source generators), which is why CouchCoopTextureButton drives the press/release
// handlers from the native `gui_input` SIGNAL instead. That replacement handled mouse events only, so a
// controller could focus a CouchCoop button and pressing A did nothing.
//
// WHAT THIS SUITE CAN AND CANNOT SEE. CouchCoopTextureButton derives from the game's NButton, and
// constructing one needs a live Godot engine, which this suite deliberately does not have — GodotSharp is
// linked for metadata reflection only, and a native call through it is an uncatchable SIGSEGV (see the
// COUCHCOOP_CACHE_ROOT comment in BrowserServerRouteTests). So the button is split: a thin Godot-shaped
// half that classifies the InputEvent, and CouchCoopButtonActivation, which holds the gate and the
// press/release choice in ordinary C#. THIS SUITE COVERS THE SECOND HALF ONLY. The classifier — that a
// left mouse button maps to MousePress/MouseRelease and that `IsActionPressed(MegaInput.select)` maps to
// SelectPress/SelectRelease — is NOT exercised here and needs a live game or a Deck to prove.
internal static class CouchCoopButtonActivationTests
{
    public static void Run()
    {
        MouseStillPressesAndReleases();
        SelectPressesAndReleases();
        TheGateRefusesEverySourceAlike();
        AnUninterestingEventDoesNothing();
        SelectIsGatedExactlyLikeTheMouse();

        Console.WriteLine("CouchCoopButtonActivationTests: ok");
    }

    private static CouchCoopButtonActivation.Outcome Resolve(
        CouchCoopButtonActivation.Input input,
        bool isEnabled = true,
        bool isVisibleInTree = true,
        bool isFocused = true)
        => CouchCoopButtonActivation.Resolve(input, isEnabled, isVisibleInTree, isFocused);

    // The pre-existing path, pinned so the controller work cannot quietly change what a click does.
    private static void MouseStillPressesAndReleases()
    {
        Expect(
            Resolve(CouchCoopButtonActivation.Input.MousePress) == CouchCoopButtonActivation.Outcome.Press,
            "a left mouse press on an enabled, visible, focused button presses it");
        Expect(
            Resolve(CouchCoopButtonActivation.Input.MouseRelease) == CouchCoopButtonActivation.Outcome.Release,
            "a left mouse release on an enabled, visible, focused button releases it");
    }

    // The fix: the controller's A button, which arrives as the select action rather than as a mouse event.
    private static void SelectPressesAndReleases()
    {
        Expect(
            Resolve(CouchCoopButtonActivation.Input.SelectPress) == CouchCoopButtonActivation.Outcome.Press,
            "the select action pressed on an enabled, visible, focused button presses it");
        Expect(
            Resolve(CouchCoopButtonActivation.Input.SelectRelease) == CouchCoopButtonActivation.Outcome.Release,
            "the select action released on an enabled, visible, focused button releases it");
    }

    // Each half of the game's clickable gate, one at a time, for every input that could activate. A
    // disabled or hidden button that a controller can still fire is the bug this half prevents.
    private static void TheGateRefusesEverySourceAlike()
    {
        CouchCoopButtonActivation.Input[] activating =
        [
            CouchCoopButtonActivation.Input.MousePress,
            CouchCoopButtonActivation.Input.MouseRelease,
            CouchCoopButtonActivation.Input.SelectPress,
            CouchCoopButtonActivation.Input.SelectRelease,
        ];

        foreach (var input in activating)
        {
            Expect(
                Resolve(input, isEnabled: false) == CouchCoopButtonActivation.Outcome.None,
                $"a disabled button ignores {input}");
            Expect(
                Resolve(input, isVisibleInTree: false) == CouchCoopButtonActivation.Outcome.None,
                $"a button that is not visible in the tree ignores {input}");
            Expect(
                Resolve(input, isFocused: false) == CouchCoopButtonActivation.Outcome.None,
                $"an unfocused button ignores {input}");
        }
    }

    private static void AnUninterestingEventDoesNothing()
    {
        Expect(
            Resolve(CouchCoopButtonActivation.Input.None) == CouchCoopButtonActivation.Outcome.None,
            "an event this control does not act on is ignored even when everything else is satisfied");
    }

    // The point of one shared rule: whatever a mouse event is allowed to do in a given state, the select
    // action is allowed to do too, and nothing more. A future gate change that forgets the controller
    // would show up here rather than on someone's Deck.
    private static void SelectIsGatedExactlyLikeTheMouse()
    {
        foreach (var enabled in Booleans)
        {
            foreach (var visible in Booleans)
            {
                foreach (var focused in Booleans)
                {
                    var mousePress = Resolve(CouchCoopButtonActivation.Input.MousePress, enabled, visible, focused);
                    var selectPress = Resolve(CouchCoopButtonActivation.Input.SelectPress, enabled, visible, focused);
                    Expect(
                        mousePress == selectPress,
                        $"select press matches mouse press at enabled={enabled} visible={visible} focused={focused}");

                    var mouseRelease = Resolve(CouchCoopButtonActivation.Input.MouseRelease, enabled, visible, focused);
                    var selectRelease = Resolve(CouchCoopButtonActivation.Input.SelectRelease, enabled, visible, focused);
                    Expect(
                        mouseRelease == selectRelease,
                        $"select release matches mouse release at enabled={enabled} visible={visible} focused={focused}");
                }
            }
        }
    }

    private static bool[] Booleans => [false, true];

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"CouchCoopButtonActivationTests: {because}");
        }
    }
}
