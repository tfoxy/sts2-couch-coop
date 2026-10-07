using System.Globalization;
using Godot;

namespace CouchCoop.Mod.Audio.Host;

/// <summary>Translates audio-proxy calls into the FMOD operations used by the private renderer.</summary>
internal static class ProxyOpTable
{
    private static readonly object Gate = new();
    private static readonly HashSet<string> Loops = new(StringComparer.Ordinal);
    private static readonly HashSet<string> Banks = new(StringComparer.Ordinal);

    internal static IReadOnlyList<HostAudioOp> Translate(bool musicProxy, string method,
        ReadOnlySpan<Variant> args, long timeUs)
    {
        static string S(ReadOnlySpan<Variant> values, int index)
            => values.Length > index ? values[index].AsString() : "";
        static string N(ReadOnlySpan<Variant> values, int index)
            => values.Length > index
                ? values[index].AsSingle().ToString("R", CultureInfo.InvariantCulture) : "0";
        static HostAudioOp[] One(HostAudioOpKind kind, HostAudioLane lane, string slot,
            string name, string value, long time) => [new(kind, lane, slot, name, value, time)];

        if (musicProxy)
        {
            switch (method)
            {
                case "update_music":
                    return One(HostAudioOpKind.Start, HostAudioLane.Music, "music", S(args, 0), "", timeUs);
                case "stop_music":
                    return One(HostAudioOpKind.Stop, HostAudioLane.Music, "music", "", "", timeUs);
                case "update_music_parameter":
                    return One(HostAudioOpKind.Parameter, HostAudioLane.Music, "music", S(args, 0), N(args, 1), timeUs);
                case "update_global_parameter":
                    return One(HostAudioOpKind.Global, HostAudioLane.Music, "", S(args, 0), N(args, 1), timeUs);
                case "update_ambience":
                    return One(HostAudioOpKind.Start, HostAudioLane.Ambience, "ambience", S(args, 0), "", timeUs);
                case "stop_ambience":
                    return One(HostAudioOpKind.Stop, HostAudioLane.Ambience, "ambience", "", "", timeUs);
                case "update_campfire_ambience":
                    return One(HostAudioOpKind.Parameter, HostAudioLane.Ambience, "ambience", "Campfire", N(args, 0), timeUs);
                case "load_act_bank":
                {
                    var path = S(args, 0);
                    lock (Gate) Banks.Add(path);
                    return One(HostAudioOpKind.LoadBank, HostAudioLane.Music, "", path, "", timeUs);
                }
                case "unload_act_bank":
                {
                    var path = S(args, 0);
                    lock (Gate) Banks.Remove(path);
                    return One(HostAudioOpKind.UnloadBank, HostAudioLane.Music, "", path, "", timeUs);
                }
                case "unload_act_banks":
                    lock (Gate)
                    {
                        var operations = Banks.Select(path => new HostAudioOp(
                            HostAudioOpKind.UnloadBank, HostAudioLane.Music, "", path, "", timeUs)).ToArray();
                        Banks.Clear();
                        return operations;
                    }
            }
            return Array.Empty<HostAudioOp>();
        }

        switch (method)
        {
            case "play_music":
                return One(HostAudioOpKind.Start, HostAudioLane.Music, "menu", S(args, 0), "", timeUs);
            case "stop_music":
                return One(HostAudioOpKind.Stop, HostAudioLane.Music, "menu", "", "", timeUs);
            case "update_music_parameter":
                return One(HostAudioOpKind.Label, HostAudioLane.Music, "menu", S(args, 0), S(args, 1), timeUs);
            case "play_loop":
            {
                var path = S(args, 0);
                lock (Gate) Loops.Add(path);
                return One(HostAudioOpKind.Start, HostAudioLane.Loops, "loop:" + path, path, "", timeUs);
            }
            case "stop_loop":
            {
                var path = S(args, 0);
                lock (Gate) Loops.Remove(path);
                return One(HostAudioOpKind.Stop, HostAudioLane.Loops, "loop:" + path, "", "", timeUs);
            }
            case "set_param":
                return One(HostAudioOpKind.Parameter, HostAudioLane.Loops,
                    "loop:" + S(args, 0), S(args, 1), N(args, 2), timeUs);
            case "stop_all_loops":
                lock (Gate)
                {
                    var operations = Loops.Select(path => new HostAudioOp(
                        HostAudioOpKind.Stop, HostAudioLane.Loops, "loop:" + path, "", "", timeUs)).ToArray();
                    Loops.Clear();
                    return operations;
                }
        }
        return Array.Empty<HostAudioOp>();
    }
}
