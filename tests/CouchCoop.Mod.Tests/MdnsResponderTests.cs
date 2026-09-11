using System.Net;
using System.Text;
using CouchCoop.Mod.HostUi;

// WS8 in-process mDNS responder. The wire codec (MdnsWire) is pure, so everything byte-level is asserted here
// without opening a socket: query parsing (including compression pointers and hostile packets), the
// case-insensitive name match, the multicast/legacy-unicast/QU response shapes, and the TTL-0 goodbye.
//
// The socket half (MdnsResponder) is only asserted where it can be done without touching the network: the
// kill-switch and the two "stay inert" paths. Real multicast behaviour is verified live against avahi with
// `dig @224.0.0.251 -p 5353` — see docs/configuration.md.
//
// Assert-or-throw, matching the repo's custom Exe runner.
internal static class MdnsResponderTests
{
    private const string HostName = "test-host.local";

    public static void Run()
    {
        ParsesAnAQuery();
        RejectsResponsesAndMalformedPackets();
        MatchesNameCaseInsensitively();
        IgnoresOtherNamesTypesAndClasses();
        MatchesAnyQueries();
        ParsesTheUnicastResponseBit();
        FollowsCompressionPointersInQuestions();
        RejectsHostilePointers();
        BuildsAMulticastResponse();
        BuildsALegacyUnicastResponse();
        BuildsAGoodbyePacket();
        RejectsUnencodableNames();
        PublishesExactlyTheNameTheQrDialogShows();
        ParsesTheKillSwitch();
        StaysInertWhenDisabledOrUnnamed();
        Console.WriteLine("MdnsResponderTests: ok");
    }

    private static void ParsesAnAQuery()
    {
        var datagram = BuildQuery(0x1234, [(HostName, MdnsWire.TypeA, MdnsWire.ClassInternet)]);
        Expect(MdnsWire.TryParseQuery(datagram, out var query), "a well-formed A query parses");
        Expect(query.TransactionId == 0x1234, "the transaction id survives the parse");
        Expect(query.Questions.Count == 1, "one question is read");

        var question = query.Questions[0];
        Expect(question.Name == HostName, $"the question name round-trips (got '{question.Name}')");
        Expect(question.Type == MdnsWire.TypeA, "the question type is A");
        Expect(question.Class == MdnsWire.ClassInternet, "the question class is IN");
        Expect(!question.UnicastResponse, "no QU bit on a plain multicast query");
        Expect(query.FindAddressQuestion(HostName) is not null, "the query is recognised as ours");
    }

    private static void RejectsResponsesAndMalformedPackets()
    {
        // Our OWN multicast response, looped back to us, must never be treated as a query — otherwise the
        // responder answers itself forever.
        var response = MdnsWire.BuildARecordResponse(HostName, IPAddress.Parse("192.168.1.10"), 120, cacheFlush: true);
        Expect(!MdnsWire.TryParseQuery(response, out _), "a response (QR=1) is not parsed as a query");

        // OPCODE 5 (UPDATE) with QR=0.
        var update = BuildQuery(1, [(HostName, MdnsWire.TypeA, MdnsWire.ClassInternet)], flags: 5 << 11);
        Expect(!MdnsWire.TryParseQuery(update, out _), "a non-standard opcode is ignored");

        Expect(!MdnsWire.TryParseQuery([], out _), "an empty datagram is rejected");
        Expect(!MdnsWire.TryParseQuery(new byte[8], out _), "a short-header datagram is rejected");
        Expect(!MdnsWire.TryParseQuery(new byte[12], out _), "a query with QDCOUNT=0 is rejected");

        // QDCOUNT says 1 but the question section is truncated mid-name.
        var truncated = BuildQuery(1, [(HostName, MdnsWire.TypeA, MdnsWire.ClassInternet)]);
        Expect(!MdnsWire.TryParseQuery(truncated.AsSpan(0, truncated.Length - 6).ToArray(), out _),
            "a truncated question is rejected");

        // QDCOUNT claims two questions but only one is present.
        var overcounted = BuildQuery(1, [(HostName, MdnsWire.TypeA, MdnsWire.ClassInternet)]);
        overcounted[5] = 2;
        Expect(!MdnsWire.TryParseQuery(overcounted, out _), "a lying QDCOUNT is rejected");
    }

    private static void MatchesNameCaseInsensitively()
    {
        // Windows hands us an UPPERCASED NetBIOS machine name, and querying phones normalise differently, so
        // the DNS case-folding rule is load-bearing rather than theoretical here.
        Expect(MdnsWire.NameEquals("TEST-Host.Local", HostName), "names compare case-insensitively");
        Expect(MdnsWire.NameEquals("test-host.local.", HostName), "a trailing root dot is not significant");
        Expect(!MdnsWire.NameEquals("other-host.local", HostName), "different names do not match");
        Expect(!MdnsWire.NameEquals(null, HostName), "a null name never matches");

        var datagram = BuildQuery(7, [("TEST-HOST.LOCAL", MdnsWire.TypeA, MdnsWire.ClassInternet)]);
        Expect(MdnsWire.TryParseQuery(datagram, out var query), "the uppercase query parses");
        Expect(query.FindAddressQuestion(HostName) is not null, "an uppercase query still matches our name");
    }

    private static void IgnoresOtherNamesTypesAndClasses()
    {
        var otherName = BuildQuery(1, [("someone-else.local", MdnsWire.TypeA, MdnsWire.ClassInternet)]);
        Expect(MdnsWire.TryParseQuery(otherName, out var otherQuery), "another host's query parses");
        Expect(otherQuery.FindAddressQuestion(HostName) is null, "we never answer for another name");

        // AAAA: we publish IPv4 only, so an AAAA question must not draw an A record.
        var aaaa = BuildQuery(1, [(HostName, 28, MdnsWire.ClassInternet)]);
        Expect(MdnsWire.TryParseQuery(aaaa, out var aaaaQuery), "an AAAA query parses");
        Expect(aaaaQuery.FindAddressQuestion(HostName) is null, "an AAAA question is not answered");

        // PTR (service discovery browse): not ours either.
        var ptr = BuildQuery(1, [(HostName, 12, MdnsWire.ClassInternet)]);
        Expect(MdnsWire.TryParseQuery(ptr, out var ptrQuery), "a PTR query parses");
        Expect(ptrQuery.FindAddressQuestion(HostName) is null, "a PTR question is not answered");

        // CHAOS class.
        var chaos = BuildQuery(1, [(HostName, MdnsWire.TypeA, 3)]);
        Expect(MdnsWire.TryParseQuery(chaos, out var chaosQuery), "a CHAOS-class query parses");
        Expect(chaosQuery.FindAddressQuestion(HostName) is null, "a non-IN class is not answered");
    }

    private static void MatchesAnyQueries()
    {
        var any = BuildQuery(1, [(HostName, MdnsWire.TypeAny, MdnsWire.ClassInternet)]);
        Expect(MdnsWire.TryParseQuery(any, out var anyQuery), "an ANY query parses");
        Expect(anyQuery.FindAddressQuestion(HostName) is not null, "QTYPE=ANY asks for the A record too");

        var anyClass = BuildQuery(1, [(HostName, MdnsWire.TypeA, MdnsWire.ClassAny)]);
        Expect(MdnsWire.TryParseQuery(anyClass, out var anyClassQuery), "a QCLASS=ANY query parses");
        Expect(anyClassQuery.FindAddressQuestion(HostName) is not null, "QCLASS=ANY covers IN");
    }

    private static void ParsesTheUnicastResponseBit()
    {
        var qu = BuildQuery(1, [(HostName, MdnsWire.TypeA, (ushort)(MdnsWire.ClassInternet | MdnsWire.UnicastResponseBit))]);
        Expect(MdnsWire.TryParseQuery(qu, out var query), "a QU query parses");
        var question = query.FindAddressQuestion(HostName);
        Expect(question is not null, "the QU bit does not break the class match");
        Expect(question!.UnicastResponse, "the QU bit is reported");
        Expect(question.Class == MdnsWire.ClassInternet, "the QU bit is stripped off the reported class");
    }

    private static void FollowsCompressionPointersInQuestions()
    {
        // Two questions: the first spells the name out, the second is a pointer back to it.
        var name = MdnsWire.EncodeName(HostName);
        var datagram = new List<byte>();
        WriteHeader(datagram, id: 0x2222, flags: 0, questionCount: 2);
        datagram.AddRange(name);
        WriteUInt16(datagram, MdnsWire.TypeA);
        WriteUInt16(datagram, MdnsWire.ClassInternet);
        WriteUInt16(datagram, 0xC000 | MdnsWire.HeaderLength); // pointer to the first question's name
        WriteUInt16(datagram, MdnsWire.TypeAny);
        WriteUInt16(datagram, MdnsWire.ClassInternet);

        Expect(MdnsWire.TryParseQuery(datagram.ToArray(), out var query), "a compressed question name parses");
        Expect(query.Questions.Count == 2, "both questions are read");
        Expect(query.Questions[1].Name == HostName, "the pointer resolves to the earlier name");
        Expect(query.Questions[1].Type == MdnsWire.TypeAny, "the record after the pointer is read at the right offset");
    }

    private static void RejectsHostilePointers()
    {
        // A pointer to itself: the classic decompression-bomb shape. Must terminate, not spin.
        var selfPointer = new List<byte>();
        WriteHeader(selfPointer, id: 1, flags: 0, questionCount: 1);
        WriteUInt16(selfPointer, 0xC000 | MdnsWire.HeaderLength);
        WriteUInt16(selfPointer, MdnsWire.TypeA);
        WriteUInt16(selfPointer, MdnsWire.ClassInternet);
        Expect(!MdnsWire.TryParseQuery(selfPointer.ToArray(), out _), "a self-referencing pointer is rejected");

        // A forward pointer (also a loop risk) and an out-of-range pointer.
        var forwardPointer = new List<byte>();
        WriteHeader(forwardPointer, id: 1, flags: 0, questionCount: 1);
        WriteUInt16(forwardPointer, 0xC000 | (MdnsWire.HeaderLength + 8));
        forwardPointer.AddRange(new byte[16]);
        Expect(!MdnsWire.TryParseQuery(forwardPointer.ToArray(), out _), "a forward pointer is rejected");

        var wildPointer = new List<byte>();
        WriteHeader(wildPointer, id: 1, flags: 0, questionCount: 1);
        WriteUInt16(wildPointer, 0xC000 | 0x3FFF);
        WriteUInt16(wildPointer, MdnsWire.TypeA);
        WriteUInt16(wildPointer, MdnsWire.ClassInternet);
        Expect(!MdnsWire.TryParseQuery(wildPointer.ToArray(), out _), "an out-of-range pointer is rejected");

        // Reserved label type 0b10.
        var reserved = new List<byte>();
        WriteHeader(reserved, id: 1, flags: 0, questionCount: 1);
        reserved.Add(0x80);
        reserved.AddRange(new byte[8]);
        Expect(!MdnsWire.TryParseQuery(reserved.ToArray(), out _), "a reserved label type is rejected");
    }

    private static void BuildsAMulticastResponse()
    {
        var address = IPAddress.Parse("192.168.1.42");
        var bytes = MdnsWire.BuildARecordResponse(HostName, address, MdnsResponder.RecordTtlSeconds, cacheFlush: true);

        Expect(ReadUInt16(bytes, 0) == 0, "a multicast response carries transaction id 0 (RFC 6762 18.1)");
        Expect(ReadUInt16(bytes, 2) == 0x8400, "flags are QR=1 AA=1");
        Expect(ReadUInt16(bytes, 4) == 0, "the question section is empty (RFC 6762 6)");
        Expect(ReadUInt16(bytes, 6) == 1, "exactly one answer");
        Expect(ReadUInt16(bytes, 8) == 0 && ReadUInt16(bytes, 10) == 0, "no authority or additional records");

        var offset = MdnsWire.HeaderLength;
        var expectedName = MdnsWire.EncodeName(HostName);
        Expect(bytes.AsSpan(offset, expectedName.Length).SequenceEqual(expectedName), "the answer name is our host name");
        Expect(expectedName[0] == 9 && Encoding.ASCII.GetString(expectedName, 1, 9) == "test-host",
            "the name is encoded as length-prefixed labels");
        offset += expectedName.Length;

        Expect(ReadUInt16(bytes, offset) == MdnsWire.TypeA, "the record type is A");
        Expect(ReadUInt16(bytes, offset + 2) == (MdnsWire.ClassInternet | MdnsWire.CacheFlushBit),
            "the record class is IN with the cache-flush bit set");
        Expect(ReadUInt32(bytes, offset + 4) == 120, "the TTL is 120 seconds");
        Expect(ReadUInt16(bytes, offset + 8) == 4, "RDLENGTH is 4 for an A record");
        Expect(bytes.AsSpan(offset + 10, 4).SequenceEqual(address.GetAddressBytes()), "RDATA is the published IPv4");
        Expect(bytes.Length == offset + 14, "there are no trailing bytes");

        var ipv6 = IPAddress.Parse("fe80::1");
        var rejected = false;
        try
        {
            MdnsWire.BuildARecordResponse(HostName, ipv6, 120, cacheFlush: true);
        }
        catch (ArgumentException)
        {
            rejected = true;
        }

        Expect(rejected, "an IPv6 address cannot be published as an A record");
    }

    private static void BuildsALegacyUnicastResponse()
    {
        // `dig @224.0.0.251 -p 5353` is a legacy querier: ephemeral source port, so RFC 6762 6.7 applies —
        // echo the id and the question, cap the TTL at 10s, and do NOT set the cache-flush bit.
        var question = new MdnsQuestion(HostName, MdnsWire.TypeA, MdnsWire.ClassInternet, UnicastResponse: false);
        var address = IPAddress.Parse("10.0.0.5");
        var bytes = MdnsWire.BuildARecordResponse(HostName, address, 10, cacheFlush: false, transactionId: 0xBEEF, echoQuestion: question);

        Expect(ReadUInt16(bytes, 0) == 0xBEEF, "a legacy response echoes the querier's transaction id");
        Expect(ReadUInt16(bytes, 4) == 1, "a legacy response repeats the question");
        Expect(ReadUInt16(bytes, 6) == 1, "a legacy response still carries one answer");

        var questionName = MdnsWire.EncodeName(HostName);
        var offset = MdnsWire.HeaderLength;
        Expect(bytes.AsSpan(offset, questionName.Length).SequenceEqual(questionName), "the echoed question name matches");
        offset += questionName.Length;
        Expect(ReadUInt16(bytes, offset) == MdnsWire.TypeA, "the echoed question type matches");
        Expect(ReadUInt16(bytes, offset + 2) == MdnsWire.ClassInternet, "the echoed question class has no stray QU bit");
        offset += 4;

        offset += questionName.Length; // answer name
        Expect(ReadUInt16(bytes, offset + 2) == MdnsWire.ClassInternet,
            "a legacy response must NOT set the cache-flush bit");
        Expect(ReadUInt32(bytes, offset + 4) == 10, "a legacy response TTL is capped at 10 seconds");
        Expect(bytes.AsSpan(offset + 10, 4).SequenceEqual(address.GetAddressBytes()), "the legacy answer carries the address");

        // A QU response is a normal mDNS response that merely travels unicast: id 0, no echoed question.
        var qu = MdnsWire.BuildARecordResponse(HostName, address, MdnsResponder.RecordTtlSeconds, cacheFlush: true);
        Expect(ReadUInt16(qu, 0) == 0 && ReadUInt16(qu, 4) == 0, "a QU response keeps id 0 and an empty question section");
    }

    private static void BuildsAGoodbyePacket()
    {
        var address = IPAddress.Parse("192.168.1.42");
        var goodbye = MdnsWire.BuildARecordResponse(HostName, address, 0, cacheFlush: true);
        var offset = MdnsWire.HeaderLength + MdnsWire.EncodeName(HostName).Length;

        Expect(ReadUInt16(goodbye, 6) == 1, "the goodbye still carries the record");
        Expect(ReadUInt32(goodbye, offset + 4) == 0, "the goodbye TTL is 0 (RFC 6762 10.1)");
        Expect(ReadUInt16(goodbye, offset + 2) == (MdnsWire.ClassInternet | MdnsWire.CacheFlushBit),
            "the goodbye keeps the cache-flush bit so caches drop the name at once");
        Expect(goodbye.AsSpan(offset + 10, 4).SequenceEqual(address.GetAddressBytes()),
            "the goodbye repeats the address it is withdrawing");
    }

    private static void RejectsUnencodableNames()
    {
        ExpectThrows(() => MdnsWire.EncodeName(string.Empty), "an empty name cannot be encoded");
        ExpectThrows(() => MdnsWire.EncodeName("."), "a bare root cannot be encoded");
        ExpectThrows(() => MdnsWire.EncodeName("a..b"), "an empty label cannot be encoded");
        ExpectThrows(() => MdnsWire.EncodeName(new string('a', 64) + ".local"), "a 64-byte label cannot be encoded");

        var maxLabel = MdnsWire.EncodeName(new string('a', 63) + ".local");
        Expect(maxLabel[0] == 63, "a 63-byte label is fine");
    }

    private static void PublishesExactlyTheNameTheQrDialogShows()
    {
        // The whole point of the responder: the phone scans what the dialog rendered, so the name we answer
        // for has to be that same string. On Windows Environment.MachineName is the UPPERCASED NetBIOS name,
        // which is exactly the case where an OS responder would publish something else.
        var dialogName = QrHostOptions.ToMdnsHostName("TOMS-DESKTOP");
        Expect(dialogName == "toms-desktop.local", $"the dialog shows the lowercased name (got '{dialogName}')");

        var query = BuildQuery(1, [("TOMS-DESKTOP.local", MdnsWire.TypeA, MdnsWire.ClassInternet)]);
        Expect(MdnsWire.TryParseQuery(query, out var parsed), "a query for the NetBIOS-cased name parses");
        Expect(parsed.FindAddressQuestion(dialogName!) is not null,
            "a query for the raw machine name is answered by the lowercased published name");

        var response = MdnsWire.BuildARecordResponse(dialogName!, IPAddress.Loopback, 120, cacheFlush: true);
        var encoded = MdnsWire.EncodeName(dialogName!);
        Expect(response.AsSpan(MdnsWire.HeaderLength, encoded.Length).SequenceEqual(encoded),
            "the published record carries the dialog's exact name");
    }

    private static void ParsesTheKillSwitch()
    {
        Expect(MdnsWire.NameEquals(HostName, HostName), "sanity");
        Expect(MdnsResponder.IsEnabled(null), "unset means enabled");
        Expect(MdnsResponder.IsEnabled(string.Empty), "blank means enabled");
        Expect(MdnsResponder.IsEnabled("1"), "1 means enabled");
        Expect(!MdnsResponder.IsEnabled("0"), "0 disables");
        Expect(!MdnsResponder.IsEnabled(" 0 "), "surrounding whitespace is tolerated");
        Expect(!MdnsResponder.IsEnabled("false"), "false disables");
        Expect(!MdnsResponder.IsEnabled("OFF"), "off disables, case-insensitively");
        Expect(!MdnsResponder.IsEnabled("no"), "no disables");
    }

    private static void StaysInertWhenDisabledOrUnnamed()
    {
        // No socket is opened on either path, so this test never touches port 5353.
        var previous = Environment.GetEnvironmentVariable(MdnsResponder.EnabledEnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(MdnsResponder.EnabledEnvironmentVariable, "0");
            var disabledLogs = new List<string>();
            var disabled = new MdnsResponder("kill-switch-test.local", IPAddress.Loopback, disabledLogs.Add);
            Expect(!disabled.IsListening, "the kill-switch keeps the responder from binding");
            Expect(disabled.HostName is null, "a disabled responder publishes nothing");
            Expect(disabledLogs.Exists(line => line.Contains(MdnsResponder.DisabledCode)), "the kill-switch logs its code");
            disabled.DisposeAsync().AsTask().GetAwaiter().GetResult();

            // A machine whose name sanitises to nothing yields a null from ToMdnsHostName; the responder must
            // survive that rather than throwing into host-ui startup.
            Environment.SetEnvironmentVariable(MdnsResponder.EnabledEnvironmentVariable, "0");
            var namelessLogs = new List<string>();
            var nameless = new MdnsResponder(QrHostOptions.ToMdnsHostName("!!!"), null, namelessLogs.Add);
            Expect(!nameless.IsListening, "a null host name keeps the responder inert");
            nameless.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
        finally
        {
            Environment.SetEnvironmentVariable(MdnsResponder.EnabledEnvironmentVariable, previous);
        }
    }

    private static byte[] BuildQuery(ushort id, (string Name, ushort Type, ushort Class)[] questions, ushort flags = 0)
    {
        var datagram = new List<byte>();
        WriteHeader(datagram, id, flags, (ushort)questions.Length);
        foreach (var question in questions)
        {
            datagram.AddRange(MdnsWire.EncodeName(question.Name));
            WriteUInt16(datagram, question.Type);
            WriteUInt16(datagram, question.Class);
        }

        return [.. datagram];
    }

    private static void WriteHeader(List<byte> datagram, ushort id, ushort flags, ushort questionCount)
    {
        WriteUInt16(datagram, id);
        WriteUInt16(datagram, flags);
        WriteUInt16(datagram, questionCount);
        WriteUInt16(datagram, 0);
        WriteUInt16(datagram, 0);
        WriteUInt16(datagram, 0);
    }

    private static void WriteUInt16(List<byte> datagram, int value)
    {
        datagram.Add((byte)((value >> 8) & 0xFF));
        datagram.Add((byte)(value & 0xFF));
    }

    private static ushort ReadUInt16(byte[] datagram, int offset)
        => (ushort)((datagram[offset] << 8) | datagram[offset + 1]);

    private static uint ReadUInt32(byte[] datagram, int offset)
        => ((uint)datagram[offset] << 24)
            | ((uint)datagram[offset + 1] << 16)
            | ((uint)datagram[offset + 2] << 8)
            | datagram[offset + 3];

    private static void ExpectThrows(Action action, string label)
    {
        try
        {
            action();
        }
        catch (ArgumentException)
        {
            return;
        }

        throw new Exception($"MdnsResponderTests assertion failed: {label}");
    }

    private static void Expect(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"MdnsResponderTests assertion failed: {label}");
        }
    }
}
