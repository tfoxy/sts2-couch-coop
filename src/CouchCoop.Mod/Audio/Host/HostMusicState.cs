namespace CouchCoop.Mod.Audio.Host;

internal enum HostAudioOpKind
{
    Start,
    Stop,
    Parameter,
    Label,
    Global,
    LoadBank,
    UnloadBank,
}

internal enum HostAudioLane
{
    Music,
    Ambience,
    Loops,
}

/// <summary>An FMOD operation observed on the host's audio proxy.</summary>
internal readonly record struct HostAudioOp(
    HostAudioOpKind Kind,
    HostAudioLane Lane,
    string Slot,
    string Name,
    string Value,
    long TimeUs);

internal sealed record HostAudioInstance(
    string EventPath,
    HostAudioLane Lane,
    IReadOnlyDictionary<string, string> Parameters,
    IReadOnlyDictionary<string, string> Labels);

internal sealed record HostMusicSnapshot(
    IReadOnlyDictionary<string, HostAudioInstance> Instances,
    IReadOnlyDictionary<string, string> Globals,
    IReadOnlyCollection<string> Banks);

/// <summary>The current FMOD music, ambience, loop and bank state for an approximate join.</summary>
internal sealed class HostMusicState
{
    private sealed class MutableInstance(string eventPath, HostAudioLane lane)
    {
        internal string EventPath = eventPath;
        internal HostAudioLane Lane = lane;
        internal readonly Dictionary<string, string> Parameters = new(StringComparer.Ordinal);
        internal readonly Dictionary<string, string> Labels = new(StringComparer.Ordinal);
    }

    private readonly object _gate = new();
    private readonly Dictionary<string, MutableInstance> _instances = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _globals = new(StringComparer.Ordinal);
    private readonly HashSet<string> _banks = new(StringComparer.Ordinal);

    internal void Apply(in HostAudioOp op)
    {
        lock (_gate)
        {
            switch (op.Kind)
            {
                case HostAudioOpKind.Start when op.Slot.Length > 0 && op.Name.Length > 0:
                    _instances[op.Slot] = new MutableInstance(op.Name, op.Lane);
                    break;
                case HostAudioOpKind.Stop:
                    _instances.Remove(op.Slot);
                    break;
                case HostAudioOpKind.Parameter:
                    if (_instances.TryGetValue(op.Slot, out var parameterTarget) && op.Name.Length > 0)
                        parameterTarget.Parameters[op.Name] = op.Value;
                    break;
                case HostAudioOpKind.Label:
                    if (_instances.TryGetValue(op.Slot, out var labelTarget) && op.Name.Length > 0)
                        labelTarget.Labels[op.Name] = op.Value;
                    break;
                case HostAudioOpKind.Global when op.Name.Length > 0:
                    _globals[op.Name] = op.Value;
                    break;
                case HostAudioOpKind.LoadBank when op.Name.Length > 0:
                    _banks.Add(op.Name);
                    break;
                case HostAudioOpKind.UnloadBank:
                    _banks.Remove(op.Name);
                    break;
            }
        }
    }

    internal HostMusicSnapshot Snapshot()
    {
        lock (_gate)
        {
            return new HostMusicSnapshot(
                _instances.ToDictionary(
                    pair => pair.Key,
                    pair => new HostAudioInstance(pair.Value.EventPath, pair.Value.Lane,
                        new Dictionary<string, string>(pair.Value.Parameters, StringComparer.Ordinal),
                        new Dictionary<string, string>(pair.Value.Labels, StringComparer.Ordinal)),
                    StringComparer.Ordinal),
                new Dictionary<string, string>(_globals, StringComparer.Ordinal),
                _banks.ToArray());
        }
    }
}
