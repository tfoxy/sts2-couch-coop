namespace CouchCoop.Mod.Audio.Host;

/// <summary>The proxy streams share marshalling, but their observation targets are independent.</summary>
internal static class HostAudioHookSetup
{
    internal static bool Install(Func<string, Action, bool> tryFeature,
        Action audio, Action music, Action marshalling)
    {
        var audioAvailable = tryFeature("host-audio-effects", audio);
        var musicAvailable = tryFeature("host-audio-music", music);
        var marshallingAvailable = tryFeature("host-audio-marshalling", marshalling);
        return marshallingAvailable && (audioAvailable || musicAvailable);
    }
}
