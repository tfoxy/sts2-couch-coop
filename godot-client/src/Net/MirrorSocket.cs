// The real mirror WebSocket transport for the M1b native client. A plain (non-Node) wrapper around Godot's
// WebSocketPeer that is DRIVEN by an owner's `_Process` calling Poll(delta). It ports the dispatch + dual-bucket
// latency behaviour of frontend/src/mirror/mirrorClient.ts, using the configured WebSocketPeer limits
// (InboundBufferSize=16MiB, MaxQueuedPackets=8192, set BEFORE ConnectToUrl; close detection incl. the >5s
// never-opened case). It never blocks: sends are fire-and-forget; scene-delta bytes are handed off (raw) to a
// background parse worker owned elsewhere (see SceneDeltaParsePipeline / MirrorStore).

using System;
using System.Collections.Generic;
using System.Text.Json;
using CouchCoop.MirrorProtocol.Envelopes;
using Godot;

namespace CouchCoop.GodotClient.Net;

public enum MirrorStatus
{
    Connecting,
    Connected,
    Disconnected,
}

// A rolling RTT snapshot for one probe variant (mirrors the flat / game* fields of MirrorLatency).
public readonly record struct LatencySnapshot(double? LastMs, double? P50, double? P95, int Count);

public sealed class MirrorSocket
{
    // Ported constants from mirrorClient.ts.
    private const int LatencyWindow = 50;
    private const double PingTimeoutMs = 2000;

    // WebSocketPeer sizing for multi-MB keyframes.
    private const int InboundBufferBytes = 16 * 1024 * 1024;
    private const int MaxQueuedPackets = 8192;

    // ---- callbacks (set by the owner/coordinator before Connect) ----
    public Action? OnOpen;
    public Action<SessionEnvelope>? OnSession;
    public Action<byte[]>? OnSceneDeltaBytes;
    public Action<string>? OnServerReload;
    public Action<int, string>? OnClosed;

    // ---- connection ----
    private WebSocketPeer? _ws;
    private string _hostPort = "";
    private bool _wasOpen;
    private bool _closedReported;
    private double _elapsedSec;

    public MirrorStatus Status { get; private set; } = MirrorStatus.Connecting;

    // ---- WS-B stream gate ----
    // Whether this socket currently wants the host's scene stream. FALSE means the host sends nothing at all (see
    // the server's watch gate), and this socket additionally refuses to hand any late/in-flight scene-delta packet
    // to the parse worker — so a viewer sitting on the join picker neither receives nor decodes the host's game.
    // Sockets are created gated (the connect URL carries `watch=0`) unless the owner already knows it may watch;
    // the coordinator flips it as the join mode changes.
    private bool _watch = true;
    // What the HOST currently believes, so a flip is sent exactly once. Seeded from the connect query at Open()
    // and re-seeded on every reopen (reconnect/redirect), which is what makes the gate survive a reconnect.
    private bool _hostWatch = true;

    public bool Watch => _watch;

    // Set the desired gate. Before the socket is open this only chooses the connect query (`?watch=0`); once open
    // it sends `{"type":"watch","on":…}`, which the host answers with a fresh FULL keyframe when turning ON.
    // Idempotent, and safely callable at any point in the lifecycle (a pre-open change is flushed on open).
    public void SetWatch(bool on)
    {
        _watch = on;
        FlushWatch();
    }

    private void FlushWatch()
    {
        if (_ws == null || _ws.GetReadyState() != WebSocketPeer.State.Open || _hostWatch == _watch)
        {
            return;
        }

        _hostWatch = _watch;
        SendText(ProtocolJson.SerializeToUtf8Bytes(new WatchMessage(_watch)));
    }

    // ---- send sequences (join:N / input:N / settings:N, like the TS client) ----
    private int _joinSeq;
    private int _inputSeq;
    private int _settingsSeq;

    // ---- dual-bucket latency ----
    private sealed class LatencyBucket
    {
        public readonly List<double> Samples = new();
        public bool Outstanding;
        public double Deadline;
        public double LastMs;
        public bool HasLast;
        public double? P50;
        public double? P95;
    }

    private readonly LatencyBucket _networkBucket = new();
    private readonly LatencyBucket _gameBucket = new();

    // WS-B: reused percentile scratch for RecordRtt (samples copied in, sorted in place — no per-pong List+Sort
    // alloc). Only ever touched from the main-thread Poll path, so one shared buffer is safe.
    private readonly double[] _rttScratch = new double[LatencyWindow];
    private double _pingIntervalMs;
    private double _sincePingMs;

    public LatencySnapshot Network => Snapshot(_networkBucket);
    public LatencySnapshot Game => Snapshot(_gameBucket);

    // ==============================================================================================
    // connection lifecycle
    // ==============================================================================================

    // Connect to an explicit host[:port]. Builds the canonical v1 websocket query. The host is remembered so a
    // headless redirect (WithPort) or reconnect can rebuild the URL keeping the same host.
    public void Connect(string hostPort)
    {
        _hostPort = NormalizeHostPort(hostPort);
        Open();
    }

    // Reconnect / redirect using the already-stored host:port (used after WithPort).
    public void Connect()
    {
        Open();
    }

    // Produce a NEW (un-connected) socket for the headless redirect: same host, the port the host handed back.
    // The caller wires callbacks then calls Connect(). We deliberately do NOT touch this socket (the old host
    // connection) — closing it would trigger the server's Release() and kill the headless instance before the
    // redirect connects; old sockets close only on app shutdown.
    public MirrorSocket WithPort(int port)
    {
        var host = HostOnly(_hostPort);
        // The redirect target is this viewer's OWN headless game — always watched, so it connects ungated and
        // receives its connect keyframe immediately (no extra round trip before the first frame).
        return new MirrorSocket { _hostPort = $"{host}:{port}", _watch = true };
    }

    private void Open()
    {
        _ws = new WebSocketPeer
        {
            InboundBufferSize = InboundBufferBytes,
            MaxQueuedPackets = MaxQueuedPackets,
        };
        _wasOpen = false;
        _closedReported = false;
        _elapsedSec = 0;
        Status = MirrorStatus.Connecting;

        // The current socket contract names every capability selector, including false, on the initial URL.
        _hostWatch = _watch;
        var url = $"ws://{_hostPort}/ws?watch={(_watch ? "1" : "0")}&staticBg=0&cardFlight=1&handTween=1&trailDrive=0";
        Error err = _ws.ConnectToUrl(url);
        if (err != Error.Ok)
        {
            GD.PrintErr($"MirrorSocket: ConnectToUrl failed for {url}: {err}");
            Status = MirrorStatus.Disconnected;
        }
    }

    public void Close()
    {
        _ws?.Close();
    }

    // ==============================================================================================
    // per-frame pump (called from the owner's _Process)
    // ==============================================================================================

    public void Poll(double deltaSeconds)
    {
        if (_ws == null)
        {
            return;
        }

        _ws.Poll();
        _elapsedSec += deltaSeconds;
        WebSocketPeer.State state = _ws.GetReadyState();

        if (state == WebSocketPeer.State.Open)
        {
            if (!_wasOpen)
            {
                _wasOpen = true;
                Status = MirrorStatus.Connected;
                // Re-arm the probe cadence so both variants fire promptly on connect (matches startPing()).
                _sincePingMs = _pingIntervalMs;
                _networkBucket.Outstanding = false;
                _gameBucket.Outstanding = false;
                // Flush a gate change made between Connect() and the socket actually opening (e.g. the host
                // stream became watchable while we were still connecting).
                FlushWatch();
                OnOpen?.Invoke();
            }

            int avail = _ws.GetAvailablePacketCount();
            for (int i = 0; i < avail; i++)
            {
                Dispatch(_ws.GetPacket());
            }

            PumpPing(deltaSeconds);
        }
        else if (state == WebSocketPeer.State.Closed && !_closedReported && (_wasOpen || _elapsedSec > 5.0))
        {
            _closedReported = true;
            Status = MirrorStatus.Disconnected;
            int code = _ws.GetCloseCode();
            string reason = _ws.GetCloseReason();
            OnClosed?.Invoke(code, reason);
        }
    }

    // ==============================================================================================
    // dispatch (order ported from mirrorClient.ts: pong -> server-reload -> session -> scene-delta)
    // ==============================================================================================

    private void Dispatch(byte[] packet)
    {
        string? type = PeekType(packet);
        switch (type)
        {
            case "pong":
                HandlePong(packet);
                break;
            case "server-reload":
                HandleServerReload(packet);
                break;
            case "session":
                {
                    var session = SessionEnvelope.Parse(packet);
                    if (session != null)
                    {
                        OnSession?.Invoke(session);
                    }
                    break;
                }
            case "scene-delta":
                // Hand the RAW bytes off to the background parse worker (never parsed on the main thread here).
                // While gated the host sends none of these; dropping any in-flight straggler here means a gated
                // viewer never decodes, applies or ACKS a frame (the ack rides the store's apply).
                if (_watch)
                {
                    OnSceneDeltaBytes?.Invoke(packet);
                }

                break;
            default:
                // state / combat-event / error / unparseable — ignored, like the TS client.
                break;
        }
    }

    private void HandlePong(byte[] packet)
    {
        try
        {
            // WS-B: parse the packet's own buffer (no ToArray copy) — the doc is disposed before returning.
            using var doc = JsonDocument.Parse((ReadOnlyMemory<byte>)packet);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("t0", out var t0el) ||
                t0el.ValueKind != JsonValueKind.Number)
            {
                return;
            }

            double t0 = t0el.GetDouble();
            bool mainThread = root.TryGetProperty("mainThread", out var mt) && mt.ValueKind == JsonValueKind.True;
            double rtt = NowMs() - t0;
            RecordRtt(mainThread ? _gameBucket : _networkBucket, rtt);
        }
        catch (JsonException)
        {
            // malformed pong — ignore
        }
    }

    private void HandleServerReload(byte[] packet)
    {
        string reason = "server-reload";
        try
        {
            // WS-B: same no-copy parse as HandlePong (Dispatch hands both the packet byte[] it already owns).
            using var doc = JsonDocument.Parse((ReadOnlyMemory<byte>)packet);
            if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                doc.RootElement.TryGetProperty("reason", out var r) &&
                r.ValueKind == JsonValueKind.String)
            {
                reason = r.GetString() ?? reason;
            }
        }
        catch (JsonException)
        {
            // keep the default reason
        }

        Status = MirrorStatus.Disconnected;
        OnServerReload?.Invoke(reason);
    }

    // ==============================================================================================
    // sends (all via ProtocolJson.SerializeToUtf8Bytes, delivered as WebSocket TEXT frames)
    // ==============================================================================================

    // `playerId` is the SEAT the viewer picked ("p:1003"), sent only when the join came from a roster BUTTON. It
    // makes the join seat-accurate: the host resolves the netId from it directly instead of matching the label,
    // which matters because a saved seat's label can be a synthesized "Player 1003". A free-text name submit passes
    // null and keeps the host's name-resolution path.
    public void SendJoin(string name, string? playerId = null)
    {
        _joinSeq++;
        SendText(ProtocolJson.SerializeToUtf8Bytes(new JoinMessage($"join:{_joinSeq}", name.Trim(), playerId)));
    }

    public void SendSceneAck()
    {
        if (!_watch)
        {
            return; // gated: nothing was rendered, so there is no frame to credit
        }

        SendText(ProtocolJson.SerializeToUtf8Bytes(new SceneAckMessage()));
    }

    public void SendInput(InputMessage message)
    {
        _inputSeq++;
        SendText(ProtocolJson.SerializeToUtf8Bytes(message with { RequestId = $"input:{_inputSeq}" }));
    }

    public void SendSettings(SettingsMessage message)
    {
        _settingsSeq++;
        SendText(ProtocolJson.SerializeToUtf8Bytes(message with { RequestId = $"settings:{_settingsSeq}" }));
    }

    // Send one probe of a variant (network = plain ping; game = mainThread:true). Guarded by the bucket's own
    // single-outstanding flag with deadline expiry so a slow pong never inflates the number nor blocks recovery.
    public void SendPing(bool mainThread)
    {
        SendProbe(mainThread ? _gameBucket : _networkBucket, mainThread);
    }

    private void SendProbe(LatencyBucket bucket, bool mainThread)
    {
        if (_ws == null || _ws.GetReadyState() != WebSocketPeer.State.Open)
        {
            return;
        }

        double now = NowMs();
        if (bucket.Outstanding && now < bucket.Deadline)
        {
            return; // still in flight (and not timed out) — don't pile on
        }

        bucket.Outstanding = true;
        bucket.Deadline = now + PingTimeoutMs;
        SendText(ProtocolJson.SerializeToUtf8Bytes(new PingMessage(now, mainThread ? true : null)));
    }

    private void SendText(byte[] utf8)
    {
        if (_ws == null || _ws.GetReadyState() != WebSocketPeer.State.Open)
        {
            return;
        }

        Error e = _ws.Send(utf8, WebSocketPeer.WriteMode.Text);
        if (e != Error.Ok)
        {
            GD.PrintErr($"MirrorSocket: send failed ({e})");
        }
    }

    // ==============================================================================================
    // latency probe cadence
    // ==============================================================================================

    // Start/stop/reschedule the probe live (ms; 0 = off). Re-armable exactly like setPingInterval().
    public void SetPingInterval(double intervalMs)
    {
        _pingIntervalMs = Math.Max(0, intervalMs);
        // Fire promptly if we're already connected and turning the probe on.
        if (_pingIntervalMs > 0 && Status == MirrorStatus.Connected)
        {
            _sincePingMs = _pingIntervalMs;
        }
    }

    private void PumpPing(double deltaSeconds)
    {
        if (_pingIntervalMs <= 0)
        {
            return;
        }

        _sincePingMs += deltaSeconds * 1000.0;
        if (_sincePingMs >= _pingIntervalMs)
        {
            _sincePingMs = 0;
            // BOTH probes each interval (network + game), independent single-outstanding buckets.
            SendPing(false);
            SendPing(true);
        }
    }

    private void RecordRtt(LatencyBucket bucket, double rtt)
    {
        bucket.Outstanding = false;
        if (!double.IsFinite(rtt) || rtt < 0)
        {
            return;
        }

        bucket.Samples.Add(rtt);
        if (bucket.Samples.Count > LatencyWindow)
        {
            bucket.Samples.RemoveAt(0);
        }

        bucket.LastMs = rtt;
        bucket.HasLast = true;
        int count = bucket.Samples.Count; // <= LatencyWindow by the eviction above
        bucket.Samples.CopyTo(_rttScratch);
        Array.Sort(_rttScratch, 0, count);
        bucket.P50 = Percentile(_rttScratch, count, 50);
        bucket.P95 = Percentile(_rttScratch, count, 95);
    }

    private static LatencySnapshot Snapshot(LatencyBucket b) =>
        new(b.HasLast ? b.LastMs : null, b.P50, b.P95, b.Samples.Count);

    // Port of mirrorClient.ts percentile(): sorted[min(len-1, max(0, ceil((p/100)*len)-1))]. `sorted` is the
    // scratch buffer, valid over [0, count).
    private static double? Percentile(double[] sorted, int count, double p)
    {
        if (count == 0)
        {
            return null;
        }

        int index = Math.Min(count - 1, Math.Max(0, (int)Math.Ceiling((p / 100.0) * count) - 1));
        return sorted[index];
    }

    // ==============================================================================================
    // helpers
    // ==============================================================================================

    // A monotonic millisecond clock (our own — only self-consistency with the echoed t0 matters). Microsecond
    // resolution keeps sub-ms RTTs meaningful on a fast LAN.
    private static double NowMs() => Time.GetTicksUsec() / 1000.0;

    // Cheap top-level `type` peek WITHOUT materializing the (multi-MB) message. Utf8JsonReader returns as soon as
    // it sees the `type` property (which the server always writes first), skipping any earlier property's value.
    private static string? PeekType(ReadOnlySpan<byte> utf8)
    {
        try
        {
            var reader = new Utf8JsonReader(utf8);
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
            {
                return null;
            }

            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.EndObject)
                {
                    return null;
                }

                if (reader.TokenType != JsonTokenType.PropertyName)
                {
                    return null;
                }

                bool isType = reader.ValueTextEquals("type");
                if (!reader.Read())
                {
                    return null;
                }

                if (isType)
                {
                    return reader.TokenType == JsonTokenType.String ? reader.GetString() : null;
                }

                reader.Skip(); // step over this property's value (scalar = no-op; container = to its End)
            }

            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string NormalizeHostPort(string hostPort) =>
        hostPort.Contains(':') ? hostPort : $"{hostPort}:13337";

    private static string HostOnly(string hostPort)
    {
        int idx = hostPort.IndexOf(':');
        return idx >= 0 ? hostPort[..idx] : hostPort;
    }
}
