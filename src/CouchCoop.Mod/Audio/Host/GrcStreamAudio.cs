using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Threading.Channels;
using CouchCoop.Mod.Runtime;

namespace CouchCoop.Mod.Audio.Host;

/// <summary>Shares one ordered host link per seat, only while viewers explicitly request stream audio.</summary>
public static class GrcStreamAudio
{
    private static readonly SemaphoreSlim Gate = new(1);
    private static readonly ConcurrentDictionary<uint, Link> Links = new();
    private static readonly Dictionary<string, Link> Routes = new(StringComparer.Ordinal);
    private static IGrcFmodModule? _module;
    private static GrcAudioObserve? _observer;
    private static IDisposable? _observation;
    private static uint _next;

    public static bool Requested => Seat.GrcAudioCue.Requested(Environment.GetEnvironmentVariable(Seat.GrcAudioCue.EnvironmentVariable),
        Environment.GetEnvironmentVariable("COUCHCOOP_AUDIO"));

    public static async Task<Subscription> SubscribeAsync(string route,
        Func<CancellationToken, Task<WebSocket>> connect, CancellationToken token)
    {
        await Gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            if (Routes.TryGetValue(route, out var existing) && !existing.Completion.IsCompleted)
            {
                existing.Users++;
                return new(existing);
            }
            ZeroClientGuard.ClientOpened();
            WebSocket? socket = null;
            try
            {
                // A non-streaming seat refuses the private route before the optional module is loaded.
                socket = await connect(token).ConfigureAwait(false);
                _module ??= GrcFmodModule.Load(Output);
                if (_observation is null)
                {
                    _observer ??= new(_module);
                    _observation = HostAudioHooks.SubscribeGrc(_observer.Reset, _observer.Apply);
                }
                var link = new Link(++_next, route, socket, _module);
                Links[link.Id] = link;
                Routes[route] = link;
                _module.SeatOpen(link.Id);
                link.Run();
                try { await link.Ready.Task.WaitAsync(token).ConfigureAwait(false); }
                catch
                {
                    link.Stop.Cancel();
                    await link.Completion.ConfigureAwait(false);
                    Links.TryRemove(link.Id, out _);
                    Routes.Remove(route);
                    link.Module.SeatClose(link.Id);
                    link.Socket.Dispose();
                    link.Stop.Dispose();
                    throw;
                }
                return new(link);
            }
            catch
            {
                socket?.Dispose();
                ZeroClientGuard.ClientClosed();
                if (Links.IsEmpty) { _observation?.Dispose(); _observation = null; }
                throw;
            }
        }
        finally { Gate.Release(); }
    }

    internal static void Output(uint seat, byte[] bytes)
    {
        if (Links.TryGetValue(seat, out var link)) link.Send(bytes);
    }

    public sealed class Subscription : IAsyncDisposable
    {
        private Link? _link;
        internal Subscription(Link link) => _link = link;
        public Task Completion => _link?.Completion ?? Task.CompletedTask;
        public async ValueTask DisposeAsync()
        {
            await Gate.WaitAsync().ConfigureAwait(false);
            try
            {
                var link = Interlocked.Exchange(ref _link, null);
                if (link is null || --link.Users != 0) return;
                link.Stop.Cancel();
                await link.Completion.ConfigureAwait(false);
                Links.TryRemove(link.Id, out _);
                if (Routes.GetValueOrDefault(link.Route) == link) Routes.Remove(link.Route);
                link.Module.SeatClose(link.Id);
                link.Socket.Dispose();
                link.Stop.Dispose();
                ZeroClientGuard.ClientClosed();
                if (Links.IsEmpty) { _observation?.Dispose(); _observation = null; }
            }
            finally { Gate.Release(); }
        }
    }

    internal sealed class Link(uint id, string route, WebSocket socket, IGrcFmodModule module)
    {
        internal readonly uint Id = id;
        internal readonly string Route = route;
        internal readonly WebSocket Socket = socket;
        internal readonly IGrcFmodModule Module = module;
        internal readonly CancellationTokenSource Stop = new();
        internal int Users = 1;
        internal Task Completion = Task.CompletedTask;
        internal readonly TaskCompletionSource Ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Channel<byte[]> _output = AudioLinkTransport.CreateQueue();
        internal void Send(byte[] bytes) { if (!_output.Writer.TryWrite(bytes)) Stop.Cancel(); }
        internal void Run() => Completion = RunAsync();
        private async Task RunAsync()
        {
            try { await AudioLinkTransport.RunAsync(Socket, _output,
                message => Module.LinkIn(Id, message), Stop, onReady: () => Ready.TrySetResult()).ConfigureAwait(false); }
            finally { Ready.TrySetException(new IOException("Audio link closed before ready")); }
        }
    }

    internal static void SetModuleForTest(IGrcFmodModule? module) { _module = module; _observer = null; }
}

/// <summary>Copies one whole bounded link message per binary WebSocket message. Queue pressure closes the link.</summary>
public static class AudioLinkTransport
{
    public static Channel<byte[]> CreateQueue() => Channel.CreateBounded<byte[]>(new BoundedChannelOptions(256)
        { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });

    public static async Task RunAsync(WebSocket socket, Channel<byte[]> output, Action<byte[]> input,
        CancellationTokenSource stop, bool acknowledge = false, Action? onReady = null)
    {
        var acknowledged = false;
        var sending = SendAsync();
        try
        {
            var buffer = new byte[1024 * 1024];
            while (!stop.IsCancellationRequested)
            {
                var length = 0;
                ValueWebSocketReceiveResult received;
                do
                {
                    received = await socket.ReceiveAsync(buffer.AsMemory(length), stop.Token).ConfigureAwait(false);
                    if (received.MessageType == WebSocketMessageType.Close) return;
                    if (received.MessageType == WebSocketMessageType.Text && length == 0 && received.EndOfMessage
                        && onReady is not null && buffer.AsSpan(0, received.Count).SequenceEqual("{\"kind\":\"ready\"}"u8))
                    {
                        onReady();
                        break;
                    }
                    if (received.MessageType != WebSocketMessageType.Binary || received.Count == 0
                        || (length += received.Count) >= buffer.Length) throw new IOException("Invalid audio link frame");
                } while (!received.EndOfMessage);
                if (length == 0) continue;
                input(buffer.AsSpan(0, length).ToArray());
                if (acknowledge && !acknowledged)
                {
                    acknowledged = true;
                    if (!output.Writer.TryWrite([])) stop.Cancel();
                }
            }
        }
        catch (Exception error) when (error is OperationCanceledException or IOException or WebSocketException or ObjectDisposedException) { }
        finally
        {
            stop.Cancel();
            socket.Abort();
            try { await sending.ConfigureAwait(false); }
            catch (Exception error) when (error is OperationCanceledException or IOException or WebSocketException or ObjectDisposedException) { }
        }

        async Task SendAsync()
        {
            try
            {
                await foreach (var bytes in output.Reader.ReadAllAsync(stop.Token).ConfigureAwait(false))
                    await socket.SendAsync(bytes.Length == 0 ? "{\"kind\":\"ready\"}"u8.ToArray().AsMemory() : bytes.AsMemory(),
                        bytes.Length == 0 ? WebSocketMessageType.Text : WebSocketMessageType.Binary, true, stop.Token).ConfigureAwait(false);
            }
            catch { stop.Cancel(); throw; }
        }
    }
}
