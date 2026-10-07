using System.Diagnostics;
using System.Runtime.InteropServices;
using CouchCoop.Mod.Audio.Render;
using CouchCoop.Mod.Audio.Banks;
using CouchCoop.Mod.Audio.Host;
using CouchCoop.MirrorProtocol.Audio;

string config = Path.GetFullPath("sts2.local.yaml");
if (!File.Exists(config)) throw new Exception("sts2.local.yaml with game.assembliesDir is required");
string? gamePath = null, assemblies = null;
foreach (string line in File.ReadLines(config))
{
    string trimmed = line.Trim();
    if (trimmed.StartsWith("path: ")) gamePath = trimmed[6..];
    if (trimmed.StartsWith("assembliesDir: ")) assemblies = trimmed[15..];
}
if (string.IsNullOrWhiteSpace(assemblies) || !Directory.Exists(assemblies))
    throw new Exception("game.assembliesDir is required for native audio tests");
if (string.IsNullOrWhiteSpace(gamePath)) throw new Exception("game.path is required to locate the package");
string package = Path.Combine(gamePath, "SlayTheSpire2.pck");
if (!File.Exists(package)) throw new FileNotFoundException("Game package missing", package);

(string Path, TakeParameter[] Parameters)[] cases = [
    ("event:/sfx/ui/clicks/ui_hover", []),
    ("event:/sfx/ui/gain_energy", []),
    ("event:/sfx/ui/cards/card_movement_B_into_discard", []),
    ("event:/sfx/characters/ironclad/ironclad_attack", []),
    ("event:/sfx/ui/clicks/ui_click", []),
    ("event:/sfx/ui/cards/card_movement_B_into_draw", []),
    ("event:/sfx/block_gain", []),
    ("event:/sfx/heal", []),
    ("event:/sfx/enemy/enemy_impact_enemy_size/enemy_impact_slime", [new("EnemyImpact_Intensity", 2)]),
    ("event:/sfx/ui/relic_activate_general", []),
    ("event:/sfx/block_hit", []),
    ("event:/sfx/debuff", []),
    ("event:/sfx/block_break", []),
    ("event:/sfx/ui/map/map_open", []),
    ("event:/sfx/ui/gold/gold_1", []),
    ("event:/sfx/enemy/enemy_impact_enemy_size/enemy_impact_armor", [new("EnemyImpact_Intensity", 2)]),
    ("event:/sfx/enemy/enemy_impact_enemy_size/enemy_impact_insect", [new("EnemyImpact_Intensity", 2)]),
    ("event:/sfx/enemy/enemy_attacks/toadpole/toadpole_attack", []),
    ("event:/sfx/buff", []),
    ("event:/sfx/ui/cards/card_movement_B_into_deck", []),
    ("event:/sfx/enemy/enemy_attacks/skulking_colony/skulking_colony_hurt", []),
    ("event:/sfx/enemy/enemy_impact_enemy_size/enemy_impact_stone", [new("EnemyImpact_Intensity", 2)]),
    ("event:/sfx/enemy/enemy_impact_enemy_size/enemy_impact_plant", [new("EnemyImpact_Intensity", 2)]),
    ("event:/sfx/enemy/enemy_fade", []),
    ("event:/sfx/characters/ironclad/ironclad_cast", []),
    ("event:/sfx/ui/cards/card_movement_B_power", []),
    ("event:/sfx/npcs/merchant/merchant_thank_yous", []),
    ("event:/sfx/characters/ironclad/ironclad_select", []),
    ("event:/sfx/ui/wipe_ironclad", []),
    ("event:/sfx/enemy/enemy_attacks/corpse_slugs/corpse_slugs_attack", []),
];
using (var packageBanks = new PckBankSource(package)) packageBanks.VerifyDigests();
if (OperatingSystem.IsLinux())
{
    NativeLibrary.Load(Path.Combine(gamePath, "libfmod.so.14"));
    NativeLibrary.Load(Path.Combine(gamePath, "libfmodstudio.so.14"));
}

// The first two blocks look like ordinary SFX. A different bus contributes only
// in the third block, after the old progressive gate would have released PCM.
float[] lateBusSamples = new float[3 * 1024 * 2];
for (int frame = 0; frame < 3 * 1024; frame++)
{
    float sample = frame < 2 * 1024 ? 0.1f : 0.2f;
    lateBusSamples[frame * 2] = sample;
    lateBusSamples[frame * 2 + 1] = sample;
}
double sfxEnergy = 3 * 1024 * 2 * 0.1 * 0.1;
double lateBusEnergy = 1024 * 2 * 0.1 * 0.1;
double mixedEnergy = 2 * 1024 * 2 * 0.1 * 0.1 + 1024 * 2 * 0.2 * 0.2;
foreach (bool lateMusic in new[] { true, false })
{
    var rejected = new Sink(Stopwatch.GetTimestamp());
    try
    {
        FmodRenderSystem.ReleaseValidatedTake(lateBusSamples, mixedEnergy, sfxEnergy,
            lateMusic ? lateBusEnergy : 0, lateMusic ? 0 : lateBusEnergy, false, rejected);
        throw new Exception($"Late {(lateMusic ? "music" : "ambience")} contribution was accepted");
    }
    catch (InvalidOperationException) { }
    if (rejected.Blocks != 0)
        throw new Exception($"Late {(lateMusic ? "music" : "ambience")} contribution leaked {rejected.Blocks} PCM blocks");
}
var accepted = new Sink(Stopwatch.GetTimestamp());
float[] pureSfxSamples = new float[lateBusSamples.Length];
Array.Fill(pureSfxSamples, 0.1f);
FmodRenderSystem.ReleaseValidatedTake(pureSfxSamples, sfxEnergy, sfxEnergy, 0, 0, false, accepted);
if (accepted.Blocks != 3 || accepted.LastBlocks != 1)
    throw new Exception($"Accepted SFX take yielded {accepted.Blocks} blocks and {accepted.LastBlocks} final blocks");

long before = Process.GetCurrentProcess().WorkingSet64;
using var backend = OperatingSystem.IsLinux()
    ? new FmodRenderSystem(package, 37, Console.WriteLine)
    : new FmodRenderSystem(assemblies, package, 37, Console.WriteLine);
var latencies = new List<int>();
var sinkLatencies = new List<int>();
double laneResidual = double.NaN;
foreach (var (path, parameters) in cases)
{
    string canonical = SoundKey.Canonical(path, parameters.Select(p => new KeyValuePair<string, float>(p.Name, p.Value)));
    var sink = new Sink(Stopwatch.GetTimestamp());
    TakeResult result = backend.Render(new TakeRequest(SoundKey.Id(canonical), canonical, path, parameters), sink);
    if (result.Frames == 0 || result.Frames > 480_000 || sink.Blocks == 0 || sink.Energy == 0 ||
        result.SfxEnergy <= 0 || result.MusicEnergy > result.SfxEnergy * .001 ||
        result.AmbienceEnergy > result.SfxEnergy * .001)
        throw new Exception($"Invalid native take {path}");
    latencies.Add(result.FirstBlockMicroseconds);
    sinkLatencies.Add(sink.FirstSinkMicroseconds);
    if (path == "event:/sfx/ui/clicks/ui_click")
    {
        laneResidual = backend.LastLaneResidualDb;
        if (laneResidual > -60)
            throw new Exception($"Gain-aligned lane sum residual {laneResidual:F1} dB exceeds -60 dB");
    }
}
latencies.Sort();
sinkLatencies.Sort();
long delta = Process.GetCurrentProcess().WorkingSet64 - before;
if (backend.CallbackAllocatedBytes != 0)
    throw new Exception($"FMOD callback allocated {backend.CallbackAllocatedBytes} bytes");
if (delta > 60L * 1024 * 1024) throw new Exception($"Native renderer RSS +{delta / 1024 / 1024} MB exceeds 60 MB");
if (latencies[14] > 1000 || latencies[28] > 3000)
    throw new Exception($"First block timing p50={latencies[14]} us p95={latencies[28]} us");
Console.WriteLine($"30 native takes: mixed p50={latencies[14]} us p95={latencies[28]} us sink p50={sinkLatencies[14]} us p95={sinkLatencies[28]} us RSS delta={delta / 1024 / 1024} MB lane residual={laneResidual:F1} dB callback alloc={backend.CallbackAllocatedBytes}");

// The stream system is independent of the take system and remains dormant until subscribed.
var streamErrors = new List<string>();
using (var stream = new StreamRenderer(assemblies, package,
    () => new HostMusicSnapshot(new Dictionary<string, HostAudioInstance>(),
        new Dictionary<string, string>(), Array.Empty<string>()), streamErrors.Add))
{
    if (stream.Active) throw new Exception("Stream renderer started without a subscriber");
    using var arrived = new ManualResetEventSlim();
    int blocks = 0, nonSilent = 0;
    long priorIndex = -1, priorDue = -1;
    using (stream.Subscribe(HostAudioLane.Music, block =>
    {
        if (block.Index <= priorIndex || block.DueTimeUs <= priorDue ||
            block.Pcm.Length != StreamRenderer.BytesPerBlock)
            throw new Exception("Invalid streamed lane block");
        priorIndex = block.Index; priorDue = block.DueTimeUs;
        Interlocked.Increment(ref blocks);
        if (!block.Silent && Interlocked.Increment(ref nonSilent) >= 3) arrived.Set();
    }))
    {
        stream.Apply(new HostAudioOp(HostAudioOpKind.Start, HostAudioLane.Music,
            "music", "event:/music/act1_b1_v1", "", 0));
        if (!arrived.Wait(TimeSpan.FromSeconds(5)))
            throw new Exception($"No music lane output after {blocks} blocks: {string.Join(" | ", streamErrors)}");
    }
    if (stream.Active || stream.SubscriberCount != 0)
        throw new Exception("Stream renderer did not release on last unsubscribe");
    using var rejoined = new ManualResetEventSlim();
    long rejoinIndex = -1;
    using (stream.Subscribe(HostAudioLane.Music, block =>
    {
        rejoinIndex = block.Index;
        rejoined.Set();
    }))
    {
        if (!rejoined.Wait(TimeSpan.FromSeconds(5)) || rejoinIndex != 0)
            throw new Exception($"Stream renderer did not restart at the next fresh block: {rejoinIndex}");
    }
    if (streamErrors.Count != 0) throw new Exception(string.Join(" | ", streamErrors));
    Console.WriteLine($"stream lane: {blocks} blocks, {nonSilent} non-silent, released on last subscriber");
}

// Replay an E8-shaped music sequence twice through independent private systems.
// The reference run is generated here, so this gate remains runnable without research recordings.
byte[][] first = ReplayMusic();
byte[][] second = ReplayMusic();
int compared = 0, matched = 0;
for (int block = 40; block < Math.Min(first.Length, second.Length); block += 4)
{
    double aa = 0, bb = 0, ab = 0;
    for (int i = 0; i < first[block].Length; i += 2)
    {
        short a = (short)(first[block][i] | first[block][i + 1] << 8);
        short b = (short)(second[block][i] | second[block][i + 1] << 8);
        aa += (double)a * a; bb += (double)b * b; ab += (double)a * b;
    }
    if (aa < 1e6 || bb < 1e6) continue;
    compared++;
    if (ab / Math.Sqrt(aa * bb) >= .99) matched++;
}
if (compared < 10 || matched < Math.Ceiling(compared * .95))
    throw new Exception($"Music replay correlation: {matched}/{compared} windows >= .99");
Console.WriteLine($"stream replay: {matched}/{compared} music windows NCC >= .99");

byte[][] ReplayMusic()
{
    var blocks = new List<byte[]>();
    var errors = new List<string>();
    using var finished = new ManualResetEventSlim();
    using var renderer = new StreamRenderer(assemblies, package,
        () => new HostMusicSnapshot(new Dictionary<string, HostAudioInstance>(),
            new Dictionary<string, string>(), Array.Empty<string>()), errors.Add);
    using (renderer.Subscribe(HostAudioLane.Music, block =>
    {
        blocks.Add(block.Pcm);
        if (blocks.Count == 32)
            renderer.Apply(new HostAudioOp(HostAudioOpKind.Global, HostAudioLane.Music,
                "", "Progress", "0.5", 0));
        if (blocks.Count == 160) finished.Set();
    }))
    {
        renderer.Apply(new HostAudioOp(HostAudioOpKind.Start, HostAudioLane.Music,
            "music", "event:/music/act1_b1_v1", "", 0));
        if (!finished.Wait(TimeSpan.FromSeconds(5)))
            throw new Exception($"Music replay timed out at {blocks.Count} blocks: {string.Join(" | ", errors)}");
    }
    if (errors.Count != 0) throw new Exception(string.Join(" | ", errors));
    return blocks.ToArray();
}

sealed class Sink(long startedAt) : IAudioBlockSink
{
    public int Blocks { get; private set; }
    public int LastBlocks { get; private set; }
    public long Energy { get; private set; }
    public int FirstSinkMicroseconds { get; private set; }
    public void OnBlock(ReadOnlyMemory<byte> pcm, int index, bool last)
    {
        if (Blocks == 0) FirstSinkMicroseconds = (int)(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds * 1000);
        Blocks++;
        if (last) LastBlocks++;
        foreach (byte sample in pcm.Span) Energy += sample;
    }
}
