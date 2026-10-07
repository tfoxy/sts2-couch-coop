using CouchCoop.Mod.Audio.Host;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes.Audio;

namespace CouchCoop.Mod.Tests;

internal static class HostMusicStateTests
{
    internal static void Run()
    {
        TargetsResolve();
        var state = new HostMusicState();
        state.Apply(new HostAudioOp(HostAudioOpKind.LoadBank, HostAudioLane.Music, "", "res://banks/act.bank", "", 1));
        state.Apply(new HostAudioOp(HostAudioOpKind.Global, HostAudioLane.Music, "", "Progress", "0.5", 2));
        state.Apply(new HostAudioOp(HostAudioOpKind.Start, HostAudioLane.Music, "music", "event:/music/track", "", 3));
        state.Apply(new HostAudioOp(HostAudioOpKind.Parameter, HostAudioLane.Music, "music", "Intensity", "2", 4));
        state.Apply(new HostAudioOp(HostAudioOpKind.Label, HostAudioLane.Music, "music", "Section", "battle", 5));
        state.Apply(new HostAudioOp(HostAudioOpKind.Start, HostAudioLane.Ambience, "ambience", "event:/ambience/room", "", 6));

        var joined = state.Snapshot();
        Check(joined.Instances.Count == 2, "music and ambience retained");
        Check(joined.Instances["music"].EventPath == "event:/music/track", "music path retained");
        Check(joined.Instances["music"].Parameters["Intensity"] == "2", "parameter retained");
        Check(joined.Instances["music"].Labels["Section"] == "battle", "label retained");
        Check(joined.Globals["Progress"] == "0.5", "global retained");
        Check(joined.Banks.Contains("res://banks/act.bank"), "act bank retained");

        state.Apply(new HostAudioOp(HostAudioOpKind.Start, HostAudioLane.Music, "music", "event:/music/next", "", 7));
        state.Apply(new HostAudioOp(HostAudioOpKind.Stop, HostAudioLane.Ambience, "ambience", "", "", 8));
        state.Apply(new HostAudioOp(HostAudioOpKind.UnloadBank, HostAudioLane.Music, "", "res://banks/act.bank", "", 9));
        var later = state.Snapshot();
        Check(joined.Instances["music"].EventPath == "event:/music/track", "earlier snapshot remains immutable");
        Check(later.Instances["music"].EventPath == "event:/music/next", "start replaces its slot");
        Check(later.Instances["music"].Parameters.Count == 0, "a new instance does not inherit parameters");
        Check(!later.Instances.ContainsKey("ambience"), "stop clears ambience");
        Check(later.Banks.Count == 0, "bank unload clears the memo");
    }

    internal static void TargetsResolve()
    {
        Check(HostAudioHooks.ResolveMarshallingHelper() is not null,
            "GodotObject.Call resolves one marshalling helper from the installed GodotSharp IL");
        Check(AccessTools.Method(typeof(NAudioManager), "_EnterTree") is not null,
            "audio proxy mount hook resolves");
        Check(AccessTools.Method(typeof(NRunMusicController), "_Ready") is not null,
            "music proxy mount hook resolves");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("HostMusicState: " + message);
    }
}
