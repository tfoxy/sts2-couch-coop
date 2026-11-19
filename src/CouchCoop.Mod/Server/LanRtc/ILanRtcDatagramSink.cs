using System.Net;

namespace CouchCoop.Mod.Server.LanRtc;

/// <summary>Consumes STUN/DTLS datagrams from the shared browser-port UDP socket.</summary>
public interface ILanRtcDatagramSink
{
    // Called on the receive loop. Return promptly; the span is only valid for this call.
    // Non-fatal exceptions are caught and logged by the socket owner.
    void ReceiveDatagram(IPEndPoint remote, IPAddress localDestination, ReadOnlySpan<byte> datagram);
}
