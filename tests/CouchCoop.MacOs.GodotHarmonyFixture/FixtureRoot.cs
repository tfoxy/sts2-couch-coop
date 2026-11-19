using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Patches;
using Godot;
using HarmonyLib;

namespace CouchCoop.MacOs.GodotHarmonyFixture;

public partial class FixtureRoot : Control
{
    internal const string MarkerPrefix = "COUCHCOOP_GODOT_HARMONY_FIXTURE:";
    private const int DiagnosticByteLimit = 32 * 1024;
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
    private readonly List<GodotNodeMountFailure> _failures = [];
    private readonly List<string> _refusalSources = [];
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

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
            else Refuse("unexpected-node:" + node.Name);
            if (node.GetNodeOrNull<Control>(MountMarkerName) is null)
            {
                node.AddChild(new Control { Name = MountMarkerName });
            }
        }, failure =>
        {
            _failures.Add(failure);
            Refuse("patch-failure");
        });

        var firstApply = _hook.Apply();
        if (!firstApply) Refuse("first-apply-false");
        AddChild(new SyntheticLobbyOne { Name = FirstSyntheticName });
        AddChild(new SyntheticLobbyTwo { Name = SecondSyntheticName });
        // A complete plan is inert: if it installed a second postfix, the callback count becomes four.
        if (!_hook.Apply()) Refuse("second-apply-false");
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
                _patchRefused,
                _failures.Select(failure => new FixtureFailure(
                    failure.Target.Key, failure.Kind.ToString(), failure.Detail)).ToArray(),
                _refusalSources.ToArray());
            Console.WriteLine("COUCHCOOP_GODOT_HARMONY_FIXTURE_DIAG:" + CreateDiagnostics());
            Console.WriteLine(MarkerPrefix + JsonSerializer.Serialize(result, JsonOptions));
            GetTree().Quit(IsSuccess(result) ? 0 : 1);
        }
    }

    private void Refuse(string source)
    {
        _patchRefused = true;
        _refusalSources.Add(source);
    }

    private string CreateDiagnostics()
    {
        var exceptions = new List<FixtureException>();
        foreach (var target in _failures.Where(failure => failure.Kind == GodotNodeMountFailureKind.PatchFailed)
            .Select(failure => failure.Target).Distinct().Take(2))
        {
            try
            {
                var method = GodotNodeMountHook.ResolveDeclaredZeroArgumentMethod(target)
                    ?? throw new MissingMethodException(target.TypeName, target.MethodName);
                new Harmony("com.couchcoop.godot-harmony-fixture.diag").Patch(method,
                    postfix: new HarmonyMethod(typeof(FixtureRoot), nameof(DiagnosticPostfix)));
            }
            catch (Exception exception)
            {
                exceptions.Add(new(target.Key, exception.GetType().FullName,
                    Truncate(exception.Message, 4 * 1024), Truncate(exception.ToString(), 16 * 1024)));
            }
        }

        var harmony = typeof(Harmony).Assembly;
        var assemblies = AppDomain.CurrentDomain.GetAssemblies().Select(assembly => assembly.GetName())
            .Where(name => name.Name?.Contains("Harmony", StringComparison.OrdinalIgnoreCase) == true
                || name.Name?.Contains("MonoMod", StringComparison.OrdinalIgnoreCase) == true)
            .Take(16).ToArray();
        var framework = RuntimeInformation.FrameworkDescription;
        var architecture = RuntimeInformation.ProcessArchitecture.ToString();
        var os = RuntimeInformation.OSDescription;
        var informationalVersion = harmony.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;

        // Bound the serialized UTF-8 JSON, including escaping, leaving room for the result marker under the
        // supervisor's stdout cap. Halving all text limits must terminate: the entry counts are fixed and bounded.
        for (var textLimit = 16 * 1024; ; textLimit /= 2)
        {
            string? Metadata(string? value) => Truncate(value, Math.Min(512, textLimit));
            var json = JsonSerializer.Serialize(new
            {
                framework = Metadata(framework),
                processArchitecture = Metadata(architecture),
                osDescription = Metadata(os),
                harmony = new
                {
                    location = Metadata(harmony.Location),
                    version = Metadata(harmony.GetName().Version?.ToString()),
                    informationalVersion = Metadata(informationalVersion),
                },
                assemblies = assemblies.Select(name => new
                {
                    name = Metadata(name.Name), version = Metadata(name.Version?.ToString()),
                }).ToArray(),
                exceptions = exceptions.Select(exception => new
                {
                    target = Metadata(exception.Target),
                    type = Metadata(exception.Type),
                    message = Truncate(exception.Message, Math.Min(4 * 1024, textLimit)),
                    full = Truncate(exception.Full, textLimit),
                }).ToArray(),
            }, JsonOptions);
            if (Encoding.UTF8.GetByteCount(json) <= DiagnosticByteLimit) return json;
        }
    }

    private static string? Truncate(string? value, int limit) =>
        value is not null && value.Length > limit ? value[..limit] : value;

    private readonly record struct FixtureException(string Target, string? Type, string? Message, string? Full);

    private static void DiagnosticPostfix() { }

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
        bool PatchRefused,
        FixtureFailure[] Failures,
        string[] RefusalSources);

    private readonly record struct FixtureFailure(string Target, string Kind, string? Detail);

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
