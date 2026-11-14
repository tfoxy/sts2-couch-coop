using System.Globalization;
using System.Text.Json;
using CouchCoop.Mod.Diagnostics;

namespace CouchCoop.Mod.Session;

/// <summary>Checks capture compatibility before a seat is assigned the streaming role.</summary>
internal static class RenderCaptureAvailability
{
    internal enum UnavailableReason
    {
        NoCapture, CaptureInvalid, OsUnsupported, LibraryMissing, CalibrationInvalid, CalibrationMissing,
        NoMatchingRecord, OperatorRecordMismatch, IdentityUnreadable, Unknown,
    }

    internal static string ReasonCode(UnavailableReason reason) => reason switch
    {
        UnavailableReason.NoCapture => "no-capture",
        UnavailableReason.CaptureInvalid => "capture-invalid",
        UnavailableReason.OsUnsupported => "os-unsupported",
        UnavailableReason.LibraryMissing => "library-missing",
        UnavailableReason.CalibrationInvalid => "calibration-invalid",
        UnavailableReason.CalibrationMissing => "calibration-missing",
        UnavailableReason.NoMatchingRecord => "no-matching-record",
        UnavailableReason.OperatorRecordMismatch => "operator-record-mismatch",
        UnavailableReason.IdentityUnreadable => "identity-unreadable",
        _ => "unknown",
    };

    internal readonly record struct PeIdentity(uint SizeOfImage, uint TimeDateStamp, string? CodeViewId)
    {
        public override string ToString() => $"size_of_image={SizeOfImage}, time_date_stamp={TimeDateStamp}, codeview_id={CodeViewId ?? "null"}";
    }

    internal static StreamingSeatLaunch.ConfigResult Resolve(
        string? extension, string? calibration, string os, string arch,
        Func<string, string> readFile, Func<string, bool> fileExists,
        Func<string, IEnumerable<string>> listFiles, Func<PeIdentity?> readIdentity, Func<string?>? readBuildId = null)
    {
        try
        {
            var request = RenderCaptureExtensionLoader.Resolve(extension, fileExists);
            if (request.Path is null) return new(null, request.Refusal, Reason: string.IsNullOrWhiteSpace(extension)
                ? UnavailableReason.NoCapture : UnavailableReason.CaptureInvalid);
            var directory = Path.GetDirectoryName(request.Path)!;
            var key = os + "." + arch;
            string? library = null;
            var inLibraries = false;
            foreach (var raw in readFile(request.Path).Split('\n'))
            {
                var line = raw.Split(';', 2)[0].Trim();
                if (line.StartsWith('[')) { inLibraries = line == "[libraries]"; continue; }
                if (!inLibraries) continue;
                var equals = line.IndexOf('=');
                if (equals < 0 || line[..equals].Trim() != key) continue;
                var value = line[(equals + 1)..].Trim();
                if (library is not null || value.Length < 2 || value[0] != '"' || value[^1] != '"')
                    return new(null, $"the capture descriptor has an invalid {key} library", Reason: UnavailableReason.CaptureInvalid);
                library = value[1..^1];
            }
            if (string.IsNullOrWhiteSpace(library)) return new(null, $"the capture descriptor has no {key} library", Reason: UnavailableReason.OsUnsupported);
            var libraryPath = Path.IsPathFullyQualified(library) ? library : Path.Combine(directory, library);
            if (!fileExists(libraryPath)) return new(null, $"the capture library does not exist: '{libraryPath}'", Reason: UnavailableReason.LibraryMissing);

            string calibrationPath;
            if (!string.IsNullOrWhiteSpace(calibration))
            {
                calibrationPath = calibration.Trim();
                if (!Path.IsPathFullyQualified(calibrationPath))
                    return new(null, $"{StreamingSeatLaunch.CalibrationEnvironmentVariable} must be an absolute path, got '{calibrationPath}'", Reason: UnavailableReason.CalibrationInvalid);
            }
            else calibrationPath = Path.Combine(directory, StreamingSeatLaunch.DefaultCalibrationFileName);

            if (os == "windows")
            {
                var identity = readIdentity();
                if (identity is null) return new(null, "the host executable has no readable Windows x86_64 PE identity", Reason: UnavailableReason.IdentityUnreadable);
                var candidates = !string.IsNullOrWhiteSpace(calibration) ? [calibrationPath] : listFiles(directory)
                    .Where(path => Path.GetFileName(path) == "calibration.json" || Path.GetFileName(path).StartsWith("calibration.", StringComparison.Ordinal))
                    .OrderBy(Path.GetFileName, StringComparer.Ordinal).ToArray();
                string? matching = null;
                foreach (var candidate in candidates)
                {
                    if (!fileExists(candidate)) continue;
                    try
                    {
                        using var record = JsonDocument.Parse(readFile(candidate));
                        var engine = record.RootElement.GetProperty("engine");
                        if (engine.GetProperty("platform").GetString() != "windows-x86_64") continue;
                        var codeview = engine.GetProperty("codeview_id");
                        if (codeview.ValueKind != JsonValueKind.Null && codeview.ValueKind != JsonValueKind.String) continue;
                        if (engine.GetProperty("size_of_image").GetUInt32() == identity.Value.SizeOfImage
                            && engine.GetProperty("time_date_stamp").GetUInt32() == identity.Value.TimeDateStamp
                            && codeview.GetString() == identity.Value.CodeViewId)
                        { matching = candidate; break; }
                    }
                    catch (Exception) { /* An invalid record cannot identify an engine. */ }
                }
                if (matching is null) return new(null, $"no capture calibration matches the host executable ({identity.Value})",
                    Reason: string.IsNullOrWhiteSpace(calibration) ? UnavailableReason.NoMatchingRecord : UnavailableReason.OperatorRecordMismatch);
                calibrationPath = matching;
            }
            else if (os == "linux")
            {
                var buildId = readBuildId?.Invoke();
                if (string.IsNullOrWhiteSpace(buildId)) return new(null, "the host executable has no readable Linux x86_64 GNU build-id", Reason: UnavailableReason.IdentityUnreadable);
                var candidates = !string.IsNullOrWhiteSpace(calibration) ? [calibrationPath] : listFiles(directory)
                    .Where(path => Path.GetFileName(path) == "calibration" || Path.GetFileName(path).StartsWith("calibration.", StringComparison.Ordinal))
                    .OrderBy(Path.GetFileName, StringComparer.Ordinal).ToArray();
                string? matching = null;
                foreach (var candidate in candidates)
                {
                    if (!fileExists(candidate)) continue;
                    try
                    {
                        using var record = JsonDocument.Parse(readFile(candidate));
                        var engine = record.RootElement.GetProperty("engine");
                        if (engine.GetProperty("platform").GetString() == "linux-" + arch
                            && engine.GetProperty("build_id").GetString() == buildId)
                        { matching = candidate; break; }
                    }
                    catch (Exception) { /* An invalid record cannot identify an engine. */ }
                }
                if (matching is null) return new(null, $"no capture calibration matches the host executable (build_id={buildId})",
                    Reason: string.IsNullOrWhiteSpace(calibration) ? UnavailableReason.NoMatchingRecord : UnavailableReason.OperatorRecordMismatch);
                calibrationPath = matching;
            }
            else if (string.IsNullOrWhiteSpace(calibration) && !fileExists(calibrationPath))
            {
                calibrationPath = Path.Combine(directory, StreamingSeatLaunch.PackagedCalibrationFileName);
            }
            if (!fileExists(calibrationPath)) return new(null, $"the capture's calibration record does not exist: '{calibrationPath}'", Reason: UnavailableReason.CalibrationMissing);
            var net = Path.Combine(directory, os == "windows" ? "render_stream_net.dll" : "librender_stream_net.so");
            return new(new StreamingSeatLaunch.Config(request.Path, calibrationPath, NetModule: fileExists(net) ? net : null), null);
        }
        catch (Exception exception)
        {
            return new(null, $"capture availability could not be read: {exception.GetType().Name}", Reason: UnavailableReason.Unknown);
        }
    }

    /// <summary>Reads GNU build-id from ELF64 x86_64 program notes, including stripped executables.</summary>
    internal static string? ReadElfBuildId(Stream stream)
    {
        try
        {
            using var reader = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: true);
            void At(long offset, long size)
            {
                if (offset < 0 || size < 0 || offset > stream.Length - size) throw new InvalidDataException();
                stream.Position = offset;
            }
            At(0, 64);
            if (reader.ReadUInt32() != 0x464c457f || reader.ReadByte() != 2
                || reader.ReadByte() != 1 || reader.ReadByte() != 1) return null;
            At(16, 8);
            var type = reader.ReadUInt16();
            if (type is not (2 or 3) || reader.ReadUInt16() != 62 || reader.ReadUInt32() != 1) return null;
            At(32, 8);
            var headers = checked((long)reader.ReadUInt64());
            At(52, 6);
            if (reader.ReadUInt16() != 64) return null;
            var entrySize = reader.ReadUInt16();
            var count = reader.ReadUInt16();
            if (entrySize < 56 || count is 0 or 0xffff) return null;
            At(headers, count * (long)entrySize);
            string? buildId = null;
            for (var i = 0; i < count; i++)
            {
                At(headers + i * (long)entrySize, 56);
                if (reader.ReadUInt32() != 4) continue; // PT_NOTE
                _ = reader.ReadUInt32();
                var offset = checked((long)reader.ReadUInt64());
                stream.Position += 16;
                var size = checked((long)reader.ReadUInt64());
                At(offset, size);
                var end = offset + size;
                while (stream.Position < end)
                {
                    if (end - stream.Position < 12) return null;
                    var nameSize = reader.ReadUInt32();
                    var descriptorSize = reader.ReadUInt32();
                    var noteType = reader.ReadUInt32();
                    var name = stream.Position;
                    var descriptor = name + ((nameSize + 3L) & ~3L);
                    var next = descriptor + ((descriptorSize + 3L) & ~3L);
                    if (next > end) return null;
                    if (noteType == 3 && nameSize == 4 && reader.ReadUInt32() == 0x00554e47) // GNU\0
                    {
                        if (descriptorSize is 0 or > 128) return null;
                        stream.Position = descriptor;
                        var id = Convert.ToHexString(reader.ReadBytes((int)descriptorSize)).ToLowerInvariant();
                        if (buildId is not null && buildId != id) return null;
                        buildId = id;
                    }
                    stream.Position = next;
                }
            }
            return buildId;
        }
        catch (Exception) { return null; }
    }

    /// <summary>Reads PE identity without loading the executable. Malformed or ambiguous images fail closed.</summary>
    internal static PeIdentity? ReadPeIdentity(Stream stream)
    {
        try
        {
            using var reader = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: true);
            void At(long offset, long size)
            {
                if (offset < 0 || size < 0 || offset > stream.Length - size) throw new InvalidDataException();
                stream.Position = offset;
            }
            At(0, 2);
            if (reader.ReadUInt16() != 0x5a4d) return null;
            At(0x3c, 4);
            long pe = reader.ReadUInt32();
            At(pe, 24);
            if (reader.ReadUInt32() != 0x00004550 || reader.ReadUInt16() != 0x8664) return null;
            var sections = reader.ReadUInt16();
            if (sections == 0) return null;
            var timestamp = reader.ReadUInt32();
            At(pe + 20, 2);
            var optionalSize = reader.ReadUInt16();
            long optional = pe + 24;
            At(optional, optionalSize);
            if (optionalSize < 112 || reader.ReadUInt16() != 0x20b) return null;
            At(optional + 56, 4);
            var sizeOfImage = reader.ReadUInt32();
            if (sizeOfImage == 0) return null;
            At(optional + 108, 4);
            var directoryCount = reader.ReadUInt32();
            uint debugRva = 0, debugSize = 0;
            if (directoryCount > 6)
            {
                if (optionalSize < 168) return null;
                At(optional + 160, 8);
                debugRva = reader.ReadUInt32(); debugSize = reader.ReadUInt32();
            }
            if ((debugRva == 0) != (debugSize == 0)) return null;
            long? debugOffset = null;
            At(optional + optionalSize, sections * 40L);
            for (var i = 0; i < sections; i++)
            {
                At(optional + optionalSize + i * 40L + 8, 16);
                _ = reader.ReadUInt32();
                var rva = reader.ReadUInt32();
                var rawSize = reader.ReadUInt32();
                var rawOffset = reader.ReadUInt32();
                if (debugSize == 0 || debugRva < rva || (ulong)debugRva + debugSize > (ulong)rva + rawSize) continue;
                var offset = (long)rawOffset + debugRva - rva;
                if (debugOffset is not null && debugOffset != offset) return null;
                debugOffset = offset;
            }
            string? codeview = null;
            if (debugSize != 0)
            {
                if (debugRva == 0 || debugOffset is null || debugSize % 28 != 0) return null;
                At(debugOffset.Value, debugSize);
                for (long i = 0; i < debugSize / 28; i++)
                {
                    At(debugOffset.Value + i * 28 + 12, 16);
                    var type = reader.ReadUInt32(); var size = reader.ReadUInt32();
                    _ = reader.ReadUInt32(); var pointer = reader.ReadUInt32();
                    if (type != 2) continue;
                    At(pointer, size);
                    if (size < 4) return null;
                    if (reader.ReadUInt32() != 0x53445352) continue;
                    if (size < 24) return null;
                    var guid = Convert.ToHexString(reader.ReadBytes(16)).ToLowerInvariant();
                    var age = reader.ReadUInt32();
                    var id = guid + ":" + age.ToString(CultureInfo.InvariantCulture);
                    if (codeview is not null && codeview != id) return null;
                    codeview = id;
                }
            }
            return new PeIdentity(sizeOfImage, timestamp, codeview);
        }
        catch (Exception) { return null; }
    }
}
