using System.Text.Json;
using CouchCoop.Mod.Session;

internal static class RenderCaptureAvailabilityTests
{
    public const string Verb = "render-capture-availability";
    private static int _assertions;
    private const string Extension = "/capture/render_stream_capture.gdextension";
    private static readonly RenderCaptureAvailability.PeIdentity Identity = new(8192, 1234, "000102030405060708090a0b0c0d0e0f:1");

    public static void Run()
    {
        using var pe = SyntheticPe();
        Check(RenderCaptureAvailability.ReadPeIdentity(pe) == Identity, "raw GUID bytes keep their file order");
        using var noDebug = SyntheticPe(debug: false);
        Check(RenderCaptureAvailability.ReadPeIdentity(noDebug) == Identity with { CodeViewId = null }, "no debug directory");
        using var truncated = new MemoryStream(pe.ToArray()[..100]);
        Check(RenderCaptureAvailability.ReadPeIdentity(truncated) is null, "truncated PE");
        using var conflicting = SyntheticPe(conflict: true);
        Check(RenderCaptureAvailability.ReadPeIdentity(conflicting) is null, "conflicting RSDS entries");
        using var throwing = new ThrowingStream();
        Check(RenderCaptureAvailability.ReadPeIdentity(throwing) is null, "reader exception");

        var files = new Dictionary<string, string>
        {
            [Extension] = "[libraries]\nwindows.x86_64 = \"capture.dll\"",
            ["/capture/capture.dll"] = "MZ",
            ["/capture/calibration.a"] = Record(Identity with { SizeOfImage = 1 }),
            ["/capture/calibration.b"] = Record(Identity),
        };
        StreamingSeatLaunch.ConfigResult Resolve(string os = "windows", string? record = null,
            Func<RenderCaptureAvailability.PeIdentity?>? identity = null) => RenderCaptureAvailability.Resolve(
                Extension, record, os, "x86_64", path => files[path], files.ContainsKey,
                _ => files.Keys.Reverse(), identity ?? (() => Identity), () => "aabb");
        Check(Resolve().Config?.Calibration == "/capture/calibration.b", "second record matches");
        files["/capture/calibration.a"] = Record(Identity);
        Check(Resolve().Config?.Calibration == "/capture/calibration.a", "matching candidates use ordinal filenames");
        Check(Resolve(record: "/capture/calibration.b").Config is not null, "operator match");
        files["/capture/calibration.a"] = Record(Identity with { SizeOfImage = 1 });
        Check(Resolve(record: "/capture/calibration.a").Config is null, "operator mismatch has no fallback");
        Check(Resolve(identity: () => null).Config is null, "missing PE identity");
        Check(Resolve(identity: () => throw new IOException()).Config is null, "identity reader throws");
        Check(Resolve(identity: () => Identity with { CodeViewId = null }).Config is null, "no CodeView cannot match a CodeView record");
        files["/capture/calibration.b"] = Record(Identity, "linux-x86_64");
        Check(Resolve().Config is null, "Linux record refused on Windows");
        files["/capture/calibration.b"] = "{}";
        Check(Resolve().Config is null, "record missing engine");
        files["/capture/calibration.b"] = Record(Identity).Replace("\"size_of_image\":8192,", "");
        Check(Resolve().Config is null, "missing size_of_image");
        files["/capture/calibration.b"] = "broken";
        Check(Resolve().Config is null, "unparseable record");
        files.Remove("/capture/calibration.a"); files.Remove("/capture/calibration.b");
        Check(Resolve().Config is null, "empty candidate set");
        Check(Resolve().Refusal?.Contains("size_of_image=8192, time_date_stamp=1234, codeview_id=" + Identity.CodeViewId) == true,
            "refusal names all identity fields");
        files["/capture/calibration.b"] = Record(Identity with { CodeViewId = null });
        Check(Resolve(identity: () => Identity with { CodeViewId = null }).Config is not null, "null CodeView equals null");
        files[Extension] = "[libraries]\nlinux.x86_64 = \"/dev/absolute.so\"";
        Check(Resolve().Config is null, "no Windows OS key");
        files[Extension] = "[libraries]\nwindows.x86_64 = \"missing.dll\"";
        Check(Resolve().Config is null, "missing relative library");
        files[Extension] = "[libraries]\nlinux.x86_64 = \"/dev/absolute.so\"";
        files["/dev/absolute.so"] = "ELF"; files["/capture/calibration"] = "{\"engine\":{\"platform\":\"linux-x86_64\",\"build_id\":\"aabb\"}}";
        Check(Resolve("linux", identity: () => throw new Exception()).Config?.Calibration == "/capture/calibration",
            "absolute Linux dev library accepted without a PE identity read");
        var unset = StreamingSeatLaunch.ResolveConfig(null, null, _ => false, "/mod/lanes/0.103.0");
        Check(unset.Config is null && unset.Refusal is null, "unset configuration is simply off");
        var mac = RenderCaptureAvailability.Resolve(null, null, "macos", "arm64", _ => throw new Exception(), _ => false, _ => [], () => throw new Exception());
        Check(mac.Config is null && mac.Refusal is null, "macOS without a packaged directory is not configured");
        LinuxRecords();
        ElfNotes();
        TypedOutcomes();
        CrossCheck();
        Console.WriteLine($"render-capture availability: {_assertions} passed.");
    }

    private static void LinuxRecords()
    {
        const string m12 = "9a404dfede6a1778b7348d0087804ae48a233e38";
        const string m14 = "d5fc2677b9aed9edbd81297609d7d53c93e2e34e";
        string RecordFor(string id, string platform = "linux-x86_64")
            => JsonSerializer.Serialize(new { engine = new { platform, build_id = id } });
        var files = new Dictionary<string, string>
        {
            [Extension] = "[libraries]\nlinux.x86_64 = \"capture.so\"",
            ["/capture/capture.so"] = "ELF",
            ["/capture/calibration.stable"] = RecordFor(m12),
            ["/capture/calibration.public-beta"] = RecordFor(m14),
            ["/capture/calibration.beta-v113"] = RecordFor(m14),
            ["/capture/calibration.invalid"] = "broken",
        };
        string? BuildId(string? id)
        {
            if (id is null) return null;
            using var elf = SyntheticElf(buildId: id);
            return RenderCaptureAvailability.ReadElfBuildId(elf);
        }
        StreamingSeatLaunch.ConfigResult Resolve(string? id = m14, string? record = null) => RenderCaptureAvailability.Resolve(
            Extension, record, "linux", "x86_64", path => files[path], files.ContainsKey,
            _ => files.Keys.Reverse(), () => throw new Exception("Linux must not read PE identity"), () => BuildId(id));
        Check(Resolve(m12).Config?.Calibration == "/capture/calibration.stable", "m.12 selects m.12 record");
        Check(Resolve().Config?.Calibration == "/capture/calibration.beta-v113", "m.14 selects m.14 with ordinal tie break");
        var unknown = Resolve("abcdef");
        Check(unknown.Config is null && unknown.Reason == RenderCaptureAvailability.UnavailableReason.NoMatchingRecord
            && unknown.Refusal?.Contains("build_id=abcdef") == true, "unknown build-id is named in typed refusal");
        Check(Resolve(null).Reason == RenderCaptureAvailability.UnavailableReason.IdentityUnreadable, "unreadable ELF identity");
        Check(Resolve(record: "/capture/calibration.stable").Reason == RenderCaptureAvailability.UnavailableReason.OperatorRecordMismatch,
            "operator mismatch never falls back to matching candidate");
        Check(Resolve(record: "/capture/calibration.public-beta").Config?.Calibration == "/capture/calibration.public-beta",
            "operator matching record wins");
        Check(Resolve(record: "/missing").Reason == RenderCaptureAvailability.UnavailableReason.OperatorRecordMismatch,
            "missing operator record fails closed");
        files["/capture/calibration.beta-v113"] = RecordFor(m14, "windows-x86_64");
        files["/capture/calibration.public-beta"] = RecordFor(m14, "linux-arm64");
        Check(Resolve().Reason == RenderCaptureAvailability.UnavailableReason.NoMatchingRecord, "Linux requires matching platform");
        files["/capture/calibration.public-beta"] = "{\"engine\":{\"platform\":\"linux-x86_64\"}}";
        Check(Resolve().Reason == RenderCaptureAvailability.UnavailableReason.NoMatchingRecord, "record missing build-id is skipped");
    }

    private static void ElfNotes()
    {
        using var elf = SyntheticElf();
        Check(RenderCaptureAvailability.ReadElfBuildId(elf) == "aabbcc", "ELF GNU build-id, unrelated note and four-byte alignment");
        using var pie = SyntheticElf(pie: true);
        Check(RenderCaptureAvailability.ReadElfBuildId(pie) == "aabbcc", "PIE executable without section headers");
        using var conflict = SyntheticElf(conflict: true);
        Check(RenderCaptureAvailability.ReadElfBuildId(conflict) is null, "conflicting GNU notes fail closed");
        using var throwing = new ThrowingStream();
        Check(RenderCaptureAvailability.ReadElfBuildId(throwing) is null, "ELF reader exception");
        foreach (var length in new[] { 0, 63, 100, 279 })
        {
            using var truncated = new MemoryStream(elf.ToArray()[..length]);
            Check(RenderCaptureAvailability.ReadElfBuildId(truncated) is null, $"truncated ELF at {length}");
        }
        foreach (var (offset, value) in new (int, byte)[] { (0, 0), (4, 1), (5, 2), (18, 3), (54, 1), (56, 0), (280, 0xff) })
        {
            var bytes = elf.ToArray(); bytes[offset] = value;
            using var malformed = new MemoryStream(bytes);
            Check(RenderCaptureAvailability.ReadElfBuildId(malformed) is null, $"malformed ELF at {offset}");
        }
        var exe = Environment.GetEnvironmentVariable("COUCHCOOP_TEST_ELF");
        if (!string.IsNullOrWhiteSpace(exe))
        {
            using var installed = File.OpenRead(exe);
            var id = RenderCaptureAvailability.ReadElfBuildId(installed);
            Check(id == Environment.GetEnvironmentVariable("COUCHCOOP_TEST_ELF_BUILD_ID"), "installed ELF build-id cross-check");
            Console.WriteLine($"ELF cross-check: build_id={id}");
        }
        if (OperatingSystem.IsLinux())
        {
            using var host = File.OpenRead("/proc/self/exe");
            Check(RenderCaptureAvailability.ReadElfBuildId(host) is { Length: > 0 }, "running executable GNU build-id");
        }
    }

    private static MemoryStream SyntheticElf(bool pie = false, bool conflict = false, string buildId = "aabbcc")
    {
        var id = Convert.FromHexString(buildId);
        var noteSize = 16 + ((id.Length + 3) & ~3);
        var stream = new MemoryStream(new byte[512]);
        using var w = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        w.Write(0x464c457f); w.Write((byte)2); w.Write((byte)1); w.Write((byte)1);
        stream.Position = 16; w.Write((ushort)(pie ? 3 : 2)); w.Write((ushort)62); w.Write(1);
        stream.Position = 32; w.Write((ulong)64);
        stream.Position = 52; w.Write((ushort)64); w.Write((ushort)56); w.Write((ushort)1);
        stream.Position = 64; w.Write(4); w.Write(0); w.Write((ulong)256);
        stream.Position = 96; w.Write((ulong)(20 + noteSize * (conflict ? 2 : 1)));
        // An unrelated, padded note precedes the GNU note.
        stream.Position = 256; w.Write(1); w.Write(1); w.Write(7); w.Write(0); w.Write(0);
        for (var i = 0; i < (conflict ? 2 : 1); i++)
        {
            stream.Position = 276 + i * noteSize; w.Write(4); w.Write(id.Length); w.Write(3); w.Write(0x00554e47);
            w.Write(id);
            if (i != 0) { stream.Position--; w.Write((byte)(id[^1] + i)); }
        }
        stream.Position = 0;
        return stream;
    }

    private static void TypedOutcomes()
    {
        var files = new Dictionary<string, string>
        {
            [Extension] = "[libraries]\nwindows.x86_64 = \"capture.dll\"",
            ["/capture/capture.dll"] = "MZ",
            ["/capture/calibration.a"] = Record(Identity),
        };
        StreamingSeatLaunch.ConfigResult Resolve(string? extension = Extension, string? calibration = null,
            string os = "windows", bool unreadable = false, bool throws = false) => RenderCaptureAvailability.Resolve(
                extension, calibration, os, "x86_64", path => throws ? throw new IOException() : files[path],
                files.ContainsKey, _ => files.Keys, () => unreadable ? null : Identity);
        void Refused(StreamingSeatLaunch.ConfigResult result, RenderCaptureAvailability.UnavailableReason reason)
            => Check(result.Config is null && result.Reason == reason, $"typed refusal: {reason}");

        var available = Resolve();
        Check(available.Config is not null && available.Reason is null && available.Refusal is null, "available outcome");
        Refused(Resolve(extension: null), RenderCaptureAvailability.UnavailableReason.NoCapture);
        Refused(Resolve(extension: "relative.gdextension"), RenderCaptureAvailability.UnavailableReason.CaptureInvalid);
        Refused(Resolve(os: "macos"), RenderCaptureAvailability.UnavailableReason.OsUnsupported);
        files.Remove("/capture/capture.dll");
        Refused(Resolve(), RenderCaptureAvailability.UnavailableReason.LibraryMissing);
        files["/capture/capture.dll"] = "MZ";
        Refused(Resolve(calibration: "relative.json"), RenderCaptureAvailability.UnavailableReason.CalibrationInvalid);
        Refused(Resolve(unreadable: true), RenderCaptureAvailability.UnavailableReason.IdentityUnreadable);
        Refused(Resolve(throws: true), RenderCaptureAvailability.UnavailableReason.Unknown);
        files["/capture/calibration.a"] = Record(Identity with { SizeOfImage = 1 });
        Refused(Resolve(), RenderCaptureAvailability.UnavailableReason.NoMatchingRecord);
        Refused(Resolve(calibration: "/capture/calibration.a"), RenderCaptureAvailability.UnavailableReason.OperatorRecordMismatch);
        files[Extension] = "[libraries]\nlinux.x86_64 = \"capture.dll\"";
        Refused(Resolve(os: "linux"), RenderCaptureAvailability.UnavailableReason.IdentityUnreadable);
    }

    private static string Record(RenderCaptureAvailability.PeIdentity identity, string platform = "windows-x86_64")
        => JsonSerializer.Serialize(new { engine = new { platform, size_of_image = identity.SizeOfImage,
            time_date_stamp = identity.TimeDateStamp, codeview_id = identity.CodeViewId } });

    private static void CrossCheck()
    {
        var exe = Environment.GetEnvironmentVariable("COUCHCOOP_TEST_PE");
        if (string.IsNullOrWhiteSpace(exe)) { Console.WriteLine("PE cross-check: skipped (COUCHCOOP_TEST_PE unset)"); return; }
        using var expected = JsonDocument.Parse(Environment.GetEnvironmentVariable("COUCHCOOP_TEST_PE_IDENTITY") ?? throw new Exception("missing expected identity"));
        using var stream = File.Open(exe, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var identity = RenderCaptureAvailability.ReadPeIdentity(stream);
        var e = expected.RootElement;
        Check(identity == new RenderCaptureAvailability.PeIdentity(e.GetProperty("size_of_image").GetUInt32(),
            e.GetProperty("time_date_stamp").GetUInt32(), e.GetProperty("codeview_id").GetString()), "Python PE cross-check");
        Console.WriteLine($"PE cross-check: {identity}");
        var directory = Environment.GetEnvironmentVariable("COUCHCOOP_TEST_CAPTURE_DIR");
        if (string.IsNullOrWhiteSpace(directory)) return;
        var result = RenderCaptureAvailability.Resolve(Path.Combine(directory, "render_stream_capture.gdextension"), null,
            "windows", "x86_64", File.ReadAllText, File.Exists, Directory.EnumerateFiles, () => identity);
        Check(result.Config?.Calibration == Path.Combine(directory, "calibration.stable"), "staged stable calibration selected: " + result.Refusal);
    }

    private static MemoryStream SyntheticPe(bool debug = true, bool conflict = false)
    {
        var stream = new MemoryStream(new byte[1024]);
        using var w = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        stream.Position = 0; w.Write((ushort)0x5a4d); stream.Position = 0x3c; w.Write(0x80);
        stream.Position = 0x80; w.Write(0x00004550); w.Write((ushort)0x8664); w.Write((ushort)1); w.Write((uint)1234);
        stream.Position = 0x94; w.Write((ushort)240);
        stream.Position = 0x98; w.Write((ushort)0x20b);
        stream.Position = 0x98 + 56; w.Write((uint)8192);
        stream.Position = 0x98 + 108; w.Write((uint)16);
        stream.Position = 0x98 + 160; w.Write(debug ? (uint)0x1000 : 0); w.Write(debug ? (uint)(conflict ? 56 : 28) : 0);
        stream.Position = 0x98 + 240 + 8; w.Write((uint)512); w.Write((uint)0x1000); w.Write((uint)512); w.Write((uint)512);
        for (var i = 0; i < (conflict ? 2 : 1); i++)
        {
            stream.Position = 512 + i * 28 + 12; w.Write((uint)2); w.Write((uint)24); w.Write((uint)0); w.Write((uint)(640 + i * 32));
            stream.Position = 640 + i * 32; w.Write(0x53445352); w.Write(Enumerable.Range(0, 16).Select(n => (byte)n).ToArray()); w.Write((uint)(1 + i));
        }
        stream.Position = 0;
        return stream;
    }

    private sealed class ThrowingStream : MemoryStream
    {
        public override long Length => throw new IOException();
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception("[RenderCaptureAvailabilityTests] " + message);
        _assertions++;
    }
}
