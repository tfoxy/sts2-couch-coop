using System.Text.Json;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Server.LanRtc;
using Transport = LanRtcTunnelTests.FakeTransport;

internal sealed partial class BrowserServerRouteTests
{
    internal static async Task RunLanRtcRelayRoutesAsync()
    {
        var oldOrigins = Environment.GetEnvironmentVariable("GRC_LIVE_ALLOWED_ORIGINS");
        Environment.SetEnvironmentVariable("GRC_LIVE_ALLOWED_ORIGINS", "http://127.0.0.1:13337");
        try
        {
            await CouchCoopGameFactsTests.WithSourceAsync(new CouchCoopGameFactsTests.FakeFacts(), async () =>
            {
                await using var fixture = await RenderRelayFixture.StartAsync();
                var transport = new Transport();
                await using (var tunnel = new LanRtcTunnel(transport, fixture.PublicServer, LanRtcWebSocketTests.Candidate))
                {
                    transport.WebSocketRequest($"/ws?seat={fixture.Host.RenderStreamSeatRoute}&{GatedQuery}");
                    LanRtcWebSocketTests.ExpectUpgrade(await transport.ReadMessageAsync(), null);
                    LanRtcWebSocketTests.EmitMessage(transport, 1, "{\"type\":\"ping\",\"t0\":123}"u8.ToArray());
                    var pong = false;
                    for (var index = 0; index < 32; index++)
                    {
                        var message = await LanRtcWebSocketTests.ReadLogicalAsync(transport);
                        using var json = JsonDocument.Parse(message.Data);
                        if (json.RootElement.GetProperty("type").GetString() == "pong")
                        { pong = json.RootElement.GetProperty("t0").GetInt32() == 123; break; }
                    }
                    Expect(pong, "seat WebSocket relay answers a ping through the tunnel");
                    transport.Emit(new(LanRtcEventKind.Closed, 1, 1));
                    await transport.ResponseAsync();
                }
                fixture.Response = "websocket";
                transport = new Transport();
                await using (var tunnel = new LanRtcTunnel(transport, fixture.PublicServer, LanRtcWebSocketTests.Candidate))
                {
                    transport.WebSocketRequest($"/render-stream/{fixture.Host.RenderStreamSeatRoute}/ws", ["render-stream.16"],
                        [["Authorization", "Bearer test-token"]]);
                    LanRtcWebSocketTests.ExpectUpgrade(await transport.ReadMessageAsync(), "render-stream.16");
                    LanRtcWebSocketTests.EmitMessage(transport, 2, [1, 255, 2]);
                    var echoed = await LanRtcWebSocketTests.ReadLogicalAsync(transport);
                    Expect(echoed.Opcode == 2 && echoed.Data.SequenceEqual(new byte[] { 1, 255, 2 }), "render-stream WebSocket relay echoes bytes through the tunnel");
                    transport.Emit(new(LanRtcEventKind.Closed, 1, 1));
                    await transport.ResponseAsync();
                }
            });
        }
        finally { Environment.SetEnvironmentVariable("GRC_LIVE_ALLOWED_ORIGINS", oldOrigins); }
    }
}
