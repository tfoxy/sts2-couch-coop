using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Server;

/// <summary>
/// The seat's status record on DISK — the second way the same heartbeat reaches the host, used only while the
/// first one is failing.
/// </summary>
/// <remarks>
/// <para>
/// WHY IT EXISTS. A seat reports to its host by POSTing <see cref="HeadlessConnectionStatus"/> to
/// <c>http://127.0.0.1:&lt;hostPort&gt;/internal/client-status</c>. Measured in the field 2026-09-18: a seat
/// that had loaded the mod, joined the host's lobby, bound its browser port and was idling healthily 74 seconds
/// later, while not one of those POSTs ever arrived — a proxy, a VPN or security software on that computer
/// filtering one program talking to another. <c>d27ff12b</c> made that diagnosable; it did not make the join
/// work. A file in the seat's own Godot user dir crosses the same gap without a socket, and the host already
/// reads a seat's <see cref="BrowserPortFile"/> record from exactly this directory for exactly this reason.
/// </para>
/// <para>
/// IT IS NOT A PARALLEL PROTOCOL. What is written is the status record itself, and the host feeds it through
/// <c>HeadlessConnectionControl.Observe</c> — the same method the HTTP route calls — so the sequence rule, the
/// generation check, the <c>StatusChanged</c> event and every downstream refusal (the cloud-isolation one
/// included) are the ones that already exist. The file changes how a status ARRIVES and nothing about what it
/// means.
/// </para>
/// <para>
/// IT IS WRITTEN ONLY AFTER THE POST HAS FAILED (see <c>HeadlessConnectionReporter</c>), which is what bounds
/// its cost to broken machines instead of adding a disk write per second to every healthy session. A healthy
/// seat never creates this file, and a seat whose channel recovers deletes it.
/// </para>
/// <para>
/// <b>Trust model.</b> The record is authenticated with an HMAC keyed by the bearer token the host handed this
/// seat in its environment, over the status text, the writer's pid and the generation. <b>The token itself is
/// never written.</b> So a local process with read access to the seat's profile can REPLAY a record (which the
/// host's sequence rule already refuses) or DELETE one (a denial of service indistinguishable from the silence
/// this feature exists to survive) — but it cannot FORGE one, which is the property that matters: a forged
/// status could declare Steam Cloud save isolation a seat does not have. Same posture as the rest of the local
/// surface; see the mod-server hardening notes.
/// </para>
/// </remarks>
public static class SeatStatusFile
{
    /// <summary>
    /// The env var a spawned seat carries its slot number in (see
    /// <c>HeadlessClientManager.SeatLaunchEnvironment</c>). Present only in a seat process.
    /// </summary>
    private const string SlotEnvironmentVariable = "COUCHCOOP_HEADLESS_SLOT";

    /// <summary>
    /// Where this process's record goes, when the answer is not the engine's. A TEST SEAM and nothing else:
    /// the real path comes from <see cref="CouchCoopUserFile.TryResolve"/>, whose first act is a native Godot
    /// call that cannot be made outside a game process — so a suite asserting what is written, and that
    /// nothing is written while the channel is healthy, has to be able to name the file itself. Exactly the
    /// reason <c>HeadlessConnectionReporter.LogSink</c> exists.
    /// </summary>
    internal static Func<string?>? PathOverride { get; set; }

    /// <summary>
    /// The file name this process writes: a per-slot one for a SEAT, a plain one otherwise.
    /// </summary>
    /// <remarks>
    /// Slot-scoped for the reason <see cref="BrowserPortFile.FileNameFor(int)"/> is: where user-dir isolation
    /// falls back to the host's own profile, every process resolves the SAME directory, and an unscoped name
    /// would have the last seat to start overwrite the record the host is reading for another one.
    /// </remarks>
    internal static string FileNameFor(int slot)
        => slot > 0
            ? "status-slot-" + slot.ToString(CultureInfo.InvariantCulture) + ".json"
            : "status.json";

    /// <inheritdoc cref="FileNameFor(int)"/>
    internal static string FileNameFor(string? headlessSlot)
        => int.TryParse(headlessSlot?.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var slot)
            ? FileNameFor(slot)
            : FileNameFor(0);

    /// <summary>
    /// Publish one status. Returns whether a record now exists on disk for the host to find.
    /// </summary>
    /// <remarks>
    /// ATOMIC, because the reader is another process on a 200 ms loop and a torn record read as a real one
    /// would be worse than no record at all: the bytes go to a sibling <c>.tmp</c> and are then moved over the
    /// record in one step. (A torn file would in fact be REFUSED — it cannot carry a valid MAC — but a
    /// refusal counted against this seat is evidence about the wrong thing.)
    /// </remarks>
    public static bool TryWrite(HeadlessConnectionStatus status, string token, long generation)
    {
        var path = ResolvePath();
        if (path is null || string.IsNullOrEmpty(token)) return false;
        try
        {
            // EVERY throw this method can produce has to die here. Its callers are the failure arms of
            // HeadlessConnectionReporter's sender — including a `catch` whose whole job is to keep a transient
            // host failure from reaching the game loop, and which used to be provably non-throwing. An escape
            // from this line would leave that sender's in-flight flag set and stop the seat reporting for good.
            if (Path.GetDirectoryName(path) is not { Length: > 0 } directory) return false;
            Directory.CreateDirectory(directory);
            var statusJson = JsonSerializer.Serialize(status);
            var pid = Environment.ProcessId;
            var temporary = path + ".tmp";
            File.WriteAllText(
                temporary,
                "{\"status\":" + statusJson
                + ",\"pid\":" + pid.ToString(CultureInfo.InvariantCulture)
                + ",\"generation\":" + generation.ToString(CultureInfo.InvariantCulture)
                + ",\"mac\":\"" + Mac(token, statusJson, pid, generation) + "\"}\n");
            File.Move(temporary, path, overwrite: true);
            return true;
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or NotSupportedException
            or ArgumentException
            or System.Security.SecurityException)
        {
            // A read-only or racing user dir is not a reason to fail anything: this whole path is the fallback
            // for a channel that is already broken, and its failure leaves exactly the behaviour that shipped.
            return false;
        }
    }

    /// <summary>Remove the record, on a clean stop or once the primary channel is working again.</summary>
    public static void Clear()
    {
        var path = ResolvePath();
        if (path is null) return;
        try
        {
            File.Delete(path);
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or NotSupportedException
            or ArgumentException
            or System.Security.SecurityException)
        {
        }
    }

    /// <summary>
    /// Read a record a SEAT wrote, by path, and believe it only if it is this seat's, this generation's, and
    /// signed with the token this host issued.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Total: an absent, unreadable, truncated, unsigned, wrongly signed, foreign-pid or wrong-generation file
    /// is <see langword="null"/>, never a throw. This is diagnostic evidence, and a missing answer is a normal
    /// one.
    /// </para>
    /// <para>
    /// THE MAC IS CHECKED OVER THE FILE'S OWN BYTES, not over a re-serialization of the parsed status:
    /// <c>JsonElement.GetRawText()</c> hands back the exact slice the writer produced, so there is no canonical
    /// form for the two sides to disagree about as the record gains fields. The pid rule is
    /// <see cref="BrowserPortFile"/>'s and is here for the same reason — a record outlives a killed seat by
    /// design, so one naming another process must never be read as this seat speaking.
    /// </para>
    /// </remarks>
    internal static HeadlessConnectionStatus? Read(string? path, string token, int expectedPid, long expectedGeneration)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrEmpty(token) || expectedPid <= 0) return null;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            if (document.RootElement.ValueKind != JsonValueKind.Object) return null;
            if (!document.RootElement.TryGetProperty("status", out var statusElement)
                || statusElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty("pid", out var pidElement)
                || !pidElement.TryGetInt32(out var pid)
                || !document.RootElement.TryGetProperty("generation", out var generationElement)
                || !generationElement.TryGetInt64(out var generation)
                || !document.RootElement.TryGetProperty("mac", out var macElement)
                || macElement.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            if (pid != expectedPid || generation != expectedGeneration) return null;
            var raw = statusElement.GetRawText();
            if (!MacMatches(macElement.GetString(), Mac(token, raw, pid, generation))) return null;
            return JsonSerializer.Deserialize<HeadlessConnectionStatus>(raw);
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or JsonException
            or ArgumentException
            or NotSupportedException)
        {
            return null;
        }
    }

    private static string? ResolvePath()
        => PathOverride is { } seam
            ? seam()
            : CouchCoopUserFile.TryResolve(
                FileNameFor(Environment.GetEnvironmentVariable(SlotEnvironmentVariable)));

    /// <summary>
    /// The signature over one record: the status text exactly as it sits in the file, the writer's pid and the
    /// generation, keyed by the bearer token. Pid and generation are inside the MAC rather than merely beside
    /// it so a record cannot be re-labelled as another process's or another generation's without breaking it.
    /// </summary>
    private static string Mac(string token, string statusJson, int pid, long generation)
        => Convert.ToHexString(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(token),
            Encoding.UTF8.GetBytes(
                statusJson
                + "|" + pid.ToString(CultureInfo.InvariantCulture)
                + "|" + generation.ToString(CultureInfo.InvariantCulture))));

    private static bool MacMatches(string? written, string expected)
        => written is not null
            && CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(written), Encoding.UTF8.GetBytes(expected));
}
