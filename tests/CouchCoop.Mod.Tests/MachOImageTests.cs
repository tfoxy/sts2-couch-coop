using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Session;

internal static class MachOImageTests
{
    private const string ArmUuid = "0123456789abcdef1020304050607080";
    private const string X64Uuid = "fedcba98765432108070605040302010";
    private const string DirectoryPath = "/mod/render-capture/macos";
    private const string Extension = DirectoryPath + "/render_stream_capture.gdextension";
    private const string Net = DirectoryPath + "/librender_stream_net.dylib";
    private const string ArmRecord = DirectoryPath + "/calibration.megadot-4.5.1-m14-01234567";
    private const string X64Record = DirectoryPath + "/calibration.megadot-4.5.1-m14-fedcba98";
    private const string Table = DirectoryPath + "/abi-table.godot-4.5.1-rendering-server";
    private static int _assertions;

    internal static void Run()
    {
        var arm = Thin("arm64", ArmUuid);
        var x64 = Thin("x86_64", X64Uuid);
        var fat = Fat(x64, arm);
        Check(Read(fat, "arm64")?.Uuid == ArmUuid, "fat selects arm64 UUID in file byte order");
        Check(Read(fat, "x86_64")?.Uuid == X64Uuid, "fat selects x86_64 UUID in file byte order");
        Check(Read(Fat(x64, arm, wide: true), "arm64")?.Uuid == ArmUuid, "fat64 offsets");
        Check(Read(arm, "arm64")?.Id8 == "01234567", "thin arm64 id8 matches calibrator UUID prefix");
        Check(Read(arm, "x86_64") is null, "thin architecture mismatch");
        Check(Read(fat, "unsupported") is null, "unsupported process architecture");
        Check(Read(Fat(arm, arm), "arm64") is null, "ambiguous architecture refused");
        var wrongCpu = (byte[])fat.Clone();
        BinaryPrimitives.WriteUInt32LittleEndian(wrongCpu.AsSpan(512 + 4), 0x01000007);
        Check(Read(wrongCpu, "arm64") is null, "fat and thin CPU mismatch");
        foreach (var length in new[] { 0, 3, 7, 31, 32, 55 })
            Check(Read(arm[..length], "arm64") is null, $"thin truncation at {length}");
        Check(Read(fat[..^1], "arm64") is null, "fat slice past EOF");
        var badCommand = (byte[])arm.Clone();
        BinaryPrimitives.WriteUInt32LittleEndian(badCommand.AsSpan(36), 0xfffffff8);
        Check(Read(badCommand, "arm64") is null, "command outside declared range");
        Check(Read(arm) is { Hardened: false, SignatureDetail: "no code signature" }, "unsigned identity retained");
        Check(Read(Thin("arm64", ArmUuid, Signature(0x10000))) is { Hardened: true, DisableLibraryValidation: false },
            "CodeDirectory runtime flag without entitlements");
        Check(Read(Thin("arm64", ArmUuid, Signature(0x10002, "<true/>"))) is { Hardened: true, DisableLibraryValidation: true },
            "ad-hoc hardened signature with library validation disabled");
        Check(Read(Thin("arm64", ArmUuid, Signature(0x10000, "<false/>"))) is { Hardened: true, DisableLibraryValidation: false },
            "false entitlement does not disable validation");
        Check(Read(Thin("arm64", ArmUuid, Signature(0x10000, "<string>true</string>"))) is { DisableLibraryValidation: false },
            "string true is not a plist boolean");
        Check(Read(Thin("arm64", ArmUuid, [0, 1, 2])) is { Hardened: false, SignatureDetail: not null },
            "malformed signature retains identity and reports detail");
        var malformedXml = Signature(0x10000, "<broken>");
        Check(Read(Thin("arm64", ArmUuid, malformedXml)) is { Hardened: false, SignatureDetail: not null },
            "unparsable entitlement follows unsigned policy");

        var files = new Dictionary<string, string>
        {
            [Extension] = "[libraries]\nmacos.arm64 = \"librender_stream_capture.dylib\"\nmacos.x86_64 = \"librender_stream_capture.dylib\"",
            [DirectoryPath + "/librender_stream_capture.dylib"] = "Mach-O",
            [Net] = "Mach-O",
            [ArmRecord] = Record(ArmUuid, "arm64"),
            [X64Record] = Record(X64Uuid, "x86_64"),
        };
        StreamingSeatLaunch.ConfigResult Resolve(string arch = "arm64", string? record = null, byte[]? image = null)
            => StreamingSeatLaunch.ResolveConfig(null, record, files.ContainsKey, "/mod/lanes/0.113.0",
                path => files[path], "macos", arch, _ => files.Keys.Reverse(),
                () => throw new Exception("macOS must not read PE identity"),
                () => throw new Exception("macOS must not read ELF identity"), () => Read(image ?? fat, arch));
        Check(Resolve().Config is { Calibration: ArmRecord, NetModule: Net, AbiTable: null }, "packaged arm64 record and dylib net module");
        Check(Resolve("x86_64").Config?.Calibration == X64Record, "packaged x86_64 record");
        Check(Resolve(image: arm).Config?.Calibration == ArmRecord, "thin host selects record");
        Check(Resolve(record: ArmRecord).Config?.Calibration == ArmRecord, "matching operator record");
        Check(Resolve(record: X64Record).Reason == RenderCaptureAvailability.UnavailableReason.OperatorRecordMismatch,
            "operator mismatch does not use another record");
        var hardened = Thin("arm64", ArmUuid, Signature(0x10000));
        var entitled = Thin("arm64", ArmUuid, Signature(0x10002, "<true/>"));
        Check(Resolve(image: hardened).Reason == RenderCaptureAvailability.UnavailableReason.LibraryValidation,
            "hardened host without entitlement refuses capture");
        Check(RenderCaptureAvailability.ReasonCode(Resolve(image: hardened).Reason!.Value) == "library-validation",
            "library validation has a stable wire code");
        Check(Resolve(image: entitled).Config?.Calibration == ArmRecord, "hardened entitled host is available");
        Check(Resolve(image: Thin("arm64", ArmUuid, Signature(0x10000, "<false/>"))).Reason
            == RenderCaptureAvailability.UnavailableReason.LibraryValidation, "false entitlement refuses capture");
        Check(Resolve(image: Thin("arm64", ArmUuid, Signature(2))).Config?.Calibration == ArmRecord,
            "non-hardened ad-hoc signature is available");
        Check(Resolve(image: arm).Config?.Calibration == ArmRecord, "unsigned host is available");
        Check(Resolve(image: Thin("arm64", ArmUuid, [0, 1, 2])).Config?.Calibration == ArmRecord,
            "unparsable signature is treated as not hardened");
        var signedFat = Fat(Thin("x86_64", X64Uuid, Signature(0x10000)), entitled);
        Check(Resolve(image: signedFat).Config?.Calibration == ArmRecord, "entitlements read relative to selected arm64 slice");
        Check(Resolve("x86_64", image: signedFat).Reason == RenderCaptureAvailability.UnavailableReason.LibraryValidation,
            "another slice's entitlement cannot bypass validation");
        files[ArmRecord] = Record(ArmUuid, "x86_64");
        Check(Resolve().Reason == RenderCaptureAvailability.UnavailableReason.NoMatchingRecord,
            "record named with arm64 id8 but x86_64 platform refused");
        files[ArmRecord] = Record(X64Uuid, "arm64");
        Check(Resolve().Reason == RenderCaptureAvailability.UnavailableReason.NoMatchingRecord, "record UUID must match");
        files.Remove(ArmRecord); files.Remove(X64Record);
        files[DirectoryPath + "/calibration.json"] = "{}";
        files[DirectoryPath + "/calibration"] = "{}";
        Check(Resolve().Reason == RenderCaptureAvailability.UnavailableReason.NoMatchingRecord, "no blind legacy fallback");
        files[Table] = "{}";
        Check(Resolve().Config is { Calibration: "", AbiTable: Table, NetModule: Net }, "no record derives using staged table and dylib");
        Check(Resolve(image: hardened).Reason == RenderCaptureAvailability.UnavailableReason.LibraryValidation,
            "library validation also gates ABI-table derivation");
        Check(Resolve(image: entitled).Config?.AbiTable == Table, "entitled host may derive");
        Check(Resolve(record: ArmRecord).Reason == RenderCaptureAvailability.UnavailableReason.OperatorRecordMismatch,
            "operator record never derives");
        Check(Resolve(image: arm[..40]).Reason == RenderCaptureAvailability.UnavailableReason.NoMatchingRecord,
            "truncated host refuses without exception or derivation");
        files.Remove(Table);
        Check(Resolve().Reason == RenderCaptureAvailability.UnavailableReason.NoMatchingRecord, "no record and no table");
        Console.WriteLine($"Mach-O image and selection: {_assertions} passed.");
    }

    private static string Record(string uuid, string arch)
        => JsonSerializer.Serialize(new { engine = new { platform = "macos-" + arch, uuid } });

    private static MachOImage.Identity? Read(byte[] data, string arch = "arm64")
    {
        using var stream = new MemoryStream(data);
        return MachOImage.Read(stream, arch);
    }

    private static byte[] Thin(string arch, string uuid, byte[]? signature = null)
    {
        using var stream = new MemoryStream();
        using var w = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        w.Write(0xfeedfacf); w.Write(arch == "arm64" ? 0x0100000c : 0x01000007);
        w.Write(arch == "arm64" ? 0 : 3); w.Write(2);
        w.Write(signature is null ? 1 : 2); w.Write(signature is null ? 24 : 40); w.Write(0); w.Write(0);
        w.Write(0x1b); w.Write(24); w.Write(Convert.FromHexString(uuid));
        if (signature is not null)
        {
            w.Write(0x1d); w.Write(16); w.Write(72); w.Write(signature.Length); w.Write(signature);
        }
        return stream.ToArray();
    }

    private static byte[] Signature(uint flags, string? entitlement = null)
    {
        var xml = entitlement is null ? [] : Encoding.UTF8.GetBytes(
            "<?xml version=\"1.0\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">"
            + "<plist version=\"1.0\"><dict><key>com.apple.security.cs.disable-library-validation</key>"
            + entitlement + "</dict></plist>");
        var count = entitlement is null ? 1 : 2;
        var directory = 12 + count * 8;
        var ents = directory + 44;
        var data = new byte[ents + (entitlement is null ? 0 : 8 + xml.Length)];
        void Be(int offset, uint value) => BinaryPrimitives.WriteUInt32BigEndian(data.AsSpan(offset), value);
        Be(0, 0xfade0cc0); Be(4, (uint)data.Length); Be(8, (uint)count);
        Be(12, 0); Be(16, (uint)directory);
        Be(directory, 0xfade0c02); Be(directory + 4, 44); Be(directory + 8, 0x20001); Be(directory + 12, flags);
        if (entitlement is not null)
        {
            Be(20, 5); Be(24, (uint)ents);
            Be(ents, 0xfade7171); Be(ents + 4, (uint)(8 + xml.Length));
            xml.CopyTo(data, ents + 8);
        }
        return data;
    }

    private static byte[] Fat(byte[] first, byte[] second, bool wide = false)
    {
        var data = new byte[512 + second.Length];
        void Be(int offset, uint value) => BinaryPrimitives.WriteUInt32BigEndian(data.AsSpan(offset), value);
        Be(0, wide ? 0xcafebabf : 0xcafebabe); Be(4, 2);
        foreach (var (image, offset, entry) in new[] { (first, 256, 8), (second, 512, wide ? 40 : 28) })
        {
            Be(entry, BinaryPrimitives.ReadUInt32LittleEndian(image.AsSpan(4)));
            Be(entry + 4, BinaryPrimitives.ReadUInt32LittleEndian(image.AsSpan(8)));
            if (wide)
            {
                BinaryPrimitives.WriteUInt64BigEndian(data.AsSpan(entry + 8), (ulong)offset);
                BinaryPrimitives.WriteUInt64BigEndian(data.AsSpan(entry + 16), (ulong)image.Length);
            }
            else { Be(entry + 8, (uint)offset); Be(entry + 12, (uint)image.Length); }
            image.CopyTo(data, offset);
        }
        return data;
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception("[MachOImageTests] " + message);
        _assertions++;
    }
}
