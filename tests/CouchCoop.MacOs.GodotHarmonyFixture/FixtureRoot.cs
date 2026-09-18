using System.Runtime.CompilerServices;
using System.Text.Json;
using CouchCoop.Mod.Patches;
using Godot;

namespace CouchCoop.MacOs.GodotHarmonyFixture;

public partial class FixtureRoot : Control
{
    internal const string MarkerPrefix = "COUCHCOOP_GODOT_HARMONY_FIXTURE:";
    private const string FirstSyntheticName = "SyntheticLobbyOne";
    private const string SecondSyntheticName = "SyntheticLobbyTwo";
    private const string MountMarkerName = "CouchCoopMountMarker";
    private static int _firstReadyCount;
    private static int _secondReadyCount;
    private static int _firstCallbackCount;
    private static int _secondCallbackCount;
    private GodotNodeMountHook? _hook;
    private ulong _startedAt;
    private int _frames;
    private bool _patchRefused;
    private bool _emitted;

    public override void _Ready()
    {
        var targets = new GodotNodeMountTarget[]
        {
            new(typeof(SyntheticLobbyOne).FullName!, "_Ready"),
            new(typeof(SyntheticLobbyTwo).FullName!, "_Ready"),
        };
        _hook = new GodotNodeMountHook("com.couchcoop.godot-harmony-fixture", targets, node =>
        {
            if (node.Name == FirstSyntheticName) _firstCallbackCount++;
            else if (node.Name == SecondSyntheticName) _secondCallbackCount++;
            else _patchRefused = true;
            if (node.GetNodeOrNull<Control>(MountMarkerName) is null)
            {
                node.AddChild(new Control { Name = MountMarkerName });
            }
        }, failure =>
        {
            _patchRefused = true;
        });

        var firstApply = _hook.Apply();
        _patchRefused |= !firstApply;
        AddChild(new SyntheticLobbyOne { Name = FirstSyntheticName });
        AddChild(new SyntheticLobbyTwo { Name = SecondSyntheticName });
        // A complete plan is inert: if it installed a second postfix, the callback count becomes four.
        _patchRefused |= !_hook.Apply();
        _startedAt = Time.GetTicksMsec();
    }

    public override void _Process(double delta)
    {
        _frames++;
        var elapsedMilliseconds = Time.GetTicksMsec() - _startedAt;
        if (!_emitted && _frames >= 30 && elapsedMilliseconds >= 5000)
        {
            _emitted = true;
            var result = new FixtureResult(
                _hook?.TargetCount ?? 0,
                _firstReadyCount + _secondReadyCount,
                _firstCallbackCount + _secondCallbackCount,
                _firstReadyCount,
                _secondReadyCount,
                _firstCallbackCount,
                _secondCallbackCount,
                CountAttachedMountMarkers(),
                _frames,
                elapsedMilliseconds,
                _patchRefused);
            Console.WriteLine(MarkerPrefix + JsonSerializer.Serialize(result));
            GetTree().Quit(IsSuccess(result) ? 0 : 1);
        }
    }

    private static bool IsSuccess(FixtureResult result) =>
        !result.PatchRefused
        && result.Targets == 2
        && result.Readies == 2
        && result.Callbacks == 2
        && result.FirstReadies == 1
        && result.SecondReadies == 1
        && result.FirstCallbacks == 1
        && result.SecondCallbacks == 1
        && result.Markers == 2
        && result.Frames >= 30
        && result.ElapsedMilliseconds >= 5000;

    // The marker count is read back from the actual node tree, not from the callback counter. This proves that
    // each callback could mutate its ready synthetic Control, while the exact names prevent unrelated children
    // from satisfying the fixture.
    private int CountAttachedMountMarkers() =>
        new[] { FirstSyntheticName, SecondSyntheticName }
            .Count(name => GetNodeOrNull<Control>($"{name}/{MountMarkerName}") is not null);

    private readonly record struct FixtureResult(
        int Targets,
        int Readies,
        int Callbacks,
        int FirstReadies,
        int SecondReadies,
        int FirstCallbacks,
        int SecondCallbacks,
        int Markers,
        int Frames,
        ulong ElapsedMilliseconds,
        bool PatchRefused);

    public partial class SyntheticLobbyOne : Control
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        public override void _Ready() => _firstReadyCount++;
    }

    public partial class SyntheticLobbyTwo : Control
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        public override void _Ready() => _secondReadyCount++;
    }
}
