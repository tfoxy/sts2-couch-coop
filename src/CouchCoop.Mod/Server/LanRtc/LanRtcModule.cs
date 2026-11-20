using System.Collections.Concurrent;
using System.Net;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Server.LanRtc;

internal enum LanRtcEventKind { PeerConnected, PeerRemoved, Open, Message, Low, Closed }
internal sealed record LanRtcEvent(LanRtcEventKind Kind, uint Peer, uint Channel = 0,
    IPAddress? Address = null, string? Label = null, bool Binary = false, byte[]? Data = null);

internal interface ILanRtcTransport
{
    ChannelReader<LanRtcEvent> Events { get; }
    LanRtcChannelSignals? GetSignals(uint peer, uint channel);
    int Send(uint peer, uint channel, bool binary, ReadOnlySpan<byte> data);
    void CloseChannel(uint peer, uint channel);
}

// Control signals must bypass the upload queue: its consumer may be waiting for a send drain.
internal sealed class LanRtcChannelSignals
{
    private readonly object _gate = new();
    private TaskCompletionSource _drained = NewSignal();
    private readonly TaskCompletionSource _closed = NewSignal();
    private readonly Channel<LanRtcEvent> _messages = Channel.CreateUnbounded<LanRtcEvent>(new()
        { SingleReader = true, AllowSynchronousContinuations = false });
    private readonly TaskCompletionSource _overflow = NewSignal(), _requestEnded = NewSignal();
    private int _queuedBytes;
    private long _bodyBytes;
    private bool _first = true, _fetch;
    public Task Overflow => _overflow.Task;
    public Task RequestEnded => _requestEnded.Task;

    // The ABI cannot pause receive. Bound each channel independently: fetch bodies total 1 MiB,
    // WebSockets queue at most 4 MiB (including message overhead); overflow retires only that channel.
    public void ConfigureFetch()
    {
        lock (_gate)
        {
            _fetch = true;
            if (_bodyBytes > LanRtcTunnel.FetchBodyLimit) _overflow.TrySetResult();
        }
    }
    public void Message(LanRtcEvent value)
    {
        lock (_gate)
        {
            if (_overflow.Task.IsCompleted || _closed.Task.IsCompleted) return;
            var charge = (value.Data?.Length ?? 0) + 64;
            var ended = !_first && value.Binary && value.Data is { Length: > 0 } data && (data[0] & 128) != 0;
            if (!_first)
            {
                _bodyBytes += Math.Max(0, (value.Data?.Length ?? 0) - 1);
            }
            _first = false;
            if (_queuedBytes + charge > LanRtcTunnel.InboxByteBudget || (_fetch && _bodyBytes > LanRtcTunnel.FetchBodyLimit))
            { _overflow.TrySetResult(); return; }
            _queuedBytes += charge;
            _messages.Writer.TryWrite(value);
            if (ended) _requestEnded.TrySetResult();
        }
    }
    public async ValueTask<LanRtcEvent> ReadAsync(CancellationToken token)
    {
        var value = await _messages.Reader.ReadAsync(token).ConfigureAwait(false);
        lock (_gate) _queuedBytes -= (value.Data?.Length ?? 0) + 64;
        return value;
    }
    public static LanRtcChannelSignals AlreadyClosed { get; } = CreateClosed();
    public Task Closed => _closed.Task;
    public Task Drained { get { lock (_gate) return _drained.Task; } }
    public void Low()
    { lock (_gate) { var drained = _drained; _drained = NewSignal(); drained.TrySetResult(); } }
    public void Close() => _closed.TrySetResult();
    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static LanRtcChannelSignals CreateClosed() { var signals = new LanRtcChannelSignals(); signals.Close(); return signals; }
}

// Native callbacks never acquire the entry gate or wait for managed consumers. In particular destroy
// may wait for a timer callback while holding the gate that serializes all host entry calls.
internal sealed unsafe class LanRtcModule : ILanRtcDatagramSink, ILanRtcTransport, IDisposable
{
    internal const string LibraryEnvironmentVariable = "COUCHCOOP_LAN_RTC_LIB";
    private readonly object _gate = new();
    private readonly LanRtcApi _api;
    private readonly BrowserPortUdpSocket _socket;
    private readonly Action<string> _log;
    private readonly Channel<LanRtcEvent> _events = Channel.CreateUnbounded<LanRtcEvent>(new() { AllowSynchronousContinuations = false });
    private readonly ConcurrentDictionary<(uint, uint), LanRtcChannelSignals> _channels = new();
    private GCHandle _user;
    private nint _handle, _library;
    private bool _disposed;
    public ChannelReader<LanRtcEvent> Events => _events.Reader;
    public LanRtcChannelSignals? GetSignals(uint peer, uint channel) => _channels.GetValueOrDefault((peer, channel));

    private LanRtcModule(LanRtcApi api, BrowserPortUdpSocket socket, Action<string> log)
    { _api = api; _socket = socket; _log = log; }

    public static LanRtcModule? TryCreate(LanRtcIdentity identity, IPEndPoint candidate,
        BrowserPortUdpSocket socket, Action<string> log, uint sendBudget = 0, string? libraryPath = null)
    {
        var path = libraryPath ?? Environment.GetEnvironmentVariable(LibraryEnvironmentVariable);
        nint library = 0;
        try
        {
            if (string.IsNullOrWhiteSpace(path)) path = ResolveLibraryPath(
                Path.GetDirectoryName(typeof(LanRtcModule).Assembly.Location)!,
                Environment.GetEnvironmentVariable(CouchCoop.Mod.Diagnostics.RenderCaptureExtensionLoader.EnvironmentVariable));
            if (path is null || !NativeLibrary.TryLoad(path, out library) ||
                !NativeLibrary.TryGetExport(library, "grc_net_rtc_v1", out var entry))
                throw new InvalidOperationException("native module or RTC export is missing");
            var api = ((delegate* unmanaged[Cdecl]<LanRtcApi*>)entry)();
            if (api == null) throw new InvalidOperationException("RTC table is null");
            var module = Create(*api, identity, candidate, socket, log, sendBudget);
            module._library = library;
            return module;
        }
        catch (Exception exception)
        {
            if (library != 0) NativeLibrary.Free(library);
            try { log($"LAN RTC unavailable: {exception.Message}"); } catch { }
            return null;
        }
    }

    // RTC uses the capture's net module, but needs neither a capture nor its engine calibration.
    internal static string ResolveLibraryPath(string assemblyDirectory, string? captureExtension)
        => Path.Combine(string.IsNullOrWhiteSpace(captureExtension)
            ? Path.Combine(CouchCoopHostUiServices.ResolvePayloadRoot(assemblyDirectory), "render-capture",
                OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux")
            : Path.GetDirectoryName(Path.GetFullPath(captureExtension))!, StreamingSeatLaunch.NetModuleFileName);

    internal static LanRtcModule Create(LanRtcApi api, LanRtcIdentity identity, IPEndPoint candidate,
        BrowserPortUdpSocket socket, Action<string> log, uint sendBudget = 0)
    {
        if (api.Abi != 1 || api.Create == null || api.Input == null || api.Send == null || api.Buffered == null ||
            api.CloseChannel == null || api.ClosePeer == null || api.Destroy == null)
            throw new ArgumentException("Invalid RTC function table.");
        if (!socket.IsListening || !BrowserPortUdpSocket.IsRtcSource(candidate.Address) || candidate.Port != socket.Port)
            throw new ArgumentException("RTC requires the shared UDP socket's LAN candidate.");
        var module = new LanRtcModule(api, socket, log);
        module._user = GCHandle.Alloc(module);
        using var key = identity.Certificate.GetECDsaPrivateKey()!;
        var keyBytes = key.ExportPkcs8PrivateKey();
        var cert = identity.Certificate.RawData;
        var ufrag = Encoding.UTF8.GetBytes(identity.IceCredentials.Ufrag + "\0");
        var password = Encoding.UTF8.GetBytes(identity.IceCredentials.Password + "\0");
        try
        {
            fixed (byte* c = cert, k = keyBytes, u = ufrag, p = password)
            {
                var config = new LanRtcConfig { Certificate = c, CertificateLength = (nuint)cert.Length,
                    Key = k, KeyLength = (nuint)keyBytes.Length, Ufrag = u, Password = p,
                    Candidate = LanRtcAddress.From(candidate), MaxPeers = 16, ReceiveMaxMessage = 262144,
                    LowThreshold = 0, SendBudget = sendBudget };
                var callbacks = new LanRtcCallbacks { Abi = 1, User = GCHandle.ToIntPtr(module._user),
                    Transmit = &Transmit, Peer = &Peer, Open = &Open, Message = &Message,
                    Low = &Low, Closed = &Closed, Log = &Log };
                var error = stackalloc byte[512];
                nint handle = 0;
                var result = api.Create(&config, &callbacks, &handle, error, 512);
                module._handle = handle;
                if (result != 0 || handle == 0)
                    throw new InvalidOperationException($"RTC create failed ({result}): {Marshal.PtrToStringUTF8((nint)error)}");
            }
            socket.RegisterSink(module);
            return module;
        }
        catch { module.Dispose(); throw; }
        finally { CryptographicOperations.ZeroMemory(keyBytes); }
    }

    public void ReceiveDatagram(IPEndPoint remote, IPAddress localDestination, ReadOnlySpan<byte> datagram)
    {
        lock (_gate)
        {
            if (_disposed) return;
            var source = LanRtcAddress.From(remote);
            var destination = LanRtcAddress.From(new IPEndPoint(localDestination, _socket.Port));
            fixed (byte* bytes = datagram)
                _api.Input(_handle, &source, &destination, bytes, (nuint)datagram.Length);
        }
    }

    public int Send(uint peer, uint channel, bool binary, ReadOnlySpan<byte> data)
    {
        lock (_gate)
        {
            if (_disposed) return -2;
            fixed (byte* bytes = data) return _api.Send(_handle, peer, channel, binary ? 1 : 0, bytes, (nuint)data.Length);
        }
    }

    public ulong Buffered(uint peer, uint channel)
    { lock (_gate) return _disposed ? 0 : _api.Buffered(_handle, peer, channel); }
    public void CloseChannel(uint peer, uint channel)
    { lock (_gate) { if (!_disposed) _api.CloseChannel(_handle, peer, channel); } }
    public void ClosePeer(uint peer)
    { lock (_gate) { if (!_disposed) _api.ClosePeer(_handle, peer); } }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            _socket.UnregisterSink(this);
            if (_handle != 0) _api.Destroy(_handle);
            _handle = 0;
            foreach (var signals in _channels.Values) signals.Close();
            _channels.Clear();
            _events.Writer.TryComplete();
            if (_user.IsAllocated) _user.Free();
            if (_library != 0) NativeLibrary.Free(_library);
            _library = 0;
        }
    }

    private static LanRtcModule Owner(nint user) => (LanRtcModule)GCHandle.FromIntPtr(user).Target!;
    private static void Report(nint user, Exception error)
    { try { Owner(user)._log($"LAN RTC callback failed: {error.GetType().Name}"); } catch { } }
    private void Post(LanRtcEvent value)
    {
        var key = (value.Peer, value.Channel);
        switch (value.Kind)
        {
            case LanRtcEventKind.Open: _channels.TryAdd(key, new()); break;
            case LanRtcEventKind.Message:
                GetSignals(value.Peer, value.Channel)?.Message(value);
                return;
            case LanRtcEventKind.Low:
                // Send credit belongs to the association; a sibling channel may be waiting with zero buffered bytes.
                foreach (var item in _channels.Where(item => item.Key.Item1 == value.Peer)) item.Value.Low();
                return;
            case LanRtcEventKind.Closed:
                if (_channels.TryRemove(key, out var signals)) signals.Close();
                break;
            case LanRtcEventKind.PeerRemoved:
                foreach (var item in _channels.Where(item => item.Key.Item1 == value.Peer))
                    if (_channels.TryRemove(item.Key, out var removed)) removed.Close();
                break;
        }
        _events.Writer.TryWrite(value);
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static void Transmit(nint user, LanRtcAddress* destination, byte* data, nuint length)
    { try { Owner(user)._socket.SendTo(destination->ToEndpoint(), new ReadOnlySpan<byte>(data, checked((int)length))); } catch (Exception e) { Report(user, e); } }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static void Peer(nint user, uint peer, int state, LanRtcAddress* remote)
    { try { Owner(user).Post(new(state == 1 ? LanRtcEventKind.PeerConnected : LanRtcEventKind.PeerRemoved, peer, Address: remote->ToEndpoint().Address)); } catch (Exception e) { Report(user, e); } }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static void Open(nint user, uint peer, uint channel, byte* label, nuint length)
    { try { Owner(user).Post(new(LanRtcEventKind.Open, peer, channel, Label: Encoding.UTF8.GetString(new ReadOnlySpan<byte>(label, checked((int)length))))); } catch (Exception e) { Report(user, e); } }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static void Message(nint user, uint peer, uint channel, int binary, byte* data, nuint length)
    { try { Owner(user).Post(new(LanRtcEventKind.Message, peer, channel, Binary: binary != 0, Data: new ReadOnlySpan<byte>(data, checked((int)length)).ToArray())); } catch (Exception e) { Report(user, e); } }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static void Low(nint user, uint peer, uint channel)
    { try { Owner(user).Post(new(LanRtcEventKind.Low, peer, channel)); } catch (Exception e) { Report(user, e); } }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static void Closed(nint user, uint peer, uint channel)
    { try { Owner(user).Post(new(LanRtcEventKind.Closed, peer, channel)); } catch (Exception e) { Report(user, e); } }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static void Log(nint user, int level, byte* data, nuint length)
    {
        try
        {
            var bytes = new ReadOnlySpan<byte>(data, checked((int)length));
            // Native info events include every message and send-credit notification. Keep lifecycle
            // and error diagnostics without turning normal traffic into an unbounded log workload.
            if (level >= 2)
            {
                try
                {
                    var reader = new Utf8JsonReader(bytes);
                    while (reader.Read())
                    {
                        if (reader.TokenType != JsonTokenType.PropertyName || reader.CurrentDepth != 1 || !reader.ValueTextEquals("event")) continue;
                        if (reader.Read() && reader.TokenType == JsonTokenType.String &&
                            (reader.ValueTextEquals("dc-message") || reader.ValueTextEquals("dc-low"))) return;
                        break;
                    }
                }
                catch (JsonException) { }
            }
            Owner(user)._log("LAN RTC: " + Encoding.UTF8.GetString(bytes));
        }
        catch (Exception e) { Report(user, e); }
    }
}
