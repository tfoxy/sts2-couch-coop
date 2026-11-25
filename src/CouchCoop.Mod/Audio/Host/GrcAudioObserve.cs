using System.Globalization;
using CouchCoop.Mod.Runtime;

namespace CouchCoop.Mod.Audio.Host;

internal interface IGrcFmodModule
{
    void SeatOpen(uint seat);
    void SeatClose(uint seat);
    void LinkIn(uint seat, ReadOnlySpan<byte> message);
    void Observe(uint op, ulong instance, string text, float value = 0);
}

/// <summary>Translates product slots into observer identities; release always follows stop.</summary>
internal sealed class GrcAudioObserve(IGrcFmodModule module)
{
    private readonly Dictionary<string, ulong> _instances = new(StringComparer.Ordinal);
    private ulong _next;

    internal void Reset(HostMusicSnapshot snapshot)
    {
        foreach (var id in _instances.Values) { module.Observe(5, id, "", 1); module.Observe(6, id, ""); }
        _instances.Clear();
        foreach (var bank in snapshot.Banks) Apply(new(HostAudioOpKind.LoadBank, default, "", bank, "", 0));
        foreach (var global in snapshot.Globals) Apply(new(HostAudioOpKind.Global, default, "", global.Key, global.Value, 0));
        foreach (var (slot, instance) in snapshot.Instances)
        {
            Apply(new(HostAudioOpKind.Start, instance.Lane, slot, instance.EventPath, "", 0));
            foreach (var pair in instance.Parameters) Apply(new(HostAudioOpKind.Parameter, instance.Lane, slot, pair.Key, pair.Value, 0));
            foreach (var pair in instance.Labels) Apply(new(HostAudioOpKind.Label, instance.Lane, slot, pair.Key, pair.Value, 0));
        }
    }

    internal void Apply(HostAudioOp op)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.GrcAudioObserve);
        _instances.TryGetValue(op.Slot, out var id);
        switch (op.Kind)
        {
            case HostAudioOpKind.Start:
                if (id != 0) { module.Observe(5, id, "", 0); module.Observe(6, id, ""); }
                id = ++_next;
                _instances[op.Slot] = id;
                module.Observe(3, id, op.Name);
                module.Observe(4, id, "");
                break;
            case HostAudioOpKind.Stop when id != 0:
                module.Observe(5, id, "", 0);
                module.Observe(6, id, "");
                _instances.Remove(op.Slot);
                break;
            case HostAudioOpKind.Parameter when id != 0:
                if (Number(op.Value, out var number)) module.Observe(7, id, op.Name, number);
                break;
            case HostAudioOpKind.Label when id != 0:
                module.Observe(10, id, op.Name + '\0' + op.Value);
                break;
            case HostAudioOpKind.Global:
                if (Number(op.Value, out var global)) module.Observe(8, 0, op.Name, global);
                else module.Observe(11, 0, op.Name + '\0' + op.Value);
                break;
            case HostAudioOpKind.LoadBank: module.Observe(1, 0, op.Name); break;
            case HostAudioOpKind.UnloadBank: module.Observe(2, 0, op.Name); break;
        }
    }

    private static bool Number(string value, out float number)
        => float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number) && float.IsFinite(number);
}
