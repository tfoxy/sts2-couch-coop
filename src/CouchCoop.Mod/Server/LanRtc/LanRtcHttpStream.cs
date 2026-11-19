using System.Threading.Channels;

namespace CouchCoop.Mod.Server.LanRtc;

// Each direction has one chunk of credit, so either consumer can pause its producer.
// The private request stream ends at the tunnel FIN rather than trusting a browser length.
internal sealed class LanRtcHttpStream : Stream, ILanRtcRequestStream
{
    private readonly ResponseStream _request = new();
    private readonly ResponseStream _response = new();
    public LanRtcHttpStream() { }
    internal LanRtcHttpStream(byte[] request)
    { _request.WriteChunkAsync(request, CancellationToken.None).GetAwaiter().GetResult(); _request.Complete(); }
    public Stream Response => _response;
    public ValueTask FeedRequestAsync(byte[] bytes, CancellationToken token) => _request.WriteChunkAsync(bytes, token);
    public void CompleteRequest(Exception? error = null) => _request.Complete(error);
    public void CompleteResponse(Exception? error = null) => _response.Complete(error);
    public override bool CanRead => true;
    public override bool CanWrite => true;
    public override bool CanSeek => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => _request.Read(buffer, offset, count);
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        => _request.ReadAsync(buffer, cancellationToken);
    public override void Write(byte[] buffer, int offset, int count)
        => WriteAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
    {
        while (!buffer.IsEmpty)
        {
            var length = Math.Min(buffer.Length, 16384);
            await _response.WriteChunkAsync(buffer[..length].ToArray(), cancellationToken).ConfigureAwait(false);
            buffer = buffer[length..];
        }
    }
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
    public override void Flush() { }
    public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    protected override void Dispose(bool disposing)
    { if (disposing) { _request.Complete(); _response.Complete(); } base.Dispose(disposing); }

    public Stream CreateClientStream() => new ClientStream(this);
    private sealed class ClientStream(LanRtcHttpStream owner) : Stream
    {
        public override bool CanRead => true;
        public override bool CanWrite => true;
        public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => owner.Response.ReadAsync(buffer, cancellationToken);
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override int Read(byte[] buffer, int offset, int count)
            => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            while (!buffer.IsEmpty)
            {
                var length = Math.Min(buffer.Length, 16384);
                await owner.FeedRequestAsync(buffer[..length].ToArray(), cancellationToken).ConfigureAwait(false);
                buffer = buffer[length..];
            }
        }
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override void Write(byte[] buffer, int offset, int count)
            => WriteAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        { if (disposing) owner.CompleteRequest(); base.Dispose(disposing); }
    }

    private sealed class ResponseStream : Stream
    {
        private readonly Channel<byte[]> _chunks = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(1)
        { SingleReader = true, SingleWriter = true, AllowSynchronousContinuations = false });
        private ReadOnlyMemory<byte> _current;
        public ValueTask WriteChunkAsync(byte[] chunk, CancellationToken token)
            => chunk.Length == 0 ? ValueTask.CompletedTask : _chunks.Writer.WriteAsync(chunk, token);
        public void Complete(Exception? error = null) => _chunks.Writer.TryComplete(error);
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (buffer.IsEmpty) return 0;
            while (_current.IsEmpty)
            {
                if (!await _chunks.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false)) return 0;
                if (_chunks.Reader.TryRead(out var chunk)) _current = chunk;
            }
            var length = Math.Min(buffer.Length, _current.Length);
            _current[..length].CopyTo(buffer);
            _current = _current[length..];
            return length;
        }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override int Read(byte[] buffer, int offset, int count)
            => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override bool CanRead => true;
        public override bool CanWrite => false;
        public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
