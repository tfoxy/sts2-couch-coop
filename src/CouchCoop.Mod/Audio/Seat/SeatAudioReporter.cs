namespace CouchCoop.Mod.Audio.Seat;

/// <summary>Routes FMOD reports to subscribed renderers. TmpSfx retains its existing reporter.</summary>
internal static class SeatAudioReporter
{
    internal static bool HasDemand => SeatAudioFeed.HasSubscribers || GrcAudioCue.Active;
    internal static bool ReportsVolumes => SeatAudioFeed.HasSubscribers || GrcAudioCue.Enabled;

    internal static void Sfx(string path, Dictionary<string, float>? parameters, float volume)
    {
        if (GrcAudioCue.Enabled) GrcAudioCue.Sfx(path, parameters, volume);
        if (SeatAudioFeed.HasSubscribers) SeatAudioFeed.Sfx(path, parameters, volume);
    }

    internal static void Loop(string path, string action)
    {
        if (GrcAudioCue.Enabled) GrcAudioCue.Loop(path, action);
        if (SeatAudioFeed.HasSubscribers) SeatAudioFeed.Loop(path, action);
    }

    internal static void Volume(float value, int field)
    {
        if (GrcAudioCue.Enabled) GrcAudioCue.Volume(value, field);
        if (!SeatAudioFeed.HasSubscribers) return;
        switch (field)
        {
            case 0: SeatAudioFeed.SetMaster(value); break;
            case 1: SeatAudioFeed.SetBgm(value); break;
            case 2: SeatAudioFeed.SetSfx(value); break;
            case 3: SeatAudioFeed.SetAmbience(value); break;
        }
    }
}
