using Godot;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Session;

/// <summary>Capture calls and signal delivery are main-thread only.</summary>
internal interface IRenderStreamCapture
{
    bool HasSingleton { get; }
    string State();
    string AttachmentState { get; }
    int Clients { get; }
    int Attach();
    int Detach();
    int Arm(IReadOnlyDictionary<string, string> options);
    int Disarm(string reason, int lingerMs);
    IDisposable Subscribe(RenderStreamCaptureSignals signals);
    void ConnectOneShot(string signal, Action callback);
}

/// <summary>Facts from this arm's signal, never from the capture's on-disk evidence.</summary>
internal sealed record RenderStreamSnapshot(
    string Listen, string Token, string CertificateHash, string RootSize, int StreamVersion)
{
    public override string ToString() => $"RenderStreamSnapshot {{ RootSize = {RootSize}, StreamVersion = {StreamVersion} }}";
}

internal sealed record RenderStreamCaptureSignals(
    Action<RenderStreamSnapshot> Armed,
    Action Disarmed,
    Action<string> ArmFailed,
    Action<string> StreamEnded,
    Action<long> ClientConnected,
    Action<long, string> ClientLeft);

internal readonly record struct RenderStreamTweenEndpoint(TweenValueKind Kind, IReadOnlyList<double> Components);

internal interface IRenderStreamTweenCapture
{
    void TweenBegin(IReadOnlyDictionary<string, object> schedule);
    void TweenCancel(long tweenId);
    IReadOnlyDictionary<string, object>? TweenCounters();
}

internal sealed class GodotRenderStreamCapture : IRenderStreamCapture, IRenderStreamTweenCapture
{
    private const string SingletonName = "RenderStreamCapture";

    public bool HasSingleton => CouchCoopMod.EngineAvailable && Engine.HasSingleton(SingletonName);

    public string State() => Singleton().Call("state").AsGodotDictionary()["state"].AsString();

    public string AttachmentState => Singleton().Call("state").AsGodotDictionary()["attachment_state"].AsString();

    public int Attach() => Singleton().Call("attach", new Godot.Collections.Dictionary()).AsInt32();

    public int Detach() => Singleton().Call("detach", new Godot.Collections.Dictionary()).AsInt32();

    public int Clients => Singleton().Call("state").AsGodotDictionary()["clients"].AsInt32();

    public int Arm(IReadOnlyDictionary<string, string> options)
    {
        var values = new Godot.Collections.Dictionary();
        foreach (var (key, value) in options) values[key] = value;
        return Singleton().Call("arm", values).AsInt32();
    }

    public int Disarm(string reason, int lingerMs) => Singleton().Call(
        "disarm", new Godot.Collections.Dictionary { ["reason"] = reason, ["linger_ms"] = lingerMs }).AsInt32();

    public void TweenBegin(IReadOnlyDictionary<string, object> schedule)
        => Singleton().Call("tween_begin", ToGodotDictionary(schedule));

    public void TweenCancel(long tweenId) => Singleton().Call("tween_cancel", tweenId);

    public IReadOnlyDictionary<string, object>? TweenCounters()
    {
        if (!HasSingleton) return null;
        var state = Singleton().Call("state").AsGodotDictionary();
        return state.TryGetValue("client_tweens", out var counters) && counters.VariantType == Variant.Type.Dictionary
            ? CounterValues(counters.AsGodotDictionary()) : null;
    }

    private static IReadOnlyDictionary<string, object> CounterValues(Godot.Collections.Dictionary source)
    {
        var result = new Dictionary<string, object>();
        foreach (var (key, value) in source)
            result[key.AsString()] = value.VariantType switch
            {
                Variant.Type.Int => value.AsInt64(),
                Variant.Type.Dictionary => CounterValues(value.AsGodotDictionary()),
                _ => throw new ArgumentException("Unsupported capture tween counter value.")
            };
        return result;
    }

    private static Godot.Collections.Dictionary ToGodotDictionary(IReadOnlyDictionary<string, object> source)
    {
        var result = new Godot.Collections.Dictionary();
        foreach (var (key, value) in source)
            result[key] = value switch
            {
                long number => Variant.From(number),
                ulong number => Variant.From(unchecked((long)number)),
                int number => Variant.From(number),
                double number => Variant.From(number),
                string text => Variant.From(text),
                RenderStreamTweenEndpoint endpoint => Endpoint(endpoint),
                IReadOnlyList<IReadOnlyDictionary<string, object>> steps => Variant.From(
                    new Godot.Collections.Array(steps.Select(step => Variant.From(ToGodotDictionary(step))))),
                _ => throw new ArgumentException($"Unsupported tween value for {key}.")
            };
        return result;
    }

    private static Variant Endpoint(RenderStreamTweenEndpoint endpoint) => EndpointValue(endpoint) switch
    {
        double number => Variant.From(number),
        Vector2 vector => Variant.From(vector),
        Vector3 vector => Variant.From(vector),
        Vector4 vector => Variant.From(vector),
        Color color => Variant.From(color),
        _ => default
    };

    internal static object? EndpointValue(RenderStreamTweenEndpoint endpoint)
    {
        var c = endpoint.Components;
        return endpoint.Kind switch
        {
            TweenValueKind.Float or TweenValueKind.Int => c[0],
            TweenValueKind.Vector2 => new Vector2((float)c[0], (float)c[1]),
            TweenValueKind.Vector3 => new Vector3((float)c[0], (float)c[1], (float)c[2]),
            TweenValueKind.Vector4 => new Vector4((float)c[0], (float)c[1], (float)c[2], (float)c[3]),
            TweenValueKind.Color => new Color((float)c[0], (float)c[1], (float)c[2], (float)c[3]),
            _ => c.Count switch
            {
                1 => c[0],
                2 => new Vector2((float)c[0], (float)c[1]),
                4 => new Color((float)c[0], (float)c[1], (float)c[2], (float)c[3]),
                _ => null
            }
        };
    }

    public IDisposable Subscribe(RenderStreamCaptureSignals signals)
    {
        var subscription = new SignalSubscription(Singleton());
        try
        {
            subscription.Add("armed", Callable.From<Variant>(info =>
            {
                var values = info.AsGodotDictionary();
                signals.Armed(new RenderStreamSnapshot(
                    values["listen"].AsString(), values["token"].AsString(), values["wt_cert_hash"].AsString(),
                    values["root_size"].AsString(), values["stream_version"].AsInt32()));
            }));
            subscription.Add("disarmed", Callable.From<Variant>(_ => signals.Disarmed()));
            subscription.Add("arm_failed", Callable.From<string>(signals.ArmFailed));
            subscription.Add("stream_ended", Callable.From<string>(signals.StreamEnded));
            subscription.Add("client_connected", Callable.From<long, Variant>((connection, _) => signals.ClientConnected(connection)));
            subscription.Add("client_left", Callable.From<long, string>(signals.ClientLeft));
            return subscription;
        }
        catch
        {
            subscription.Dispose();
            throw;
        }
    }

    public void ConnectOneShot(string signal, Action callback)
    {
        // The disarmed signal carries one info dictionary argument.
        var result = Singleton().Connect(
            signal, Callable.From<Variant>(_ => callback()), (uint)GodotObject.ConnectFlags.OneShot);
        if (result != Error.Ok) throw new InvalidOperationException($"Cannot connect render-stream {signal}: {result}.");
    }

    private static GodotObject Singleton() => Engine.GetSingleton(SingletonName);

    private sealed class SignalSubscription(GodotObject singleton) : IDisposable
    {
        private readonly List<(string Signal, Callable Callback)> _connections = [];

        internal void Add(string signal, Callable callback)
        {
            var result = singleton.Connect(signal, callback);
            if (result != Error.Ok) throw new InvalidOperationException($"Cannot connect render-stream {signal}: {result}.");
            _connections.Add((signal, callback));
        }

        public void Dispose()
        {
            foreach (var (signal, callback) in _connections)
            {
                if (GodotObject.IsInstanceValid(singleton) && singleton.IsConnected(signal, callback))
                    singleton.Disconnect(signal, callback);
            }
            _connections.Clear();
        }
    }
}
