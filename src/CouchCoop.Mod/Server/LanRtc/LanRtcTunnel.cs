using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CouchCoop.Mod.Server.LanRtc;

internal sealed class LanRtcTunnel : IAsyncDisposable
{
    internal const string Label = "couch-tunnel/1";
    internal const int InboxByteBudget = 4 * 1024 * 1024;
    internal const int FetchBodyLimit = 1024 * 1024;
    private readonly ILanRtcTransport _transport;
    private readonly Func<Stream, IPAddress, CancellationToken, Task> _serve;
    private readonly string _host;
    private readonly Action<string> _log;
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentDictionary<(uint, uint), Session> _sessions = new();
    private readonly Task _pump;

    public LanRtcTunnel(ILanRtcTransport transport, CouchCoopBrowserServer server, IPEndPoint candidate, Action<string>? log = null)
        : this(transport, (stream, address, token) => server.ServeAsync(stream, false, address, token), candidate, log) { }

    internal LanRtcTunnel(ILanRtcTransport transport, Func<Stream, IPAddress, CancellationToken, Task> serve,
        IPEndPoint candidate, Action<string>? log = null)
    {
        _transport = transport; _serve = serve; _host = candidate.ToString(); _log = log ?? (_ => { });
        _pump = Task.Run(PumpAsync);
    }

    private async Task PumpAsync()
    {
        var peers = new Dictionary<uint, IPAddress>();
        try
        {
            await foreach (var value in _transport.Events.ReadAllAsync(_stop.Token).ConfigureAwait(false))
            {
                var key = (value.Peer, value.Channel);
                switch (value.Kind)
                {
                    case LanRtcEventKind.PeerConnected:
                        if (value.Address is { } address && !IPAddress.IsLoopback(address) && !address.Equals(IPAddress.Any)
                            && !address.Equals(IPAddress.IPv6Any)) peers[value.Peer] = address;
                        break;
                    case LanRtcEventKind.PeerRemoved:
                        peers.Remove(value.Peer);
                        foreach (var item in _sessions.Where(item => item.Key.Item1 == value.Peer)) item.Value.Abort();
                        break;
                    case LanRtcEventKind.Open:
                        if (value.Label != Label || !peers.TryGetValue(value.Peer, out var remote))
                        { _transport.CloseChannel(value.Peer, value.Channel); break; }
                        var session = new Session(this, value.Peer, value.Channel, remote, _stop.Token);
                        if (!_sessions.TryAdd(key, session)) { session.Dispose(); break; }
                        session.Start();
                        break;
                    case LanRtcEventKind.Low:
                        // Drain signals bypass the message inbox through the transport.
                        break;
                    case LanRtcEventKind.Closed:
                        if (_sessions.TryGetValue(key, out var closed)) closed.Abort();
                        break;
                }
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        finally
        {
            var active = _sessions.Values.ToArray();
            foreach (var session in active) session.Abort();
            await Task.WhenAll(active.Select(session => session.Completion)).ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        await _pump.ConfigureAwait(false);
        _stop.Dispose();
    }

    private sealed class Session : IDisposable
    {
        private readonly LanRtcTunnel _owner;
        private readonly uint _peer, _channel;
        private readonly IPAddress _remote;
        private readonly CancellationTokenSource _abort;
        private readonly LanRtcChannelSignals _signals;
        private readonly object _lowGate = new();

        public Task Completion { get; private set; } = Task.CompletedTask;
        public Session(LanRtcTunnel owner, uint peer, uint channel, IPAddress remote, CancellationToken stop)
        {
            _owner = owner; _peer = peer; _channel = channel; _remote = remote;
            _abort = CancellationTokenSource.CreateLinkedTokenSource(stop);
            _signals = owner._transport.GetSignals(peer, channel) ?? LanRtcChannelSignals.AlreadyClosed;
        }
        public void Start() => Completion = Task.Run(RunAsync);
        public void Abort() { lock (_lowGate) { if (!_disposed) _abort.Cancel(); } }
        private bool _disposed;
        public void Dispose() { lock (_lowGate) { _disposed = true; _abort.Dispose(); } }
        private async Task WatchClosedAsync(CancellationToken token)
        {
            try { await _signals.Closed.WaitAsync(token).ConfigureAwait(false); Abort(); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        }

        private async Task SendAsync(bool binary, byte[] data, CancellationToken token)
        {
            while (true)
            {
                var drained = _signals.Drained;
                var result = _owner._transport.Send(_peer, _channel, binary, data);
                if (result == 0) return;
                if (result != 1) throw new IOException($"RTC send failed ({result}).");
                await drained.WaitAsync(token).ConfigureAwait(false);
            }
        }

        private async Task RunAsync()
        {
            var token = _abort.Token;
            var closed = WatchClosedAsync(token);
            try
            {
                var first = await _signals.ReadAsync(token).ConfigureAwait(false);
                if (first.Binary || first.Data is null) throw new InvalidDataException("Expected tunnel request JSON.");
                using var json = JsonDocument.Parse(first.Data);
                var request = json.RootElement;
                var kind = request.GetProperty("t").GetString();
                if (request.GetProperty("v").GetInt32() != 1 || kind is not ("fetch" or "ws"))
                    throw new InvalidDataException("Unsupported tunnel request.");
                var upgrade = kind == "ws" ? CreateUpgrade(request) : null;
                var method = request.GetProperty("m").GetString()!;
                var path = request.GetProperty("p").GetString()!;
                if (!IsToken(method) || !path.StartsWith('/') || path.Any(c => c <= ' ' || c >= 127) || path.Contains('#'))
                    throw new InvalidDataException("Invalid request target or method.");
                if (upgrade is not null && method != "GET") throw new InvalidDataException("WebSocket requires GET.");
                _webSocket = upgrade is not null;
                if (!_webSocket) _signals.ConfigureFetch();
                var overflow = !_webSocket ? WatchOverflowAsync(token) : Task.CompletedTask;
                var header = BuildRequestHeader(request, method, path, _owner._host, upgrade);
                using var stream = new LanRtcHttpStream();
                await stream.FeedRequestAsync(Encoding.ASCII.GetBytes(header), token).ConfigureAwait(false);
                var upload = upgrade is null ? FeedBodyAsync(stream, token) : Task.CompletedTask;
                var serving = ServeAsync(stream, token, drainRequest: upgrade is null);
                try
                {
                    if (upgrade is null) await SendResponseAsync(stream.Response, method, upload, token).ConfigureAwait(false);
                    else await RelayWebSocketAsync(stream, upgrade, token).ConfigureAwait(false);
                    await upload.ConfigureAwait(false);
                    await serving.ConfigureAwait(false);
                }
                finally
                {
                    _abort.Cancel();
                    stream.CompleteRequest();
                    await Task.WhenAll(upload, serving, overflow).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
            catch (Exception exception)
            { if (!_signals.Overflow.IsCompleted) try { _owner._log($"LAN RTC tunnel closed: {exception.GetType().Name}"); } catch { } }
            finally
            {
                if (_signals.Overflow.IsCompleted && !_signals.Closed.IsCompleted && !_owner._stop.IsCancellationRequested)
                {
                    try
                    {
                        using var failure = CancellationTokenSource.CreateLinkedTokenSource(_owner._stop.Token);
                        var sending = SendLimitAsync(failure.Token);
                        if (await Task.WhenAny(sending, _signals.Closed).ConfigureAwait(false) != sending) failure.Cancel();
                        await sending.ConfigureAwait(false);
                    }
                    catch (Exception) { }
                    try { _owner._log(_webSocket ? "LAN RTC WebSocket inbound limit exceeded (1009)." : "LAN RTC fetch body limit exceeded (413)."); } catch { }
                }
                _owner._transport.CloseChannel(_peer, _channel);
                _owner._sessions.TryRemove((_peer, _channel), out _);
                Abort();
                await closed.ConfigureAwait(false);
                Dispose();
            }
        }

        private bool _webSocket, _responseStarted;
        private async Task WatchOverflowAsync(CancellationToken token)
        {
            try { await _signals.Overflow.WaitAsync(token).ConfigureAwait(false); Abort(); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        }
        private async Task SendLimitAsync(CancellationToken token)
        {
            if (_webSocket)
                await SendAsync(true, [0x88, 0x03, 0xf1], token).ConfigureAwait(false);
            else if (!_responseStarted)
            {
                await SendAsync(false, JsonSerializer.SerializeToUtf8Bytes(new { s = 413, h = Array.Empty<string[]>(), sp = (string?)null }), token).ConfigureAwait(false);
                await SendAsync(true, [0x80], token).ConfigureAwait(false);
            }
        }

        private async Task FeedBodyAsync(LanRtcHttpStream stream, CancellationToken token)
        {
            try
            {
                var initial = true;
                while (true)
                {
                    var message = await _signals.ReadAsync(token).ConfigureAwait(false);
                    var data = message.Data;
                    if (!message.Binary || data is null || data.Length is < 1 or > 16385 ||
                        ((data[0] & 0x7f) != (initial ? 2 : 0) && !(initial && data.Length == 1 && data[0] == 0x80))) throw new InvalidDataException("Invalid fetch body frame.");
                    initial = false;
                    await stream.FeedRequestAsync(data[1..], token).ConfigureAwait(false);
                    if ((data[0] & 0x80) != 0) break;
                }
                stream.CompleteRequest();
            }
            catch (Exception error)
            { stream.CompleteRequest(error); Abort(); throw; }
        }

        private async Task ServeAsync(LanRtcHttpStream stream, CancellationToken token, bool drainRequest)
        {
            Exception? error = null;
            try { await _owner._serve(stream, _remote, token).ConfigureAwait(false); }
            catch (Exception exception) { error = exception; }
            finally { stream.CompleteResponse(error); }
            if (error is null && drainRequest) await stream.CopyToAsync(Stream.Null, token).ConfigureAwait(false);
        }

        private async Task RelayWebSocketAsync(LanRtcHttpStream stream, WebSocketUpgrade upgrade, CancellationToken token)
        {
            var (status, headers) = await ReadResponseHeadAsync(stream.Response, token).ConfigureAwait(false);
            if (status != 101)
            {
                stream.CompleteRequest();
                await SendFetchResponseAsync(stream.Response, "GET", Task.CompletedTask, status, headers, token).ConfigureAwait(false);
                return;
            }
            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(upgrade.Key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            var selected = Header(headers, "Sec-WebSocket-Protocol");
            if (!string.Equals(Header(headers, "Upgrade"), "websocket", StringComparison.OrdinalIgnoreCase) ||
                !ConnectionHeaders(headers).Contains("Upgrade") || Header(headers, "Sec-WebSocket-Accept") != accept ||
                (selected is not null && !upgrade.Protocols.Contains(selected, StringComparer.Ordinal)))
                throw new InvalidDataException("Invalid WebSocket upgrade.");
            var connection = ConnectionHeaders(headers);
            await SendAsync(false, JsonSerializer.SerializeToUtf8Bytes(new
                { s = 101, h = headers.Where(h => !IsHopHeader(h[0], connection)).ToArray(), sp = selected }), token).ConfigureAwait(false);
            _responseStarted = true;
            var overflow = WatchOverflowAsync(token);
            try { await LanRtcWebSocketRelay.RunAsync(stream, selected, _signals.ReadAsync, SendAsync, token).ConfigureAwait(false); }
            finally { Abort(); await overflow.ConfigureAwait(false); }
        }

        private async Task SendResponseAsync(Stream stream, string method, Task upload, CancellationToken token)
        {
            var (status, headers) = await ReadResponseHeadAsync(stream, token).ConfigureAwait(false);
            if (status == 101) throw new InvalidDataException("Unexpected fetch upgrade.");
            await SendFetchResponseAsync(stream, method, upload, status, headers, token).ConfigureAwait(false);
        }

        private static async Task<(int, List<string[]>)> ReadResponseHeadAsync(Stream stream, CancellationToken token)
        {
            var budget = new HeaderBudget();
            var statusLine = await ReadLineAsync(stream, budget, token).ConfigureAwait(false);
            var parts = statusLine.Split(' ', 3);
            if (parts.Length < 2 || !parts[0].StartsWith("HTTP/1.", StringComparison.Ordinal) ||
                !int.TryParse(parts[1], out var status) || (status != 101 && status is < 200 or > 599))
                throw new InvalidDataException("Invalid HTTP response.");
            var headers = new List<string[]>();
            while (true)
            {
                var line = await ReadLineAsync(stream, budget, token).ConfigureAwait(false);
                if (line.Length == 0) break;
                var colon = line.IndexOf(':');
                if (colon <= 0) throw new InvalidDataException("Invalid response header.");
                headers.Add([line[..colon], line[(colon + 1)..].Trim()]);
            }
            return (status, headers);
        }

        private async Task SendFetchResponseAsync(Stream stream, string method, Task upload,
            int status, List<string[]> headers, CancellationToken token)
        {
            var connection = ConnectionHeaders(headers);
            var responseHeaders = headers.Where(h => !IsHopHeader(h[0], connection) &&
                !h[0].Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)).ToArray();
            // Keep the status uncommitted until upload FIN so an oversized body can still answer 413.
            if (!_webSocket)
            {
                await _signals.RequestEnded.WaitAsync(token).ConfigureAwait(false);
                token.ThrowIfCancellationRequested();
                if (_signals.Overflow.IsCompleted) throw new OperationCanceledException(token);
            }
            await SendAsync(false, JsonSerializer.SerializeToUtf8Bytes(new { s = status, h = responseHeaders, sp = (string?)null }), token).ConfigureAwait(false);
            _responseStarted = true;
            if (!method.Equals("HEAD", StringComparison.OrdinalIgnoreCase) && status is not (204 or 304))
            {
                var encoding = Header(headers, "Transfer-Encoding");
                var length = Header(headers, "Content-Length");
                if (encoding is not null)
                {
                    if (!encoding.Equals("chunked", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Unsupported transfer encoding.");
                    while (true)
                    {
                        var line = await ReadLineAsync(stream, new HeaderBudget(), token).ConfigureAwait(false);
                        if (!long.TryParse(line.Split(';')[0], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var chunk) || chunk < 0)
                            throw new InvalidDataException("Invalid chunk length.");
                        if (chunk == 0)
                        {
                            var trailers = new HeaderBudget();
                            while ((await ReadLineAsync(stream, trailers, token).ConfigureAwait(false)).Length != 0) { }
                            break;
                        }
                        await CopyBodyAsync(stream, chunk, token).ConfigureAwait(false);
                        if ((await ReadLineAsync(stream, new HeaderBudget(), token).ConfigureAwait(false)).Length != 0)
                            throw new InvalidDataException("Invalid chunk terminator.");
                    }
                }
                else if (length is not null)
                {
                    if (!long.TryParse(length, NumberStyles.None, CultureInfo.InvariantCulture, out var size))
                        throw new InvalidDataException("Invalid response length.");
                    await CopyBodyAsync(stream, size, token).ConfigureAwait(false);
                }
                else await CopyBodyAsync(stream, null, token).ConfigureAwait(false);
            }
            await upload.ConfigureAwait(false);
            await SendAsync(true, [0x80], token).ConfigureAwait(false);
        }

        private bool _firstBody = true;
        private async Task CopyBodyAsync(Stream stream, long? remaining, CancellationToken token)
        {
            var buffer = new byte[16385];
            while (remaining is null || remaining > 0)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(1, (int)Math.Min(16384, remaining ?? 16384)), token).ConfigureAwait(false);
                if (read == 0)
                {
                    if (remaining > 0) throw new EndOfStreamException("Truncated HTTP response.");
                    break;
                }
                buffer[0] = (byte)(_firstBody ? 2 : 0); _firstBody = false;
                await SendAsync(true, buffer[..(read + 1)], token).ConfigureAwait(false);
                if (remaining is not null) remaining -= read;
            }
        }
    }

    private static string BuildRequestHeader(JsonElement request, string method, string path, string host, WebSocketUpgrade? upgrade)
    {
        var headers = new List<string[]>();
        foreach (var item in request.GetProperty("h").EnumerateArray())
        {
            if (item.GetArrayLength() != 2) throw new InvalidDataException("Invalid header pair.");
            var name = item[0].GetString()!; var value = item[1].GetString()!;
            if (!IsToken(name) || value.Any(c => c is '\r' or '\n' or '\0' || c > 127))
                throw new InvalidDataException("Invalid header.");
            headers.Add([name, value]);
        }
        var connection = ConnectionHeaders(headers);
        var result = new StringBuilder($"{method} {path} HTTP/1.1\r\n");
        foreach (var h in headers)
        {
            if (IsHopHeader(h[0], connection) || h[0].Equals("Host", StringComparison.OrdinalIgnoreCase) ||
                h[0].Equals("Origin", StringComparison.OrdinalIgnoreCase) || h[0].StartsWith("Sec-WebSocket-", StringComparison.OrdinalIgnoreCase) ||
                h[0].Equals("Content-Length", StringComparison.OrdinalIgnoreCase) || h[0].Equals("Content-Encoding", StringComparison.OrdinalIgnoreCase) ||
                h[0].Equals("Forwarded", StringComparison.OrdinalIgnoreCase) || h[0].StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase)) continue;
            result.Append(h[0]).Append(": ").Append(h[1]).Append("\r\n");
        }
        result.Append($"Host: {host}\r\nOrigin: {CouchCoopWebOrigin.Resolve()}\r\n");
        if (upgrade is null) result.Append("Connection: close\r\n");
        else
        {
            result.Append($"Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {upgrade.Key}\r\n");
            if (upgrade.Protocols.Length > 0) result.Append("Sec-WebSocket-Protocol: ").Append(string.Join(", ", upgrade.Protocols)).Append("\r\n");
        }
        result.Append("\r\n");
        if (Encoding.ASCII.GetByteCount(result.ToString()) > CouchCoopHttpRequest.MaxHeaderBytes)
            throw new InvalidDataException("Tunnel headers too large.");
        return result.ToString();
    }

    private sealed record WebSocketUpgrade(string Key, string[] Protocols);
    private static WebSocketUpgrade CreateUpgrade(JsonElement request)
    {
        var protocols = request.GetProperty("sp").EnumerateArray().Select(p => p.GetString()!).ToArray();
        if (protocols.Any(p => !IsToken(p)) || protocols.Distinct(StringComparer.Ordinal).Count() != protocols.Length)
            throw new InvalidDataException("Invalid WebSocket protocols.");
        return new(Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)), protocols);
    }

    private static bool IsToken(string value) => !string.IsNullOrEmpty(value) && value.All(c =>
        char.IsAsciiLetterOrDigit(c) || "!#$%&'*+-.^_`|~".Contains(c));
    private static string? Header(List<string[]> headers, string name)
        => headers.FirstOrDefault(h => h[0].Equals(name, StringComparison.OrdinalIgnoreCase))?[1];
    private static HashSet<string> ConnectionHeaders(List<string[]> headers) => headers
        .Where(h => h[0].Equals("Connection", StringComparison.OrdinalIgnoreCase))
        .SelectMany(h => h[1].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        .ToHashSet(StringComparer.OrdinalIgnoreCase);
    private static bool IsHopHeader(string name, HashSet<string> connection) => connection.Contains(name) ||
        new[] { "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "TE", "Trailer", "Transfer-Encoding", "Upgrade" }
            .Contains(name, StringComparer.OrdinalIgnoreCase);
    private sealed class HeaderBudget { public int Remaining = CouchCoopHttpRequest.MaxHeaderBytes; }
    private static async Task<string> ReadLineAsync(Stream stream, HeaderBudget budget, CancellationToken token)
    {
        using var bytes = new MemoryStream();
        var one = new byte[1];
        while (true)
        {
            if (--budget.Remaining < 0) throw new InvalidDataException("HTTP headers too large.");
            if (await stream.ReadAsync(one, token).ConfigureAwait(false) == 0) throw new EndOfStreamException();
            if (one[0] == '\n')
            {
                var line = bytes.ToArray();
                if (line.Length == 0 || line[^1] != '\r') throw new InvalidDataException("Invalid HTTP line ending.");
                return Encoding.ASCII.GetString(line, 0, line.Length - 1);
            }
            bytes.WriteByte(one[0]);
        }
    }
}
