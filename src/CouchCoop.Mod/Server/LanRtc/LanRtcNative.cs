using System.Net;
using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Server.LanRtc;

// Layout and calling convention match grc_net_rtc_v1. All pointed-to input is borrowed for the call.
[StructLayout(LayoutKind.Sequential)]
internal unsafe struct LanRtcAddress
{
    public byte Family;
    public byte Reserved;
    public ushort Port;
    public fixed byte Address[16];

    public static LanRtcAddress From(IPEndPoint endpoint)
    {
        var result = new LanRtcAddress { Family = (byte)(endpoint.Address.AddressFamily ==
            System.Net.Sockets.AddressFamily.InterNetwork ? 4 : 6), Port = checked((ushort)endpoint.Port) };
        endpoint.Address.GetAddressBytes().CopyTo(new Span<byte>(result.Address, 16));
        return result;
    }

    public IPEndPoint ToEndpoint()
    {
        fixed (byte* address = Address)
            return new IPEndPoint(new IPAddress(new ReadOnlySpan<byte>(address, Family switch
            { 4 => 4, 6 => 16, _ => throw new ArgumentException("Invalid RTC address family.") })), Port);
    }
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct LanRtcConfig
{
    public byte* Certificate;
    public nuint CertificateLength;
    public byte* Key;
    public nuint KeyLength;
    public byte* Ufrag;
    public byte* Password;
    public LanRtcAddress Candidate;
    public uint MaxPeers, ReceiveMaxMessage, LowThreshold, SendBudget;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct LanRtcCallbacks
{
    public uint Abi;
    public nint User;
    public delegate* unmanaged[Cdecl]<nint, LanRtcAddress*, byte*, nuint, void> Transmit;
    public delegate* unmanaged[Cdecl]<nint, uint, int, LanRtcAddress*, void> Peer;
    public delegate* unmanaged[Cdecl]<nint, uint, uint, byte*, nuint, void> Open;
    public delegate* unmanaged[Cdecl]<nint, uint, uint, int, byte*, nuint, void> Message;
    public delegate* unmanaged[Cdecl]<nint, uint, uint, void> Low;
    public delegate* unmanaged[Cdecl]<nint, uint, uint, void> Closed;
    public delegate* unmanaged[Cdecl]<nint, int, byte*, nuint, void> Log;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct LanRtcApi
{
    public uint Abi;
    public delegate* unmanaged[Cdecl]<LanRtcConfig*, LanRtcCallbacks*, nint*, byte*, nuint, int> Create;
    public delegate* unmanaged[Cdecl]<nint, LanRtcAddress*, LanRtcAddress*, byte*, nuint, int> Input;
    public delegate* unmanaged[Cdecl]<nint, uint, uint, int, byte*, nuint, int> Send;
    public delegate* unmanaged[Cdecl]<nint, uint, uint, ulong> Buffered;
    public delegate* unmanaged[Cdecl]<nint, uint, uint, void> CloseChannel;
    public delegate* unmanaged[Cdecl]<nint, uint, void> ClosePeer;
    public delegate* unmanaged[Cdecl]<nint, void> Destroy;
}
