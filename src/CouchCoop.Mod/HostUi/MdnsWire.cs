using System.Net;
using System.Net.Sockets;
using System.Text;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The pure DNS wire half of the mod's mDNS responder: parse a multicast query, build an A-record
/// response. No sockets, no clock, no environment — every byte-level rule is unit-testable.
/// </summary>
/// <remarks>
/// <para>
/// Scope is deliberately tiny. We are not a general DNS implementation: <see cref="TryParseQuery"/>
/// reads the header plus the question section (that is all a responder needs), and
/// <see cref="BuildARecordResponse"/> emits exactly one A record. Answer/authority/additional
/// sections of an incoming query are ignored, which also means known-answer suppression
/// (RFC 6762 §7.1) is not implemented — at our volume (one record, answered only when asked) the
/// extra multicast traffic is negligible and the parser stays small enough to audit.
/// </para>
/// <para>
/// Names are compared and encoded as DNS labels, not as strings with dots: the one name we publish is
/// LDH-only (see <see cref="QrHostOptions.ToMdnsHostName"/>), so ASCII case folding is exact here.
/// </para>
/// </remarks>
public static class MdnsWire
{
    /// <summary>Fixed DNS header size: ID, flags, and the four section counts.</summary>
    public const int HeaderLength = 12;

    /// <summary>QTYPE/TYPE for an IPv4 host address record.</summary>
    public const ushort TypeA = 1;

    /// <summary>
    /// QTYPE/TYPE for an IPv6 host address record.
    /// </summary>
    /// <remarks>
    /// MEASURED, and not what one would guess: an Android client asks for AAAA over the **IPv4** multicast
    /// group, as a separate datagram beside its A query (captured 2026-08-21 — see
    /// <c>.sts2/research/mdns-windows-android-aug21.md</c>). So AAAA support is mostly about the RECORD
    /// TYPE, not about which socket the question arrives on; the IPv6 transport lane in
    /// <see cref="MdnsResponder"/> is a separate, additive concern.
    /// </remarks>
    public const ushort TypeAaaa = 28;

    /// <summary>QTYPE <c>ANY</c> — a request for every record we hold for the name.</summary>
    public const ushort TypeAny = 255;

    /// <summary>CLASS <c>IN</c> (the internet class), the only class mDNS uses.</summary>
    public const ushort ClassInternet = 1;

    /// <summary>QCLASS <c>ANY</c> — matches every class, so it matches IN too.</summary>
    public const ushort ClassAny = 255;

    /// <summary>
    /// Top bit of a question's CLASS: "unicast response requested" (RFC 6762 §5.4). Same bit position
    /// as <see cref="CacheFlushBit"/>, which is the answer-side meaning of the top CLASS bit.
    /// </summary>
    public const ushort UnicastResponseBit = 0x8000;

    /// <summary>Top bit of an answer's CLASS: "flush the cache for this name/type" (RFC 6762 §10.2).</summary>
    public const ushort CacheFlushBit = 0x8000;

    /// <summary>Mask that strips the QU / cache-flush bit off a CLASS field.</summary>
    public const ushort ClassMask = 0x7FFF;

    /// <summary>Response header flags: QR=1 (response) and AA=1 (authoritative). RFC 6762 §18.</summary>
    public const ushort ResponseFlags = 0x8400;

    /// <summary>Longest single DNS label.</summary>
    public const int MaxLabelLength = 63;

    /// <summary>Longest encoded name (all labels plus their length bytes).</summary>
    public const int MaxNameLength = 255;

    // A compression pointer may only point strictly backwards, which already makes loops impossible;
    // this cap is a second belt against a pathological chain of single-label hops.
    private const int MaxPointerJumps = 16;

    /// <summary>
    /// Parse a datagram as an mDNS QUERY. Returns <see langword="false"/> for anything that is not a
    /// well-formed standard query with at least one question — including our own responses (QR=1),
    /// which is what keeps the responder from answering itself on the loopback of its own multicast.
    /// </summary>
    public static bool TryParseQuery(ReadOnlySpan<byte> datagram, out MdnsQuery query)
    {
        query = MdnsQuery.Empty;

        if (datagram.Length < HeaderLength)
        {
            return false;
        }

        var transactionId = ReadUInt16(datagram, 0);
        var flags = ReadUInt16(datagram, 2);

        // QR bit set => this is a response, not a query.
        if ((flags & 0x8000) != 0)
        {
            return false;
        }

        // OPCODE must be 0 (standard QUERY). RFC 6762 §18.3: a responder silently ignores anything else.
        if (((flags & 0x7800) >> 11) != 0)
        {
            return false;
        }

        var questionCount = ReadUInt16(datagram, 4);
        if (questionCount == 0)
        {
            return false;
        }

        var offset = HeaderLength;
        var questions = new List<MdnsQuestion>(questionCount);
        for (var index = 0; index < questionCount; index++)
        {
            if (!TryReadName(datagram, ref offset, out var name))
            {
                return false;
            }

            if (offset + 4 > datagram.Length)
            {
                return false;
            }

            var type = ReadUInt16(datagram, offset);
            var rawClass = ReadUInt16(datagram, offset + 2);
            offset += 4;

            questions.Add(new MdnsQuestion(
                name,
                type,
                (ushort)(rawClass & ClassMask),
                (rawClass & UnicastResponseBit) != 0));
        }

        query = new MdnsQuery(transactionId, questions);
        return true;
    }

    /// <summary>
    /// Build a response carrying exactly one A record.
    /// </summary>
    /// <param name="name">The name being answered for, e.g. <c>my-machine.local</c>.</param>
    /// <param name="address">The IPv4 to publish. Must be <see cref="AddressFamily.InterNetwork"/>.</param>
    /// <param name="ttlSeconds">Record TTL. <c>0</c> makes this a goodbye packet (RFC 6762 §10.1).</param>
    /// <param name="cacheFlush">
    /// Sets the cache-flush bit. True for normal multicast responses and announcements (the name is
    /// ours and unique); MUST be false in a legacy unicast response (RFC 6762 §6.7).
    /// </param>
    /// <param name="transactionId">
    /// <c>0</c> for multicast responses (RFC 6762 §18.1). A legacy unicast response must echo the
    /// querier's id instead, or the querier will not match the reply to its question.
    /// </param>
    /// <param name="echoQuestion">
    /// <see langword="null"/> for a normal mDNS response (RFC 6762 §6: responses SHOULD have an empty
    /// question section). A legacy unicast response must repeat the question it answers.
    /// </param>
    /// <summary>
    /// Build a one-question A QUERY for <paramref name="name"/>.
    /// </summary>
    /// <remarks>
    /// The responder never sends queries — this exists for <see cref="MdnsHealth"/>'s self-check, which has
    /// to ask over the real network because that is the only way to observe a firewall that silently drops
    /// inbound 5353. <paramref name="unicastResponse"/> sets the QU bit (RFC 6762 §5.4), which is what lets
    /// an answer come straight back to an ephemeral socket.
    /// </remarks>
    public static byte[] BuildAQuery(string name, bool unicastResponse)
    {
        var encoded = EncodeName(name);
        var buffer = new List<byte>(HeaderLength + encoded.Length + 4);
        WriteUInt16(buffer, 0);  // ID — mDNS ignores it, and a legacy responder echoes whatever we send.
        WriteUInt16(buffer, 0);  // Flags: standard QUERY, QR clear.
        WriteUInt16(buffer, 1);  // QDCOUNT
        WriteUInt16(buffer, 0);  // ANCOUNT
        WriteUInt16(buffer, 0);  // NSCOUNT
        WriteUInt16(buffer, 0);  // ARCOUNT

        buffer.AddRange(encoded);
        WriteUInt16(buffer, TypeA);
        WriteUInt16(buffer, (ushort)(ClassInternet | (unicastResponse ? UnicastResponseBit : 0)));

        return [.. buffer];
    }

    public static byte[] BuildARecordResponse(
        string name,
        IPAddress address,
        uint ttlSeconds,
        bool cacheFlush,
        ushort transactionId = 0,
        MdnsQuestion? echoQuestion = null)
    {
        ArgumentNullException.ThrowIfNull(address);
        if (address.AddressFamily != AddressFamily.InterNetwork)
        {
            throw new ArgumentException("Only IPv4 addresses can be published as an A record.", nameof(address));
        }

        var answerName = EncodeName(name);
        var questionName = echoQuestion is null ? null : EncodeName(echoQuestion.Name);

        var buffer = new List<byte>(HeaderLength + answerName.Length + 14 + (questionName?.Length ?? 0) + 4);
        WriteUInt16(buffer, transactionId);
        WriteUInt16(buffer, ResponseFlags);
        WriteUInt16(buffer, (ushort)(questionName is null ? 0 : 1)); // QDCOUNT
        WriteUInt16(buffer, 1);                                      // ANCOUNT
        WriteUInt16(buffer, 0);                                      // NSCOUNT
        WriteUInt16(buffer, 0);                                      // ARCOUNT

        if (questionName is not null)
        {
            buffer.AddRange(questionName);
            WriteUInt16(buffer, echoQuestion!.Type);
            // Echo the class with the QU bit cleared: the querier compares the echoed question against
            // the one it sent, and a stray top bit makes it look like a different class.
            WriteUInt16(buffer, echoQuestion.Class);
        }

        buffer.AddRange(answerName);
        WriteUInt16(buffer, TypeA);
        WriteUInt16(buffer, (ushort)(ClassInternet | (cacheFlush ? CacheFlushBit : 0)));
        WriteUInt32(buffer, ttlSeconds);
        WriteUInt16(buffer, 4); // RDLENGTH
        buffer.AddRange(address.GetAddressBytes());

        return [.. buffer];
    }

    /// <summary>
    /// Parse a datagram as an mDNS RESPONSE and return the address records it carries.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The mirror of <see cref="TryParseQuery"/>, and it exists for exactly one caller: the responder's
    /// startup SELF-CHECK, which asks the multicast group for its own published name and needs to know
    /// whether anything answered. Nothing on the serving path parses responses — a responder that read other
    /// responders' answers would be implementing the cache/known-answer half of RFC 6762, which this
    /// deliberately is not.
    /// </para>
    /// <para>
    /// Only A and AAAA answers are returned; every other record type is skipped by its RDLENGTH rather than
    /// decoded, so a PTR/SRV/TXT-heavy service response parses without needing any of that grammar. The
    /// authority and additional sections are ignored (an mDNS responder is authoritative, so what we want is
    /// always in the ANSWER section).
    /// </para>
    /// </remarks>
    public static bool TryParseResponse(ReadOnlySpan<byte> datagram, out MdnsResponse response)
    {
        response = MdnsResponse.Empty;

        if (datagram.Length < HeaderLength)
        {
            return false;
        }

        var transactionId = ReadUInt16(datagram, 0);
        var flags = ReadUInt16(datagram, 2);

        // QR bit CLEAR => this is a query, not a response.
        if ((flags & 0x8000) == 0)
        {
            return false;
        }

        var questionCount = ReadUInt16(datagram, 4);
        var answerCount = ReadUInt16(datagram, 6);
        var offset = HeaderLength;

        // A legacy-unicast response echoes the question section; skip past it to reach the answers.
        for (var index = 0; index < questionCount; index++)
        {
            if (!TryReadName(datagram, ref offset, out _) || offset + 4 > datagram.Length)
            {
                return false;
            }

            offset += 4;
        }

        var records = new List<MdnsAddressRecord>(answerCount);
        for (var index = 0; index < answerCount; index++)
        {
            if (!TryReadName(datagram, ref offset, out var name) || offset + 10 > datagram.Length)
            {
                return false;
            }

            var type = ReadUInt16(datagram, offset);
            var rawClass = ReadUInt16(datagram, offset + 2);
            var ttl = ReadUInt32(datagram, offset + 4);
            var dataLength = ReadUInt16(datagram, offset + 8);
            offset += 10;

            if (offset + dataLength > datagram.Length)
            {
                return false;
            }

            var isInternetClass = (rawClass & ClassMask) is ClassInternet or ClassAny;
            if (isInternetClass && type == TypeA && dataLength == 4)
            {
                records.Add(new MdnsAddressRecord(name, type, new IPAddress(datagram.Slice(offset, 4).ToArray()), ttl));
            }
            else if (isInternetClass && type == TypeAaaa && dataLength == 16)
            {
                records.Add(new MdnsAddressRecord(name, type, new IPAddress(datagram.Slice(offset, 16).ToArray()), ttl));
            }

            offset += dataLength;
        }

        response = new MdnsResponse(transactionId, records);
        return true;
    }

    /// <summary>
    /// DNS name equality: case-insensitive per label, and a trailing root dot is not significant.
    /// </summary>
    public static bool NameEquals(string? left, string? right)
    {
        if (left is null || right is null)
        {
            return false;
        }

        return string.Equals(
            left.TrimEnd('.'),
            right.TrimEnd('.'),
            StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Encode a dotted name as length-prefixed DNS labels terminated by a zero byte.</summary>
    public static byte[] EncodeName(string name)
    {
        var trimmed = (name ?? string.Empty).Trim().TrimEnd('.');
        if (trimmed.Length == 0)
        {
            throw new ArgumentException("A DNS name must have at least one label.", nameof(name));
        }

        var encoded = new List<byte>(trimmed.Length + 2);
        foreach (var label in trimmed.Split('.'))
        {
            var bytes = Encoding.UTF8.GetBytes(label);
            if (bytes.Length == 0)
            {
                throw new ArgumentException($"Empty label in DNS name '{name}'.", nameof(name));
            }

            if (bytes.Length > MaxLabelLength)
            {
                throw new ArgumentException($"Label longer than {MaxLabelLength} bytes in DNS name '{name}'.", nameof(name));
            }

            encoded.Add((byte)bytes.Length);
            encoded.AddRange(bytes);
        }

        encoded.Add(0);
        if (encoded.Count > MaxNameLength)
        {
            throw new ArgumentException($"Encoded DNS name '{name}' exceeds {MaxNameLength} bytes.", nameof(name));
        }

        return [.. encoded];
    }

    private static bool TryReadName(ReadOnlySpan<byte> datagram, ref int offset, out string name)
    {
        name = string.Empty;

        var builder = new StringBuilder(64);
        var cursor = offset;
        var followedPointer = false;
        var jumps = 0;
        var encodedLength = 0;

        while (true)
        {
            if (cursor >= datagram.Length)
            {
                return false;
            }

            var length = datagram[cursor];
            if ((length & 0xC0) == 0xC0)
            {
                // Compression pointer. Legal in a question name (rare, but a multi-question packet may
                // use one), so it has to be handled rather than rejected.
                if (cursor + 1 >= datagram.Length)
                {
                    return false;
                }

                var pointer = ((length & 0x3F) << 8) | datagram[cursor + 1];

                // The consumed length of THIS name ends at the pointer, wherever the pointer leads.
                if (!followedPointer)
                {
                    offset = cursor + 2;
                    followedPointer = true;
                }

                // Pointers must reference an earlier occurrence. Enforcing strictly-backwards is what
                // makes a crafted self-referencing packet terminate instead of spinning the loop.
                if (pointer >= cursor || ++jumps > MaxPointerJumps)
                {
                    return false;
                }

                cursor = pointer;
                continue;
            }

            if ((length & 0xC0) != 0)
            {
                // Reserved label type (0b01 / 0b10) — not something a responder should guess at.
                return false;
            }

            cursor++;

            if (length == 0)
            {
                if (!followedPointer)
                {
                    offset = cursor;
                }

                name = builder.ToString();
                return true;
            }

            if (cursor + length > datagram.Length)
            {
                return false;
            }

            encodedLength += length + 1;
            if (encodedLength > MaxNameLength)
            {
                return false;
            }

            if (builder.Length > 0)
            {
                builder.Append('.');
            }

            builder.Append(Encoding.UTF8.GetString(datagram.Slice(cursor, length)));
            cursor += length;
        }
    }

    private static ushort ReadUInt16(ReadOnlySpan<byte> datagram, int offset)
        => (ushort)((datagram[offset] << 8) | datagram[offset + 1]);

    private static uint ReadUInt32(ReadOnlySpan<byte> datagram, int offset)
        => ((uint)datagram[offset] << 24)
            | ((uint)datagram[offset + 1] << 16)
            | ((uint)datagram[offset + 2] << 8)
            | datagram[offset + 3];

    private static void WriteUInt16(List<byte> buffer, ushort value)
    {
        buffer.Add((byte)(value >> 8));
        buffer.Add((byte)(value & 0xFF));
    }

    private static void WriteUInt32(List<byte> buffer, uint value)
    {
        buffer.Add((byte)(value >> 24));
        buffer.Add((byte)((value >> 16) & 0xFF));
        buffer.Add((byte)((value >> 8) & 0xFF));
        buffer.Add((byte)(value & 0xFF));
    }
}

/// <summary>One entry of a query's question section.</summary>
/// <param name="Name">Dotted name, exactly as it appeared on the wire (case preserved).</param>
/// <param name="Type">QTYPE.</param>
/// <param name="Class">QCLASS with the QU bit already stripped.</param>
/// <param name="UnicastResponse">The QU bit: the querier wants the answer unicast back to it.</param>
public sealed record MdnsQuestion(string Name, ushort Type, ushort Class, bool UnicastResponse)
{
    /// <summary>
    /// An A query, or an ANY query (which asks for the A record too).
    /// </summary>
    /// <remarks>
    /// An AAAA question is deliberately NOT an address question here. This responder publishes A records
    /// only, and the browser server it advertises binds <c>IPAddress.Any</c> — AF_INET, no IPv6 listener —
    /// so an AAAA answer would name an address nothing accepts connections on, and Happy Eyeballs prefers
    /// IPv6. Answering AAAA needs a dual-stack listener first; until then, silence is the correct answer and
    /// the querier falls back to the A record it asked for in the same breath. (Measured: an Android client
    /// asks A and AAAA as separate datagrams over the IPv4 group, and resolves fine off the A alone — see
    /// <c>.sts2/research/mdns-windows-android-aug21.md</c>.)
    /// </remarks>
    public bool AsksForAddress => Type is MdnsWire.TypeA or MdnsWire.TypeAny;

    /// <summary>IN, or the QCLASS wildcard that also covers IN.</summary>
    public bool IsInternetClass => Class is MdnsWire.ClassInternet or MdnsWire.ClassAny;

    /// <summary>True when this question asks for the IPv4 address of <paramref name="hostName"/>.</summary>
    public bool Matches(string hostName)
        => AsksForAddress && IsInternetClass && MdnsWire.NameEquals(Name, hostName);
}

/// <summary>One A/AAAA record read out of a response's answer section.</summary>
/// <param name="Type"><see cref="MdnsWire.TypeA"/> or <see cref="MdnsWire.TypeAaaa"/>.</param>
/// <param name="TtlSeconds">As sent; <c>0</c> is a goodbye (RFC 6762 §10.1) and NOT a usable answer.</param>
public sealed record MdnsAddressRecord(string Name, ushort Type, IPAddress Address, uint TtlSeconds);

/// <summary>A parsed mDNS response: the header id plus the address records in its answer section.</summary>
public sealed record MdnsResponse(ushort TransactionId, IReadOnlyList<MdnsAddressRecord> Answers)
{
    public static readonly MdnsResponse Empty = new(0, []);
}

/// <summary>A parsed mDNS query: the header id plus its question section.</summary>
public sealed record MdnsQuery(ushort TransactionId, IReadOnlyList<MdnsQuestion> Questions)
{
    public static readonly MdnsQuery Empty = new(0, []);

    /// <summary>The first question asking for <paramref name="hostName"/>'s address, if any.</summary>
    public MdnsQuestion? FindAddressQuestion(string hostName)
    {
        for (var index = 0; index < Questions.Count; index++)
        {
            if (Questions[index].Matches(hostName))
            {
                return Questions[index];
            }
        }

        return null;
    }
}
