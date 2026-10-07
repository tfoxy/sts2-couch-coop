using System.Text.Json.Serialization;

namespace CouchCoop.MirrorProtocol.Envelopes;

// Audio WebSockets are separate from the scene socket. All times are monotonic microseconds.
// Seat -> viewer/host; key and keyId are both present so the host can verify identity.
public sealed record SeatAudioSfx(string KeyId, string Key, long T, float Pitch = 1, float Volume = 1)
{
    public string Kind => "sfx";
}

public sealed record SeatAudioTmpSfx(string ResPath, long T, float Pitch = 1, float Volume = 1)
{
    public string Kind => "tmpsfx";
}

public sealed record SeatAudioLoop(string KeyId, string Key, string Action, long T)
{
    public string Kind => "loop";
}

// Raw 0..1 seat values; clients apply the FMOD square curve for SFX/lanes.
// Changed entries only on a delta; all four required in a snapshot.
public sealed record SeatAudioVolumes(float? Master = null, float? Bgm = null, float? Sfx = null,
    float? Ambience = null, float? GodotMasterDb = null, float? GodotSfxDb = null, bool Snapshot = false)
{
    public string Kind => "volumes";
}

public sealed record SeatAudioHello(int Schema = 1)
{
    public string Kind => "hello";
}

public sealed record SeatAudioAck(long Seq)
{
    public string Kind => "ack";
}

// Render lane client -> host.
public sealed record AudioPlay(string KeyId, string Key)
{
    public string Kind => "play";
}

public sealed record AudioLanes(bool Music, bool Ambience, bool Loops)
{
    public string Kind => "lanes";
}

// Render lane host -> client. TakeStart precedes a first-sight stream; TakeReady closes it
// and advertises the immutable cache URL.
public sealed record AudioHello(int Schema, string Bankset, int SampleRate = 48_000, int LaneBlockFrames = 512)
{
    public string Kind => "hello";
}

public sealed record AudioTakeStart(string KeyId, uint StreamId)
{
    public string Kind => "take-start";
}

public sealed record AudioTakeReady(string KeyId, uint StreamId, string Url)
{
    public string Kind => "take-ready";
}

public sealed record AudioUnavailable(string KeyId, string Reason)
{
    public string Kind => "unavailable";
}

public sealed record AudioClock(ulong HostUs, ulong SentUs,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? Seq = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] double? ClientPerfMs = null)
{
    public string Kind => "clock";
}
