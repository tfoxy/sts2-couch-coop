using System.Net;
using System.Net.Sockets;

namespace CouchCoop.Mod.Contracts;

/// <summary>Stable process-wide admission shared by the listener and every hot-reload generation.</summary>
public sealed class NetworkAdmissionLimiter
{
    public const int MaxHttpConnections = 128;
    public const int MaxHttpConnectionsPerAddress = 64;
    public const int MinimumWebSocketConnections = 32;
    private readonly object _gate = new();
    private readonly Dictionary<IPAddress, int> _httpByAddress = new();
    private readonly Dictionary<TcpClient, Lease> _attachedHttp = new(ReferenceEqualityComparer.Instance);
    private readonly Func<int?> _supportedPlayers;
    private int _http;
    private int _webSockets;

    /// <summary>
    /// <paramref name="supportedPlayers"/> reports how many players the live game will admit, or null when that
    /// is not knowable right now (no lobby, no game state). Unknown falls back to
    /// <see cref="MinimumWebSocketConnections"/> alone — 32, which at four sockets a player already covers eight
    /// of them. That is the honest answer for a flood guard, which is all this is: it deliberately does not
    /// invent a player count, because a fabricated one is the only way this class could refuse a legitimate
    /// viewer.
    /// </summary>
    public NetworkAdmissionLimiter(Func<int?>? supportedPlayers = null)
        => _supportedPlayers = supportedPlayers ?? (() => null);

    public Lease? TryAcquireHttp(IPAddress? address)
    {
        address ??= IPAddress.None;
        lock (_gate)
        {
            var addressCount = _httpByAddress.GetValueOrDefault(address);
            if (_http >= MaxHttpConnections || addressCount >= MaxHttpConnectionsPerAddress) return null;
            _http++;
            _httpByAddress[address] = addressCount + 1;
            return new Lease(() => ReleaseHttp(address));
        }
    }

    public Lease? TryAcquireWebSocket()
    {
        var limit = _supportedPlayers() is { } players
            ? Math.Max(MinimumWebSocketConnections, 4L * Math.Max(1, players))
            : MinimumWebSocketConnections;
        lock (_gate)
        {
            if (_webSockets >= limit) return null;
            _webSockets++;
            return new Lease(() => { lock (_gate) _webSockets--; });
        }
    }

    public void AttachHttp(TcpClient client, Lease lease)
    {
        lock (_gate)
        {
            if (!_attachedHttp.TryAdd(client, lease)) throw new InvalidOperationException("Client already has an admission lease.");
        }
    }

    public Lease? TakeAttachedHttp(TcpClient client)
    {
        lock (_gate)
        {
            return _attachedHttp.Remove(client, out var lease) ? lease : null;
        }
    }

    private void ReleaseHttp(IPAddress address)
    {
        lock (_gate)
        {
            _http--;
            var count = _httpByAddress[address] - 1;
            if (count == 0) _httpByAddress.Remove(address);
            else _httpByAddress[address] = count;
        }
    }

    public sealed class Lease(Action release) : IDisposable
    {
        private Action? _release = release;
        public void Dispose() => Interlocked.Exchange(ref _release, null)?.Invoke();
    }
}
