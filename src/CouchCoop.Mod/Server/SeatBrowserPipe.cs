using System.Buffers.Binary;
using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Server;

/// <summary>A private, full-duplex browser stream for a headless seat. No TCP port is bound.</summary>
internal sealed class SeatBrowserPipe : IAsyncDisposable
{
    internal const string NameEnvironmentVariable = "COUCHCOOP_SEAT_BROWSER_PIPE";
    internal const string TokenEnvironmentVariable = "COUCHCOOP_SEAT_BROWSER_PIPE_TOKEN";
    private const int MaxPreludeBytes = 1024;
    private const int MaxUpgradeStatusBytes = 1024;
    private static readonly TimeSpan UpgradeResponseTimeout = TimeSpan.FromSeconds(30);
    private readonly string _name;
    private readonly string _token;
    private readonly Func<Stream, bool, IPAddress, CancellationToken, Task> _serve;
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentDictionary<long, Task> _sessions = new();
    private Task? _acceptLoop;
    private long _nextSession;

    private SeatBrowserPipe(string name, string token,
        Func<Stream, bool, IPAddress, CancellationToken, Task> serve)
    {
        _name = name;
        _token = token;
        _serve = serve;
    }

    internal static SeatBrowserPipe? StartFromEnvironment(
        Func<Stream, bool, IPAddress, CancellationToken, Task> serve)
    {
        var name = Environment.GetEnvironmentVariable(NameEnvironmentVariable);
        var token = Environment.GetEnvironmentVariable(TokenEnvironmentVariable);
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(token)) return null;
        if (name.Length > 120 || !name.All(char.IsAsciiLetterOrDigit)
            || token.Length != 64 || !token.All(Uri.IsHexDigit))
            throw new InvalidOperationException("The seat browser pipe configuration is invalid.");
        return Start(name, token, serve);
    }

    internal static SeatBrowserPipe Start(string name, string token,
        Func<Stream, bool, IPAddress, CancellationToken, Task> serve)
    {
        // Construct the first listener before announcing readiness to the host. A faulted accept task
        // must never make a seat look ready while no pipe exists.
        var listener = CreateListener(name);
        var pipe = new SeatBrowserPipe(name, token, serve);
        pipe._acceptLoop = pipe.AcceptLoopAsync(listener);
        try
        {
            // A successful local connect proves the accept loop has bound the platform pipe before the
            // seat reports RelayReady. The probe closes without a prelude and never reaches the game server.
            using var readinessProbe = new NamedPipeClientStream(".", name, PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            readinessProbe.Connect(500);
        }
        catch
        {
            pipe.DisposeAsync().AsTask().GetAwaiter().GetResult();
            throw;
        }
        return pipe;
    }

    private static NamedPipeServerStream CreateListener(string name)
        => new(name, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

    private async Task AcceptLoopAsync(NamedPipeServerStream listener)
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                await listener.WaitForConnectionAsync(_stop.Token).ConfigureAwait(false);
                var connected = listener;
                listener = CreateListener(_name);
                var id = Interlocked.Increment(ref _nextSession);
                var session = ServeOneAsync(connected);
                _sessions[id] = session;
                _ = session.ContinueWith(completed => _sessions.TryRemove(id, out _),
                    CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        catch (Exception error)
        {
            HeadlessConnectionReporter.PublishRelayStopped();
            CouchCoopLog.Stderr($"seat browser pipe stopped: {error.GetType().Name}: {error.Message}");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try
            {
                await HeadlessConnectionReporter.ReportTerminalFailureAsync("seat-browser-relay-failed",
                    $"The private browser pipe stopped: {error.GetType().Name}.", deadline.Token).ConfigureAwait(false);
            }
            catch { }
            throw;
        }
        finally { listener.Dispose(); }
    }

    private async Task ServeOneAsync(NamedPipeServerStream pipe)
    {
        await using (pipe.ConfigureAwait(false))
        {
            try
            {
                var sizeBytes = new byte[4];
                using var authDeadline = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
                authDeadline.CancelAfter(TimeSpan.FromSeconds(3));
                await pipe.ReadExactlyAsync(sizeBytes, authDeadline.Token).ConfigureAwait(false);
                var size = BinaryPrimitives.ReadInt32BigEndian(sizeBytes);
                if (size is < 1 or > MaxPreludeBytes) return;
                var bytes = new byte[size];
                await pipe.ReadExactlyAsync(bytes, authDeadline.Token).ConfigureAwait(false);
                var prelude = JsonSerializer.Deserialize<Prelude>(bytes);
                if (prelude is null || prelude.Token?.Length != _token.Length
                    || !CryptographicOperations.FixedTimeEquals(
                        Encoding.ASCII.GetBytes(prelude.Token), Encoding.ASCII.GetBytes(_token))
                    || !IPAddress.TryParse(prelude.RemoteAddress, out var remoteAddress)) return;
                await _serve(pipe, prelude.IsSecure, remoteAddress, _stop.Token).ConfigureAwait(false);
            }
            catch (Exception error) when (error is IOException or EndOfStreamException or OperationCanceledException
                or JsonException or ObjectDisposedException)
            {
                // The browser or host went away. The owned pipe closes this one connection only.
            }
            catch (Exception error)
            {
                CouchCoopLog.Stderr($"seat browser pipe connection failed: {error.GetType().Name}: {error.Message}");
            }
        }
    }

    internal static async Task RelayAsync(string name, string token, Stream browser,
        ReadOnlyMemory<byte> requestHeader, IPAddress remoteAddress, bool isSecure,
        CancellationToken cancellationToken)
    {
        using var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(2000, cancellationToken).ConfigureAwait(false);
        var prelude = JsonSerializer.SerializeToUtf8Bytes(new Prelude(token, remoteAddress.ToString(), isSecure));
        if (prelude.Length > MaxPreludeBytes) throw new InvalidOperationException("Seat relay prelude is too large.");
        var sizeBytes = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(sizeBytes, prelude.Length);
        await pipe.WriteAsync(sizeBytes, cancellationToken).ConfigureAwait(false);
        await pipe.WriteAsync(prelude, cancellationToken).ConfigureAwait(false);
        await pipe.WriteAsync(requestHeader, cancellationToken).ConfigureAwait(false);
        // Observe the viewer immediately. A tab can close while the game's first upgrade is still loading;
        // its EOF must not turn a response deadline into a failure of the entire seat process.
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var upstream = PumpViewerAsync(browser, pipe, stop.Token);
        var response = ReadUpgradeResponsePrefixAsync(pipe, stop.Token);
        try
        {
            if (await Task.WhenAny(upstream, response).ConfigureAwait(false) == upstream)
            {
                await upstream.ConfigureAwait(false);
                return;
            }
            var prefix = await response.ConfigureAwait(false);
            try { await browser.WriteAsync(prefix, cancellationToken).ConfigureAwait(false); }
            catch (Exception error) when (error is IOException or ObjectDisposedException)
            {
                // The viewer closed during the upgrade; the seat's pipe answered correctly.
                return;
            }
            var downstream = pipe.CopyToAsync(browser, stop.Token);
            await Task.WhenAny(upstream, downstream).ConfigureAwait(false);
            stop.Cancel();
            try { await Task.WhenAll(upstream, downstream).ConfigureAwait(false); }
            catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException
                or TimeoutException) { }
        }
        finally
        {
            stop.Cancel();
            try { await upstream.ConfigureAwait(false); }
            catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException) { }
            try { await response.ConfigureAwait(false); }
            catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException
                or TimeoutException) { }
        }
    }

    private static async Task PumpViewerAsync(Stream browser, Stream pipe, CancellationToken cancellationToken)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        try
        {
            while (true)
            {
                int read;
                try { read = await browser.ReadAsync(buffer, cancellationToken).ConfigureAwait(false); }
                catch (Exception error) when (error is IOException or ObjectDisposedException) { return; }
                if (read == 0) return;
                await pipe.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
            }
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    private static async Task<byte[]> ReadUpgradeResponsePrefixAsync(Stream pipe, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(UpgradeResponseTimeout);
        var prefix = new byte[MaxUpgradeStatusBytes];
        var count = 0;
        try
        {
            while (count < prefix.Length)
            {
                var read = await pipe.ReadAsync(prefix.AsMemory(count), deadline.Token).ConfigureAwait(false);
                if (read == 0) throw new IOException("The seat relay closed before the WebSocket upgrade response.");
                count += read;
                for (var index = 1; index < count; index++)
                {
                    if (prefix[index - 1] != '\r' || prefix[index] != '\n') continue;
                    var status = Encoding.ASCII.GetString(prefix, 0, index - 1);
                    if (!status.StartsWith("HTTP/1.1 101 ", StringComparison.Ordinal)
                        && status != "HTTP/1.1 101")
                        throw new SeatRelayUpgradeRejectedException(status);
                    return prefix[..count];
                }
            }
            throw new SeatRelayUpgradeRejectedException("The seat sent an oversized upgrade status line.");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new SeatRelayResponseTimeoutException();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        if (_acceptLoop is not null)
        {
            try { await _acceptLoop.ConfigureAwait(false); }
            catch (Exception) { /* A fatal accept-loop fault was reported to the host when it happened. */ }
        }
        await Task.WhenAll(_sessions.Values).ConfigureAwait(false);
        _stop.Dispose();
    }

    private sealed record Prelude(string Token, string RemoteAddress, bool IsSecure);
}

internal sealed class SeatRelayResponseTimeoutException()
    : TimeoutException("The seat did not answer the WebSocket upgrade within 30 seconds.");

internal sealed class SeatRelayUpgradeRejectedException(string status)
    : IOException($"The seat refused the WebSocket upgrade: {status}");
