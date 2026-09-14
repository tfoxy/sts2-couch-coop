using System.Text.Json;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.MirrorProtocol.Tests;

// Parse-side SessionEnvelope round-trips (matching browserEnvelope.ts's session normalizer) + send-side client
// control message serialization (byte-compatible with what mirrorClient.ts sends: camelCase, omit nulls).
internal static class EnvelopeTests
{
    public static void Run()
    {
        ParsesAFullSessionEnvelope();
        RejectsMissingCurrentSessionFields();
        RejectsMalformedCurrentSessionFields();
        RejectsNonSessionType();
        SerializesClientMessagesCamelCaseOmitNull();
    }

    private static void ParsesAFullSessionEnvelope()
    {
        var json = TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session",
            ["session"] = new Dictionary<string, object?>
            {
                ["name"] = "Alice",
                ["status"] = "joined",
                ["joined"] = true,
                ["playerId"] = "p:2",
                ["connectionCount"] = 3,
            },
            ["players"] = new List<object?>
            {
                new Dictionary<string, object?> { ["playerId"] = "p:1", ["name"] = "Host", ["isHost"] = true, ["isRunPlayer"] = false, ["connectionCount"] = 1, ["disconnected"] = false, ["isLocal"] = true, ["netId"] = null, ["isMirrorSeat"] = false, ["seatStatus"] = "ready", ["seatStatusReason"] = null, ["characterId"] = null },
                new Dictionary<string, object?> { ["playerId"] = "p:2", ["name"] = "Bob", ["isHost"] = false, ["isRunPlayer"] = true, ["connectionCount"] = 0, ["disconnected"] = true, ["isLocal"] = false, ["netId"] = 2, ["isMirrorSeat"] = false, ["seatStatus"] = "ready", ["seatStatusReason"] = null, ["characterId"] = null },
            },
            ["screen"] = new Dictionary<string, object?> { ["kind"] = "run", ["type"] = "run", ["title"] = "Run", ["mirrorMode"] = "mp-run" },
            ["headlessMirrorPort"] = 41234,
            ["directView"] = false,
            ["joinRejection"] = null,
            ["refreshRate"] = 24,
            ["scrollAction"] = true,
            ["assetCacheToken"] = "cache",
            ["hostName"] = "host",
        });

        var env = SessionEnvelope.Parse(json);
        Check.That(env is not null, "session parsed");

        Check.Equal(env!.Session.Name, "Alice", "session.name");
        Check.Equal(env.Session.Status, "joined", "session.status");
        Check.Equal(env.Session.Joined, true, "session.joined");
        Check.Equal(env.Session.PlayerId, "p:2", "session.playerId");
        Check.Equal(env.Session.ConnectionCount, 3, "session.connectionCount");

        Check.Equal(env.Players.Count, 2, "players count");
        Check.Equal(env.Players[0].PlayerId, "p:1", "players[0].playerId");
        Check.Equal(env.Players[0].IsHost, true, "players[0].isHost");
        Check.Equal(env.Players[1].PlayerId, "p:2", "players[1].playerId");
        Check.Equal(env.Players[1].Name, "Bob", "players[1].name");
        Check.Equal(env.Players[1].IsRunPlayer, true, "players[1].isRunPlayer");
        Check.Equal(env.Players[1].Disconnected, true, "players[1].disconnected");

        Check.Equal(env.Screen.Kind, "run", "screen.kind");
        Check.Equal(env.Screen.Type, "run", "screen.type");
        Check.Equal(env.Screen.Title, "Run", "screen.title");
        Check.Equal(env.Screen.MirrorMode, "mp-run", "screen.mirrorMode");

        Check.Equal(env.HeadlessMirrorPort, 41234, "headlessMirrorPort");
        Check.Equal(env.DirectView, false, "directView");
        Check.Equal(env.JoinRejection, null, "joinRejection");
        Check.Equal(env.RefreshRate, 24, "refreshRate");
        Check.Equal(env.AssetCacheToken, "cache", "assetCacheToken");
        Check.Equal(env.HostName, "host", "hostName");
    }

    private static void RejectsMissingCurrentSessionFields()
    {
        var env = SessionEnvelope.Parse(TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session",
            // no session / players / screen / directives
        }));
        Check.That(env is null, "a current session requires its assignment, roster, and semantic-action support");

        // Every kind the host can produce parses back out unchanged. The allowlist is a hand-kept twin of the
        // producer (BrowserAssignmentClassifier.MirrorModeFor) and of MIRROR_SCREEN_KINDS in the frontend.
        foreach (var kind in new[]
        {
            "singleplayer-run", "mp-run", "mp-character-select", "sp-character-select", "mp-load-game",
            "main-menu", "unsupported",
        })
        {
            var ok = SessionEnvelope.Parse(TestFixtures.J(new Dictionary<string, object?>
            {
                ["type"] = "session",
                ["session"] = CurrentAssignment(),
                ["players"] = new List<object?>(),
                ["scrollAction"] = true,
                ["assetCacheToken"] = "cache",
                ["hostName"] = "host",
                ["screen"] = new Dictionary<string, object?> { ["kind"] = "lobby", ["type"] = null, ["title"] = null, ["mirrorMode"] = kind },
            }));
            Check.Equal(ok!.Screen.MirrorMode, kind, $"{kind} is on the allowlist");
        }

        // Unknown mirrorMode is not a current session contract.
        var bad = SessionEnvelope.Parse(TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session",
            ["session"] = CurrentAssignment(),
            ["players"] = new List<object?>(),
            ["scrollAction"] = true,
            ["assetCacheToken"] = "cache",
            ["hostName"] = "host",
            ["screen"] = new Dictionary<string, object?> { ["kind"] = "run", ["type"] = null, ["title"] = null, ["mirrorMode"] = "bogus" },
        }));
        Check.That(bad is null, "unknown mirrorMode rejects");
        // A near-miss must not squeak through: the allowlist is exact, not a prefix/substring test.
        var nearMiss = SessionEnvelope.Parse(TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session",
            ["session"] = CurrentAssignment(),
            ["players"] = new List<object?>(),
            ["scrollAction"] = true,
            ["assetCacheToken"] = "cache",
            ["hostName"] = "host",
            ["screen"] = new Dictionary<string, object?> { ["kind"] = "lobby", ["type"] = null, ["title"] = null, ["mirrorMode"] = "sp-character-selection" },
        }));
        Check.That(nearMiss is null, "a near-miss kind rejects");
        // A screen missing its required discriminator rejects.
        var noKind = SessionEnvelope.Parse(TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session",
            ["session"] = CurrentAssignment(),
            ["players"] = new List<object?>(),
            ["scrollAction"] = true,
            ["assetCacheToken"] = "cache",
            ["hostName"] = "host",
            ["screen"] = new Dictionary<string, object?> { ["title"] = "X" },
        }));
        Check.That(noKind is null, "screen.kind is required");
    }

    private static void RejectsNonSessionType()
    {
        Check.That(SessionEnvelope.Parse(TestFixtures.J(new Dictionary<string, object?> { ["type"] = "state" })) is null, "non-session type → null");
        Check.That(SessionEnvelope.Parse("not json at all") is null, "garbage → null");
    }

    private static void RejectsMalformedCurrentSessionFields()
    {
        var missingSemanticSupport = TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session",
            ["session"] = CurrentAssignment(),
            ["players"] = new List<object?>(),
            ["assetCacheToken"] = "cache",
            ["hostName"] = "host",
        });
        Check.That(SessionEnvelope.Parse(missingSemanticSupport) is null, "missing semantic-action support rejects a current session");

        var falseScrollAction = TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session", ["session"] = CurrentAssignment(), ["players"] = new List<object?>(),
            ["screen"] = CurrentScreen(), ["assetCacheToken"] = "cache", ["hostName"] = "host",
            ["scrollAction"] = false,
        });
        Check.That(SessionEnvelope.Parse(falseScrollAction) is null, "false scrollAction rejects a current session");

        var missingAssetCacheToken = TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session", ["session"] = CurrentAssignment(), ["players"] = new List<object?>(),
            ["screen"] = CurrentScreen(), ["hostName"] = "host", ["scrollAction"] = true,        });
        Check.That(SessionEnvelope.Parse(missingAssetCacheToken) is null, "missing assetCacheToken rejects a current session");

        var missingHostName = TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session", ["session"] = CurrentAssignment(), ["players"] = new List<object?>(),
            ["screen"] = CurrentScreen(), ["assetCacheToken"] = "cache", ["scrollAction"] = true,        });
        Check.That(SessionEnvelope.Parse(missingHostName) is null, "missing hostName rejects a current session");

        var malformedSeat = TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session",
            ["session"] = CurrentAssignment(),
            ["scrollAction"] = true,
            ["assetCacheToken"] = "cache",
            ["hostName"] = "host",
            ["screen"] = CurrentScreen(),
            ["players"] = new List<object?>
            {
                new Dictionary<string, object?>
                {
                    ["playerId"] = "p:1002", ["name"] = "Seat", ["isHost"] = false, ["isRunPlayer"] = true,
                    ["connectionCount"] = 0, ["disconnected"] = false, ["isLocal"] = false, ["isMirrorSeat"] = true,
                },
            },
        });
        Check.That(SessionEnvelope.Parse(malformedSeat) is null, "missing seat status rejects a current session");

        var missingNullableSessionIdentity = CurrentAssignment();
        missingNullableSessionIdentity.Remove("name");
        var absentNullableIdentity = TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session",
            ["session"] = missingNullableSessionIdentity,
            ["players"] = new List<object?>(),
            ["screen"] = CurrentScreen(),
            ["scrollAction"] = true,
            ["assetCacheToken"] = "cache",
            ["hostName"] = "host",
        });
        Check.That(SessionEnvelope.Parse(absentNullableIdentity) is null, "missing nullable session name rejects; explicit null is required");

        var missingNullableSeatIdentity = TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "session",
            ["session"] = CurrentAssignment(),
            ["screen"] = CurrentScreen(),
            ["scrollAction"] = true,
            ["assetCacheToken"] = "cache",
            ["hostName"] = "host",
            ["players"] = new List<object?>
            {
                new Dictionary<string, object?>
                {
                    ["playerId"] = "p:1002", ["name"] = "Seat", ["isHost"] = false, ["isRunPlayer"] = true,
                    ["connectionCount"] = 0, ["disconnected"] = false, ["isLocal"] = false, ["isMirrorSeat"] = true,
                    ["seatStatus"] = "ready", ["seatStatusReason"] = null, ["characterId"] = null,
                },
            },
        });
        Check.That(SessionEnvelope.Parse(missingNullableSeatIdentity) is null, "missing nullable netId rejects; explicit null is required");
    }

    private static Dictionary<string, object?> CurrentAssignment() => new()
    {
        ["name"] = null,
        ["status"] = "unassigned",
        ["joined"] = false,
        ["playerId"] = null,
        ["connectionCount"] = 0,
    };

    private static Dictionary<string, object?> CurrentScreen() => new()
    {
        ["kind"] = "unsupported",
        ["type"] = null,
        ["title"] = null,
        ["mirrorMode"] = "unsupported",
    };

    private static void SerializesClientMessagesCamelCaseOmitNull()
    {
        // join
        AssertKeys(ProtocolJson.Serialize(new JoinMessage("join:1", "Alice")), new()
        {
            ["type"] = "join", ["requestId"] = "join:1", ["name"] = "Alice",
        }, "join");

        // scene-ack
        Check.Equal(ProtocolJson.Serialize(new SceneAckMessage()), "{\"type\":\"scene-ack\"}", "scene-ack exact bytes");

        // watch (WS-B stream gate) — exact bytes, because the host reads `on` strictly as a JSON true (anything
        // else, including a missing key or the string "true", is read as OFF).
        Check.Equal(ProtocolJson.Serialize(new WatchMessage(true)), "{\"on\":true,\"type\":\"watch\"}", "watch:on exact bytes");
        Check.Equal(ProtocolJson.Serialize(new WatchMessage(false)), "{\"on\":false,\"type\":\"watch\"}", "watch:off exact bytes");

        // ping (network)
        AssertKeys(ProtocolJson.Serialize(new PingMessage(123.5)), new() { ["type"] = "ping", ["t0"] = 123.5 }, "ping");
        AssertNoKey(ProtocolJson.Serialize(new PingMessage(123.5)), "mainThread", "ping omits null mainThread");
        // ping (main-thread)
        AssertKeys(ProtocolJson.Serialize(new PingMessage(9, true)), new() { ["type"] = "ping", ["t0"] = 9.0, ["mainThread"] = true }, "ping mainThread");

        // input (pointer click) — key/modifiers/pressed omitted
        var input = ProtocolJson.Serialize(new InputMessage("input:1", "click", Button: "left", CoordX: 100, CoordY: 200));
        AssertKeys(input, new()
        {
            ["type"] = "input", ["requestId"] = "input:1", ["kind"] = "click", ["button"] = "left", ["coordX"] = 100.0, ["coordY"] = 200.0,
        }, "input");
        AssertNoKey(input, "key", "input omits null key");
        AssertNoKey(input, "modifiers", "input omits null modifiers");
        AssertNoKey(input, "pressed", "input omits null pressed");

        // input (keyboard down)
        var key = ProtocolJson.Serialize(new InputMessage("input:2", "key", Key: "KeyE", Modifiers: "shift", Pressed: true));
        AssertKeys(key, new()
        {
            ["type"] = "input", ["requestId"] = "input:2", ["kind"] = "key", ["key"] = "KeyE", ["modifiers"] = "shift", ["pressed"] = true,
        }, "input key");
        AssertNoKey(key, "coordX", "keyboard input omits coordX");

        // settings — only set fields present
        var settings = ProtocolJson.Serialize(new SettingsMessage(RequestId: "settings:1", RefreshRate: 30, FreezeParticles: true));
        AssertKeys(settings, new()
        {
            ["type"] = "settings", ["requestId"] = "settings:1", ["refreshRate"] = 30.0, ["freezeParticles"] = true,
        }, "settings");
        AssertNoKey(settings, "freezeSpines", "settings omits null freezeSpines");
        AssertNoKey(settings, "tweenReplay", "settings omits null tweenReplay");
    }

    private static void AssertKeys(string json, Dictionary<string, object?> expected, string label)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        foreach (var (k, v) in expected)
        {
            Check.That(root.TryGetProperty(k, out var el), $"{label}: has '{k}'");
            switch (v)
            {
                case string s:
                    Check.Equal(el.GetString(), s, $"{label}.{k}");
                    break;
                case bool b:
                    Check.Equal(el.GetBoolean(), b, $"{label}.{k}");
                    break;
                case double d:
                    Check.Close(el.GetDouble(), d, $"{label}.{k}");
                    break;
                default:
                    throw new Exception($"unsupported expected type for {label}.{k}");
            }
        }
    }

    private static void AssertNoKey(string json, string key, string label)
    {
        using var doc = JsonDocument.Parse(json);
        Check.That(!doc.RootElement.TryGetProperty(key, out _), label);
    }
}
