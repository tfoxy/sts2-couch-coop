using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text.Json;
using CouchCoop.Mod.Audio.Seat;
using CouchCoop.Mod.Server;

internal static class SeatAudioLaneConnectionTests
{
    public static async Task RunAsync()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var server = Task.Run(async () =>
        {
            using var tcp = await listener.AcceptTcpClientAsync(stop.Token);
            await using var stream = tcp.GetStream();
            var request = await CouchCoopHttpRequest.TryReadAsync(stream, stop.Token)
                ?? throw new Exception("missing audio upgrade request");
            await SeatAudioLaneConnection.AcceptAsync(stream, request, stop.Token);
        }, stop.Token);
        using var socket = new ClientWebSocket();
        await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/ws?lane=audio"), stop.Token);
        Require(await ReceiveKindAsync(socket, stop.Token) == "volumes", "snapshot is first frame");
        SeatAudioFeed.SetSfx(1);
        Require(await ReceiveKindAsync(socket, stop.Token) == "volumes", "volume change is pushed");
        SeatAudioFeed.Sfx("event:/sfx/test", null, 1);
        Require(await ReceiveKindAsync(socket, stop.Token) == "sfx", "SFX follows the volume delta");
        SeatAudioFeed.SetGodotSfxDb(float.NegativeInfinity);
        Require(await ReceiveKindAsync(socket, stop.Token) == "volumes", "Godot mute survives socket JSON");
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", stop.Token);
        await server;
        Console.WriteLine("seat audio lane: ok");
    }

    private static async Task<string?> ReceiveKindAsync(ClientWebSocket socket, CancellationToken token)
    {
        var bytes = new byte[2048];
        var result = await socket.ReceiveAsync(bytes.AsMemory(), token);
        Require(result.MessageType == WebSocketMessageType.Text && result.EndOfMessage,
            "audio frame is a complete text message");
        using var json = JsonDocument.Parse(bytes.AsMemory(0, result.Count));
        return json.RootElement.GetProperty("kind").GetString();
    }

    private static void Require(bool value, string label)
    {
        if (!value) throw new Exception("[SeatAudioLaneConnectionTests] " + label);
    }
}
